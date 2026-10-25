import { nativeToScVal, rpc, scValToNative } from '@stellar/stellar-sdk';
import prisma from '../../lib/prisma';
import type { NetworkId } from '../../lib/networks';
import { payloopConfig, type PayLoopConfig } from './config';
import { rpcServer, simulateRead } from './soroban';

export type PolicyStatus = 'active' | 'paused' | 'revoked' | 'completed';
const STATUS: PolicyStatus[] = ['active', 'paused', 'revoked', 'completed'];
const FAILURE: Record<number, string> = { 1: 'insufficient_balance', 2: 'insufficient_allowance' };

export interface ChainPolicy {
  policyId: bigint;
  subscriber: string;
  merchant: string;
  amount: bigint;
  intervalSeconds: number;
  cap: bigint;
  spent: bigint;
  charges: number;
  failedAttempts: number;
  nextChargeAt: Date;
  chainCreatedAt: Date;
  status: PolicyStatus;
}

export function decodePolicy(native: Record<string, any>): ChainPolicy {
  return {
    policyId: BigInt(native.id),
    subscriber: String(native.subscriber),
    merchant: String(native.merchant),
    amount: BigInt(native.amount),
    intervalSeconds: Number(native.interval),
    cap: BigInt(native.cap),
    spent: BigInt(native.spent),
    charges: Number(native.charges),
    failedAttempts: Number(native.failed_attempts),
    nextChargeAt: new Date(Number(native.next_charge_at) * 1000),
    chainCreatedAt: new Date(Number(native.created_at) * 1000),
    status: STATUS[Number(native.status)] || 'active',
  };
}

export interface PayLoopContext {
  config: PayLoopConfig;
  server: rpc.Server;
}

export function payloopContext(network?: NetworkId): PayLoopContext {
  const config = payloopConfig(network);
  return { config, server: rpcServer(config.rpcUrl) };
}

export async function readChainPolicy(ctx: PayLoopContext, policyId: bigint) {
  const { value, latestLedger } = await simulateRead(
    ctx.server,
    ctx.config.passphrase,
    ctx.config.contractId,
    'get_policy',
    [nativeToScVal(policyId, { type: 'u64' })],
  );
  return { policy: decodePolicy(scValToNative(value)), latestLedger };
}

export async function readPolicyCount(ctx: PayLoopContext): Promise<bigint> {
  const { value } = await simulateRead(ctx.server, ctx.config.passphrase, ctx.config.contractId, 'policy_count');
  return BigInt(scValToNative(value));
}

function policyRow(ctx: PayLoopContext, policy: ChainPolicy, ledger: number) {
  return {
    network: ctx.config.network,
    contractId: ctx.config.contractId,
    policyId: policy.policyId,
    subscriber: policy.subscriber,
    merchant: policy.merchant,
    amount: policy.amount.toString(),
    intervalSeconds: policy.intervalSeconds,
    cap: policy.cap.toString(),
    spent: policy.spent.toString(),
    charges: policy.charges,
    failedAttempts: policy.failedAttempts,
    nextChargeAt: policy.nextChargeAt,
    chainCreatedAt: policy.chainCreatedAt,
    status: policy.status,
    syncedLedger: ledger,
  };
}

/** Pull the authoritative policy state from the contract into the index. */
export async function refreshPolicy(ctx: PayLoopContext, policyId: bigint) {
  const { policy, latestLedger } = await readChainPolicy(ctx, policyId);
  const data = policyRow(ctx, policy, latestLedger);
  return prisma.payLoopPolicy.upsert({
    where: { contractId_policyId: { contractId: ctx.config.contractId, policyId } },
    create: data,
    update: data,
  });
}

/** Single-worker lease so only one relayer submits charges at a time. */
export async function acquireLease(ctx: PayLoopContext, owner: string, ttlMs: number): Promise<boolean> {
  const { contractId, network } = ctx.config;
  await prisma.payLoopSyncState.upsert({
    where: { contractId },
    create: { contractId, network },
    update: {},
  });
  const now = new Date();
  const claimed = await prisma.payLoopSyncState.updateMany({
    where: { contractId, OR: [{ leaseOwner: null }, { leaseOwner: owner }, { leaseUntil: { lt: now } }] },
    data: { leaseOwner: owner, leaseUntil: new Date(now.getTime() + ttlMs) },
  });
  return claimed.count === 1;
}

export async function releaseLease(ctx: PayLoopContext, owner: string) {
  await prisma.payLoopSyncState.updateMany({
    where: { contractId: ctx.config.contractId, leaseOwner: owner },
    data: { leaseOwner: null, leaseUntil: null },
  });
}

/** RPC rejects with plain `{ code, message }` objects, not Error instances. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

function isRangeError(error: unknown) {
  return /startLedger must be|ledger range|outside of the ledger range|before the oldest/i.test(errorMessage(error));
}

export interface SyncReport {
  events: number;
  charges: number;
  policies: number;
  latestLedger: number;
  /** True when the RPC retention window forced a jump; reconcile afterwards. */
  gap: boolean;
  /** Policies found by the count check whose events had been missed. */
  discovered?: number;
}

