# WebSoroban AI Credits (Dodo Payments)

Credit-based billing for the AI Copilot. New users get **50 free credits**; each
Copilot run consumes credits based on the **actual model cost** OpenRouter reports;
when a user runs out they buy a **one-time credit pack** via Dodo Payments.

> This is the **fiat/credits** system. It is **separate** from the testnet-XLM
> plan/template payment flow (`routes/payments.ts`, `Payment`/`Subscription`).
> Don't conflate them.

---

## 1. The credit model

**Our DB is the source of truth.** Every credit movement is an append-only
`CreditLedger` row; `User.credits` is a denormalized running balance updated in the
**same transaction** as the ledger row (atomic `increment`/`decrement`, no
read-modify-write race).

| reason | delta | refId (idempotency key) |
|--------|-------|--------------------------|
| `signup_grant` | +50 | `"signup"` |
| `purchase` | + pack credits | Dodo `payment_id` |
| `usage` | − credits charged | `AgentRun.id` |
| `refund` / `admin` | ± | free-form / null |

Idempotency rides `@@unique([userId, reason, refId])`: a signup grant, a purchase,
and a usage debit can each be applied **at most once**. A duplicate insert throws
`P2002`, which rolls the whole transaction back (so the balance change is undone
too) — a retried webhook or worker job can never double-credit or double-charge.

`AiUsage` records each run's `model`, `mode`, tokens, `costUsd`, and `creditsCharged`
(one row per run; `runId` unique).

### cost → credits

OpenRouter returns the real USD cost per request (we enable usage accounting:
`usage: { include: true }`, parsed in `services/ai/openrouter.ts`). The harness
sums `costUsd` across **all** model calls in a run. Conversion (`services/billing/config.ts`):

```
creditsCharged = ceil(costUsd * CREDITS_PER_USD * CREDIT_MARGIN)   // min 1 if cost > 0
```

- `CREDITS_PER_USD` (default **100**) — set above `1/price` so it embeds margin
  (100 ⇒ 1 credit ≈ $0.01 of model cost).
- `CREDIT_MARGIN` (default **1**) — extra markup multiplier.

This stays fair across Auto / MAX / cheap / expensive models because we always bill
on **actual** cost, not a flat per-run fee.

> **BYO-key users are not metered.** If a user set their own OpenRouter key, the
> cost is on their account, so we skip the gate and the debit for them.

---

## 2. Metering + gating (server-side, non-bypassable)

- **Before a run** (`routes/ai.ts` → `ensureCredits`): `POST /threads/:id/messages`,
  `/plans/:id/build`, and `/multitask` check `balance > 0`. If not, they return
  **402 `OUT_OF_CREDITS`** with the pack list and **do not** create or enqueue the
  run. The client never decides the balance.
- **Overspend guard** (`services/ai/harness.ts`): the run is given a `creditBudget`
  (= current balance); the loop stops once the run's actual cost reaches it, so one
  run can't run the balance deeply negative.
- **After a run** (`workers/agentWorker.ts`): in **one transaction** it writes the
  `AiUsage` row and the `usage` ledger debit (idempotent by `runId`), then emits the
  new balance over the run's socket (`credits` event + `creditBalance` on `done`)
  so the header badge updates live. Cancelled runs are still charged for cost
  actually incurred.

---

## 3. The 3 credit packs

Defined in `services/billing/config.ts` (price + granted credits are env-configurable):

| Pack | Default price | Default credits | Env product id |
|------|---------------|-----------------|----------------|
| Starter | $5.00 | 500 | `DODO_PRODUCT_STARTER` |
| Pro | $20.00 | 2,500 | `DODO_PRODUCT_PRO` |
| Max | $50.00 | 7,000 | `DODO_PRODUCT_MAX` |

The **server-side** map `product_id → credits` is authoritative; credits are also
written into the product metadata, but grants never depend on client input.

### Create the products (idempotent)

```bash
# Reads DODO_PAYMENTS_API_KEY + DODO_PAYMENTS_ENVIRONMENT.
npm run dodo:products
```

It looks up existing products by metadata/name before creating, prints the
`product_id`s, and you paste them into `DODO_PRODUCT_STARTER/_PRO/_MAX`.

> ⚠️ In **`live_mode`** this creates **real, purchasable** products that accept
> **real charges**. Use `test_mode` while developing.

---

## 4. Checkout → webhook → grant

```
Browser ── POST /api/billing/checkout {pack} ──▶ Dodo checkout session
        ◀── checkout_url ── redirect ── customer pays ──▶ Dodo
Dodo ── POST /api/webhooks/dodo (signed) ──▶ verify ─▶ enqueue ─▶ billing worker ─▶ grant credits
```

1. **Checkout** (`routes/billing.ts`): creates/reuses the Dodo customer (stores
   `User.dodoCustomerId`), creates a checkout session for the pack's `product_id`
   with `metadata { userId, credits }`, the return URL, and the allowed payment
   methods (card **+ stablecoin/crypto**, see below), returns `checkout_url`.
