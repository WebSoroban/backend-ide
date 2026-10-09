import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTH_ENTRY_WALLETS,
  USDC_ISSUERS,
  checkUsdcTrustline,
  checkWalletCompatibility,
  constructWebhookEvent,
  createWebSorobanPay,
  verifyWebhook,
} from './index';
import { AUTH_ENTRY_WALLETS as SERVER_WALLETS } from '../../services/x402Wallets';
import { USDC_ISSUERS as SERVER_ISSUERS } from '../../services/x402Network';
import { signWebhook } from '../../services/x402Webhooks';

const PAY_TO = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const base = { apiUrl: 'https://api.example.com/api', endpointId: 'ep_1', payTo: PAY_TO };

test('stays in sync with the WebSoroban server', () => {
  assert.deepEqual(AUTH_ENTRY_WALLETS, SERVER_WALLETS);
  assert.deepEqual(USDC_ISSUERS, SERVER_ISSUERS);
});

test('infers the network from the key prefix and refuses a mismatch', () => {
  assert.equal(createWebSorobanPay({ ...base, apiKey: 'wsp_test_x' }).network, 'stellar:testnet');
  assert.equal(createWebSorobanPay({ ...base, apiKey: 'wsp_live_x' }).network, 'stellar:pubnet');
  assert.throws(() => createWebSorobanPay({ ...base, apiKey: 'wsp_test_x', network: 'stellar:pubnet' }), /settles on stellar:testnet/);
  assert.throws(() => createWebSorobanPay({ ...base, apiKey: 'sk_live_x' }), /wsp_test_ or wsp_live_/);
  assert.throws(() => createWebSorobanPay({ ...base, apiKey: undefined }), /WEBSOROBAN_PAY_KEY/);
});

test('verifies deliveries signed by the WebSoroban dispatcher', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'payment.settled', createdAt: '2026-10-09T00:00:00.000Z', data: {} });
  const now = 1_790_000_000;
  const header = signWebhook('wsp_whsec_secret', now, body);
  assert.equal(verifyWebhook('wsp_whsec_secret', header, body, { now: now * 1000 }), true);
  assert.equal(verifyWebhook('wsp_whsec_secret', header, Buffer.from(body), { now: now * 1000 }), true);
  assert.equal(verifyWebhook('wsp_whsec_other', header, body, { now: now * 1000 }), false);
  assert.equal(verifyWebhook('wsp_whsec_secret', header, body, { now: (now + 600) * 1000 }), false);
  assert.equal(verifyWebhook('wsp_whsec_secret', undefined, body), false);
  assert.throws(() => constructWebhookEvent('wsp_whsec_secret', 't=1,v1=00', body), /Invalid WebSoroban webhook signature/);
});

test('explains wallet compatibility', () => {
  assert.equal(checkWalletCompatibility('Freighter').supported, true);
  assert.equal(checkWalletCompatibility('freighter-mobile').supported, false);
  assert.equal(checkWalletCompatibility('metamask').wallet, null);
});

test('checks USDC trustlines without network access for contract accounts', async () => {
  const report = await checkUsdcTrustline('CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', 'stellar:testnet');
  assert.equal(report.status, 'not_applicable');
  assert.equal(report.ready, true);
  await assert.rejects(() => checkUsdcTrustline('nope'), /Stellar G-address/);
});
