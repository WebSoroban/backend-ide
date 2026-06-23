/**
 * Credit ledger service — the server-side, transactional core of AI billing.
 *
 * The CreditLedger is the source of truth; User.credits is a denormalized running
 * balance updated in the SAME transaction as each ledger row, so the two can
 * never drift and there's no read-modify-write race (we use an atomic
 * `increment`/`decrement` on the row).
 *
 * Idempotency rides the CreditLedger @@unique([userId, reason, refId]) constraint:
 *   - signup_grant + refId "signup"  → granted at most once per user,
 *   - purchase     + refId paymentId → a replayed webhook can't double-credit,
 *   - usage        + refId aiRunId   → a retried worker can't double-charge.
 * A duplicate insert throws P2002, which rolls the whole transaction back (so the
 * balance change is undone too) and is treated as a no-op "already applied".
 */
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { SIGNUP_GRANT_CREDITS } from './config';

export type LedgerReason = 'signup_grant' | 'purchase' | 'usage' | 'refund' | 'admin';

export interface LedgerEntry {
  userId: string;
  /** + grant, - spend. */
  delta: number;
  reason: LedgerReason;
  /** paymentId | aiRunId | "signup" | null — also the idempotency key. */
  refId?: string | null;
}

export interface LedgerResult {
  /** Whether this call actually applied the entry (false = idempotent no-op). */
  applied: boolean;
  /** Balance after (current balance if it was a no-op). */
  balance: number;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/**
 * Apply a single ledger entry atomically. Increments/decrements User.credits and
 * writes the ledger row in one transaction. Idempotent on (userId, reason, refId):
 * a duplicate is a no-op that returns the current balance.
 */
export async function applyLedger(entry: LedgerEntry): Promise<LedgerResult> {
  const { userId, delta, reason } = entry;
  const refId = entry.refId ?? null;
  try {
    const balance = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: { credits: { increment: delta } },
        select: { credits: true },
      });
      // Throws P2002 on a duplicate (userId, reason, refId) → rolls back the
      // increment above, so no double-credit/charge.
      await tx.creditLedger.create({
        data: { userId, delta, reason, refId, balanceAfter: u.credits },
      });
      return u.credits;
    });
    return { applied: true, balance };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { applied: false, balance: await getBalance(userId) };
    }
    throw e;
  }
}

/** Current credit balance (denormalized running total; ledger is source of truth). */
export async function getBalance(userId: string): Promise<number> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { credits: true } });
  return u?.credits ?? 0;
}

/**
 * Grant the one-time signup credits, idempotently. Fast-path checks for an
 * existing grant; the unique constraint is the race backstop.
 */
export async function ensureSignupGrant(userId: string): Promise<LedgerResult> {
  if (SIGNUP_GRANT_CREDITS <= 0) return { applied: false, balance: await getBalance(userId) };
  const existing = await prisma.creditLedger.findFirst({
    where: { userId, reason: 'signup_grant' },
    select: { id: true },
  });
  if (existing) return { applied: false, balance: await getBalance(userId) };
  return applyLedger({ userId, delta: SIGNUP_GRANT_CREDITS, reason: 'signup_grant', refId: 'signup' });
}

/**
 * Grant credits for a verified purchase. Idempotent by Dodo payment id, so a
 * webhook retry (or a reconciliation re-run) never double-credits.
 */
export async function grantPurchaseCredits(userId: string, credits: number, paymentId: string): Promise<LedgerResult> {
  if (credits <= 0) return { applied: false, balance: await getBalance(userId) };
  return applyLedger({ userId, delta: credits, reason: 'purchase', refId: paymentId });
}

/**
 * Record a run's usage (AiUsage row) and debit the credits in one transaction.
 * Idempotent by runId (AiUsage.runId unique + ledger (userId,'usage',runId)), so a
 * retried worker job can't write the usage or charge twice. Returns the new balance.
 */
export async function recordUsageAndDebit(input: {
  userId: string;
  runId: string;
  model: string;
  mode: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  creditsCharged: number;
}): Promise<LedgerResult> {
  const { userId, runId, creditsCharged } = input;
  try {
    const balance = await prisma.$transaction(async (tx) => {
      // runId is unique → a retry throws P2002 and rolls everything back.
      await tx.aiUsage.create({
        data: {
          userId,
          runId,
          model: input.model,
          mode: input.mode,
          tokensIn: input.tokensIn,
          tokensOut: input.tokensOut,
          costUsd: input.costUsd,
          creditsCharged,
        },
      });
      if (creditsCharged > 0) {
        const u = await tx.user.update({
          where: { id: userId },
          data: { credits: { decrement: creditsCharged } },
          select: { credits: true },
        });
        await tx.creditLedger.create({
          data: { userId, delta: -creditsCharged, reason: 'usage', refId: runId, balanceAfter: u.credits },
        });
        return u.credits;
      }
      const u = await tx.user.findUnique({ where: { id: userId }, select: { credits: true } });
      return u?.credits ?? 0;
    });
    return { applied: true, balance };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { applied: false, balance: await getBalance(userId) };
    }
    throw e;
  }
}

export default {
  applyLedger,
  getBalance,
  ensureSignupGrant,
  grantPurchaseCredits,
  recordUsageAndDebit,
};
