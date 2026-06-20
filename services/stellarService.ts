/**
 * Network-parameterized Stellar/Soroban transaction builder for the NON-CUSTODIAL
 * path (mainnet default). The backend builds + simulates + prepares a transaction
 * and returns the unsigned XDR; the user's browser wallet signs it; the signed
 * XDR is posted back here and submitted. The backend NEVER sees the mainnet key.
 *
 * Deploying a Soroban contract is two host-function transactions, each signed
 * separately by the browser wallet:
 *   1. upload   — install the wasm (its hash = sha256(wasm))
 *   2. create   — instantiate a contract instance from that wasm hash
 *
 * Custodial signing (testnet always; mainnet opt-in) does NOT use this module —
 * deploys go through deploymentService (CLI) and invokes through invokeService.
 */
import * as StellarSdk from '@stellar/stellar-sdk';
import { getNetwork, type NetworkId } from '../lib/networks';
import { parseSpecFromWasmBase64 } from './contractSpec';

const rpc: any = (StellarSdk as any).rpc;
const Operation: any = (StellarSdk as any).Operation;
const Address: any = (StellarSdk as any).Address;
const TransactionBuilder: any = (StellarSdk as any).TransactionBuilder;
const BASE_FEE: string = (StellarSdk as any).BASE_FEE;
const scValToNative: any = (StellarSdk as any).scValToNative;
const sha256: any = (StellarSdk as any).hash;

function server(network: NetworkId) {
  const cfg = getNetwork(network);
  return new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith('http://') });
}

async function accountOrThrow(network: NetworkId, publicKey: string) {
  try {
    return await server(network).getAccount(publicKey);
  } catch {
    throw new Error(
      `Account ${publicKey} is not funded on ${getNetwork(network).label}. ` +
        (network === 'mainnet'
          ? 'Send XLM to this address before deploying (see the funding guide).'
          : 'Fund it from the faucet first.'),
    );
  }
}

/** Total fee (inclusion + resource) in stroops and XLM, read off a prepared tx. */
function feeOf(prepared: any): { feeStroops: string; feeXlm: string } {
  const feeStroops = String(prepared.fee ?? BASE_FEE);
  const feeXlm = (Number(feeStroops) / 1e7).toFixed(7);
  return { feeStroops, feeXlm };
}

export interface PreparedTx {
  xdr: string;
  feeStroops: string;
  feeXlm: string;
}

/** Build + simulate + prepare a single-operation tx; return unsigned XDR + fee. */
async function prepareOp(network: NetworkId, sourcePk: string, op: any): Promise<PreparedTx> {
  const cfg = getNetwork(network);
  const account = await accountOrThrow(network, sourcePk);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: cfg.passphrase })
    .addOperation(op)
    .setTimeout(180)
    .build();

  const s = server(network);
  const sim = await s.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  const prepared = await s.prepareTransaction(tx);
  return { xdr: prepared.toXDR(), ...feeOf(prepared) };
}

/** Submit a signed XDR and poll to a terminal status. Returns hash + returnValue. */
async function submitSignedXdr(
  network: NetworkId,
  signedXdr: string,
): Promise<{ hash: string; returnValue?: any; status: string }> {
  const cfg = getNetwork(network);
  const s = server(network);
  const tx = TransactionBuilder.fromXDR(signedXdr, cfg.passphrase);
  const send: any = await s.sendTransaction(tx);
  if (send.status === 'ERROR') {
    throw new Error(`Transaction rejected: ${safe(send.errorResult)}`);
  }
  const got: any = await s.pollTransaction(send.hash, { attempts: 30, sleepStrategy: () => 1000 });
  if (got.status !== 'SUCCESS') {
    throw new Error(`Transaction ${got.status}${got.resultXdr ? `: ${safe(got.resultXdr)}` : ''}`);
  }
  return { hash: send.hash, returnValue: got.returnValue, status: got.status };
}

// ---- Deploy: step 1 (upload wasm) ----------------------------------------

export interface PreparedUpload extends PreparedTx {
  wasmHashHex: string;
}

