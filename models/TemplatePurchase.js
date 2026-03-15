const mongoose = require('mongoose');

const templatePurchaseSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  templateId: {
    type: String,
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'XLM'
  },
  txHash: {
    type: String,
    default: null,
    sparse: true,
    index: true
  },
  network: {
    type: String,
    enum: ['testnet', 'mainnet'],
    default: 'testnet'
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'failed', 'expired'],
    default: 'pending',
    index: true
  },
  memo: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  confirmedAt: {
    type: Date,
    default: null
  },
  expiresAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

templatePurchaseSchema.index({ userId: 1, templateId: 1, status: 1 });
templatePurchaseSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('TemplatePurchase', templatePurchaseSchema);
