import {
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  type xdr,
} from '@stellar/stellar-sdk';

/** PayLoop contract errors, by code (see contracts/payloop/src/lib.rs). */
export const CONTRACT_ERRORS: Record<number, string> = {
  1: 'PolicyNotFound',
  2: 'InvalidAmount',
  3: 'InvalidInterval',
  4: 'InvalidCap',
  5: 'InvalidParty',
  6: 'NotActive',
  7: 'NotPaused',
  8: 'AlreadyFinal',
  9: 'NotDue',
  10: 'Overflow',
  11: 'InvalidAllowanceExpiry',
};

export class SorobanCallError extends Error {
  constructor(message: string, readonly contractError: string | null = parseContractError(message)) {
    super(message);
    this.name = 'SorobanCallError';
  }
}

/** Extract the contract error name from a host error such as `Error(Contract, #9)`. */
export function parseContractError(message: string): string | null {
  const match = message.match(/Error\(Contract, #(\d+)\)/);
  return match ? CONTRACT_ERRORS[Number(match[1])] || `Contract#${match[1]}` : null;
}

export function rpcServer(url: string) {
  return new rpc.Server(url, { allowHttp: url.startsWith('http://') });
}

// Simulation needs a syntactically valid source; it is never charged or signed.
const READ_SOURCE = Keypair.random().publicKey();

/** Call a read-only contract function through simulation. */
export async function simulateRead(
  server: rpc.Server,
  passphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<{ value: xdr.ScVal; latestLedger: number }> {
  const transaction = new TransactionBuilder(new Account(READ_SOURCE, '0'), { fee: '100', networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) throw new SorobanCallError(simulation.error);
  if (!simulation.result) throw new SorobanCallError(`${method} returned no result.`);
  return { value: simulation.result.retval, latestLedger: simulation.latestLedger };
}

export interface SubmittedCall {
  hash: string;
  ledger: number;
  returnValue: unknown;
}

const POLL_INTERVAL_MS = 1_000;

/** Turn a failed transaction into its operation result code plus any host error. */
function describeFailure(result: rpc.Api.GetFailedTransactionResponse): string {
  const parts: string[] = [result.resultXdr.result().switch().name];
  try {
    const operation = result.resultXdr.result().results()[0];
    parts.push(operation.tr().invokeHostFunctionResult().switch().name);
  } catch {
    // Not an invokeHostFunction result.
  }
  const hostError = (result.diagnosticEventsXdr || [])
    .map((event) => {
      try {
        return JSON.stringify(scValToNative(event.event().body().v0().data()), (_key, value) => typeof value === 'bigint' ? value.toString() : value);
      } catch {
        return '';
      }
    })
    .find((text) => /Error|error/.test(text));
  if (hostError) parts.push(hostError.slice(0, 300));
  return parts.join(' / ');
}

/**
 * Simulate, sign, submit, and wait for a Soroban call. Simulation failures
 * (including contract errors) throw before anything is submitted.
 */
export async function submitCall(
  server: rpc.Server,
  passphrase: string,
  signer: Keypair,
  operation: xdr.Operation,
  options: { inclusionFee?: string; timeoutMs?: number } = {},
): Promise<SubmittedCall> {
  const account = await server.getAccount(signer.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: options.inclusionFee || process.env.PAYLOOP_INCLUSION_FEE || '1000',
    networkPassphrase: passphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  let prepared;
  try {
    prepared = await server.prepareTransaction(transaction);
  } catch (error) {
    throw new SorobanCallError(error instanceof Error ? error.message : String(error));
  }
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new SorobanCallError(`Transaction rejected: ${sent.errorResult?.result().switch().name || 'unknown error'}`);
  }
  if (sent.status === 'TRY_AGAIN_LATER') throw new SorobanCallError('RPC asked to try again later.');

  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        hash: sent.hash,
        ledger: result.ledger,
        returnValue: result.returnValue ? scValToNative(result.returnValue) : undefined,
      };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new SorobanCallError(`Transaction ${sent.hash} failed: ${describeFailure(result)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new SorobanCallError(`Transaction ${sent.hash} was not confirmed in time.`);
}
