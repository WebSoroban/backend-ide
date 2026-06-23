/**
 * Dodo Payments webhook (mounted at /api/webhooks/dodo).
 *
 * MUST be registered with a RAW body parser BEFORE express.json() — the Standard
 * Webhooks signature is an HMAC over the raw bytes, so a re-serialized JSON body
 * would fail verification.
 *
 * Flow: verify signature → (idempotent) enqueue a grant job → return 200 fast.
 * Credits are NEVER granted here; the billing worker grants them after verifying
 * the payment again server-to-server. An unverified request is rejected.
 */
import express, { type Request, type Response } from 'express';
import prisma from '../../lib/prisma';
import { verifyWebhook } from '../../services/billing/dodo';
import { addBillingGrantJob } from '../../queues/billingQueue';

const router = express.Router();

router.post('/', async (req: Request, res: Response) => {
  if (!process.env.DODO_PAYMENTS_WEBHOOK_SECRET) {
    console.error('[DodoWebhook] DODO_PAYMENTS_WEBHOOK_SECRET not set — rejecting.');
    return res.status(503).json({ error: 'Webhooks not configured' });
  }

  // express.raw gives a Buffer; verify against the raw string.
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : '';
  const eventId = (req.headers['webhook-id'] as string) || '';

  let event: any;
  try {
    event = verifyWebhook(raw, req.headers as any);
  } catch (e: any) {
    console.warn('[DodoWebhook] signature verification failed:', e?.message);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const type: string = event?.type || '';
  const data = event?.data || {};
  const paymentId: string | undefined = data.payment_id || data.paymentId;

  // Fast idempotent ack: if we've already recorded this event, do nothing.
  if (eventId) {
    const seen = await prisma.processedWebhookEvent.findUnique({ where: { eventId } }).catch(() => null);
    if (seen) return res.status(200).json({ received: true, deduped: true });
  }

  // One-time credit packs: grant on a succeeded/completed payment. Other event
  // types are acked and ignored. The grant happens in the worker (retryable).
  const isPaymentSuccess = /^payment\.(succeeded|completed)$/.test(type);
  if (isPaymentSuccess && paymentId) {
    try {
      await addBillingGrantJob({ eventId, paymentId, type });
    } catch (e: any) {
      // If enqueue fails, return 5xx so Dodo retries the webhook later.
      console.error('[DodoWebhook] failed to enqueue grant job:', e?.message);
      return res.status(500).json({ error: 'Could not enqueue grant' });
    }
  } else {
    // Record non-grant events so we don't reprocess; grant events are recorded by
    // the worker once handled.
    if (eventId) {
      await prisma.processedWebhookEvent
        .create({ data: { eventId, source: 'dodo', type, payload: { ignored: true } as any } })
        .catch(() => {});
    }
  }

  return res.status(200).json({ received: true });
});

export default router;