const PAGE = 200;

/** Ledgers re-scanned on every sync. RPC can report a ledger as latest before
 * all of its events are queryable, so never trust an opaque forward-only
 * cursor: resume a little before the last ledger and rely on idempotency. */
export const OVERLAP_LEDGERS = 30;
const DISCOVERY_RESCAN_LEDGERS = 17_280;

/**
 * Scan contract events from `startLedger` to the RPC's latest ledger. Charges
 * are recorded once per RPC event id (re-scans are no-ops) and every touched
 * policy id is collected for a fresh read from the contract.
 */
async function scanEvents(ctx: PayLoopContext, startLedger: number, touched: Set<bigint>, report: SyncReport) {
  const { contractId } = ctx.config;
  const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [contractId] }];
  let request: rpc.Api.GetEventsRequest = { filters, startLedger: Math.max(startLedger, 1), limit: PAGE };
  let lastCursor = '';
  for (;;) {
    let page: rpc.Api.GetEventsResponse;
    try {
      page = await ctx.server.getEvents(request);
    } catch (error) {
      if (!isRangeError(error) || report.gap) throw error;
      // The RPC no longer holds our position. Resume from its oldest ledger and
      // let snapshots plus reconciliation repair anything in between.
      const { oldestLedger } = await ctx.server.getHealth();
      request = { filters, startLedger: Math.max(oldestLedger, ctx.config.startLedger, 1), limit: PAGE };
      report.gap = true;
      continue;
    }
    report.latestLedger = page.latestLedger;

    for (const event of page.events) {
      // Protocol 23+ RPC omits this field because failed calls emit no events;
      // only an explicit false marks an event from a failed call.
      if ((event as { inSuccessfulContractCall?: boolean }).inSuccessfulContractCall === false) continue;
      report.events += 1;
      const name = String(scValToNative(event.topic[0]));
      const policyId = BigInt(scValToNative(event.topic[1]));
      touched.add(policyId);
      if (name !== 'charged' && name !== 'charge_failed') continue;

      // A charge row references its policy, so make sure the policy is indexed.
      const existing = await prisma.payLoopPolicy.findUnique({
        where: { contractId_policyId: { contractId, policyId } },
        select: { amount: true },
      });
      const policy = existing || await refreshPolicy(ctx, policyId);
      const data = scValToNative(event.value) as Record<string, any>;
      const dueAt = new Date(Number(data.due_at) * 1000);
      const closedAt = new Date(event.ledgerClosedAt);
      const created = await prisma.payLoopCharge.createMany({
        data: [{
          contractId,
          policyId,
          eventId: event.id,
          txHash: event.txHash,
          ledger: event.ledger,
          ledgerClosedAt: closedAt,
          outcome: name === 'charged' ? 'charged' : FAILURE[Number(data.reason)] || `failed_${data.reason}`,
          amount: name === 'charged' ? BigInt(data.amount).toString() : policy.amount,
          chargeNumber: name === 'charged' ? Number(data.charges) : null,
          dueAt,
          delaySeconds: Math.max(0, Math.round((closedAt.getTime() - dueAt.getTime()) / 1000)),
        }],
        skipDuplicates: true,
      });
      report.charges += created.count;
    }

    // RPC scans a bounded ledger window per request (10,000 ledgers), so a
    // short or empty page does not mean the end. Stop only once the cursor has
    // reached the latest ledger, or if it stops advancing.
    if (cursorLedger(page.cursor) >= page.latestLedger || page.cursor === lastCursor) break;
    lastCursor = page.cursor;
    request = { filters, cursor: page.cursor, limit: PAGE };
  }
}

