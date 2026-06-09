/**
 * Contract invoke service — the real read/write pipeline.
 *
 *   READ  (simulate): build op -> simulateTransaction -> decode retval. No
 *                     signature, no submission. Fast and synchronous.
 *   WRITE (sign+send): build -> prepareTransaction (footprint/auth/fees from
 *                     simulation) -> sign with the user's wallet (decrypted in
 *                     memory only) -> sendTransaction -> poll getTransaction.
 *
 * Args are ALWAYS encoded with `contract.Spec.funcArgsToScVals` and results
 * decoded with `spec.funcResToNative` — never hand-rolled comma parsing.
 *
 * TESTNET ONLY.
 */
import * as StellarSdk from '@stellar/stellar-sdk';
import prisma from '../lib/prisma';
import walletService from './wallet';
import socketService from './socketService';
import { buildSpec, parseSpecFromWasmBase64, fetchSpecFromChain, type ParsedSpec } from './contractSpec';

const TESTNET_RPC = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const TESTNET_PASSPHRASE = StellarSdk.Networks.TESTNET;

const rpc: any = (StellarSdk as any).rpc;
const xdr: any = (StellarSdk as any).xdr;
const Contract: any = (StellarSdk as any).Contract;
const TransactionBuilder: any = (StellarSdk as any).TransactionBuilder;
const Account: any = (StellarSdk as any).Account;
const BASE_FEE: string = (StellarSdk as any).BASE_FEE;
const scValToNative: any = (StellarSdk as any).scValToNative;

function getServer() {
  return new rpc.Server(TESTNET_RPC, { allowHttp: false });
}

export interface InvokeRequest {
  contractId: string;
  functionName: string;
  args: Record<string, any>;
  userId?: string | null;
  projectId?: string | null;
  /** When true, a state-changing call is signed + submitted (otherwise simulated). */
  execute?: boolean;
  /** Socket room id for live status (submitted -> pending -> confirmed/failed). */
  clientRef?: string | null;
}

export interface InvokeResult {
  success: boolean;
  readOnly: boolean;
  status: 'simulated' | 'submitted' | 'success' | 'failed';
  result?: any;
  returnValue?: any;
  txHash?: string;
  resourceFee?: string;
  cost?: any;
  latestLedger?: number;
  events?: any[];
  error?: string;
  invocationId?: string;
}

/** Recursively convert SDK-native values into JSON-safe values. */
function toJsonSafe(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Map) {
    const out: Record<string, any> = {};
    for (const [k, v] of value.entries()) out[String(k)] = toJsonSafe(v);
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) out[k] = toJsonSafe(value[k]);
    return out;
  }
  return value;
}

/**
 * Turn a raw RPC/host error string into an actionable, human message.
 * Never returns a stack trace.
 */
