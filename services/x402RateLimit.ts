/** Managed facilitator proxy budget. One bucket per endpoint, reset every minute. */
export const FACILITATOR_PROXY_LIMIT = 120
export const FACILITATOR_PROXY_WINDOW_MS = 60_000

type Bucket = { count: number; resetAt: number }

export function createRateLimiter(
  limit = FACILITATOR_PROXY_LIMIT,
  windowMs = FACILITATOR_PROXY_WINDOW_MS,
  now: () => number = Date.now,
) {
  const buckets = new Map<string, Bucket>()

  return {
    limit,
    windowMs,
    allow(key: string) {
      const currentTime = now()
      const current = buckets.get(key)
      if (!current || current.resetAt <= currentTime) {
        buckets.set(key, { count: 1, resetAt: currentTime + windowMs })
        return true
      }
      current.count += 1
      return current.count <= limit
    },
    reset() {
      buckets.clear()
    },
  }
}

export const facilitatorProxyLimiter = createRateLimiter()
