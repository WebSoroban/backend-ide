import assert from 'node:assert/strict'
import test from 'node:test'
import { explainX402Error, normalizeX402Error } from '../services/x402Errors'
import { createRateLimiter, FACILITATOR_PROXY_LIMIT } from '../services/x402RateLimit'
import { applySpend, extractPayer, usdcToStroops, stroopsToUsdc } from '../services/x402SpendLimit'
import { signWebhook, verifyWebhookSignature, webhookEventName } from '../services/x402Webhooks'

test('splits wallet failures into unsupported wallets and bad signatures', () => {
  assert.equal(normalizeX402Error(new Error('facilitator timed out')).code, 'FACILITATOR_TIMEOUT')
  assert.equal(normalizeX402Error(new Error('invalid signature')).code, 'INVALID_SIGNATURE')
  assert.equal(normalizeX402Error(new Error('Freighter Mobile does not support auth entries')).code, 'UNSUPPORTED_WALLET')
  const allowance = explainX402Error('INSUFFICIENT_BALANCE_OR_ALLOWANCE')
  assert.match(allowance?.fix || '', /trustline/)
})

test('enforces 120 facilitator calls per endpoint per minute', () => {
  let now = 1_000
  const limiter = createRateLimiter(FACILITATOR_PROXY_LIMIT, 60_000, () => now)
  for (let call = 0; call < FACILITATOR_PROXY_LIMIT; call += 1) {
    assert.equal(limiter.allow('endpoint-a'), true)
  }
  assert.equal(limiter.allow('endpoint-a'), false)
  assert.equal(limiter.allow('endpoint-b'), true)
  now += 60_000
  assert.equal(limiter.allow('endpoint-a'), true)
})

test('blocks an agent payment that would exceed the daily USDC cap', () => {
  const limit = usdcToStroops('1')
  const first = applySpend({
    spentStroops: 0n,
    limitStroops: limit,
    windowStartedAt: 0,
    periodMs: 86_400_000,
  }, usdcToStroops('0.40'), 1_000)
  assert.equal(first.ok, true)
  const second = applySpend({
    spentStroops: first.spentStroops,
    limitStroops: limit,
    windowStartedAt: first.windowStartedAt,
    periodMs: 86_400_000,
  }, usdcToStroops('0.70'), 2_000)
  assert.equal(second.ok, false)
  assert.equal(stroopsToUsdc(first.spentStroops), '0.4')
  const reset = applySpend({
    spentStroops: first.spentStroops,
    limitStroops: limit,
    windowStartedAt: 0,
    periodMs: 1_000,
  }, usdcToStroops('0.70'), 2_000)
  assert.equal(reset.ok, true)
})

test('signs webhook payloads and names settlement events', () => {
  const body = JSON.stringify({ type: 'payment.settled' })
  const header = signWebhook('secret', 1_700_000_000, body)
  assert.equal(verifyWebhookSignature('secret', header, body, 1_700_000_000 * 1000), true)
  assert.equal(verifyWebhookSignature('other', header, body, 1_700_000_000 * 1000), false)
  assert.equal(webhookEventName({ status: 'settled', type: 'settlement', errorCode: null }), 'payment.settled')
  assert.equal(webhookEventName({ status: 'failed', type: 'settlement', errorCode: 'SPEND_LIMIT_EXCEEDED' }), 'wallet.spend_limit_exceeded')
  assert.equal(extractPayer({ payer: 'not-an-address' }), null)
  assert.equal(extractPayer({ payer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' }), 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')
})
