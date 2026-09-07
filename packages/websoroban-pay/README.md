# `@websoroban/pay`

Express middleware for WebSoroban Pay's managed Stellar testnet facilitator.

```ts
import express from 'express';
import { createWebSorobanPay } from '@websoroban/pay';

const app = express();
const pay = createWebSorobanPay({
  apiUrl: process.env.WEBSOROBAN_API_URL!,
  apiKey: process.env.WEBSOROBAN_PAY_KEY,
  endpointId: process.env.WEBSOROBAN_ENDPOINT_ID!,
  payTo: process.env.STELLAR_PAY_TO!,
});

app.use(pay.protect('GET /brief', '$0.01'));
app.get('/brief', (_req, res) => res.json({ message: 'Paid access granted.' }));
```

The key belongs in a server-side environment variable. This MVP supports the x402 exact scheme, Stellar testnet, and USDC-denominated prices.
