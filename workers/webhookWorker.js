require('dotenv').config();
const { createWorker, WEBHOOK_QUEUE_NAME } = require('../queues/bullmq');
const Webhook = require('../models/Webhook');
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/soroban-ide';

mongoose.connect(MONGODB_URI).then(() => {
  console.log('[WebhookWorker] Connected to MongoDB');
}).catch((err) => {
  console.error('[WebhookWorker] MongoDB connection error:', err);
  process.exit(1);
});

/**
 * Deliver a webhook: POST payload to url with retry logic.
 */
async function processWebhookJob(job) {
  const { webhookId, url, payload, secret } = job.data;

  const webhook = await Webhook.findById(webhookId);
  if (!webhook || !webhook.active) {
    console.log('[WebhookWorker] Webhook no longer active, skipping', webhookId);
    return;
  }

  const body = {
    contract: payload.contract,
    event: payload.event,
    from: payload.from,
    to: payload.to,
    amount: payload.amount,
    txHash: payload.txHash,
    ledger: payload.ledger,
    timestamp: payload.timestamp,
    data: payload.data
  };

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'WebSoroban-Webhooks/1.0'
  };
  if (secret) {
    const hmac = require('crypto').createHmac('sha256', secret);
    hmac.update(JSON.stringify(body));
    headers['X-Webhook-Signature'] = hmac.digest('hex');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  await Webhook.updateOne(
    { _id: webhookId },
    {
      $set: {
        lastTriggeredAt: new Date(),
        lastStatus: response.status,
        lastError: response.ok ? null : `${response.status} ${response.statusText}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Webhook delivery failed: ${response.status} ${response.statusText}`);
  }

  console.log('[WebhookWorker] Delivered webhook', webhookId, url, response.status);
}

const worker = createWorker(WEBHOOK_QUEUE_NAME, processWebhookJob, {
  concurrency: parseInt(process.env.WEBHOOK_WORKER_CONCURRENCY || '3', 10)
});

worker.on('completed', (job) => {
  console.log('[WebhookWorker] Job completed:', job.id);
});

worker.on('failed', (job, err) => {
  console.error('[WebhookWorker] Job failed:', job?.id, err.message);
});

worker.on('error', (err) => {
  console.error('[WebhookWorker] Worker error:', err);
});

console.log('[WebhookWorker] Started');

process.on('SIGTERM', async () => {
  console.log('[WebhookWorker] SIGTERM received, closing...');
  await worker.close();
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[WebhookWorker] SIGINT received, closing...');
  await worker.close();
  await mongoose.connection.close();
  process.exit(0);
});

module.exports = worker;
