const express = require('express');
const router = express.Router();
const ContractEvent = require('../models/ContractEvent');
const deploymentService = require('../services/deploymentService');
const { authApiKey } = require('../middleware/authApiKey');
const { authenticate } = require('../middleware/auth');

/**
 * POST /api/contracts/:contractAddress/invoke
 * Invoke a contract function (IDE). Requires JWT.
 */
router.post('/:contractAddress/invoke', authenticate, async (req, res) => {
  try {
    const contractAddress = req.params.contractAddress;
    const { functionName, args = [], network = 'testnet' } = req.body;
    if (!functionName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: functionName'
      });
    }
    const invokeResult = await deploymentService.invokeContract(
      contractAddress,
      functionName,
      args,
      null,
      network
    );
    res.json({
      success: invokeResult.success,
      output: invokeResult.output,
      contractId: invokeResult.contractId,
      functionName: invokeResult.functionName,
      args: invokeResult.args,
      logs: invokeResult.logs
    });
  } catch (error) {
    console.error('[Contracts] Invoke error:', error);
    res.status(500).json({
      success: false,
      error: 'Contract invocation failed',
      message: error.message
    });
  }
});

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

function normalizeContractId(addr) {
  if (!addr || typeof addr !== 'string') return addr;
  const s = addr.trim();
  return s.startsWith('C') ? s : `C${s}`;
}

async function fetchEventsFromRpc(contractAddress, limit = 20) {
  try {
    const contractId = normalizeContractId(contractAddress);
    const resLedger = await fetch(SOROBAN_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestLedger',
        params: {}
      })
    });
    const dataLedger = await resLedger.json();
    const latest = dataLedger.result?.sequence ?? dataLedger.result ?? 0;
    const startLedger = Math.max(0, Number(latest) - 10000);

    const res = await fetch(SOROBAN_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'getEvents',
        params: {
          startLedger: String(startLedger),
          filters: [{ contractIds: [contractId], type: 'contract' }],
          pagination: { limit: Math.min(limit, 100) }
        }
      })
    });
    const data = await res.json();
    if (data.error || !data.result) return [];
    const raw = data.result.events ?? data.result ?? [];
    const list = Array.isArray(raw) ? raw : [];
    return list.map((ev) => ({
      contract: ev.contractId ?? contractId,
      eventType: ev.type ?? ev.name ?? 'contract_event',
      data: ev.value ?? ev.data ?? {},
      txHash: ev.txHash ?? ev.transactionHash ?? ev.tx ?? ev.id ?? '',
      ledger: typeof ev.ledger === 'string' ? parseInt(ev.ledger, 10) : (ev.ledger ?? 0),
      timestamp: ev.ledgerClosedAt ? new Date(ev.ledgerClosedAt) : null,
      fromRpc: true
    }));
  } catch (err) {
    console.error('[Contracts] fetchEventsFromRpc error:', err.message);
    return [];
  }
}

/**
 * GET /api/contracts/:address/events
 * List events for a contract. Uses index first, then falls back to RPC getEvents. Requires API key.
 */
router.get('/:address/events', authApiKey, async (req, res) => {
  try {
    const { address } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const cursor = req.query.cursor;
    const eventType = req.query.eventType;

    const contractNorm = normalizeContractId(address);
    const filter = { $or: [{ contract: address }, { contract: contractNorm }, { contract: address.startsWith('C') ? address.slice(1) : `C${address}` }] };
    if (eventType) filter.eventType = eventType;
    if (cursor) {
      const doc = await ContractEvent.findOne({ _id: cursor }).select('timestamp').lean();
      if (doc && doc.timestamp) {
        filter.timestamp = { $lt: doc.timestamp };
      }
    }

    let events = await ContractEvent.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .select('contract eventType data txHash ledger timestamp')
      .lean();

    if (events.length === 0) {
      const rpcEvents = await fetchEventsFromRpc(address, limit);
      events = rpcEvents.map((e) => {
        const { fromRpc, ...rest } = e;
        return rest;
      });
    }

    res.json({
      success: true,
      events,
      nextCursor: events.length === limit ? events[events.length - 1]?._id?.toString() : null
    });
  } catch (error) {
    console.error('[Contracts] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contract events',
      message: error.message
    });
  }
});

module.exports = router;
