import assert from 'node:assert/strict'
import test from 'node:test'
import { Account, Contract, Keypair, Networks, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk'
import { classifyFacilitatorReason, explainX402Error, normalizeX402Error } from '../services/x402Errors'
import { createRateLimiter, FACILITATOR_PROXY_LIMIT } from '../services/x402RateLimit'
import { applySpend, usdcToStroops, stroopsToUsdc } from '../services/x402SpendLimit'
import { decodeStellarTransfer, extractPayer } from '../services/x402Payload'
import { evaluateBalances, trustlineAccount } from '../services/x402Trustline'
import { networkFromApiKey, parseX402Network, toNetworkId, USDC_ISSUERS } from '../services/x402Network'
import { AUTH_ENTRY_WALLETS, walletCompatibility } from '../services/x402Wallets'
import {
  isWebhookUrl,
  nextRetryDelay,
  RETRY_DELAYS_MS,
  signWebhook,
  verifyWebhookSignature,
  webhookEventName,
} from '../services/x402Webhooks'
import { successRate } from '../services/x402PayService'

const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

function stellarPayment(from: string, to: string, amount: bigint, network = 'stellar:testnet') {
  const source = Keypair.random().publicKey()
  const transaction = new TransactionBuilder(new Account(source, '1'), {
    fee: '100',
    networkPassphrase: network === 'stellar:pubnet' ? Networks.PUBLIC : Networks.TESTNET,
  })
    .addOperation(new Contract(USDC_TESTNET).call(
      'transfer',
      nativeToScVal(from, { type: 'address' }),
      nativeToScVal(to, { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    ))
    .setTimeout(60)
    .build()
  return { x402Version: 2, accepted: { scheme: 'exact', network }, payload: { transaction: transaction.toXDR() } }
}

test('splits wallet failures into unsupported wallets and bad signatures', () => {
  assert.equal(normalizeX402Error(new Error('facilitator timed out')).code, 'FACILITATOR_TIMEOUT')
  assert.equal(normalizeX402Error(new Error('invalid signature')).code, 'INVALID_SIGNATURE')
  assert.equal(normalizeX402Error(new Error('Freighter Mobile does not support auth entries')).code, 'UNSUPPORTED_WALLET')
  const allowance = explainX402Error('INSUFFICIENT_BALANCE_OR_ALLOWANCE')
  assert.match(allowance?.fix || '', /trustline/)
})

test('maps facilitator reasons onto readable catalog codes', () => {
  assert.equal(classifyFacilitatorReason('insufficient_funds'), 'INSUFFICIENT_BALANCE_OR_ALLOWANCE')
  assert.equal(classifyFacilitatorReason('invalid_exact_stellar_payload_simulation_failed', 'trustline entry is missing'), 'TRUSTLINE_MISSING')
  assert.equal(classifyFacilitatorReason('network_mismatch'), 'NETWORK_MISMATCH')
  // Observed live on OpenZeppelin Channels (production probe, 2026-10-25).
  assert.equal(classifyFacilitatorReason('invalid_exact_stellar_payload_fee_below_minimum'), 'FEE_BELOW_MINIMUM')
  assert.equal(classifyFacilitatorReason('invalid_exact_stellar_payload_wrong_amount'), 'invalid_exact_stellar_payload_wrong_amount')
  assert.equal(classifyFacilitatorReason(null, null), null)
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

test('reads payer, recipient, and amount from a signed Stellar transfer', () => {
  const payer = Keypair.random().publicKey()
  const payee = Keypair.random().publicKey()
  const payload = stellarPayment(payer, payee, 100_000n)

  const transfer = decodeStellarTransfer(payload)
  assert.deepEqual(transfer, { network: 'stellar:testnet', asset: USDC_TESTNET, from: payer, to: payee, amount: 100_000n })
  // Facilitator request bodies wrap the payload; the network can come from the requirements.
  assert.equal(decodeStellarTransfer({ paymentPayload: payload, paymentRequirements: { network: 'stellar:testnet' } })?.from, payer)
  assert.equal(extractPayer({ paymentPayload: payload }), payer)
  assert.equal(decodeStellarTransfer({ ...payload, accepted: { network: 'ethereum:1' } }), null)
  assert.equal(decodeStellarTransfer({ payload: { transaction: 'not-xdr' }, accepted: { network: 'stellar:testnet' } }), null)
  assert.equal(extractPayer({ payer: 'not-an-address' }), null)
  assert.equal(extractPayer({ payer }), payer)
})

test('schedules webhook retries and gives up after the last delay', () => {
  assert.equal(nextRetryDelay(1), RETRY_DELAYS_MS[0])
  assert.equal(nextRetryDelay(RETRY_DELAYS_MS.length), RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])
  assert.equal(nextRetryDelay(RETRY_DELAYS_MS.length + 1), null)
})

test('signs webhook payloads and names settlement events', () => {
  const body = JSON.stringify({ type: 'payment.settled' })
  const header = signWebhook('secret', 1_700_000_000, body)
  assert.equal(verifyWebhookSignature('secret', header, body, 1_700_000_000 * 1000), true)
  assert.equal(verifyWebhookSignature('other', header, body, 1_700_000_000 * 1000), false)
  assert.equal(verifyWebhookSignature('secret', header, body, (1_700_000_000 + 301) * 1000), false)
  assert.equal(verifyWebhookSignature('secret', header, `${body} `, 1_700_000_000 * 1000), false)
  assert.equal(webhookEventName({ status: 'settled', type: 'settlement', errorCode: null }), 'payment.settled')
  assert.equal(webhookEventName({ status: 'failed', type: 'settlement', errorCode: 'SPEND_LIMIT_EXCEEDED' }), 'wallet.spend_limit_exceeded')
  assert.equal(webhookEventName({ status: 'payment_required', type: 'request', errorCode: null }), null)
})

test('only accepts public https webhook targets', () => {
  assert.equal(isWebhookUrl('https://hooks.example.com/pay', true), true)
  assert.equal(isWebhookUrl('http://hooks.example.com/pay', true), false)
  assert.equal(isWebhookUrl('http://localhost:4000/hook', false), true)
  assert.equal(isWebhookUrl('http://localhost:4000/hook', true), false)
  for (const target of [
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/hook',
    'https://192.168.1.10/hook',
    'https://172.16.0.1/hook',
    'https://[::1]/hook',
    'https://[fd00::1]/hook',
    'https://user:pass@hooks.example.com/hook',
    'https://metadata.google.internal/hook',
    'not a url',
  ]) {
    assert.equal(isWebhookUrl(target, true), false, target)
  }
})

test('evaluates USDC trustlines against the network issuer', () => {
  const address = Keypair.random().publicKey()
  const usdc = { asset_code: 'USDC', asset_issuer: USDC_ISSUERS['stellar:testnet'], balance: '5.0000000', is_authorized: true }
  assert.equal(evaluateBalances(address, 'stellar:testnet', [usdc]).status, 'ready')
  assert.equal(evaluateBalances(address, 'stellar:pubnet', [usdc]).status, 'missing_trustline')
  assert.equal(evaluateBalances(address, 'stellar:testnet', [{ ...usdc, is_authorized: false }]).status, 'not_authorized')
  assert.equal(evaluateBalances(address, 'stellar:testnet', [{ asset_type: 'native', balance: '10' }]).ready, false)
  assert.equal(trustlineAccount(address), address)
  assert.equal(trustlineAccount(USDC_TESTNET), null)
})

test('resolves networks and key prefixes without guessing', () => {
  assert.equal(parseX402Network(undefined), 'stellar:testnet')
  assert.equal(parseX402Network('mainnet'), 'stellar:pubnet')
  assert.equal(parseX402Network('stellar:pubnet'), 'stellar:pubnet')
  assert.equal(parseX402Network('ethereum'), null)
  assert.equal(toNetworkId('stellar:pubnet'), 'mainnet')
  assert.equal(networkFromApiKey('wsp_test_abc'), 'stellar:testnet')
  assert.equal(networkFromApiKey('wsp_live_abc'), 'stellar:pubnet')
  assert.equal(networkFromApiKey('sk_live_abc'), null)
})

test('reports settlement success only over facilitator attempts', () => {
  assert.equal(successRate(0, 0), null)
  assert.equal(successRate(95, 5), 0.95)
  assert.equal(successRate(2, 1), 0.6667)
})

test('lists checkout-capable wallets honestly', () => {
  const checkout = AUTH_ENTRY_WALLETS.filter((wallet) => wallet.checkout).map((wallet) => wallet.id)
  assert.deepEqual(checkout, ['freighter', 'hana', 'hot-wallet', 'klever'])
  assert.equal(AUTH_ENTRY_WALLETS.filter((wallet) => wallet.authEntry).length, 6)
  assert.equal(walletCompatibility('FREIGHTER-MOBILE')?.authEntry, false)
  assert.equal(walletCompatibility('unknown'), null)
})

test('treats team accounts as internal for adoption metrics', async () => {
  const { isInternalEmail, maskEmail } = await import('../services/x402Adoption')
  const previous = { admins: process.env.ADMIN_EMAILS, domains: process.env.X402_INTERNAL_DOMAINS }
  process.env.ADMIN_EMAILS = 'Founder@Example.com'
  process.env.X402_INTERNAL_DOMAINS = 'websoroban.in'
  try {
    assert.equal(isInternalEmail('founder@example.com'), true)
    assert.equal(isInternalEmail('dev@websoroban.in'), true)
    assert.equal(isInternalEmail('dev@team.websoroban.in'), true)
    assert.equal(isInternalEmail('dev@notwebsoroban.in'), false)
    assert.equal(isInternalEmail('builder@gmail.com'), false)
    assert.equal(maskEmail('builder@gmail.com'), 'b***@gmail.com')
  } finally {
    for (const [name, value] of [['ADMIN_EMAILS', previous.admins], ['X402_INTERNAL_DOMAINS', previous.domains]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
