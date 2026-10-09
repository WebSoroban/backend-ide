# WebSoroban Pay

WebSoroban Pay turns an Express endpoint into an official x402 v2 resource that settles USDC on Stellar. It supports the `exact` scheme on **Stellar testnet** by default and on **Stellar mainnet** when an operator configures a mainnet facilitator. Every challenge, verification, settlement, and failure is recorded for Payment Studio, signed webhooks, and settlement reliability metrics.

## Runtime requirements

- Node.js 22 or newer (required by `@x402/stellar`)
- PostgreSQL with every Prisma migration applied
- Redis (shared rate limits; the limiter fails open if Redis is down)
- A public HTTPS API URL for usable payment challenge URLs

## Configure

```env
PUBLIC_API_URL=https://api.example.com/api

# Testnet. Recommended: OpenZeppelin Channels.
X402_FACILITATOR_URL=https://channels.openzeppelin.com/x402/testnet
X402_FACILITATOR_API_KEY=your_relayer_api_key

# Mainnet (optional). Enabled only when BOTH are set; there is no public fallback.
X402_MAINNET_FACILITATOR_URL=
X402_MAINNET_FACILITATOR_API_KEY=
MAINNET_HORIZON_URL=https://horizon.stellar.org
```

With no testnet facilitator key, the server falls back to the public `https://www.x402.org/facilitator` testnet service. That is fine for development but is not an availability guarantee.

Apply the schema and build:

```bash
npm run migrate:deploy
npm run build
npm run build:pay-sdk   # compiles packages/websoroban-pay to dist/
```

## Networks

| | Testnet | Mainnet |
|---|---|---|
| CAIP-2 id | `stellar:testnet` | `stellar:pubnet` |
| Endpoint key prefix | `wsp_test_` | `wsp_live_` |
| Hosted resource | `/api/pay/resource/:slug` | `/api/pay/live/resource/:slug` |
| USDC issuer | `GBBD47IF…LFLA5` | `GA5ZSEJY…KZVN` (Circle) |

Each network runs its own x402 resource server and talks to exactly one facilitator, so a testnet facilitator can never be asked to settle mainnet funds. The SDK infers the network from the key prefix and refuses a mismatched `network` option. The proxy rejects any payment whose requirements name a different network (`NETWORK_MISMATCH`).

## Product flow

1. Sign in and open `/pay` in the frontend.
2. Pick a network, then create a route with a name, slug, price, response, and payout address. The studio checks that the payout address exists and holds a USDC trustline; creation is refused if it cannot receive USDC.
3. Copy the endpoint key. Only its SHA-256 hash is stored.
4. **Inspect 402** to confirm the challenge exposes `PAYMENT-REQUIRED`.
5. Open the hosted checkout, connect Freighter, Hana, HOT, or Klever, and approve the exact authorization. The checkout checks the payer's USDC trustline before asking for a signature.
6. The checkout shows the settlement transaction and its Stellar Expert receipt.
7. Protect your own Express service with `@websoroban/pay` using the generated snippet.
8. Settlement success rate, failure reasons with fixes, and webhook delivery state appear in Payment Studio.

The public checkout lives at `/pay/checkout?resource=<encoded-resource-url>` and needs no WebSoroban login. The facilitator sponsors transaction fees; the buyer authorizes only the exact USDC transfer.

## Wallets

x402 on Stellar needs a wallet that signs Soroban **authorization entries**.

| Wallet | Auth entries | Hosted checkout |
|---|---|---|
| Freighter (extension) | Yes | Yes |
| Hana | Yes | Yes |
| HOT | Yes | Yes |
| Klever | Yes | Yes |
| Albedo | Yes | No: Stellar Wallets Kit 1.9's Albedo module rejects `signAuthEntry`; sign from your own client |
| OneKey | Yes | No: no Wallets Kit module; sign from your own client |
| Freighter Mobile | No | No |

The checkout verifies every returned signature against the exact authorization preimage and the connected account before submitting it. `GET /api/pay/wallets` and the SDK's `AUTH_ENTRY_WALLETS` publish the same list.

## Settlement reliability

`GET /api/pay/overview` returns `metrics.settlement` for 24h, 7d, and 30d windows:

- `successRate = settled / (settled + facilitator failures)`
- Failures that never reach the facilitator (spend caps, rate limits, network mismatches, disabled networks) are excluded from the rate but still listed in `failureReasons`, each with its cause and fix.

Facilitator reasons such as `insufficient_funds` or `invalid_exact_stellar_payload_*` are mapped onto the catalog in `services/x402Errors.ts`; unknown reasons keep their raw code.

## Webhooks