/** Ledger encoded in an RPC event cursor (`<toid>-<index>`; ledger = toid >> 32). */
export function cursorLedger(cursor: string): number {
  try {
    return Number(BigInt(cursor.split('-')[0]) >> 32n);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Index contract events since the last synced ledger (minus an overlap), then
 * re-read every touched policy from the contract so the index converges on
 * chain state. A safety net compares the contract's policy count with the
 * index: any policy whose events were never seen is indexed directly, and the
 * past day is re-scanned for its charges.
 */
export async function syncPayLoop(ctx: PayLoopContext = payloopContext()): Promise<SyncReport> {
  const report: SyncReport = { events: 0, charges: 0, policies: 0, latestLedger: 0, gap: false };
  if (!ctx.config.enabled) return report;
  const { contractId, network } = ctx.config;
  const state = await prisma.payLoopSyncState.upsert({
    where: { contractId },
    create: { contractId, network },
    update: {},
  });
  const touched = new Set<bigint>();
  const resumeFrom = state.lastLedger > 0
    ? Math.max(state.lastLedger - OVERLAP_LEDGERS, ctx.config.startLedger)
    : ctx.config.startLedger;
  await scanEvents(ctx, resumeFrom, touched, report);

  // Policy ids are sequential, so any id up to the on-chain count that the
  // index lacks was missed (or predates the RPC retention window).
  const onChain = await readPolicyCount(ctx);
  const indexedCount = BigInt(await prisma.payLoopPolicy.count({ where: { contractId } }));
  if (onChain > indexedCount) {
    const indexed = new Set((await prisma.payLoopPolicy.findMany({ where: { contractId }, select: { policyId: true } })).map((row) => row.policyId));
    const missing: bigint[] = [];
    for (let id = 1n; id <= onChain; id += 1n) if (!indexed.has(id) && !touched.has(id)) missing.push(id);
    if (missing.length) {
      missing.forEach((id) => touched.add(id));
      const back = Math.max(report.latestLedger - DISCOVERY_RESCAN_LEDGERS, ctx.config.startLedger);
      await scanEvents(ctx, back, touched, report);
      report.discovered = missing.length;
    }
  }

  await prisma.payLoopSyncState.update({
    where: { contractId },
    data: { lastLedger: report.latestLedger, cursor: null },
  });
  for (const policyId of touched) await refreshPolicy(ctx, policyId);
  report.policies = touched.size;
  return report;
}

export interface Mismatch {
  policyId: string;
  field: string;
  chain: string;
  index: string;
}

const COMPARED: Array<keyof ReturnType<typeof policyRow>> = [
  'subscriber', 'merchant', 'amount', 'intervalSeconds', 'cap', 'spent', 'charges', 'failedAttempts', 'status',
];

function compare(chain: ChainPolicy, row: Record<string, any> | null, chargeRows: number): Mismatch[] {
  const id = chain.policyId.toString();
  if (!row) return [{ policyId: id, field: 'policy', chain: 'present', index: 'missing' }];
  const expected = policyRowValues(chain);
  const mismatches: Mismatch[] = [];
  for (const field of COMPARED) {
    const left = String(expected[field]);
    const right = String(row[field]);
    if (left !== right) mismatches.push({ policyId: id, field, chain: left, index: right });
  }
  if (row.nextChargeAt.getTime() !== chain.nextChargeAt.getTime()) {
    mismatches.push({ policyId: id, field: 'nextChargeAt', chain: chain.nextChargeAt.toISOString(), index: row.nextChargeAt.toISOString() });
  }
  // Every on-chain charge must have its payment row.
  if (chargeRows !== chain.charges) {
    mismatches.push({ policyId: id, field: 'chargeHistory', chain: String(chain.charges), index: String(chargeRows) });
  }
  return mismatches;
}

function policyRowValues(policy: ChainPolicy): Record<string, string | number> {
  return {
    subscriber: policy.subscriber,
    merchant: policy.merchant,
    amount: policy.amount.toString(),
    intervalSeconds: policy.intervalSeconds,
    cap: policy.cap.toString(),
    spent: policy.spent.toString(),
    charges: policy.charges,
    failedAttempts: policy.failedAttempts,
    status: policy.status,
  };
}

export interface ReconcileReport {
  contractId: string;
  checked: number;
  matched: number;
  mismatches: Mismatch[];
  checkedAt: string;
}

/**
 * Compare every policy in the contract with the index, including the number of
 * successful charges. A difference seen once is re-checked after a fresh sync
 * so a charge landing mid-check is not reported as drift.
 */
export async function reconcilePayLoop(ctx: PayLoopContext = payloopContext()): Promise<ReconcileReport> {
  const { contractId } = ctx.config;
  await syncPayLoop(ctx);
  const total = await readPolicyCount(ctx);

  async function check(policyId: bigint) {
    const { policy } = await readChainPolicy(ctx, policyId);
    const [row, chargeRows] = await Promise.all([
      prisma.payLoopPolicy.findUnique({ where: { contractId_policyId: { contractId, policyId } } }),
      prisma.payLoopCharge.count({ where: { contractId, policyId, outcome: 'charged' } }),
    ]);
    return compare(policy, row, chargeRows);
  }

  const mismatches: Mismatch[] = [];
  let matched = 0;
  for (let id = 1n; id <= total; id += 1n) {
    let found = await check(id);
    if (found.length) {
      await syncPayLoop(ctx);
      found = await check(id);
    }
    if (found.length) mismatches.push(...found);
    else matched += 1;
  }
  const orphans = await prisma.payLoopPolicy.findMany({ where: { contractId, policyId: { gt: total } }, select: { policyId: true } });
  for (const orphan of orphans) {
    mismatches.push({ policyId: orphan.policyId.toString(), field: 'policy', chain: 'missing', index: 'present' });
  }
  return { contractId, checked: Number(total), matched, mismatches, checkedAt: new Date().toISOString() };
}
