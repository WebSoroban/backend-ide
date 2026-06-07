# Migration Notes — MongoDB → Neon (Postgres/Prisma), feature removal, per-user wallets

This backend was migrated off MongoDB/Mongoose to **Neon.tech serverless Postgres
via Prisma**, had several features removed, and now uses **per-user Stellar
testnet wallets** for server-side contract deploys.

---

## 1. Database: Neon + Prisma

### Connection strings

Prisma needs two URLs (set both in `.env`, and in Railway env vars):

| Var | Purpose | Source |
| --- | --- | --- |
| `DATABASE_URL` | Pooled connection, used at runtime | Neon dashboard → "Pooled connection" |
| `DIRECT_URL`   | Direct (non-pooled), used for migrations | Same string with `-pooler` removed from the host |

Both must end with `?sslmode=require`. Example:

```
DATABASE_URL=postgresql://user:pass@ep-foo-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require
DIRECT_URL=postgresql://user:pass@ep-foo.us-east-1.aws.neon.tech/neondb?sslmode=require
```

> Note: avoid `channel_binding=require` on `DIRECT_URL` — Prisma's migration
> engine can fail to connect with it. `sslmode=require` is sufficient.

### Running migrations

```bash
npm install                 # runs `prisma generate` via postinstall
npx prisma migrate dev      # local: create/apply a migration
npm run migrate:deploy      # CI/prod: apply committed migrations (prisma migrate deploy)
```

The initial migration lives in `prisma/migrations/`. On **Railway** the start
command runs migrations automatically before boot:

```
npx prisma migrate deploy && npm start
```

### Schema overview (`prisma/schema.prisma`)

`User`, `Wallet` (1‑1 with User), `Project` → `File[]` / `Deployment[]`, `Job`,
`Invite`, `Subscription`, `Payment`, `UsageLog`, `TemplatePurchase`.

- IDs are `cuid()`. API responses expose `_id` (= `id`) for frontend
  compatibility via `lib/serialize.js`.
- `User.subscription` and `User.usage` are JSON columns (denormalized current
  state); the relational `Subscription` table keeps full history. The plan /
  usage logic that used to be Mongoose instance methods now lives in
  `services/userService.js`.
- Embedded `Project.files` became the `File` table; `Project.deploymentHistory`
  became the `Deployment` table (serialized back to `deploymentHistory` in
  responses).

The singleton client is `lib/prisma.js` — import it everywhere instead of
`mongoose` models.

---

## 2. Removed features

API keys, webhooks, the RPC tester, and the blockchain explorer were removed
end to end: their routes, models, services, queue jobs, middleware, workers, and
env vars are gone (`apikeys`, `webhooks`, `rpc`, `accounts`, `transactions`, the
contract-events endpoint, the indexer + webhook workers, `ApiKey`/`Webhook`/
`Transaction`/`Block`/`ContractEvent`/`IndexerState` models).

`routes/contracts.js` keeps only the authenticated `POST /:contractAddress/invoke`.
The `docker-compose.yml` no longer starts MongoDB or the indexer/webhook workers.

> Frontend note: `web-soroban/lib/devApi.ts` (apikeys/webhooks/RPC/explorer dev
> pages) now points at removed endpoints and will 404. Remove those pages
> separately on the frontend.

---

## 3. Per-user testnet wallets + server-side deploy

**Testnet only** — the network passphrase, Friendbot, Horizon, and Soroban RPC
endpoints are hardcoded; there is no mainnet path.

### Encryption key

Wallet secret keys are AES‑256‑GCM encrypted at rest (`lib/crypto.js`). Generate
the key and set `WALLET_ENCRYPTION_KEY` (base64, 32 bytes):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Ciphertext is stored as `base64(iv ‖ authTag ‖ ciphertext)`. Secrets are
**never** stored in plaintext, never logged, and never returned by any API.

### Wallet flow (`services/wallet.js`)

- On first successful OAuth login (Google/GitHub/Discord) and on the
  external-wallet sign-in path, the server calls `getOrCreateWallet(userId)`,
  which generates a `Keypair`, encrypts + persists the secret, and funds the
  account via Friendbot (`https://friendbot.stellar.org/?addr=PUBKEY`).
- If the frontend owns OAuth (e.g. NextAuth), it should call
  `POST /api/wallet/ensure` post-login to create + fund the wallet.

### Wallet endpoints (all require an authenticated session)

| Method | Path | Returns |
| --- | --- | --- |
| GET  | `/api/wallet/me`     | `{ publicKey, funded, balance }` |
| POST | `/api/wallet/ensure` | creates+funds if missing, returns `{ publicKey, funded, balance }` |
| POST | `/api/wallet/fund`   | re-runs Friendbot if balance is low, returns `{ publicKey, funded, balance }` |

`GET /api/deploy/wallet-info` also returns the same public info.

### Deploy

`POST /api/deploy` (queued) and `POST /api/deploy/prepare-deployment` (sync) both
sign with the requesting user's wallet. `deploymentService.deployContract` loads
the user's keypair in memory (`loadKeypair`) and hands the secret to the Stellar
CLI via the `STELLAR_ACCOUNT` environment variable — never on the command line
or in logs. Each successful deploy is recorded as a `Deployment` row with the
deployer's `publicKey` and the resulting contract id.

---

## 4. Env var changes

Removed: `MONGODB_URI`, `RPC_LOG_REQUESTS`, `INDEXER_INTERVAL_MS`,
`WEBHOOK_WORKER_CONCURRENCY`, `DEPLOY_SECRET_KEY` (shared deploy wallet).

Added: `DATABASE_URL`, `DIRECT_URL`, `WALLET_ENCRYPTION_KEY`.

See `env.example` for the full list.

---

## 5. Quick start (local)

```bash
cp env.example .env          # fill in DATABASE_URL, DIRECT_URL, WALLET_ENCRYPTION_KEY, JWT_SECRET, OAuth
npm install                  # installs deps + prisma generate
npx prisma migrate deploy    # or migrate dev for a fresh DB
redis-server &               # BullMQ needs Redis
npm run dev                  # API on :3001
npm run worker:compile       # compile worker
npm run worker:deploy        # deploy worker (needs the Stellar CLI installed)
```
