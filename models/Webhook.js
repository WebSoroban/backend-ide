const mongoose = require('mongoose');

const webhookSchema = new mongoose.Schema({
  url: {
    type: String,
    required: true,
    trim: true
  },
  eventType: {
    type: String,
    required: true,
    index: true
  },
  contract: {
    type: String,
    default: null,
    index: true
  },
  active: {
    type: Boolean,
    default: true,
    index: true
  },
  apiKeyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApiKey',
    default: null,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  secret: { type: String, default: null },
  lastTriggeredAt: { type: Date, default: null },
  lastStatus: { type: Number, default: null },
  lastError: { type: String, default: null }
}, {
  timestamps: true
});

webhookSchema.index({ eventType: 1, contract: 1, active: 1 });

module.exports = mongoose.model('Webhook', webhookSchema);
