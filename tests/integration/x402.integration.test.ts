/**
 * End-to-end tests for WebSoroban Pay against a real Postgres and a mock
 * facilitator + Horizon. Run with:
 *
 *   X402_TEST_DATABASE_URL=postgresql://… npm run test:integration
 *
 * The database must have every migration applied and must be disposable:
 * the suite creates and deletes its own rows.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Account, Contract, Keypair, Networks, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk';

const DATABASE_URL = process.env.X402_TEST_DATABASE_URL;
const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

type Handler = (req: http.IncomingMessage, body: string) => { status: number; body: unknown };

function listen(handler: Handler) {
  const calls: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
      const result = handler(req, body);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  return new Promise<{ url: string; calls: typeof calls; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function payment(from: string, to: string, amount: bigint) {
  const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(USDC_TESTNET).call(
      'transfer',
      nativeToScVal(from, { type: 'address' }),
      nativeToScVal(to, { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    ))
    .setTimeout(60)
    .build();
  return { x402Version: 2, accepted: { scheme: 'exact', network: 'stellar:testnet' }, payload: { transaction: transaction.toXDR() } };
}

describe('WebSoroban Pay integration', { skip: !DATABASE_URL && 'X402_TEST_DATABASE_URL is not set' }, () => {
  const payTo = Keypair.random().publicKey();
  const payer = Keypair.random().publicKey();
  const noTrustline = Keypair.random().publicKey();
  let settleResponse: { status: number; body: unknown } = { status: 200, body: {} };
  let receiverStatus = 200;

  let facilitator: Awaited<ReturnType<typeof listen>>;
  let horizon: Awaited<ReturnType<typeof listen>>;
  let receiver: Awaited<ReturnType<typeof listen>>;
  let api: http.Server;
  let apiUrl = '';
  let token = '';
  let userId = '';
  let prisma: typeof import('../../lib/prisma').default;
  let webhooks: typeof import('../../services/x402Webhooks');
  let spend: typeof import('../../services/x402AgentSpend');

  async function call(method: string, path: string, init: { body?: unknown; auth?: string; headers?: Record<string, string> } = {}) {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(init.auth ? { Authorization: `Bearer ${init.auth}` } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: response.status, headers: response.headers, body };
  }

  before(async () => {
    facilitator = await listen((req, body) => {
      if (req.url?.endsWith('/supported')) {
        return { status: 200, body: { kinds: [{ x402Version: 2, scheme: 'exact', network: 'stellar:testnet', extra: { areFeesSponsored: true } }], extensions: [], signers: {} } };
      }
      if (req.url?.endsWith('/settle')) return settleResponse;
      if (req.url?.endsWith('/verify')) return { status: 200, body: { isValid: true, payer: JSON.parse(body)?.payer } };
      return { status: 404, body: {} };
    });
    horizon = await listen((req) => {
      const id = req.url?.split('/accounts/')[1];
      if (id === noTrustline) return { status: 200, body: { balances: [{ asset_type: 'native', balance: '10' }] } };
      if (id === payTo || id === payer) {
        return { status: 200, body: { balances: [{ asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '1.0000000', is_authorized: true }] } };
      }
      return { status: 404, body: {} };
    });
    receiver = await listen(() => ({ status: receiverStatus, body: { ok: receiverStatus < 300 } }));

    Object.assign(process.env, {
      DATABASE_URL,
      DIRECT_URL: DATABASE_URL,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-secret',
      WALLET_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      HORIZON_URL: horizon.url,
      X402_FACILITATOR_URL: facilitator.url,
      X402_FACILITATOR_API_KEY: 'facilitator-key',
      PUBLIC_API_URL: 'http://127.0.0.1/api',
    });
    delete process.env.X402_MAINNET_FACILITATOR_URL;
    delete process.env.X402_MAINNET_FACILITATOR_API_KEY;

    const express = (await import('express')).default;
    const payRoutes = (await import('../../routes/pay')).default;
    prisma = (await import('../../lib/prisma')).default;
    webhooks = await import('../../services/x402Webhooks');
    spend = await import('../../services/x402AgentSpend');
    const { generateToken } = await import('../../utils/auth');

    const user = await prisma.user.create({ data: { email: `x402-${Date.now()}@example.test` } });
    userId = user.id;
    token = generateToken(user as any);

    const app = express();
    app.use(express.json());
    app.use('/api/pay', payRoutes);
    await new Promise<void>((resolve) => {
      api = app.listen(0, '127.0.0.1', () => resolve());
    });
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/pay`;
  });

  after(async () => {
    webhooks?.stopWebhookDispatcher();
    await (await import('../../middleware/rateLimit')).closeRateLimitClient();
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma?.$disconnect();
    await Promise.all([facilitator?.close(), horizon?.close(), receiver?.close()]);
    await new Promise<void>((resolve) => api ? api.close(() => resolve()) : resolve());
  });

  let endpoint: { id: string; slug: string; resourceUrl: string };
  let apiKey = '';

  test('refuses a payout address that cannot hold USDC', async () => {
    const response = await call('POST', '/endpoints', {
      auth: token,
      body: { name: 'No trustline', slug: `no-trust-${Date.now()}`, price: '0.01', payTo: noTrustline },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'PAYOUT_NOT_READY');
    assert.equal(response.body.trustline.status, 'missing_trustline');
  });

  test('refuses mainnet when no mainnet facilitator is configured', async () => {
    const response = await call('POST', '/endpoints', {
      auth: token,
      body: { name: 'Live', slug: `live-${Date.now()}`, price: '0.01', payTo, network: 'stellar:pubnet' },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'NETWORK_DISABLED');
  });

  test('creates a testnet endpoint with a testnet key', async () => {
    const response = await call('POST', '/endpoints', {
      auth: token,
      body: { name: 'Research brief', slug: `brief-${Date.now()}`, price: '0.01', payTo },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.match(response.body.apiKey, /^wsp_test_/);
    assert.equal(response.body.endpoint.network, 'stellar:testnet');
    assert.equal(response.body.trustline.status, 'ready');
    endpoint = response.body.endpoint;
    apiKey = response.body.apiKey;
  });

  test('serves an x402 challenge and keeps networks apart', async () => {
    const challenge = await call('GET', `/resource/${endpoint.slug}`, { headers: { Accept: 'application/json' } });
    assert.equal(challenge.status, 402);
    assert.ok(challenge.headers.get('payment-required'), 'PAYMENT-REQUIRED header');
    assert.equal(challenge.body.network, 'stellar:testnet');

    const wrong = await call('GET', `/live/resource/${endpoint.slug}`);
    assert.equal(wrong.status, 404);
    assert.equal(wrong.body.error, 'NETWORK_MISMATCH');
  });

  function settleBody(from = payer, to = payTo, amount = 100_000n, network = 'stellar:testnet') {
    return {
      x402Version: 2,
      paymentPayload: payment(from, to, amount),
      paymentRequirements: { scheme: 'exact', network, asset: USDC_TESTNET, payTo: to, amount: amount.toString(), maxTimeoutSeconds: 60, extra: { areFeesSponsored: true } },
    };
  }

  test('settles through the proxy and records the real amount', async () => {
    settleResponse = { status: 200, body: { success: true, transaction: 'a'.repeat(64), payer, network: 'stellar:testnet' } };
    const before = facilitator.calls.length;
    const response = await call('POST', '/facilitator/settle', { auth: apiKey, body: settleBody() });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(facilitator.calls.length, before + 1);
    assert.equal(facilitator.calls[facilitator.calls.length - 1].headers.authorization, 'Bearer facilitator-key');

    const event = await prisma.x402Event.findFirst({ where: { endpointId: endpoint.id, type: 'settlement' }, orderBy: { createdAt: 'desc' } });
    assert.equal(event?.status, 'settled');
    assert.equal(event?.amount, '$0.01');
    assert.equal(event?.payer, payer);
  });

  test('rejects proxy payments to another recipient, asset, or network before the facilitator', async () => {
    const before = facilitator.calls.length;
    const otherRecipient = settleBody(payer, Keypair.random().publicKey());
    const redirected = await call('POST', '/facilitator/settle', { auth: apiKey, body: otherRecipient });
    assert.equal(redirected.status, 400);

    const smuggled = settleBody();
    smuggled.paymentPayload = payment(payer, Keypair.random().publicKey(), 100_000n);
    const tampered = await call('POST', '/facilitator/settle', { auth: apiKey, body: smuggled });
    assert.equal(tampered.status, 400);

    const mainnet = await call('POST', '/facilitator/settle', { auth: apiKey, body: settleBody(payer, payTo, 100_000n, 'stellar:pubnet') });
    assert.equal(mainnet.status, 400);
    assert.equal(mainnet.body.error, 'NETWORK_MISMATCH');
    assert.equal(facilitator.calls.length, before, 'facilitator must not be called');
  });

  test('enforces an agent cap on real Stellar payloads and releases failed settlements', async () => {
    const created = await call('POST', '/agent-wallets', {
      auth: token,
      body: { name: 'Research agent', publicKey: payer, spendLimit: '0.02', endpointId: endpoint.id },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    settleResponse = { status: 200, body: { success: true, transaction: 'b'.repeat(64), payer, network: 'stellar:testnet' } };
    assert.equal((await call('POST', '/facilitator/settle', { auth: apiKey, body: settleBody() })).status, 200);
    assert.equal((await call('POST', '/facilitator/settle', { auth: apiKey, body: settleBody() })).status, 200);

    const before = facilitator.calls.length;
    const capped = await call('POST', '/facilitator/settle', { auth: apiKey, body: settleBody() });
    assert.equal(capped.status, 402);
    assert.equal(capped.body.error, 'SPEND_LIMIT_EXCEEDED');
    assert.equal(facilitator.calls.length, before, 'capped payment must not reach the facilitator');

    // A failed settlement gives its reservation back.
    await prisma.x402AgentWallet.updateMany({ where: { publicKey: payer }, data: { spentStroops: '100000' } });
    settleResponse = { status: 200, body: { success: false, errorReason: 'insufficient_funds', transaction: '', network: 'stellar:testnet' } };
    const failed = await call('POST', '/facilitator/settle', { auth: apiKey, body: settleBody() });
    assert.equal(failed.status, 200);
    const wallet = await prisma.x402AgentWallet.findFirst({ where: { publicKey: payer } });
    assert.equal(wallet?.spentStroops, '100000');
    const event = await prisma.x402Event.findFirst({ where: { endpointId: endpoint.id, status: 'failed', type: 'settlement' }, orderBy: { createdAt: 'desc' } });
    assert.equal(event?.errorCode, 'INSUFFICIENT_BALANCE_OR_ALLOWANCE');
  });

  test('never lets concurrent settlements exceed the cap', async () => {
    const signer = Keypair.random().publicKey();
    await prisma.x402AgentWallet.create({
      data: { userId, name: 'Burst agent', publicKey: signer, spendLimitUsdc: '1', limitStroops: '10000000' },
    });
    const fingerprints = Array.from({ length: 10 }, (_, index) => `burst-${signer}-${index}`);
    const attempts = await Promise.all(fingerprints.map((fingerprint) => spend.reserveAgentSpend({
      userId,
      endpointId: endpoint.id,
      payer: signer,
      price: '$0.3',
      fingerprint,
    })));
    assert.equal(attempts.filter((gate) => gate.allowed).length, 3);
    const spent = async () => (await prisma.x402AgentWallet.findFirstOrThrow({ where: { publicKey: signer } })).spentStroops;
    assert.equal(await spent(), '9000000');

    // Retrying an already-reserved payment is idempotent, not a second charge.
    const reserved = fingerprints[attempts.findIndex((gate) => gate.allowed)];
    const retry = await spend.reserveAgentSpend({ userId, endpointId: endpoint.id, payer: signer, price: '$0.3', fingerprint: reserved });
    assert.equal(retry.allowed, true);
    assert.equal(await spent(), '9000000');

    // Releasing returns the hold once; a duplicate release is a no-op.
    await Promise.all([spend.releaseAgentSpend(reserved), spend.releaseAgentSpend(reserved)]);
    assert.equal(await spent(), '6000000');
  });

  test('delivers signed webhooks durably and exactly once per claim', async () => {
    const registered = await call('POST', '/webhooks', {
      auth: token,
      body: { url: `${receiver.url}/hooks`, events: ['payment.settled', 'payment.failed'], endpointId: endpoint.id },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const secret: string = registered.body.secret;

    receiverStatus = 500;
    settleResponse = { status: 200, body: { success: true, transaction: 'c'.repeat(64), payer: Keypair.random().publicKey(), network: 'stellar:testnet' } };
    const before = receiver.calls.length;
    await call('POST', '/facilitator/settle', { auth: apiKey, body: settleBody(Keypair.random().publicKey()) });
    await waitFor(() => receiver.calls.length > before);

    const delivery = await waitForValue(() => prisma.x402WebhookDelivery.findFirst({
      where: { webhookId: registered.body.webhook.id, eventType: 'payment.settled', attempts: { gte: 1 } },
      orderBy: { createdAt: 'desc' },
    }));
    assert.equal(delivery.status, 'pending');
    assert.ok(delivery.nextAttemptAt && delivery.nextAttemptAt > new Date(), 'retry is scheduled in the future');

    // The receiver recovers; make the retry due and race two dispatchers.
    receiverStatus = 200;
    await prisma.x402WebhookDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const callsBefore = receiver.calls.length;
    await Promise.all([webhooks.attemptDelivery(delivery.id), webhooks.attemptDelivery(delivery.id), webhooks.sweepDueDeliveries()]);
    assert.equal(receiver.calls.length, callsBefore + 1, 'exactly one dispatcher sends a claimed delivery');

    const delivered = await prisma.x402WebhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.attempts, 2);

    const last = receiver.calls[receiver.calls.length - 1];
    assert.equal(webhooks.verifyWebhookSignature(secret, String(last.headers['x-websoroban-signature']), last.body), true);
    const payload = JSON.parse(last.body);
    assert.equal(payload.type, 'payment.settled');
    assert.equal(payload.data.network, 'stellar:testnet');

    const test = await call('POST', `/webhooks/${registered.body.webhook.id}/test`, { auth: token });
    assert.equal(test.status, 200);
    assert.equal(test.body.delivery.status, 'delivered');
  });

  test('reports settlement reliability and readable failure reasons', async () => {
    const overview = await call('GET', '/overview', { auth: token });
    assert.equal(overview.status, 200);
    const day = overview.body.metrics.settlement.find((window: any) => window.label === '24h');
    assert.ok(day.settled >= 4);
    assert.ok(day.successRate > 0 && day.successRate < 1);
    assert.ok(Number(overview.body.metrics.revenueUsdc) >= 0.04);
    const codes = overview.body.failureReasons.map((reason: any) => reason.code);
    assert.ok(codes.includes('INSUFFICIENT_BALANCE_OR_ALLOWANCE'));
    assert.ok(codes.includes('SPEND_LIMIT_EXCEEDED'));
    assert.ok(overview.body.failureReasons.every((reason: any) => reason.fix));
    assert.ok(overview.body.webhooks[0].lastDelivery);
    assert.deepEqual(overview.body.networks.map((network: any) => network.enabled), [true, false]);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForValue<T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for value.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
