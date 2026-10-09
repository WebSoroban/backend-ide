/**
 * Live end-to-end check of WebSoroban Pay on Stellar testnet.
 *
 * Creates throwaway testnet accounts (Friendbot, a USDC trustline, and XLM
 * swapped to USDC on the testnet DEX), starts the Pay API in-process, then
 * makes real paid requests through both integration paths:
 *
 *   1. the hosted resource  GET /api/pay/resource/:slug
 *   2. an Express app protected by @web-soroban/pay via the managed proxy
 *
 * and checks the payout account actually received the USDC.
 *
 *   X402_E2E_DATABASE_URL=postgresql://… npx tsx scripts/x402-live-e2e.ts
 *
 * The database must be disposable with all migrations applied. The script
 * refuses to fall back to DATABASE_URL so it never writes to a real database.
 * Uses the facilitator from X402_FACILITATOR_URL/X402_FACILITATOR_API_KEY, or
 * the public x402.org testnet facilitator when neither is set.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const DATABASE_URL = process.env.X402_E2E_DATABASE_URL;
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const RPC_URL = 'https://soroban-testnet.stellar.org';
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const horizon = new Horizon.Server(HORIZON_URL);

function step(message: string) {
  console.log(`\n▸ ${message}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function submit(keypair: Keypair, operations: ReturnType<typeof Operation.changeTrust>[]) {
  const account = await horizon.loadAccount(keypair.publicKey());
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET });
  for (const operation of operations) builder.addOperation(operation);
  const transaction = builder.setTimeout(60).build();
  transaction.sign(keypair);
  return horizon.submitTransaction(transaction);
}

async function fundedAccount(withUsdc: boolean) {
  const keypair = Keypair.random();
  const friendbot = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
  if (!friendbot.ok) throw new Error(`Friendbot failed with HTTP ${friendbot.status}.`);
  const operations = [Operation.changeTrust({ asset: USDC })];
  if (withUsdc) {
    operations.push(Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(),
      sendAmount: '50',
      destination: keypair.publicKey(),
      destAsset: USDC,
      destMin: '1',
      path: [],
    }) as any);
  }
  await submit(keypair, operations);
  return keypair;
}

async function usdcBalance(publicKey: string): Promise<number> {
  const account = await horizon.loadAccount(publicKey);
  const line = account.balances.find((balance: any) => balance.asset_code === 'USDC' && balance.asset_issuer === USDC.getIssuer());
  return Number((line as any)?.balance || 0);
}

function listen(app: { listen: (port: number, host: string, cb: () => void) => Server }, port: number) {
  return new Promise<Server>((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  if (!DATABASE_URL) throw new Error('Set X402_E2E_DATABASE_URL to a disposable, migrated Postgres database.');
  const apiPort = await freePort();
  const apiBase = `http://127.0.0.1:${apiPort}/api`;
  Object.assign(process.env, {
    DATABASE_URL,
    DIRECT_URL: DATABASE_URL,
    NODE_ENV: 'development',
    JWT_SECRET: process.env.JWT_SECRET || randomBytes(32).toString('hex'),
    WALLET_ENCRYPTION_KEY: process.env.WALLET_ENCRYPTION_KEY || randomBytes(32).toString('base64'),
    PUBLIC_API_URL: apiBase,
  });

  step('Funding throwaway testnet accounts');
  const [payee, payer] = await Promise.all([fundedAccount(false), fundedAccount(true)]);
  console.log(`  payee ${payee.publicKey()}`);
  console.log(`  payer ${payer.publicKey()} holds ${await usdcBalance(payer.publicKey())} USDC`);

  const express = (await import('express')).default;
  const prisma = (await import('../lib/prisma')).default;
  const payRoutes = (await import('../routes/pay')).default;
  const { generateToken } = await import('../utils/auth');
  const { facilitatorFor } = await import('../services/x402Network');
  const { x402Client, x402HTTPClient, wrapFetchWithPayment } = await import('@x402/fetch');
  const { createEd25519Signer } = await import('@x402/stellar');
  const { ExactStellarScheme } = require('@x402/stellar/exact/client') as {
    ExactStellarScheme: new (signer: unknown, rpc?: { url: string }) => any;
  };
  // Loaded at runtime: the SDK builds with node16 resolution, separate from the backend.
  const { createWebSorobanPay } = require('../packages/websoroban-pay/index') as {
    createWebSorobanPay: (options: Record<string, unknown>) => {
      preflight: () => Promise<{ ok: boolean }>;
      protect: (route: string, price: string) => import('express').RequestHandler;
    };
  };
  console.log(`  facilitator ${facilitatorFor('stellar:testnet')?.label}`);

  const api = express();
  api.use(express.json());
  api.use('/api/pay', payRoutes);
  const apiServer = await listen(api, apiPort);
  const user = await prisma.user.create({ data: { email: `x402-e2e-${Date.now()}@example.test` } });
  const servers: Server[] = [apiServer];

  try {
    step('Creating a paid endpoint through the Pay API');
    const created = await fetch(`${apiBase}/pay/endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(user as any)}` },
      body: JSON.stringify({ name: 'Live e2e brief', slug: `e2e-${Date.now()}`, price: '0.01', payTo: payee.publicKey() }),
    }).then((response) => response.json() as Promise<any>);
    if (!created.success) throw new Error(`Endpoint creation failed: ${JSON.stringify(created)}`);
    console.log(`  ${created.endpoint.resourceUrl} (${created.trustline.status})`);

    const signer = createEd25519Signer(payer.secret(), 'stellar:testnet');
    const client = new x402Client().register('stellar:*', new ExactStellarScheme(signer, { url: RPC_URL }));
    const paidFetch = wrapFetchWithPayment(fetch, client);
    const httpClient = new x402HTTPClient(client);

    async function pay(label: string, url: string) {
      const started = Date.now();
      const response = await paidFetch(url, { headers: { Accept: 'application/json' } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
      const settlement = httpClient.getPaymentSettleResponse((name) => response.headers.get(name));
      if (!settlement?.transaction) throw new Error(`${label} returned no settlement transaction.`);
      console.log(`  ✓ ${label} settled in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      console.log(`    https://stellar.expert/explorer/testnet/tx/${settlement.transaction}`);
      return settlement.transaction;
    }

    const before = await usdcBalance(payee.publicKey());

    step('Paying the hosted resource');
    await pay('Hosted resource', created.endpoint.resourceUrl);

    step('Paying an Express app protected by @web-soroban/pay');
    const merchant = express();
    const sdk = createWebSorobanPay({ apiUrl: apiBase, apiKey: created.apiKey, endpointId: created.endpoint.id, payTo: payee.publicKey() });
    const preflight = await sdk.preflight();
    if (!preflight.ok) throw new Error(`SDK preflight failed: ${JSON.stringify(preflight)}`);
    merchant.use(sdk.protect('GET /brief', '$0.01'));
    merchant.get('/brief', (_req, res) => { res.json({ paid: true }); });
    const merchantPort = await freePort();
    servers.push(await listen(merchant, merchantPort));
    await pay('SDK-protected route', `http://127.0.0.1:${merchantPort}/brief`);

    step('Checking the payout and the activity trail');
    const after = await usdcBalance(payee.publicKey());
    const received = Math.round((after - before) * 1e7) / 1e7;
    if (received !== 0.02) throw new Error(`Payee received ${received} USDC, expected 0.02.`);
    console.log(`  ✓ payee received ${received} USDC`);
    const settled = await prisma.x402Event.count({ where: { endpointId: created.endpoint.id, type: 'settlement', status: 'settled' } });
    if (settled !== 2) throw new Error(`Expected 2 settled events, found ${settled}.`);
    console.log(`  ✓ ${settled} settlement events recorded`);
    console.log('\nLive testnet e2e passed.');
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.$disconnect();
    for (const server of servers) server.close();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`\n✖ ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
