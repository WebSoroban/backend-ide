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
 *
 * The wallet row is locked for the duration of the check, so two concurrent
 * settlements from the same signer cannot both slip under the cap. Each
 * reservation is keyed by the payment fingerprint: a retried settle of the
 * same payment is idempotent, and the reservation survives a restart so it
 * can be committed or released by whichever process sees the outcome.
 *
 * Payments from signers that are not registered are not capped.
 */
export async function reserveAgentSpend(input: {
  userId: string
  endpointId: string
  payer: string | null
  price: string
  fingerprint: string
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
    select: { id: true },
  })
  if (!wallet) return { allowed: true }

  const amount = usdcToStroops(input.price)
  const decision = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "X402AgentWallet" WHERE "id" = ${wallet.id} FOR UPDATE`
    const existing = await tx.x402SpendReservation.findUnique({ where: { fingerprint: input.fingerprint } })
    if (existing && existing.status !== 'released') {
      return { ok: true as const, walletId: existing.walletId, amount: BigInt(existing.amountStroops) }
    }

    const current = await tx.x402AgentWallet.findUniqueOrThrow({ where: { id: wallet.id } })
    const next = applySpend({
      spentStroops: BigInt(current.spentStroops),
      limitStroops: BigInt(current.limitStroops),
      windowStartedAt: current.windowStartedAt.getTime(),
      periodMs: current.periodSeconds * 1000 || DAY_MS,
    }, amount, Date.now())
    if (!next.ok) return { ok: false as const, walletId: current.id }

    const windowStartedAt = new Date(next.windowStartedAt)
    await tx.x402AgentWallet.update({
      where: { id: current.id },
      data: { spentStroops: next.spentStroops.toString(), windowStartedAt },
    })
    await tx.x402SpendReservation.upsert({
      where: { fingerprint: input.fingerprint },
      create: {
        walletId: current.id,
        fingerprint: input.fingerprint,
        amountStroops: amount.toString(),
        windowStartedAt,
        status: 'reserved',
      },
      update: { walletId: current.id, amountStroops: amount.toString(), windowStartedAt, status: 'reserved' },
    })
    return { ok: true as const, walletId: current.id, amount }
  })

  if (!decision.ok) {
    const info = explainX402Error('SPEND_LIMIT_EXCEEDED')!
    await recordX402Event({
      endpointId: input.endpointId,
      type: 'settlement',
      status: 'failed',
      requestFingerprint: input.fingerprint,
      payer: input.payer,
      amount: input.price,
      errorCode: info.code,
      errorMessage: info.message,
      metadata: { walletId: decision.walletId },
    })
    return { allowed: false, walletId: decision.walletId, message: info.message }
  }
  return { allowed: true, walletId: decision.walletId, amountStroops: decision.amount }
}

/** Mark a reservation spent after the facilitator confirms settlement. */
export async function commitAgentSpend(fingerprint: string) {
  await prisma.x402SpendReservation.updateMany({
    where: { fingerprint, status: 'reserved' },
    data: { status: 'committed' },
  })
}

/**
 * Return reserved spend after a failed settlement. The refund only applies to
 * the window it was reserved in; once the window has rolled over the counter
 * already restarted from zero.
 */
export async function releaseAgentSpend(fingerprint: string) {
  const reservation = await prisma.x402SpendReservation.findUnique({ where: { fingerprint } })
  if (!reservation || reservation.status !== 'reserved') return
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "X402AgentWallet" WHERE "id" = ${reservation.walletId} FOR UPDATE`
    const claimed = await tx.x402SpendReservation.updateMany({
      where: { id: reservation.id, status: 'reserved' },
      data: { status: 'released' },
    })
    if (claimed.count !== 1) return
    const wallet = await tx.x402AgentWallet.findUnique({ where: { id: reservation.walletId } })
    if (!wallet || wallet.windowStartedAt.getTime() !== reservation.windowStartedAt.getTime()) return
    const next = BigInt(wallet.spentStroops) - BigInt(reservation.amountStroops)
    await tx.x402AgentWallet.update({
      where: { id: wallet.id },
      data: { spentStroops: (next > 0n ? next : 0n).toString() },
    })
  })
}
