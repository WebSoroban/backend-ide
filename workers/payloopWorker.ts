import 'dotenv/config';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import prisma from '../lib/prisma';
import { captureError, initObservability } from '../lib/observability';
import { relayerKeypair } from '../services/payloop/config';
import { acquireLease, payloopContext, releaseLease, syncPayLoop } from '../services/payloop/indexer';
import { relayDueCharges } from '../services/payloop/relayer';

initObservability();

const TICK_MS = Number(process.env.PAYLOOP_TICK_MS) || 5_000;
const LEASE_MS = Math.max(TICK_MS * 6, 30_000);
const owner = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
const ctx = payloopContext();
let stopping = false;

/**
 * PayLoop indexer + relayer. Only the lease holder runs, so several replicas
 * can be deployed for availability without double-submitting charges.
 */
async function tick() {
  if (!(await acquireLease(ctx, owner, LEASE_MS))) return;
  const before = await syncPayLoop(ctx);
  const relayed = await relayDueCharges(ctx);
  const after = relayed.attempted ? await syncPayLoop(ctx) : null;
  const events = before.events + (after?.events || 0);
  const payments = before.charges + (after?.charges || 0);
  const gap = before.gap || Boolean(after?.gap);
  if (relayed.attempted || events || gap) {
    console.log(`[PayLoop] ledger ${(after || before).latestLedger}: ${events} events, ${payments} payments indexed; relayed ${relayed.charged} charged, ${relayed.uncovered} uncovered, ${relayed.errors} errors${gap ? ' (retention gap — run reconcile)' : ''}`);
  }
}

async function main() {
  if (!ctx.config.enabled) {
    console.error('[PayLoop] No contract configured. Set PAYLOOP_CONTRACT_ID or deploy with scripts/payloop-deploy.ts.');
    process.exit(1);
  }
  if (!relayerKeypair()) console.warn('[PayLoop] PAYLOOP_RELAYER_SECRET is not set: indexing only, no charges will be submitted.');
  console.log(`[PayLoop] worker ${owner} on ${ctx.config.network} contract ${ctx.config.contractId}`);
  while (!stopping) {
    const started = Date.now();
    try {
      await tick();
    } catch (error) {
      captureError(error, { scope: 'payloopWorker' });
      console.error('[PayLoop] tick failed:', error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, TICK_MS - (Date.now() - started))));
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[PayLoop] ${signal} received, releasing lease`);
  await releaseLease(ctx, owner).catch(() => undefined);
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void main();