Register `payment.settled`, `payment.failed`, or `wallet.spend_limit_exceeded`. Deliveries are signed `t=<unix>,v1=<hmac>` over `${timestamp}.${rawBody}` in `X-WebSoroban-Signature`, with `X-WebSoroban-Delivery` and `X-WebSoroban-Event`. Verify with the SDK:

```ts
import { constructWebhookEvent } from '@websoroban/pay';

app.post('/webhooks/pay', express.raw({ type: 'application/json' }), (req, res) => {
  const event = constructWebhookEvent(process.env.WEBSOROBAN_WEBHOOK_SECRET!, req.header('X-WebSoroban-Signature'), req.body);
  // event.id is stable per payment event; use it to deduplicate.
  res.sendStatus(204);
});
```

Delivery is durable. Each delivery is stored in Postgres, attempted immediately, then retried after 10s, 1m, 5m, 30m, and 2h before it is marked `failed`. Any API instance can pick up due retries: a delivery is claimed with a conditional update, so it is sent at most once per attempt even with several instances running. Redirects are not followed, and targets must be public HTTPS (`http://localhost` is allowed outside production). `POST /api/pay/webhooks/:id/test` sends a signed `webhook.test` delivery.

## Agent spend limits

An agent wallet caps a signer's daily USDC spend (`spendingLimitStroops`, `periodLedgers` ≈ 17280). The payer is read from the signed Stellar transfer itself, not from client-echoed fields. Before settlement the cap is reserved under a row lock, so concurrent payments cannot slip past it. The reservation is keyed by the payment fingerprint, which makes retries idempotent. It is committed on success and released on failure. A payment over the cap never reaches the facilitator.

## Managed facilitator proxy

`/api/pay/facilitator/{supported,verify,settle}` authenticates with the endpoint key, then:

- limits each endpoint to 120 calls per minute across instances (Redis), with a per-instance in-memory backstop;
- requires the payment to pay **this endpoint's payout address, in USDC, on its network**, checked against both the requirements and the signed transfer, so a leaked key cannot be used to settle arbitrary transfers on WebSoroban's sponsored fees;
- strips developer credentials, adds the server-owned facilitator authorization, and times out after 20 seconds;
- records fingerprints, never raw payment payloads.

## API surface

- `GET /api/pay/overview`: authenticated studio data and metrics
- `GET /api/pay/networks`: enabled networks and facilitators
- `GET /api/pay/wallets`: auth-entry wallet compatibility
- `GET /api/pay/trustline?address=&network=`: public USDC trustline check
- `POST /api/pay/endpoints`: create an endpoint (`network` optional) and return its key once
- `PATCH /api/pay/endpoints/:id`: pause or resume
- `POST /api/pay/endpoints/:id/rotate-key`: invalidate and replace a key
- `GET /api/pay/resource/:slug`, `GET /api/pay/live/resource/:slug`: hosted x402 resources
- `POST /api/pay/webhooks`, `PATCH|DELETE /api/pay/webhooks/:id`: manage webhooks
- `POST /api/pay/webhooks/:id/test`, `GET /api/pay/webhooks/:id/deliveries`: test and inspect delivery
- `POST /api/pay/agent-wallets`, `PATCH /api/pay/agent-wallets/:id`: agent spend caps
- `/api/pay/facilitator/{supported,verify,settle}`: endpoint-key proxy for the SDK

## Adoption and time-to-first-payment

`GET /api/pay/adoption` (admin) and `npx tsx scripts/x402-adoption.ts` report:

- **External adopters** (KR target ≥ 10): non-team accounts with an endpoint
  that settled a payment from a payer other than its own payout address.
  Self-payments and team accounts never count. Team accounts are
  `ADMIN_EMAILS`, `X402_INTERNAL_EMAILS`, and `X402_INTERNAL_DOMAINS`.
- The funnel: created an endpoint → served a 402 → was paid (and via the SDK).
- **Time from endpoint creation to first paid request**: median, p75, and
  the count within 30 minutes. The KR1.1 session protocol is in `X402_STUDY.md`.

## Testing

```bash
npm test                         # unit tests, including the SDK
X402_TEST_DATABASE_URL=… npm run test:integration   # real Postgres, mock facilitator
X402_E2E_DATABASE_URL=… npx tsx scripts/x402-live-e2e.ts   # real testnet payments
npx tsx scripts/load-x402-proxy.ts   # in-process rate-limit budget
```

The live e2e funds throwaway testnet accounts (Friendbot, USDC trustline, XLM swapped to USDC on the testnet DEX), then pays both the hosted resource and an SDK-protected Express route, and checks that the payout account received the USDC. Both database variables must point at a disposable, migrated database. The scripts never fall back to `DATABASE_URL`.