export function humanizeError(raw: string): string {
  const s = String(raw || '');
  // Contract-defined error: Error(Contract, #12) or "Error(Contract, #12)"
  const contractErr = s.match(/Error\(Contract,\s*#?(\d+)\)/i) || s.match(/ContractError\((\d+)\)/i);
  if (contractErr) return `Contract returned error #${contractErr[1]}. Check the contract's error enum for this code.`;
  if (/InvalidAction|require_auth|auth.*fail|Unauthorized|signature/i.test(s))
    return 'Authorization failed — the call requires a signature this wallet did not provide.';
  if (/insufficient|underfunded|balance|tx_insufficient/i.test(s))
    return 'Insufficient balance to cover the resource fee. Fund the wallet via the faucet and retry.';
  if (/ExpiredFootprint|restore|entry.*expired|archived/i.test(s))
    return 'The contract storage footprint is expired/archived and must be restored before this call.';
  if (/account not found|NotFound|getAccount/i.test(s))
    return 'Source account not found on testnet. Fund the wallet via the faucet first.';
  // Strip anything that looks like a path or stack frame.
  const firstLine = s.split('\n')[0].trim();
  return firstLine.length > 300 ? firstLine.slice(0, 300) + '…' : firstLine || 'Invocation failed';
}

/** Resolve the parsed spec for a contract: stored on Project, else from chain. */
export async function getSpecForContract(contractId: string): Promise<ParsedSpec | null> {
  const project = await prisma.project.findFirst({
    where: { contractAddress: contractId },
    select: { spec: true },
    orderBy: { updatedAt: 'desc' },
  });
  const stored = project?.spec as unknown as ParsedSpec | null;
  if (stored && Array.isArray(stored.entries) && stored.entries.length > 0) return stored;

  // Fallback: pull WASM from chain and parse, then cache it on the project.
  const fetched = await fetchSpecFromChain(contractId);
  if (fetched && fetched.entries.length > 0) {
    await prisma.project
      .updateMany({ where: { contractAddress: contractId }, data: { spec: fetched as any } })
      .catch(() => {});
    return fetched;
  }
  return null;
}

/**
 * Coerce a single form value (the web UI sends everything as a string) into the
 * JS type `funcArgsToScVals`/`nativeToScVal` expects for the given spec type:
 *   u32/i32           -> number
 *   u64/i64/u128/i128/u256/i256/Timepoint/Duration -> bigint
 *   bool              -> boolean
 *   Bytes/BytesN<n>   -> Buffer (from hex)
 *   Option<T>         -> null for empty, else coerce(T)
 *   Vec<T>            -> array, each element coerce(T)
 * Anything else (String/Symbol/Address/UDT/Map/...) is passed through unchanged.
 */
function coerceScalar(type: string, v: any): any {
  if (v === undefined || v === null) return v;

  // Option<T>: empty string / null means "no value"; otherwise coerce the inner.
  const opt = type.match(/^Option<(.+)>$/);
  if (opt) {
    if (v === '' || v === null) return null;
    return coerceScalar(opt[1].trim(), v);
  }

  // Vec<T>: accept a JS array or a JSON-ish string, coerce each element.
  const vec = type.match(/^Vec<(.+)>$/);
  if (vec) {
    let arr = v;
    if (typeof arr === 'string') {
      try { arr = JSON.parse(arr); } catch { return v; }
    }
    return Array.isArray(arr) ? arr.map((el) => coerceScalar(vec[1].trim(), el)) : v;
  }

  switch (type) {
    case 'u32':
    case 'i32': {
      if (typeof v === 'number') return v;
      const s = String(v).trim();
      if (s === '' || !/^-?\d+$/.test(s)) return v; // let the SDK surface a clear error
      return Number(s);
    }
    case 'u64':
    case 'i64':
    case 'u128':
    case 'i128':
    case 'u256':
    case 'i256':
    case 'Timepoint':
    case 'Duration': {
      if (typeof v === 'bigint') return v;
      const s = String(v).trim();
      if (s === '' || !/^-?\d+$/.test(s)) return v;
      try { return BigInt(s); } catch { return v; }
    }
    case 'bool': {
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0' || s === '') return false;
      return v;
    }
    default:
      if (/^Bytes/.test(type) && typeof v === 'string') {
        const hex = v.startsWith('0x') ? v.slice(2) : v;
        return Buffer.from(hex, 'hex');
      }
      return v;
  }
}

/** Coerce form values into the shapes `funcArgsToScVals` expects (per spec type). */
function coerceArgs(spec: ParsedSpec, functionName: string, args: Record<string, any>): Record<string, any> {
  const fn = spec.functions.find((f) => f.name === functionName);
  if (!fn) return args;
  const out: Record<string, any> = { ...args };
  for (const input of fn.inputs) {
    if (!(input.name in out)) continue;
    out[input.name] = coerceScalar(input.type, out[input.name]);
  }
  return out;
}

/** Best-effort decode of Soroban diagnostic events from a tx meta XDR. */
function decodeEvents(getRes: any): any[] {
  try {
    const meta = getRes.resultMetaXdr;
    if (!meta || typeof meta.v3 !== 'function') return [];
    const soroban = meta.v3().sorobanMeta();
    if (!soroban) return [];
    const events = soroban.events() || [];
    return events.map((e: any) => {
      try {
        const body = e.body().v0();
        return {
          topics: (body.topics() || []).map((t: any) => toJsonSafe(scValToNative(t))),
          data: toJsonSafe(scValToNative(body.data())),
        };
      } catch {
        return { raw: e.toXDR('base64') };
      }
    });
  } catch {
    return [];
  }
}

/**
 * Run a contract function. Always simulates first to decode the return value,
 * determine read vs write, and assemble the footprint. Only submits a signed
 * transaction when the call is state-changing AND `execute` is true.
 */
export async function invoke(req: InvokeRequest): Promise<InvokeResult> {
  const { contractId, functionName, args = {}, userId = null, projectId = null, execute = false, clientRef = null } = req;

  const emit = (status: string, extra: any = {}) => {
    if (clientRef) socketService.emitJobStatus(clientRef, status, { contractId, functionName, ...extra });
  };

  let spec = await getSpecForContract(contractId);
  if (!spec) {
    throw new Error('Contract spec unavailable. Recompile the contract to enable typed invoke.');
  }

  // Rebuild a contract.Spec from the stored entries. If the stored entries can't
  // be decoded (e.g. truncated/older format -> "Bad union switch"), pull a fresh
  // spec straight from the on-chain WASM and use that instead.
  let specObj: any;
  try {
    specObj = buildSpec(spec.entries);
  } catch (err: any) {
    const fresh = await fetchSpecFromChain(contractId);
    if (!fresh || fresh.entries.length === 0) {
      throw new Error(
        `Could not decode the contract interface (${err.message}). Recompile and redeploy the contract.`,
      );
    }
    try {
      specObj = buildSpec(fresh.entries);
    } catch (err2: any) {
      throw new Error(`Could not decode the contract interface: ${err2.message}`);
    }
    spec = fresh;
  }

  const coerced = coerceArgs(spec, functionName, args);

  // Encode args via the spec — never hand-rolled.
  let scVals: any[];
  try {
    scVals = specObj.funcArgsToScVals(functionName, coerced);
  } catch (err: any) {
    throw new Error(`Invalid arguments for ${functionName}: ${err.message}`);
  }

  const server = getServer();
  const contract = new Contract(contractId);

  // Source account: the user's wallet if we have one, else an unfunded stub
  // (fine for read-only simulation).
  let sourcePk: string | null = userId ? await walletService.getPublicKey(userId) : null;
  let account: any;
  if (sourcePk) {
    try {
      account = await server.getAccount(sourcePk);
    } catch {
      account = new Account(sourcePk, '0');
    }
  } else {
    const ephemeral = (StellarSdk as any).Keypair.random();
    sourcePk = ephemeral.publicKey();
    account = new Account(sourcePk, '0');
  }

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: TESTNET_PASSPHRASE })
    .addOperation(contract.call(functionName, ...scVals))
    .setTimeout(180)
    .build();

  // ---- Simulate ----
  let sim: any;
  try {
    sim = await server.simulateTransaction(tx);
  } catch (err: any) {
    throw new Error(`Simulation failed: ${err.message}`);
  }
  if (rpc.Api.isSimulationError(sim)) {
    const invocation = await persistInvocation({
      contractId, userId, projectId, functionName, args, status: 'failed', readOnly: true, error: sim.error,
    });
    return {
      success: false, readOnly: true, status: 'failed',
      error: humanizeError(sim.error), invocationId: invocation?.id,
    };
  }

  // Decode the simulated return value.
  let decoded: any = undefined;
  try {
    if (sim.result?.retval) decoded = toJsonSafe(specObj.funcResToNative(functionName, sim.result.retval));
  } catch {
    try { decoded = toJsonSafe(scValToNative(sim.result.retval)); } catch { decoded = null; }
  }

  // Read vs write: footprint writes or auth entries => state-changing.
  let readOnly = true;
  try {
    const rw = sim.transactionData ? sim.transactionData.getReadWrite() : [];
    const auth = sim.result?.auth || [];
    readOnly = (rw?.length ?? 0) === 0 && (auth?.length ?? 0) === 0;
  } catch {
    readOnly = (sim.result?.auth?.length ?? 0) === 0;
  }

  const resourceFee = sim.minResourceFee ? String(sim.minResourceFee) : undefined;
  const cost = sim.cost ? toJsonSafe(sim.cost) : undefined;

  // Read-only, or a write the caller only wanted to preview -> stop after sim.
  if (readOnly || !execute) {
    const invocation = await persistInvocation({
      contractId, userId, projectId, functionName, args,
      status: 'simulated', readOnly, returnValue: decoded, resourceFee,
    });
    return {
      success: true, readOnly, status: 'simulated', result: decoded, returnValue: decoded,
      resourceFee, cost, latestLedger: sim.latestLedger, invocationId: invocation?.id,
    };
  }

  // ---- Write: prepare -> sign -> send -> poll ----
  if (!userId) throw new Error('Sign-in required to submit a state-changing transaction.');

  emit('submitted');
  const prepared = await server.prepareTransaction(tx);
  const keypair = await walletService.loadKeypair(userId); // decrypted in memory only
  prepared.sign(keypair);

  const sendRes: any = await server.sendTransaction(prepared);
  const txHash = sendRes.hash;
  if (sendRes.status === 'ERROR') {
    const raw = safeXdrToString(sendRes.errorResult);
    const invocation = await persistInvocation({
      contractId, userId, projectId, functionName, args, status: 'failed', readOnly: false, txHash, error: raw,
    });
    emit('failed', { txHash, error: humanizeError(raw) });
    return { success: false, readOnly: false, status: 'failed', txHash, error: humanizeError(raw), resourceFee, invocationId: invocation?.id };
  }

  emit('pending', { txHash });

  // Poll until SUCCESS/FAILED or timeout.
  const getRes: any = await server.pollTransaction(txHash, { attempts: 30, sleepStrategy: () => 1000 });

  if (getRes.status === 'SUCCESS') {
    let returnValue: any = undefined;
    try {
      if (getRes.returnValue) returnValue = toJsonSafe(specObj.funcResToNative(functionName, getRes.returnValue));
    } catch {
      try { returnValue = toJsonSafe(scValToNative(getRes.returnValue)); } catch { returnValue = null; }
    }
    const events = decodeEvents(getRes);
    const invocation = await persistInvocation({
      contractId, userId, projectId, functionName, args, status: 'success', readOnly: false, txHash, returnValue, resourceFee,
    });
    emit('confirmed', { txHash, returnValue });
    return {
      success: true, readOnly: false, status: 'success', txHash, result: returnValue, returnValue,
      events, resourceFee, latestLedger: getRes.latestLedger, invocationId: invocation?.id,
    };
  }

  // FAILED or NOT_FOUND (timeout).
  const raw = getRes.resultXdr ? safeXdrToString(getRes.resultXdr) : `Transaction ${getRes.status}`;
  const invocation = await persistInvocation({
    contractId, userId, projectId, functionName, args, status: 'failed', readOnly: false, txHash, error: raw,
  });
  emit('failed', { txHash, error: humanizeError(raw) });
  return { success: false, readOnly: false, status: 'failed', txHash, error: humanizeError(raw), resourceFee, invocationId: invocation?.id };
}

