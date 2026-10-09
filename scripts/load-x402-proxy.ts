/**
 * In-process load check for the managed facilitator proxy rate limit.
 * Does not call OpenZeppelin. Run with: npx tsx scripts/load-x402-proxy.ts
 */
import { createRateLimiter, FACILITATOR_PROXY_LIMIT, FACILITATOR_PROXY_WINDOW_MS } from '../services/x402RateLimit'

const endpoints = 50
const callsEach = FACILITATOR_PROXY_LIMIT + 20
const limiter = createRateLimiter()
const started = performance.now()
let allowed = 0
let rejected = 0

for (let endpoint = 0; endpoint < endpoints; endpoint += 1) {
  for (let call = 0; call < callsEach; call += 1) {
    if (limiter.allow(`endpoint-${endpoint}`)) allowed += 1
    else rejected += 1
  }
}

const elapsedMs = performance.now() - started
const expectedAllowed = endpoints * FACILITATOR_PROXY_LIMIT
const expectedRejected = endpoints * (callsEach - FACILITATOR_PROXY_LIMIT)

if (allowed !== expectedAllowed || rejected !== expectedRejected) {
  console.error(`Rate limit mismatch. allowed=${allowed} rejected=${rejected}`)
  process.exit(1)
}

console.log(JSON.stringify({
  limitPerMinute: FACILITATOR_PROXY_LIMIT,
  windowMs: FACILITATOR_PROXY_WINDOW_MS,
  endpoints,
  calls: endpoints * callsEach,
  allowed,
  rejected,
  elapsedMs: Number(elapsedMs.toFixed(2)),
}, null, 2))
