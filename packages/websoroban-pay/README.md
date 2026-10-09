# `@web-soroban/pay`

x402 payments for Express APIs, settled in USDC on Stellar through WebSoroban's managed facilitator.

```bash
npm install @web-soroban/pay @x402/core @x402/express @x402/stellar express
```

Node 22 or newer is required.

## Protect a route

```ts
import express from 'express';
import { createWebSorobanPay } from '@web-soroban/pay';

const app = express();
const pay = createWebSorobanPay({
  apiUrl: process.env.WEBSOROBAN_API_URL!,
  apiKey: process.env.WEBSOROBAN_PAY_KEY,      // wsp_test_… = testnet, wsp_live_… = mainnet
  endpointId: process.env.WEBSOROBAN_ENDPOINT_ID!,
  payTo: process.env.STELLAR_PAY_TO!,          // the endpoint's payout address
});

app.use(pay.protect('GET /brief', '$0.01'));
app.get('/brief', (_req, res) => res.json({ message: 'Paid access granted.' }));

app.listen(8787, async () => {
  const report = await pay.preflight();
  if (!report.ok) console.warn(report);
});
```

The network comes from the key prefix. Passing a `network` that disagrees with the key throws, so a testnet key cannot guard a mainnet route.

`preflight()` confirms that the key reaches the WebSoroban facilitator and that the payout account holds a USDC trustline. Settlement to an account without one always fails.

## Wallet compatibility

```ts
import { AUTH_ENTRY_WALLETS, checkWalletCompatibility } from '@web-soroban/pay';

checkWalletCompatibility('freighter');        // { supported: true, … }
checkWalletCompatibility('freighter-mobile'); // { supported: false, guidance: 'Use the desktop extension.' }
```

x402 on Stellar needs a wallet that signs Soroban authorization entries: Freighter (extension), Hana, HOT, Klever, Albedo, or OneKey.

## USDC trustlines

```ts
import { checkUsdcTrustline } from '@web-soroban/pay';

const report = await checkUsdcTrustline('G…', 'stellar:testnet');
// report.status: 'ready' | 'missing_account' | 'missing_trustline' | 'not_authorized' | 'not_applicable' | 'unknown'
```

## Webhooks

```ts
import { constructWebhookEvent } from '@web-soroban/pay';

app.post('/webhooks/pay', express.raw({ type: 'application/json' }), (req, res) => {
  const event = constructWebhookEvent(process.env.WEBSOROBAN_WEBHOOK_SECRET!, req.header('X-WebSoroban-Signature'), req.body);
  if (event.type === 'payment.settled') { /* fulfil the order; dedupe on event.id */ }
  res.sendStatus(204);
});
```

Pass the **raw** body. A re-serialized JSON object will not match the signature. Signatures older than five minutes are rejected.

The endpoint key belongs in a server-side environment variable. Never ship it to a browser.
