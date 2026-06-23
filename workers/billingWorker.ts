import 'dotenv/config';
import type { Job } from 'bullmq';
import { createWorker, BILLING_QUEUE_NAME } from '../queues/bullmq';
import type { BillingGrantPayload } from '../queues/billingQueue';
import prisma from '../lib/prisma';
import { processPaymentGrant } from '../services/billing/grant';
import { initObservability, captureError } from '../lib/observability';

initObservability();

const CONCURRENCY = parseInt(process.env.BILLING_WORKER_CONCURRENCY || '2', 10);

/**
 * Process a verified Dodo billing event: grant the mapped credits for the payment.
 * The grant itself is idempotent (ledger unique on payment id), and we record the
 * processed event id for a fast audit trail. Throwing makes BullMQ retry.
 */
async function processBillingJob(job: Job) {
  const { eventId, paymentId, type } = job.data as BillingGrantPayload;
  console.log(`[BillingWorker] grant for payment ${paymentId} (event ${eventId}, ${type || 'n/a'})`);

  const result = await processPaymentGrant(paymentId);

  if (!result.ok) {
    // Non-succeeded payment / unresolved user → not retryable; log and ack.
    console.warn(`[BillingWorker] skipped payment ${paymentId}: ${result.reason}`);
  } else {
    console.log(
      `[BillingWorker] ${result.applied ? 'granted' : 'already granted'} ${result.credits} credits to ${result.userId} (balance ${result.balance})`
    );
  }

  // Record the processed event (best-effort; dedupe + audit).
  if (eventId) {
    await prisma.processedWebhookEvent
      .upsert({
        where: { eventId },
        update: { type, payload: { paymentId, result } as any },
        create: { eventId, source: 'dodo', type, payload: { paymentId, result } as any },
      })
      .catch(() => {});
  }
}

const worker = createWorker(BILLING_QUEUE_NAME, processBillingJob, { concurrency: CONCURRENCY });

worker.on('completed', (job) => console.log(`[BillingWorker] Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`[BillingWorker] Job ${job?.id} failed:`, err.message));
worker.on('error', (err) => captureError(err, { worker: 'billing', scope: 'worker' }));

console.log(`[BillingWorker] Started with concurrency: ${CONCURRENCY}`);

process.on('SIGTERM', async () => {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

export default worker;
