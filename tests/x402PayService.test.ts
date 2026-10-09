import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEndpointApiKey,
  fingerprintPayment,
  hashEndpointApiKey,
  normalizeEndpointSlug,
  normalizeUsdPrice,
  normalizeX402Error,
  slugFromResourcePath,
  validatePayoutAddress,
} from '../services/x402PayService';

test('normalizes endpoint slugs without allowing path characters', () => {
  assert.equal(normalizeEndpointSlug('  Market Brief / Daily  '), 'market-brief-daily');
  assert.equal(normalizeEndpointSlug('--Already---Clean--'), 'already-clean');
});

test('normalizes positive USDC prices with Stellar precision', () => {
  assert.equal(normalizeUsdPrice('0.01'), '$0.01');
  assert.equal(normalizeUsdPrice('$1.1234567'), '$1.1234567');
  assert.throws(() => normalizeUsdPrice('0'), /greater than 0/);
  assert.throws(() => normalizeUsdPrice('0.12345678'), /up to 7 decimal/);
});

test('creates network-scoped keys while storing only deterministic hashes', () => {
  const key = createEndpointApiKey();
  assert.match(key.raw, /^wsp_test_/);
  assert.equal(key.hash, hashEndpointApiKey(key.raw));
  assert.notEqual(key.hash, key.raw);
  assert.match(key.prefix, /^wsp_test_/);
  assert.match(createEndpointApiKey('stellar:pubnet').raw, /^wsp_live_/);
});

test('extracts encoded endpoint slugs from resource paths', () => {
  assert.equal(slugFromResourcePath('/api/pay/resource/market-brief'), 'market-brief');
  assert.equal(slugFromResourcePath('/resource/market%2Dbrief?day=today'), 'market-brief');
  assert.equal(slugFromResourcePath('/other/path'), null);
});

test('fingerprints payment material without retaining it', () => {
  const first = fingerprintPayment({ payload: 'secret' });
  assert.equal(first, fingerprintPayment({ payload: 'secret' }));
  assert.notEqual(first, fingerprintPayment({ payload: 'other' }));
  assert.equal(first.length, 64);
});

test('maps facilitator failures to stable product errors', () => {
  assert.equal(normalizeX402Error(new Error('request timed out')).code, 'FACILITATOR_TIMEOUT');
  assert.equal(normalizeX402Error(new Error('insufficient balance')).code, 'INSUFFICIENT_BALANCE_OR_ALLOWANCE');
  assert.equal(normalizeX402Error(new Error('invalid signature')).code, 'INVALID_SIGNATURE');
  assert.equal(normalizeX402Error(new Error('unsupported wallet')).code, 'UNSUPPORTED_WALLET');
  assert.match(normalizeX402Error(new Error('insufficient balance')).fix, /USDC trustline/);
});

test('rejects invalid Stellar payout addresses', () => {
  assert.throws(() => validatePayoutAddress('not-a-stellar-address'), /valid Stellar address/);
});
