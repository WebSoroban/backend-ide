const mongoose = require('mongoose');
const crypto = require('crypto');

const apiKeySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  keyHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  keyPrefix: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  rateLimit: {
    type: Number,
    default: 100,
    min: 1
  },
  usage: {
    count: { type: Number, default: 0 },
    lastResetAt: { type: Date, default: Date.now }
  },
  lastUsedAt: { type: Date, default: null }
}, {
  timestamps: true
});

apiKeySchema.index({ userId: 1, createdAt: -1 });

/**
 * Hash a plain API key for storage/lookup
 */
apiKeySchema.statics.hashKey = function (key) {
  return crypto.createHash('sha256').update(key).digest('hex');
};

/**
 * Get prefix (first 8 chars) for display and lookup hint
 */
apiKeySchema.statics.getPrefix = function (key) {
  return key && key.length >= 8 ? key.slice(0, 8) : '';
};

module.exports = mongoose.model('ApiKey', apiKeySchema);
