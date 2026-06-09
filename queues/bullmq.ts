import { Queue, Worker, QueueEvents, type Processor, type WorkerOptions } from 'bullmq';
import { createRedisClient, redisTarget } from '../lib/redis';

// Shared Redis connection (supports REDIS_URL for managed hosts like Railway,
// with a discrete REDIS_HOST/PORT fallback for local + docker-compose).
const connection = createRedisClient({
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    console.log(`[Redis] Retrying connection (attempt ${times})...`);
    return delay;
  },
  reconnectOnError: (err: Error) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  }
});

// Handle Redis connection events
connection.on('connect', () => {
  console.log(`[Redis] Connected to ${redisTarget()}`);
});

connection.on('error', (err: Error) => {
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
const TEST_QUEUE_NAME = 'test';

/**
 * Create a queue instance
 */
function createQueue(queueName: string): Queue {
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
 */
function createWorker(
  queueName: string,
  processor: Processor,
  options: Partial<WorkerOptions> & { concurrency?: number } = {}
): Worker {
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
 */
function createQueueEvents(queueName: string): QueueEvents {
  return new QueueEvents(queueName, { connection });
}

export {
  connection,
  createQueue,
  createWorker,
  createQueueEvents,
  COMPILE_QUEUE_NAME,
  DEPLOY_QUEUE_NAME,
  TEST_QUEUE_NAME
};

export default {
  connection,
  createQueue,
  createWorker,
  createQueueEvents,
  COMPILE_QUEUE_NAME,
  DEPLOY_QUEUE_NAME,
  TEST_QUEUE_NAME
};
