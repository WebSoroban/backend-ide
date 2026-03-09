const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const { authApiKey } = require('../middleware/authApiKey');

/**
 * GET /api/accounts/:address/transactions
 * List indexed transactions for an account (by from address). Requires API key.
 */
router.get('/:address/transactions', authApiKey, async (req, res) => {
  try {
    const { address } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const cursor = req.query.cursor;

    const filter = { from: address };
    if (cursor) {
      const doc = await Transaction.findOne({ hash: cursor }).select('timestamp').lean();
      if (doc && doc.timestamp) {
        filter.timestamp = { $lt: doc.timestamp };
      }
    }

    const txs = await Transaction.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .select('hash ledger from contract function timestamp status success')
      .lean();

    res.json({
      success: true,
      transactions: txs,
      nextCursor: txs.length === limit ? txs[txs.length - 1]?.hash : null
    });
  } catch (error) {
    console.error('[Accounts] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch account transactions',
      message: error.message
    });
  }
});

module.exports = router;