function safeXdrToString(x: any): string {
  try {
    if (!x) return 'unknown error';
    if (typeof x === 'string') return x;
    if (typeof x.toXDR === 'function') return JSON.stringify(x.toXDR('base64'));
    return JSON.stringify(x);
  } catch {
    return 'unknown error';
  }
}

async function persistInvocation(data: {
  contractId: string;
  userId?: string | null;
  projectId?: string | null;
  functionName: string;
  args: Record<string, any>;
  status: string;
  readOnly: boolean;
  txHash?: string;
  returnValue?: any;
  resourceFee?: string;
  error?: string;
}) {
  try {
    return await prisma.invocation.create({
      data: {
        contractId: data.contractId,
        userId: data.userId ?? null,
        projectId: data.projectId ?? null,
        functionName: data.functionName,
        args: (data.args ?? {}) as any,
        status: data.status,
        readOnly: data.readOnly,
        txHash: data.txHash ?? null,
        returnValue: data.returnValue === undefined ? undefined : (data.returnValue as any),
        resourceFee: data.resourceFee ?? null,
        error: data.error ? humanizeError(data.error) : null,
      },
    });
  } catch (err: any) {
    console.warn('[invokeService] Could not persist invocation:', err.message);
    return null;
  }
}

export default { invoke, getSpecForContract, humanizeError };
