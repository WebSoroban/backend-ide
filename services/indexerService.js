/**
 * Soroban blockchain indexer service.
 * Fetches ledger/transaction data from Soroban RPC and stores in MongoDB.
 * Block storage is disabled (temporarily); only IndexerState, Transaction, and ContractEvent are used.
 */

const IndexerState = require('../models/IndexerState');
const Transaction = require('../models/Transaction');
const ContractEvent = require('../models/ContractEvent');
const { addWebhookDeliveryJobs } = require('../queues/webhookQueue');

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

let _rpcId = 0;
function rpcRequest(method, params = {}) {
  const id = ++_rpcId;
  return fetch(SOROBAN_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params
    })
  }).then((res) => res.json()).then((data) => {
    if (data.error) {
      throw new Error(data.error.message || 'RPC error');
    }
    return data.result;
  });
}

/**
 * Get latest ledger sequence from RPC
 */
async function getLatestLedger() {
  const result = await rpcRequest('getLatestLedger');
  return result?.sequence ?? result;
}

/**
 * Fetch and index a single ledger by sequence.
 * Stores Transactions and ContractEvents only (Block storage disabled). Enqueues webhook deliveries for matching events.
 */
async function indexLedger(sequence) {
  const last = await getLastIndexedSequence();
  if (last >= sequence) {
    return { indexed: false, sequence, reason: 'already_indexed' };
  }

  let ledgerResult;
  try {
    ledgerResult = await rpcRequest('getLedgers', { startLedger: sequence, limit: 1 });
  } catch (err) {
    console.error('[IndexerService] getLedgers error:', err.message);
    return { indexed: false, sequence, error: err.message };
  }

  const ledger = Array.isArray(ledgerResult?.ledgers) ? ledgerResult.ledgers[0] : ledgerResult;
  if (!ledger) {
    return { indexed: false, sequence, reason: 'no_ledger' };
  }

  const ledgerSeq = ledger.sequence ?? ledger.id ?? sequence;
  const closedAt = ledger.closedAt ? new Date(ledger.closedAt) : new Date();

  // Block storage disabled - do not save Block documents

  let txHashes = [];
  try {
    const txResult = await rpcRequest('getTransactions', {
      startLedger: ledgerSeq,
      pagination: { limit: 200 }
    });
    txHashes = txResult?.transactions ?? txResult ?? [];
  } catch (err) {
    console.error('[IndexerService] getTransactions error:', err.message);
  }

  const txIds = Array.isArray(txHashes) ? txHashes : [];
  for (const txId of txIds) {
    const hash = typeof txId === 'string' ? txId : txId?.hash ?? txId?.id;
    if (!hash) continue;
    try {
      const txDetail = await rpcRequest('getTransaction', { hash });
      if (!txDetail) continue;

      const from = txDetail.sourceAccount ?? txDetail.source ?? null;
      const contract = txDetail.contract ?? txDetail.contractId ?? null;
      const fn = txDetail.function ?? txDetail.functionName ?? null;
      const status = txDetail.status ?? (txDetail.successful ? 'success' : 'failed');
      const success = txDetail.successful ?? (status === 'success');

      await Transaction.findOneAndUpdate(
        { hash },
        {
          hash,
          ledger: ledgerSeq,
          from: from ? String(from).slice(0, 56) : null,
          contract: contract ? String(contract).slice(0, 56) : null,
          function: fn ? String(fn).slice(0, 64) : null,
          timestamp: closedAt,
          status,
          success,
          raw: txDetail
        },
        { upsert: true }
      );

      const events = txDetail.events ?? txDetail.result?.events ?? [];
      for (const ev of events) {
        const eventType = ev.type ?? ev.name ?? 'contract_event';
        const eventData = ev.data ?? ev.value ?? ev;
        const doc = {
          contract: contract ? String(contract).slice(0, 56) : (ev.contract ?? 'unknown'),
          eventType,
          data: typeof eventData === 'object' ? eventData : { value: eventData },
          txHash: hash,
          ledger: ledgerSeq,
          timestamp: closedAt,
          raw: ev
        };
        const created = await ContractEvent.create(doc);
        await addWebhookDeliveryJobs(created);
      }
    } catch (err) {
      console.error('[IndexerService] getTransaction error for', hash, err.message);
    }
  }

  // Update indexer progress (Block storage disabled)
  await IndexerState.findOneAndUpdate(
    {},
    { $set: { lastSequence: ledgerSeq } },
    { upsert: true }
  );
  console.log(`[IndexerService] Indexed ledger ${ledgerSeq}, ${txIds.length} transactions`);
  return { indexed: true, sequence: ledgerSeq, txCount: txIds.length };
}

/**
 * Get the last indexed ledger sequence from DB (from IndexerState; Block collection not used).
 */
async function getLastIndexedSequence() {
  const doc = await IndexerState.findOne().select('lastSequence').lean();
  return doc?.lastSequence ?? 0;
}

/**
 * Run one indexer cycle: fetch latest from RPC, index any new ledgers.
 * When no ledgers are indexed yet, start from the RPC's latest ledger (not 1),
 * since the RPC only retains a window of history (e.g. oldest 1250330, latest 1371289).
 */
async function runCycle() {
  try {
    const latest = await getLatestLedger();
    const last = await getLastIndexedSequence();
    const start = last === 0 ? latest : last + 1;
    let indexed = 0;
    for (let seq = start; seq <= latest; seq++) {
      const result = await indexLedger(seq);
      if (result.indexed) indexed++;
    }
    return { latest, last, indexed };
  } catch (error) {
    console.error('[IndexerService] Cycle error:', error);
    throw error;
  }
}

module.exports = {
  getLatestLedger,
  getLastIndexedSequence,
  indexLedger,
  runCycle
};
