import type { Job } from 'bullmq';
import { createQueue, BILLING_QUEUE_NAME } from './bullmq';

// Queue for processing verified Dodo billing events (credit grants). The webhook
// verifies the signature, enqueues a job, and returns 200 immediately; the
// billing worker does the actual grant with retries (BullMQ defaultJobOptions).
const billingQueue = createQueue(BILLING_QUEUE_NAME);

export interface BillingGrantPayload {
  /** Standard Webhooks event id (also our dedupe key). */
  eventId: string;
  /** Dodo payment id — the entitlement key (idempotent grant ref). */
  paymentId: string;
  /** Webhook event type, for logging. */
  type?: string;
}

async function addBillingGrantJob(payload: BillingGrantPayload): Promise<Job> {
  const { eventId, paymentId } = payload;
  if (!paymentId) throw new Error('Missing required parameter: paymentId');
  // jobId keyed on the event id so a duplicate webhook delivery dedupes at the
  // queue level too (BullMQ ignores an add with an existing jobId).
  const job = await billingQueue.add('grant', payload, { jobId: `dodo-${eventId || paymentId}` });
  console.log(`[BillingQueue] Added grant job ${job.id} (payment ${paymentId})`);
  return job;
}

export { billingQueue, addBillingGrantJob };
export default { billingQueue, addBillingGrantJob };
