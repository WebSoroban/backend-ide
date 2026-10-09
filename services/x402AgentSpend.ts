import prisma from '../lib/prisma'
import { explainX402Error } from './x402Errors'
import { applySpend, DAY_MS, usdcToStroops } from './x402SpendLimit'
import { recordX402Event } from './x402PayService'

export interface SpendGate {
  allowed: boolean
  walletId?: string
  amountStroops?: bigint
  message?: string
}

/**
 * Reserve daily spend for a registered agent signer before settlement.
 * Payments from unknown signers are not capped.
 */
export async function reserveAgentSpend(input: {
  userId: string
  endpointId: string
  payer: string | null
  price: string
}): Promise<SpendGate> {
  if (!input.payer) return { allowed: true }
  const wallet = await prisma.x402AgentWallet.findFirst({
    where: {
      userId: input.userId,
      publicKey: input.payer,
      active: true,
      OR: [{ endpointId: null }, { endpointId: input.endpointId }],
    },
    orderBy: { endpointId: { sort: 'desc', nulls: 'last' } },
  })
  if (!wallet) return { allowed: true }

  const amount = usdcToStroops(input.price)
  const now = Date.now()
  const decision = applySpend({
    spentStroops: BigInt(wallet.spentStroops),
    limitStroops: BigInt(wallet.limitStroops),
    windowStartedAt: wallet.windowStartedAt.getTime(),
    periodMs: wallet.periodSeconds * 1000 || DAY_MS,
  }, amount, now)

  if (!decision.ok) {
    const info = explainX402Error('SPEND_LIMIT_EXCEEDED')!
    await recordX402Event({
      endpointId: input.endpointId,
      type: 'settlement',
      status: 'failed',
      payer: input.payer,
      amount: input.price,
      errorCode: info.code,
      errorMessage: info.message,
      metadata: { walletId: wallet.id, cause: info.cause, fix: info.fix },
    })
    return { allowed: false, walletId: wallet.id, message: info.message }
  }

  await prisma.x402AgentWallet.update({
    where: { id: wallet.id },
    data: {
      spentStroops: decision.spentStroops.toString(),
      windowStartedAt: new Date(decision.windowStartedAt),
    },
  })
  return { allowed: true, walletId: wallet.id, amountStroops: amount }
}

export async function releaseAgentSpend(walletId: string | undefined, amountStroops: bigint | undefined) {
  if (!walletId || amountStroops === undefined) return
  const wallet = await prisma.x402AgentWallet.findUnique({ where: { id: walletId } })
  if (!wallet) return
  const next = BigInt(wallet.spentStroops) - amountStroops
  await prisma.x402AgentWallet.update({
    where: { id: wallet.id },
    data: { spentStroops: (next > 0n ? next : 0n).toString() },
  })
}
