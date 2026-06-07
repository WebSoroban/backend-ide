const { Queue, Worker, QueueEvents } = require('bullmq');
const Redis = require('ioredis');

// Redis connection configuration
// Default to 'localhost' for local development, 'redis' for Docker
const redisHost = process.env.REDIS_HOST || (process.env.NODE_ENV === 'production' ? 'redis' : 'localhost');
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
const redisPassword = process.env.REDIS_PASSWORD || undefined;
const redisDb = parseInt(process.env.REDIS_DB || '0', 10);

// Create Redis connection with retry logic
const connection = new Redis({
  host: redisHost,
  port: redisPort,
  password: redisPassword,
  db: redisDb,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    console.log(`[Redis] Retrying connection (attempt ${times})...`);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  }
});

// Handle Redis connection events
connection.on('connect', () => {
  console.log(`[Redis] Connected to ${redisHost}:${redisPort}`);
});

connection.on('error', (err) => {
  console.error(`[Redis] Connection error: ${err.message}`);
});

connection.on('close', () => {
  console.log('[Redis] Connection closed');
});

connection.on('reconnecting', () => {
  console.log('[Redis] Reconnecting...');
});

// Queue names
const COMPILE_QUEUE_NAME = 'compile';
const DEPLOY_QUEUE_NAME = 'deploy';

/**
 * Create a queue instance
 * @param {string} queueName - Name of the queue
 * @returns {Queue} BullMQ queue instance
 */
function createQueue(queueName) {
  return new Queue(queueName, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      },
      removeOnComplete: {
        age: 24 * 3600, // Keep completed jobs for 24 hours
        count: 1000 // Keep max 1000 completed jobs
      },
      removeOnFail: {
        age: 7 * 24 * 3600 // Keep failed jobs for 7 days
      }
    }
  });
}

/**
 * Create a worker instance
 * @param {string} queueName - Name of the queue
 * @param {Function} processor - Job processor function
 * @param {Object} options - Worker options
 * @returns {Worker} BullMQ worker instance
 */
function createWorker(queueName, processor, options = {}) {
  const concurrency = options.concurrency || 1;
  
  return new Worker(queueName, processor, {
    connection,
    concurrency,
    limiter: options.limiter,
    ...options
  });
}

/**
 * Create queue events instance for monitoring
 * @param {string} queueName - Name of the queue
 * @returns {QueueEvents} BullMQ queue events instance
 */
function createQueueEvents(queueName) {
  return new QueueEvents(queueName, { connection });
}

module.exports = {
  connection,
  createQueue,
  createWorker,
  createQueueEvents,
  COMPILE_QUEUE_NAME,
  DEPLOY_QUEUE_NAME
};

