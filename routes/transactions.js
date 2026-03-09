const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const { authApiKey } = require('../middleware/authApiKey');

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

async function fetchTransactionFromRpc(hash) {
  const res = await fetch(SOROBAN_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: { hash }
    })
  });
  const data = await res.json();
  if (data.error || !data.result) return null;
  const r = data.result;
  const ledger = r.ledger ?? r.ledgerSeq ?? r.lastModified ?? 0;
  const status = r.status ?? (r.successful ? 'success' : 'failed');
  return {
    hash,
    ledger: Number(ledger),
    from: r.sourceAccount ?? r.source ?? null,
    contract: r.contract ?? r.contractId ?? null,
    function: r.function ?? r.functionName ?? null,
    timestamp: r.createdAt ? new Date(r.createdAt) : null,
    status,
    success: r.successful ?? (status === 'success'),
    raw: r,
    fromRpc: true
  };
}

/**
 * GET /api/transactions/:hash
 * Get a transaction by hash. Checks index first, then falls back to live RPC. Requires API key.
 */
router.get('/:hash', authApiKey, async (req, res) => {
  try {
    const { hash } = req.params;
    let tx = await Transaction.findOne({ hash }).lean();
    if (!tx) {
      const rpcTx = await fetchTransactionFromRpc(hash);
      if (rpcTx) {
        tx = rpcTx;
        try {
          await Transaction.findOneAndUpdate(
            { hash },
            {
              hash: tx.hash,
              ledger: tx.ledger,
              from: tx.from,
              contract: tx.contract,
              function: tx.function,
              timestamp: tx.timestamp,
              status: tx.status,
              success: tx.success,
              raw: tx.raw
            },
            { upsert: true }
          );
        } catch (e) {
          console.warn('[Transactions] Failed to cache RPC tx:', e.message);
        }
      } else {
        return res.status(404).json({
          success: false,
          error: 'Transaction not found',
          message: 'Transaction not in index and not found on RPC (check hash and network).'
        });
      }
    }
    const out = tx && typeof tx.toObject === 'function' ? tx.toObject() : { ...tx };
    delete out.fromRpc;
    res.json({ success: true, transaction: out });
  } catch (error) {
    console.error('[Transactions] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transaction',
      message: error.message
    });
  }
});

module.exports = router;
