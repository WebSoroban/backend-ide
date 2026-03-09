const { createQueue, WEBHOOK_QUEUE_NAME } = require('./bullmq');
const Webhook = require('../models/Webhook');

const webhookQueue = createQueue(WEBHOOK_QUEUE_NAME);

/**
 * Find webhooks matching the contract event and add delivery jobs.
 * @param {Object} contractEventDoc - ContractEvent document (from indexer)
 */
async function addWebhookDeliveryJobs(contractEventDoc) {
  if (!contractEventDoc || !contractEventDoc.contract) return;

  const eventType = contractEventDoc.eventType || 'contract_event';
  const contract = contractEventDoc.contract;

  const webhooks = await Webhook.find({
    active: true,
    eventType: { $in: [eventType, 'contract_event', '*'] },
    $or: [
      { contract: null },
      { contract: '' },
      { contract }
    ]
  }).lean();

  const payload = {
    contract: contractEventDoc.contract,
    event: eventType,
    data: contractEventDoc.data || {},
    txHash: contractEventDoc.txHash,
    ledger: contractEventDoc.ledger,
    timestamp: contractEventDoc.timestamp,
    from: contractEventDoc.data?.from ?? null,
    to: contractEventDoc.data?.to ?? null,
    amount: contractEventDoc.data?.amount ?? null
  };

  for (const wh of webhooks) {
    await webhookQueue.add(
      'deliver',
      {
        webhookId: wh._id.toString(),
        url: wh.url,
        payload,
        secret: wh.secret
      },
      {
        jobId: `webhook-${wh._id}-${contractEventDoc.txHash}-${Date.now()}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 }
      }
    );
  }

  if (webhooks.length > 0) {
    console.log(`[WebhookQueue] Added ${webhooks.length} delivery job(s) for event ${eventType} contract ${contract}`);
  }
}

module.exports = {
  webhookQueue,
  addWebhookDeliveryJobs
};
