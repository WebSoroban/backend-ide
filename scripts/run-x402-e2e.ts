import { readFileSync } from 'node:fs';
import { Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { x402Client, x402HTTPClient } from '@x402/fetch';
import { createEd25519Signer, getNetworkPassphrase } from '@x402/stellar';

const { ExactStellarScheme } = require('@x402/stellar/exact/client') as {
  ExactStellarScheme: new (signer: unknown, rpcConfig?: { url: string }) => any;
};

const NETWORK = 'stellar:testnet' as const;
const RPC_URL = 'https://soroban-testnet.stellar.org';
const PAYER_FILE = '/private/tmp/websoroban-x402-payer.json';

async function main() {
  const payer = JSON.parse(readFileSync(PAYER_FILE, 'utf8')) as {
    privateKey: string;
    publicKey: string;
    endpointSlug: string;
  };
  const url = `http://127.0.0.1:3001/api/pay/resource/${payer.endpointSlug}`;
  const signer = createEd25519Signer(payer.privateKey, NETWORK);
  const coreClient = new x402Client().register(
    'stellar:*',
    new ExactStellarScheme(signer, { url: RPC_URL }),
  );
  const httpClient = new x402HTTPClient(coreClient);

  const challenge = await fetch(url, { headers: { Accept: 'application/json' } });
  if (challenge.status !== 402) {
    throw new Error(`Expected the initial request to return 402, received ${challenge.status}: ${await challenge.text()}`);
  }
  const paymentRequired = httpClient.getPaymentRequiredResponse((name) => challenge.headers.get(name));
  let paymentPayload: any = await coreClient.createPaymentPayload(paymentRequired);

  const passphrase = getNetworkPassphrase(NETWORK);
  const transaction = new Transaction(paymentPayload.payload.transaction, passphrase);
  const sorobanData = transaction.toEnvelope().v1()?.tx()?.ext()?.sorobanData();
  if (sorobanData) {
    paymentPayload = {
      ...paymentPayload,
      payload: {
        ...paymentPayload.payload,
        transaction: TransactionBuilder.cloneFrom(transaction, {
          fee: '1',
          sorobanData,
          networkPassphrase: passphrase,
        }).build().toXDR(),
      },
    };
  }

  const paidResponse = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...httpClient.encodePaymentSignatureHeader(paymentPayload),
    },
  });
  const body = await paidResponse.text();
  const settlement = httpClient.getPaymentSettleResponse((name) => paidResponse.headers.get(name));

  console.log(JSON.stringify({
    payer: payer.publicKey,
    challengeStatus: challenge.status,
    paidStatus: paidResponse.status,
    body: parseJson(body),
    settlement,
  }, null, 2));

  if (!paidResponse.ok) process.exitCode = 1;
}

function parseJson(value: string) {
  try { return JSON.parse(value); } catch { return value; }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
