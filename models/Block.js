const mongoose = require('mongoose');

const blockSchema = new mongoose.Schema({
  ledger: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  sequence: {
    type: Number,
    required: true,
    index: true
  },
  closedAt: { type: Date, default: null },
  txCount: { type: Number, default: 0 },
  raw: { type: mongoose.Schema.Types.Mixed, default: null }
}, {
  timestamps: true
});

blockSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Block', blockSchema);