2. **Webhook** (`routes/webhooks/dodo.ts`, mounted with a **raw body** parser
   before `express.json()`): verifies the **Standard Webhooks** signature
   (`webhook-id`/`webhook-signature`/`webhook-timestamp` via
   `DODO_PAYMENTS_WEBHOOK_SECRET`). On `payment.succeeded` it enqueues a grant job
   and returns **200 immediately**. An unverified request is rejected — **credits
   are never granted without a verified webhook.**
3. **Billing worker** (`workers/billingWorker.ts`): re-fetches the payment from Dodo
   (server-to-server), maps `product_id → credits` server-side, and grants via a
   `purchase` ledger entry — **idempotent by payment id**. BullMQ retries on
   failure. Run it: `npm run worker:billing`.
4. **Reconciliation fallback** (`POST /api/billing/reconcile {paymentId}`): for a
   missed webhook, verifies the payment by id and grants the same way (idempotent).
   The `/billing` page calls it automatically if it returns with a `payment_id`.

---

### Payment methods (card + stablecoin)

The checkout session sets `allowed_payment_method_types` from
`allowedPaymentMethods()` (`services/billing/config.ts`): card (`credit`/`debit`)
is always included as the required fallback, plus Dodo's `crypto_currency` method
(USDC/USDT and other crypto) when `DODO_ENABLE_CRYPTO` ≠ `false` (default on). The
customer picks card or stablecoin on the Dodo-hosted page.

The **payment method does not affect entitlement**: a stablecoin payment fires the
same `payment.succeeded` webhook and maps `product_id → credits` server-side, so
the verified-webhook → idempotent-grant flow is identical. Enable the crypto method
in your Dodo dashboard as well.

## 5. Live vs test mode

`DODO_PAYMENTS_ENVIRONMENT` gates everything (`services/billing/dodo.ts`). The Dodo
SDK **defaults to `live_mode`**, so be explicit:

- **Dev:** `DODO_PAYMENTS_ENVIRONMENT=test_mode`, test card **4242 4242 4242 4242**
  (any future expiry + CVC). No real money.
- **Prod:** `DODO_PAYMENTS_ENVIRONMENT=live_mode`, live API key + live webhook
  secret. Real products, real charges.

All Dodo secrets are **server-side only** — never sent to the browser or logged.
Point the Dodo dashboard webhook at `https://<api-host>/api/webhooks/dodo`.

---

## 6. API surface

| Method/Path | Purpose |
|-------------|---------|
| `GET /api/billing/balance` | current credit balance |
| `GET /api/billing/plans` | the 3 packs (price + credits) |
| `GET /api/billing/ledger?limit=` | credit history (grants/purchases/usage) |
| `GET /api/billing/usage?limit=` | recent per-run usage (model, cost, credits) |
| `POST /api/billing/checkout` | `{ pack }` → `{ checkout_url }` |
| `POST /api/billing/reconcile` | `{ paymentId }` → idempotent grant (fallback) |
| `POST /api/webhooks/dodo` | signed webhook → enqueue grant (raw body) |

`GET /api/auth/me` returns `credits` and lazily applies the one-time signup grant
(idempotent), which also backfills pre-existing users exactly once.

---

## 7. UI

- **Credit badge** in the Copilot header (`components/billing/credit-badge.tsx`) —
  live-updates after each run via the `credits:updated` window event.
- **Out-of-credits** — a gated run (402) opens the upgrade modal
  (`components/billing/upgrade-modal.tsx`) with the 3 packs → Buy → Dodo checkout.
- **`/billing` page** — balance, totals, the 3 packs, full credit ledger, recent AI
  usage, and the 50-free-credits onboarding note.

---

## 8. Setup checklist

1. `npm install` (adds `dodopayments`, `standardwebhooks`).
2. `npm run migrate:deploy` (applies the `ai_credits` migration).
3. Set `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_SECRET`,
   `DODO_PAYMENTS_ENVIRONMENT`, `DODO_RETURN_URL` (see `env.example`).
4. `npm run dodo:products` → paste the printed ids into `DODO_PRODUCT_*`.
5. Add the webhook endpoint in the Dodo dashboard → copy its secret.
6. Run the billing worker (alongside the others):
   - **Local:** `npm run worker:billing` (or `docker compose up worker-billing`).
   - **Railway:** add a new service from the repo, then
     Settings → Config-as-code → Railway Config File = `railway.worker-billing.toml`.
     It uses the lean `Dockerfiles/Dockerfile.billing` (no Rust toolchain). Set the
     shared `REDIS_URL`, `DATABASE_URL`/`DIRECT_URL`, the `DODO_*` vars, and the
     credit config on the service.

### Deploying the worker

The billing worker is a separate process like the compile/deploy/test/agent
workers, but **lightweight** (no Rust/Stellar image):

| Target | How |
|--------|-----|
| npm | `npm run worker:billing` (prod) · `worker:billing:dev` (watch) |
| docker-compose | `worker-billing` service (`Dockerfiles/Dockerfile.billing`) |
| Railway | a service pointed at `railway.worker-billing.toml` |
| shared worker image | `Dockerfile.worker` also accepts `WORKER_TYPE=billing` |
