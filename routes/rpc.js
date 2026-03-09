const express = require('express');
const router = express.Router();
const rpcService = require('../services/rpcService');
const { authApiKey } = require('../middleware/authApiKey');

const RPC_LOG_REQUESTS = process.env.RPC_LOG_REQUESTS === 'true';

/**
 * POST /api/rpc
 * JSON-RPC proxy to Soroban RPC. Requires API key.
 * Body: { "method": "getAccount", "params": ["GABC..."], "id": 1, "jsonrpc": "2.0" }
 * Or batch: [ { method, params, id, jsonrpc }, ... ]
 */
router.post('/', authApiKey, async (req, res) => {
  try {
    const body = req.body;

    if (Array.isArray(body)) {
      const results = await rpcService.forwardBatch(body, { logRequest: RPC_LOG_REQUESTS });
      return res.json(results);
    }

    if (!body || typeof body !== 'object') {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request' },
        id: body?.id ?? null
      });
    }

    const result = await rpcService.forwardRequest(body, { logRequest: RPC_LOG_REQUESTS });
    res.json(result);
  } catch (error) {
    console.error('[RPC] Error:', error.message);
    res.status(502).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: error.message || 'Internal error'
      },
      id: req.body?.id ?? null
    });
  }
});

module.exports = router;
