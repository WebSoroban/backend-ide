const mongoose = require('mongoose');

/**
 * Minimal state for indexer progress. Used instead of Block collection to avoid storing ledger/block data.
 * Single document: { lastSequence }.
 */
const indexerStateSchema = new mongoose.Schema({
  lastSequence: { type: Number, default: 0 }
}, {
  collection: 'indexerstate',
  strict: true
});

// Ensure a single document
indexerStateSchema.index({ _id: 1 }, { unique: true });

module.exports = mongoose.model('IndexerState', indexerStateSchema);
