const ApiKey = require('../models/ApiKey');

// In-memory rate limit store: keyPrefix -> { count, resetAt }
const rateLimitStore = new Map();
const RATE_WINDOW_MS = 60 * 1000; // 1 minute

/**
 * API Key authentication middleware.
 * Reads X-API-KEY header, validates it, attaches key data to request.
 * Rejects invalid or missing keys.
 */
async function authApiKey(req, res, next) {
  try {
    const rawKey = req.headers['x-api-key'] || req.query.apiKey;

    if (!rawKey || typeof rawKey !== 'string') {
      return res.status(401).json({
        success: false,
        error: 'API key required',
        message: 'Provide X-API-KEY header or apiKey query parameter'
      });
    }

    const keyHash = ApiKey.hashKey(rawKey);
    const keyPrefix = ApiKey.getPrefix(rawKey);

    const apiKey = await ApiKey.findOne({ keyHash }).populate('userId', 'email isActive');
    if (!apiKey) {
      console.log(`[AuthApiKey] Invalid API key prefix: ${keyPrefix}...`);
      return res.status(401).json({
        success: false,
        error: 'Invalid API key'
      });
    }

    if (apiKey.userId && !apiKey.userId.isActive) {
      return res.status(401).json({
        success: false,
        error: 'API key owner account is inactive'
      });
    }

    // Rate limiting
    const limit = apiKey.rateLimit || 100;
    const now = Date.now();
    const storeKey = apiKey.keyPrefix;
    let window = rateLimitStore.get(storeKey);
    if (!window || now >= window.resetAt) {
      window = { count: 0, resetAt: now + RATE_WINDOW_MS };
      rateLimitStore.set(storeKey, window);
    }
    window.count += 1;
    if (window.count > limit) {
      console.log(`[AuthApiKey] Rate limit exceeded for key ${storeKey}...`);
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        message: `Max ${limit} requests per minute`
      });
    }

    req.apiKey = apiKey;
    req.apiKeyUserId = apiKey.userId?._id?.toString() || apiKey.userId?.toString();

    // Update last used (fire and forget)
    ApiKey.updateOne(
      { _id: apiKey._id },
      { $set: { lastUsedAt: new Date() }, $inc: { 'usage.count': 1 } }
    ).catch((err) => console.error('[AuthApiKey] Usage update error:', err));

    next();
  } catch (error) {
    console.error('[AuthApiKey] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Authentication failed',
      message: error.message
    });
  }
}

module.exports = { authApiKey };
