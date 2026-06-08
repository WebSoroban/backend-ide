/**
 * Single source of truth for Redis connections (BullMQ queues + socket pub/sub).
 *
 * Connection precedence:
 *   1. REDIS_URL (or REDIS_PRIVATE_URL) — a full connection string. This is what
 *      managed hosts like Railway / Render / Upstash / Heroku provide. ioredis
 *      parses auth, host, port, db and enables TLS automatically for `rediss://`.
 *   2. Discrete REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_DB — for local
 *      dev and docker-compose (host defaults to 'redis' in production compose).
 *
 * IMPORTANT for managed hosts: a bare `REDIS_HOST` is NOT provided by Railway
 * (it exposes `REDIS_URL` / `REDISHOST`). Set `REDIS_URL` on the API **and**
 * both worker services so they all share the same Redis — otherwise the workers
 * connect to a different (or non-existent) instance and never pick up jobs.
 */
import Redis, { type RedisOptions } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || '';

// BullMQ requires these; harmless for pub/sub clients too.
const BASE_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

/** Create a configured ioredis client. Pass `extra` to merge/override options. */
export function createRedisClient(extra: RedisOptions = {}): Redis {
  if (REDIS_URL) {
    return new Redis(REDIS_URL, { ...BASE_OPTIONS, ...extra });
  }

  const host = process.env.REDIS_HOST || (process.env.NODE_ENV === 'production' ? 'redis' : 'localhost');
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  const db = parseInt(process.env.REDIS_DB || '0', 10);
  return new Redis({ host, port, password, db, ...BASE_OPTIONS, ...extra });
}

/** Human-readable description of where we're connecting (for logs; no secrets). */
export function redisTarget(): string {
  if (REDIS_URL) {
    try {
      const u = new URL(REDIS_URL);
      return `${u.protocol}//${u.hostname}:${u.port || '6379'} (from REDIS_URL)`;
    } catch {
      return 'REDIS_URL';
    }
  }
  const host = process.env.REDIS_HOST || (process.env.NODE_ENV === 'production' ? 'redis' : 'localhost');
  return `${host}:${process.env.REDIS_PORT || '6379'}`;
}

export default { createRedisClient, redisTarget };
