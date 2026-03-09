const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  hash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  ledger: { type: Number, required: true, index: true },
  from: { type: String, default: null, index: true },
  contract: { type: String, default: null, index: true },
  function: { type: String, default: null, index: true },
  timestamp: { type: Date, default: null },
  status: { type: String, default: 'unknown', index: true },
  success: { type: Boolean, default: false },
  raw: { type: mongoose.Schema.Types.Mixed, default: null }
}, {
  timestamps: true
});

transactionSchema.index({ ledger: -1 });
transactionSchema.index({ from: 1, timestamp: -1 });
transactionSchema.index({ contract: 1, timestamp: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
