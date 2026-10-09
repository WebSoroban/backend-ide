import { Address, Networks, Transaction, scValToNative } from '@stellar/stellar-sdk'

/**
 * The exact Stellar scheme carries a base64 transaction that invokes the USDC
 * asset contract's `transfer(from, to, amount)`. This module reads that
 * transfer without trusting any echoed field, the same way the facilitator
 * does, so WebSoroban can gate spend and validate the recipient before the
 * payload ever reaches the facilitator.
 */
export interface StellarTransfer {
  network: string
  asset: string
  from: string
  to: string
  amount: bigint
}

const PASSPHRASES: Record<string, string> = {
  'stellar:testnet': Networks.TESTNET,
  'stellar:pubnet': Networks.PUBLIC,
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' ? value as Record<string, any> : null
}

/** Accepts a v2 payment payload, or a facilitator request body that wraps one. */
export function decodeStellarTransfer(input: unknown, fallbackNetwork?: string): StellarTransfer | null {
  const body = asRecord(input)
  const payload = asRecord(body?.paymentPayload) || body
  const transactionXdr = payload?.payload?.transaction
  const network = String(payload?.accepted?.network || body?.paymentRequirements?.network || fallbackNetwork || '')
  const passphrase = PASSPHRASES[network]
  if (typeof transactionXdr !== 'string' || !passphrase) return null
  try {
    const transaction = new Transaction(transactionXdr, passphrase)
    if (transaction.operations.length !== 1) return null
    const operation = transaction.operations[0]
    if (operation.type !== 'invokeHostFunction') return null
    const func = operation.func
    if (func.switch().name !== 'hostFunctionTypeInvokeContract') return null
    const invocation = func.invokeContract()
    if (invocation.functionName().toString() !== 'transfer') return null
    const args = invocation.args()
    if (args.length !== 3) return null
    const amount = scValToNative(args[2])
    if (typeof amount !== 'bigint') return null
    return {
      network,
      asset: Address.fromScAddress(invocation.contractAddress()).toString(),
      from: String(scValToNative(args[0])),
      to: String(scValToNative(args[1])),
      amount,
    }
  } catch {
    return null
  }
}

/** Payer address from a payment payload, or a facilitator-echoed `payer`. */
export function extractPayer(input: unknown): string | null {
  const transfer = decodeStellarTransfer(input)
  if (transfer?.from) return transfer.from
  const echoed = asRecord(input)?.payer
  return typeof echoed === 'string' && /^[GC][A-Z2-7]{55}$/.test(echoed) ? echoed : null
}
