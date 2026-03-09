require('dotenv').config();
const mongoose = require('mongoose');
const indexerService = require('../services/indexerService');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/soroban-ide';
const INDEXER_INTERVAL_MS = parseInt(process.env.INDEXER_INTERVAL_MS || '15000', 10);

mongoose.connect(MONGODB_URI).then(() => {
  console.log('[IndexerWorker] Connected to MongoDB');
}).catch((err) => {
  console.error('[IndexerWorker] MongoDB connection error:', err);
  process.exit(1);
});

let intervalId;

async function tick() {
  try {
    const result = await indexerService.runCycle();
    if (result.indexed > 0) {
      console.log(`[IndexerWorker] Cycle complete: indexed ${result.indexed} ledger(s), latest ${result.latest}`);
    }
  } catch (error) {
    console.error('[IndexerWorker] Cycle error:', error.message);
  }
}

async function start() {
  console.log('[IndexerWorker] Starting indexer, interval:', INDEXER_INTERVAL_MS, 'ms');
  await tick();
  intervalId = setInterval(tick, INDEXER_INTERVAL_MS);
}

start();

process.on('SIGTERM', async () => {
  console.log('[IndexerWorker] SIGTERM received, shutting down...');
  if (intervalId) clearInterval(intervalId);
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[IndexerWorker] SIGINT received, shutting down...');
  if (intervalId) clearInterval(intervalId);
  await mongoose.connection.close();
  process.exit(0);
});
