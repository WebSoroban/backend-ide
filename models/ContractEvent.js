const mongoose = require('mongoose');

const contractEventSchema = new mongoose.Schema({
  contract: {
    type: String,
    required: true,
    index: true
  },
  eventType: {
    type: String,
    required: true,
    index: true
  },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  txHash: { type: String, required: true, index: true },
  ledger: { type: Number, required: true, index: true },
  timestamp: { type: Date, default: null },
  raw: { type: mongoose.Schema.Types.Mixed, default: null }
}, {
  timestamps: true
});

contractEventSchema.index({ contract: 1, timestamp: -1 });
contractEventSchema.index({ txHash: 1 });
contractEventSchema.index({ ledger: -1 });

module.exports = mongoose.model('ContractEvent', contractEventSchema);