/** Prepare the wasm-upload transaction. The wasm hash is sha256(wasm). */
async function prepareUpload(network: NetworkId, sourcePk: string, wasmBase64: string): Promise<PreparedUpload> {
  const wasm = Buffer.from(wasmBase64, 'base64');
  const op = Operation.uploadContractWasm({ wasm });
  const prepared = await prepareOp(network, sourcePk, op);
  const wasmHashHex = Buffer.from(sha256(wasm)).toString('hex');
  return { ...prepared, wasmHashHex };
}

async function submitUpload(network: NetworkId, signedXdr: string): Promise<{ txHash: string; wasmHashHex?: string }> {
  const { hash, returnValue } = await submitSignedXdr(network, signedXdr);
  let wasmHashHex: string | undefined;
  try {
    const native = returnValue ? scValToNative(returnValue) : null;
    if (native) wasmHashHex = Buffer.from(native).toString('hex');
  } catch {
    /* hash is recoverable from the wasm itself; non-fatal */
  }
  return { txHash: hash, wasmHashHex };
}

// ---- Deploy: step 2 (create contract instance) ---------------------------

/**
 * Build constructor ScVals the way the custodial CLI path does: fill every
 * Address constructor param with the deployer's own address. Non-Address
 * required args can't be defaulted (caller is warned).
 */
function constructorArgsFor(wasmBase64: string, sourcePk: string): { args: any[]; filled: string[]; skipped: string[] } {
  const args: any[] = [];
  const filled: string[] = [];
  const skipped: string[] = [];
  try {
    const ctor = parseSpecFromWasmBase64(wasmBase64).functions.find((f) => f.name === '__constructor');
    if (ctor) {
      for (const input of ctor.inputs) {
        const base = input.type.replace(/^Option<(.*)>$/, '$1');
        if (base === 'Address' || base === 'MuxedAddress') {
          args.push(Address.fromString(sourcePk).toScVal());
          filled.push(input.name);
        } else {
          skipped.push(`${input.name}: ${input.type}`);
        }
      }
    }
  } catch {
    /* no/❓ spec — deploy without constructor args */
  }
  return { args, filled, skipped };
}

export interface PreparedCreate extends PreparedTx {
  filled: string[];
  skipped: string[];
}

async function prepareCreate(
  network: NetworkId,
  sourcePk: string,
  wasmHashHex: string,
  wasmBase64: string,
): Promise<PreparedCreate> {
  const wasmHash = Buffer.from(wasmHashHex, 'hex');
  const { args, filled, skipped } = constructorArgsFor(wasmBase64, sourcePk);
  const salt = Buffer.from((StellarSdk as any).hash(Buffer.from(`${sourcePk}:${wasmHashHex}:${Date.now()}`)));
  const op = Operation.createCustomContract({
    address: Address.fromString(sourcePk),
    wasmHash,
    salt,
    ...(args.length ? { constructorArgs: args } : {}),
  });
  const prepared = await prepareOp(network, sourcePk, op);
  return { ...prepared, filled, skipped };
}

async function submitCreate(network: NetworkId, signedXdr: string): Promise<{ txHash: string; contractId: string }> {
  const { hash, returnValue } = await submitSignedXdr(network, signedXdr);
  let contractId = '';
  try {
    contractId = Address.fromScVal(returnValue).toString();
  } catch {
    try {
      contractId = String(scValToNative(returnValue));
    } catch {
      /* leave empty — caller surfaces the tx hash */
    }
  }
  if (!contractId || !contractId.startsWith('C')) {
    throw new Error('Deployed, but could not read the contract id from the result. Check the explorer.');
  }
  return { txHash: hash, contractId };
}

function safe(x: any): string {
  try {
    if (!x) return 'unknown error';
    if (typeof x === 'string') return x;
    if (typeof x.toXDR === 'function') return x.toXDR('base64');
    return JSON.stringify(x);
  } catch {
    return 'unknown error';
  }
}

export default {
  prepareUpload,
  submitUpload,
  prepareCreate,
  submitCreate,
  submitSignedXdr,
};
export { prepareUpload, submitUpload, prepareCreate, submitCreate, submitSignedXdr };
