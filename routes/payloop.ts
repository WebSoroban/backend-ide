import express, { type NextFunction, type Request, type Response } from 'express';
import { StrKey } from '@stellar/stellar-sdk';
import type { PayLoopCharge, PayLoopPolicy } from '@prisma/client';
import prisma from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';
import { rateLimit } from '../middleware/rateLimit';
import { formatUsdc, MIN_INTERVAL_SECONDS, USDC_DECIMALS } from '../services/payloop/config';
import { payloopContext, reconcilePayLoop } from '../services/payloop/indexer';

const router = express.Router();
const ON_SCHEDULE_SECONDS = Number(process.env.PAYLOOP_ON_SCHEDULE_SECONDS) || 60;
const STATUSES = new Set(['active', 'paused', 'revoked', 'completed']);

const asyncRoute = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };

function serializePolicy(policy: PayLoopPolicy) {
  return {
    policyId: policy.policyId.toString(),
    network: policy.network,
    contractId: policy.contractId,
    subscriber: policy.subscriber,
    merchant: policy.merchant,
    amount: policy.amount,
    amountUsdc: formatUsdc(policy.amount),
    intervalSeconds: policy.intervalSeconds,
    cap: policy.cap,
    capUsdc: formatUsdc(policy.cap),
    spent: policy.spent,
    spentUsdc: formatUsdc(policy.spent),
    charges: policy.charges,
    failedAttempts: policy.failedAttempts,
    nextChargeAt: policy.nextChargeAt.toISOString(),
    createdAt: policy.chainCreatedAt.toISOString(),
    status: policy.status,
    lastAttemptAt: policy.lastAttemptAt?.toISOString() || null,
    lastAttemptError: policy.lastAttemptError,
    syncedLedger: policy.syncedLedger,
  };
}

function serializeCharge(charge: PayLoopCharge) {
  return {
    eventId: charge.eventId,
    policyId: charge.policyId.toString(),
    txHash: charge.txHash,
    ledger: charge.ledger,
    at: charge.ledgerClosedAt.toISOString(),
    outcome: charge.outcome,
    amount: charge.amount,
    amountUsdc: formatUsdc(charge.amount),
    chargeNumber: charge.chargeNumber,
    dueAt: charge.dueAt.toISOString(),
    delaySeconds: charge.delaySeconds,
  };
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const publicLimit = rateLimit({ windowSec: 60, max: 120, prefix: 'payloop-read', keyFor: (req) => req.ip });

router.get('/config', (_req, res) => {
  const { config } = payloopContext();
  res.json({
    success: true,
    enabled: config.enabled,
    network: config.network,
    contractId: config.contractId || null,
    token: config.token,
    tokenDecimals: USDC_DECIMALS,
    minIntervalSeconds: MIN_INTERVAL_SECONDS,
    explorerBase: config.explorerBase,
    demoMerchant: process.env.PAYLOOP_DEMO_MERCHANT?.trim() || null,
  });
});

router.get('/policies', publicLimit, asyncRoute(async (req: Request, res: Response) => {
  const { config } = payloopContext();
  const subscriber = String(req.query.subscriber || '').trim();
  const merchant = String(req.query.merchant || '').trim();
  const status = String(req.query.status || '').trim();
  for (const address of [subscriber, merchant]) {
    if (address && !StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) {
      return res.status(400).json({ success: false, error: 'Filter by a valid Stellar address.' });
    }
  }
  if (!subscriber && !merchant) {
    return res.status(400).json({ success: false, error: 'Pass a subscriber or merchant address.' });
  }
  if (status && !STATUSES.has(status)) return res.status(400).json({ success: false, error: 'Unknown status.' });
  const policies = await prisma.payLoopPolicy.findMany({
    where: {
      contractId: config.contractId,
      ...(subscriber ? { subscriber } : {}),
      ...(merchant ? { merchant } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { policyId: 'desc' },
    take: 100,
  });
  res.json({ success: true, policies: policies.map(serializePolicy) });
}));

router.get('/policies/:policyId', publicLimit, asyncRoute(async (req: Request, res: Response) => {
  const { config } = payloopContext();
  if (!/^\d{1,19}$/.test(req.params.policyId)) return res.status(400).json({ success: false, error: 'Invalid policy id.' });
  const policyId = BigInt(req.params.policyId);
  const policy = await prisma.payLoopPolicy.findUnique({
    where: { contractId_policyId: { contractId: config.contractId, policyId } },
  });
  if (!policy) return res.status(404).json({ success: false, error: 'Policy is not indexed yet.' });
  const charges = await prisma.payLoopCharge.findMany({
    where: { contractId: config.contractId, policyId },
    orderBy: { ledger: 'desc' },
    take: 50,
  });
  res.json({ success: true, policy: serializePolicy(policy), charges: charges.map(serializeCharge) });
}));

/** Relayer health: how many charges landed on schedule (KR: on-schedule recurring charges). */
router.get('/stats', publicLimit, asyncRoute(async (_req: Request, res: Response) => {
  const { config } = payloopContext();
  const where = { contractId: config.contractId };
  const [byStatus, byOutcome, recurring, sync] = await Promise.all([
    prisma.payLoopPolicy.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.payLoopCharge.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
    prisma.payLoopCharge.findMany({
      where: { ...where, outcome: 'charged', chargeNumber: { gt: 1 } },
      select: { delaySeconds: true },
      orderBy: { ledger: 'desc' },
      take: 5_000,
    }),
    prisma.payLoopSyncState.findUnique({ where: { contractId: config.contractId } }),
  ]);
  const delays = recurring.map((charge) => charge.delaySeconds).sort((left, right) => left - right);
  res.json({
    success: true,
    contractId: config.contractId,
    policies: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
    charges: Object.fromEntries(byOutcome.map((row) => [row.outcome, row._count._all])),
    recurring: {
      thresholdSeconds: ON_SCHEDULE_SECONDS,
      total: delays.length,
      onSchedule: delays.filter((delay) => delay <= ON_SCHEDULE_SECONDS).length,
      p50DelaySeconds: percentile(delays, 50),
      p95DelaySeconds: percentile(delays, 95),
    },
    indexer: sync ? { lastLedger: sync.lastLedger, updatedAt: sync.updatedAt.toISOString() } : null,
  });
}));

router.post('/reconcile', authenticate, requireAdmin, asyncRoute(async (_req: Request, res: Response) => {
  const report = await reconcilePayLoop();
  res.status(report.mismatches.length ? 409 : 200).json({ success: report.mismatches.length === 0, ...report });
}));

export default router;
