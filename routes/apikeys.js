const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const ApiKey = require('../models/ApiKey');
const { authenticate } = require('../middleware/auth');

/**
 * POST /api/apikeys
 * Create a new API key (plain key returned only once)
 */
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, rateLimit } = req.body;
    const userId = req.user._id;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Name is required'
      });
    }

    const plainKey = `wsk_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = ApiKey.hashKey(plainKey);
    const keyPrefix = ApiKey.getPrefix(plainKey);

    const apiKey = new ApiKey({
      name: name.trim(),
      keyHash,
      keyPrefix,
      userId,
      rateLimit: Math.min(Math.max(parseInt(rateLimit, 10) || 100, 1), 10000)
    });
    await apiKey.save();

    console.log(`[ApiKeys] Created key ${keyPrefix}... for user ${userId}`);

    res.status(201).json({
      success: true,
      apiKey: {
        id: apiKey._id,
        name: apiKey.name,
        key: plainKey,
        keyPrefix: `${keyPrefix}...`,
        rateLimit: apiKey.rateLimit,
        createdAt: apiKey.createdAt
      },
      message: 'Store the key securely. It will not be shown again.'
    });
  } catch (error) {
    console.error('[ApiKeys] Create error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create API key',
      message: error.message
    });
  }
});

/**
 * GET /api/apikeys
 * List API keys for the current user (keys themselves are not returned)
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const keys = await ApiKey.find({ userId: req.user._id })
      .select('name keyPrefix rateLimit usage lastUsedAt createdAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      apiKeys: keys.map((k) => ({
        id: k._id,
        name: k.name,
        keyPrefix: `${k.keyPrefix}...`,
        rateLimit: k.rateLimit,
        usage: k.usage,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt
      }))
    });
  } catch (error) {
    console.error('[ApiKeys] List error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list API keys',
      message: error.message
    });
  }
});

/**
 * DELETE /api/apikeys/:id
 * Revoke an API key
 */
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const key = await ApiKey.findOne({
      _id: req.params.id,
      userId: req.user._id
    });
    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'API key not found'
      });
    }
    await ApiKey.deleteOne({ _id: key._id });
    console.log(`[ApiKeys] Deleted key ${key.keyPrefix}...`);
    res.json({ success: true, message: 'API key revoked' });
  } catch (error) {
    console.error('[ApiKeys] Delete error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete API key',
      message: error.message
    });
  }
});

module.exports = router;
