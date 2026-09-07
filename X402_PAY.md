# WebSoroban Pay MVP

WebSoroban Pay turns an Express endpoint into an official x402 v2 resource on Stellar testnet. The MVP supports the exact payment scheme and USDC-denominated prices, with a managed facilitator proxy and an activity trail for payment challenges, verification, settlement, and failures.

## Runtime requirements

- Node.js 22 or newer (required by `@x402/stellar`)
- PostgreSQL with the Prisma migration applied
- A public HTTPS API URL for usable payment challenge URLs

## Configure

```env
PUBLIC_API_URL=https://api.example.com/api

# Recommended: OpenZeppelin Channels testnet facilitator
X402_FACILITATOR_URL=https://channels.openzeppelin.com/x402/testnet
X402_FACILITATOR_API_KEY=your_relayer_api_key
```

When no facilitator API key is configured, the server falls back to the public `https://www.x402.org/facilitator` testnet service. This fallback is suitable for development, not an availability guarantee.

Apply the schema and build:

```bash
npm run migrate:deploy
npm run build
```

## Product flow

1. Sign in and open `/pay` in the frontend.
2. Create a route with a name, slug, price, response, and Stellar testnet payout G-address.
3. Copy the endpoint key. Only its SHA-256 hash is stored.
4. Send the built-in test request and confirm the HTTP 402 response exposes `PAYMENT-REQUIRED`.
5. Open **Pay with Freighter**, connect a testnet account holding testnet USDC, and approve the exact authorization.
6. Confirm the checkout displays the settlement transaction and Stellar Expert receipt link.
7. Add `@websoroban/pay` to an Express service using the generated snippet when protecting an external service.
8. Verification and settlement events appear in Payment Studio.

The public checkout lives at `/pay/checkout?resource=<encoded-resource-url>` and
does not require a WebSoroban login. The facilitator sponsors transaction fees;
the buyer authorizes only the exact USDC transfer.

## Browser client

Use mutually compatible x402 and Freighter packages:

```bash
npm install @x402/core@^2.25.0 @x402/fetch@^2.25.0 \
  @x402/stellar@^2.25.0 @stellar/freighter-api@^6.0.1
```

`@stellar/freighter-api` 4.1 is not compatible with current Freighter extension
auth-signature transport. The checkout uses 6.0.1 and verifies the returned
Ed25519 signature against the exact authorization preimage before submitting it.

For cross-origin browser clients, allow and expose the x402 headers:

```ts
cors({
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'PAYMENT-SIGNATURE',
    'X-PAYMENT',
    'Access-Control-Expose-Headers', // emitted by @x402/fetch 2.25 paid retries
  ],
  exposedHeaders: [
    'PAYMENT-REQUIRED',
    'PAYMENT-RESPONSE',
    'PAYMENT-ERROR',
    'X-PAYMENT-RESPONSE',
  ],
});
```

WebSoroban's checkout removes the unnecessary `Access-Control-Expose-Headers`
request header, while the backend accepts it for compatibility with stock
`@x402/fetch` browser clients.

## Local end-to-end test

1. Start the backend on `http://localhost:3001` and frontend on
   `http://localhost:3000`.
2. Apply the Prisma migration with `npm run migrate:deploy`.
3. Open `/pay`, create an endpoint, and select **Pay with Freighter**.
4. Set Freighter to Testnet and use an account funded with testnet USDC.
5. Approve the authorization once.
6. Confirm the protected request returns HTTP `200`, `PAYMENT-RESPONSE` is
   readable by the browser, and the receipt opens the testnet transaction.

The initial HTTP `402` is expected. A successful x402 client reads the challenge,
signs it, and automatically retries the same resource with `PAYMENT-SIGNATURE`.

## API surface

- `GET /api/pay/overview` — authenticated studio data
- `POST /api/pay/endpoints` — create an endpoint and return its key once
- `PATCH /api/pay/endpoints/:id` — pause or resume
- `POST /api/pay/endpoints/:id/rotate-key` — invalidate and replace a key
- `GET /api/pay/resource/:slug` — hosted x402-protected JSON resource
- `/api/pay/facilitator/{supported,verify,settle}` — endpoint-key-authenticated proxy

The proxy is limited to 120 calls per endpoint per minute, strips developer-supplied upstream credentials, adds the server-owned facilitator authorization, times out after 20 seconds, and records fingerprints rather than raw payment payloads.

## MVP boundary

This release is testnet-only. Mainnet, spend limits, team roles, webhook delivery, and MPP sessions are not presented as shipped features.
