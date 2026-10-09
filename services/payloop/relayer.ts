import { Contract, nativeToScVal, type Keypair } from '@stellar/stellar-sdk';
import prisma from '../../lib/prisma';
import { relayerKeypair } from './config';
import { refreshPolicy, type PayLoopContext } from './indexer';
import { SorobanCallError, submitCall } from './soroban';

const OUTCOMES = ['charged', 'insufficient_balance', 'insufficient_allowance'] as const;

/**
 * Wait before retrying a policy that could not be charged. On-chain failures
 * (the subscriber could not cover the charge) back off further each time;
 * submission errors retry after a minute.
 */
export function retryDelayMs(failedAttempts: number): number {
  const steps = [0, 60_000, 5 * 60_000, 30 * 60_000, 60 * 60_000];
  return steps[Math.min(failedAttempts, steps.length - 1)];
}

export interface RelayReport {
  due: number;
  attempted: number;
  charged: number;
  uncovered: number;
  errors: number;
  skipped: number;
}

/**
 * Submit `charge` for every indexed policy that is due. Charges go out one at
 * a time from a single fee-paying account so sequence numbers never collide.
 * The contract enforces every rule, so a stale index can only waste a fee,
 * never overcharge: NotDue / NotActive simply refresh the policy.
 */
export async function relayDueCharges(
  ctx: PayLoopContext,
  options: { now?: Date; limit?: number; signer?: Keypair | null } = {},
): Promise<RelayReport> {
  const report: RelayReport = { due: 0, attempted: 0, charged: 0, uncovered: 0, errors: 0, skipped: 0 };
  const signer = options.signer === undefined ? relayerKeypair() : options.signer;
  if (!ctx.config.enabled || !signer) return report;
  const now = options.now || new Date();

  const due = await prisma.payLoopPolicy.findMany({
    where: { contractId: ctx.config.contractId, status: 'active', nextChargeAt: { lte: now } },
    orderBy: { nextChargeAt: 'asc' },
    take: options.limit || 25,
  });
  report.due = due.length;

  for (const policy of due) {
    const failures = policy.lastAttemptError ? Math.max(policy.failedAttempts, 1) : policy.failedAttempts;
    if (policy.lastAttemptAt && now.getTime() - policy.lastAttemptAt.getTime() < retryDelayMs(failures)) {
      report.skipped += 1;
      continue;
    }
    report.attempted += 1;
    const attemptAt = new Date();
    try {
      const result = await submitCall(
        ctx.server,
        ctx.config.passphrase,
        signer,
        new Contract(ctx.config.contractId).call('charge', nativeToScVal(policy.policyId, { type: 'u64' })),
      );
      const outcome = OUTCOMES[Number(result.returnValue)] || 'charged';
      if (outcome === 'charged') report.charged += 1;
      else report.uncovered += 1;
      await prisma.payLoopPolicy.update({
        where: { id: policy.id },
        data: { lastAttemptAt: attemptAt, lastAttemptError: outcome === 'charged' ? null : outcome },
      });
    } catch (error) {
      const contractError = error instanceof SorobanCallError ? error.contractError : null;
      if (contractError === 'NotDue' || contractError === 'NotActive') {
        // The index was behind the chain; nothing was charged.
        report.skipped += 1;
      } else {
        report.errors += 1;
        await prisma.payLoopPolicy.update({
          where: { id: policy.id },
          data: { lastAttemptAt: attemptAt, lastAttemptError: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
        });
      }
    }
    await refreshPolicy(ctx, policy.policyId).catch(() => undefined);
  }
  return report;
}
