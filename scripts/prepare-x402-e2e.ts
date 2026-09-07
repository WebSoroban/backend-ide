import 'dotenv/config';
import { chmodSync, writeFileSync } from 'node:fs';
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import prisma from '../lib/prisma';
import walletService from '../services/wallet';

const ENDPOINT_SLUG = process.argv[2] || 'research-brief';
const PAYER_FILE = '/private/tmp/websoroban-x402-payer.json';
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');

async function hasUsdcTrustline(publicKey: string) {
  const account = await horizon.loadAccount(publicKey);
  return account.balances.some((balance: any) =>
    balance.asset_code === 'USDC' && balance.asset_issuer === USDC.getIssuer(),
  );
}

async function ensureUsdcTrustline(keypair: Keypair) {
  if (await hasUsdcTrustline(keypair.publicKey())) return false;
  const account = await horizon.loadAccount(keypair.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(30)
    .build();
  transaction.sign(keypair);
  await horizon.submitTransaction(transaction);
  return true;
}

async function main() {
  const endpoint = await prisma.x402Endpoint.findUnique({
    where: { slug: ENDPOINT_SLUG },
    select: { userId: true, payTo: true },
  });
  if (!endpoint) throw new Error(`Endpoint ${ENDPOINT_SLUG} was not found.`);

  const payee = await walletService.loadKeypair(endpoint.userId);
  if (payee.publicKey() !== endpoint.payTo) {
    throw new Error('The endpoint payout address is not the user-managed testnet wallet.');
  }
  const payeeTrustlineAdded = await ensureUsdcTrustline(payee);

  const payer = Keypair.random();
  const friendbot = await fetch(`https://friendbot.stellar.org/?addr=${payer.publicKey()}`);
  if (!friendbot.ok) throw new Error(`Friendbot failed with HTTP ${friendbot.status}.`);
  const payerTrustlineAdded = await ensureUsdcTrustline(payer);

  writeFileSync(PAYER_FILE, JSON.stringify({
    privateKey: payer.secret(),
    publicKey: payer.publicKey(),
    endpointSlug: ENDPOINT_SLUG,
  }), { mode: 0o600 });
  chmodSync(PAYER_FILE, 0o600);

  console.log(JSON.stringify({
    payee: endpoint.payTo,
    payeeTrustlineAdded,
    payer: payer.publicKey(),
    payerTrustlineAdded,
    payerSecretStoredAt: PAYER_FILE,
  }, null, 2));
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
