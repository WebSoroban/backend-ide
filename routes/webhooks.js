const express = require('express');
const router = express.Router();
const Webhook = require('../models/Webhook');
const { authenticate } = require('../middleware/auth');
const { authApiKey } = require('../middleware/authApiKey');
const crypto = require('crypto');

/**
 * POST /api/webhooks
 * Create a webhook. Accepts either JWT (authenticate) or API key (authApiKey).
 * Body: { eventType, contract?, url }
 */
router.post('/', async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    return authApiKey(req, res, () => createWebhook(req, res, next));
  }
  return authenticate(req, res, (err) => {
    if (err) return next(err);
    return createWebhook(req, res, next);
  });
});

async function createWebhook(req, res, next) {
  try {
    const { eventType, contract, url } = req.body;
    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({
        success: false,
        error: 'url is required'
      });
    }
    if (!eventType || typeof eventType !== 'string' || !eventType.trim()) {
      return res.status(400).json({
        success: false,
        error: 'eventType is required'
      });
    }

    let userId = null;
    let apiKeyId = null;
    if (req.user) {
      userId = req.user._id;
    } else if (req.apiKey) {
      apiKeyId = req.apiKey._id;
      userId = req.apiKey.userId?._id ?? req.apiKey.userId;
    }

    const secret = crypto.randomBytes(16).toString('hex');
    const webhook = new Webhook({
      url: url.trim(),
      eventType: eventType.trim(),
      contract: contract ? String(contract).trim() : null,
      active: true,
      apiKeyId,
      userId,
      secret
    });
    await webhook.save();

    console.log('[Webhooks] Created webhook', webhook._id, webhook.url);

    res.status(201).json({
      success: true,
      webhook: {
        id: webhook._id,
        url: webhook.url,
        eventType: webhook.eventType,
        contract: webhook.contract,
        active: webhook.active,
        createdAt: webhook.createdAt
      }
    });
  } catch (error) {
    console.error('[Webhooks] Create error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create webhook',
      message: error.message
    });
  }
}

/**
 * GET /api/webhooks
 * List webhooks for the current user or API key.
 */
router.get('/', async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    return authApiKey(req, res, () => listWebhooks(req, res, next));
  }
  return authenticate(req, res, (err) => {
    if (err) return next(err);
    return listWebhooks(req, res, next);
  });
});

async function listWebhooks(req, res, next) {
  try {
    let filter = {};
    if (req.user) {
      filter.userId = req.user._id;
    } else if (req.apiKey) {
      const uid = req.apiKey.userId?._id ?? req.apiKey.userId;
      filter = { $or: [{ userId: uid }, { apiKeyId: req.apiKey._id }] };
    } else {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const webhooks = await Webhook.find(filter)
      .sort({ createdAt: -1 })
      .select('url eventType contract active lastTriggeredAt lastStatus createdAt')
      .lean();

    res.json({
      success: true,
      webhooks: webhooks.map((w) => ({
        id: w._id,
        url: w.url,
        eventType: w.eventType,
        contract: w.contract,
        active: w.active,
        lastTriggeredAt: w.lastTriggeredAt,
        lastStatus: w.lastStatus,
        createdAt: w.createdAt
      }))
    });
  } catch (error) {
    console.error('[Webhooks] List error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list webhooks',
      message: error.message
    });
  }
}

/**
 * DELETE /api/webhooks/:id
 * Delete a webhook.
 */
router.delete('/:id', async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    return authApiKey(req, res, () => deleteWebhook(req, res, next));
  }
  return authenticate(req, res, (err) => {
    if (err) return next(err);
    return deleteWebhook(req, res, next);
  });
});

async function deleteWebhook(req, res, next) {
  try {
    let filter = { _id: req.params.id };
    if (req.user) {
      filter.userId = req.user._id;
    } else if (req.apiKey) {
      const uid = req.apiKey.userId?._id ?? req.apiKey.userId;
      filter = { _id: req.params.id, $or: [{ userId: uid }, { apiKeyId: req.apiKey._id }] };
    }

    const webhook = await Webhook.findOne(filter);
    if (!webhook) {
      return res.status(404).json({
        success: false,
        error: 'Webhook not found'
      });
    }
    await Webhook.deleteOne({ _id: webhook._id });
    console.log('[Webhooks] Deleted webhook', webhook._id);
    res.json({ success: true, message: 'Webhook deleted' });
  } catch (error) {
    console.error('[Webhooks] Delete error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete webhook',
      message: error.message
    });
  }
}

module.exports = router;
