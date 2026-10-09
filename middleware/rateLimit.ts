/**
 * Redis-backed fixed-window rate limiter.
 *
 * Keyed per authenticated user (falls back to IP), shared across API instances
 * via Redis so it holds behind a load balancer. It is deliberately FAIL-OPEN: if
 * Redis is unavailable the request is allowed through — a metering outage must
 * never take deploys/invokes offline. Apply AFTER `authenticate` so `req.userId`
 * is populated.
 */
import type { Request, Response, NextFunction } from 'express';
import type { Redis } from 'ioredis';
import { createRedisClient } from '../lib/redis';

let client: Redis | null = null;
let creationFailed = false;

function getClient(): Redis | null {
  if (client) return client;
  if (creationFailed) return null;
  try {
    // Fail fast (don't queue) so a Redis outage falls through to fail-open
    // instead of hanging the request.
    client = createRedisClient({ maxRetriesPerRequest: 1, enableOfflineQueue: false });
    client.on('error', (e) => console.warn('[RateLimit] redis error:', e.message));
    return client;
  } catch (e: any) {
    creationFailed = true;
    console.warn('[RateLimit] could not create redis client (limiter disabled):', e.message);
    return null;
  }
}

export interface RateLimitOptions {
  /** window length in seconds */
  windowSec: number;
  /** max requests allowed per window */
  max: number;
  /** namespace so different routes don't share a counter */
  prefix: string;
  /** counter key; defaults to the authenticated user, then the client IP */
  keyFor?: (req: Request) => string | undefined;
}

export function rateLimit({ windowSec, max, prefix, keyFor }: RateLimitOptions) {
  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const redis = getClient();
    if (!redis) return next(); // fail-open

    const id = keyFor?.(req) || req.userId || req.ip || 'anon';
    const key = `rl:${prefix}:${id}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSec);

      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));

      if (count > max) {
        const ttl = await redis.ttl(key);
        const retry = ttl > 0 ? ttl : windowSec;
        res.setHeader('Retry-After', String(retry));
        return res.status(429).json({
          success: false,
          error: `Too many requests. Try again in ${retry}s.`,
          code: 'RATE_LIMITED',
        });
      }
      return next();
    } catch (e: any) {
      console.warn('[RateLimit] check failed (allowing request):', e.message);
      return next(); // fail-open
    }
  };
}

/** Close the shared Redis connection (for graceful shutdown and tests). */
export async function closeRateLimitClient() {
  const current = client;
  client = null;
  if (current) await current.quit().catch(() => current.disconnect());
}

export default rateLimit;
