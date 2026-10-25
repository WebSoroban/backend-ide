# WebSoroban backend

The API and workers behind [websoroban.in](https://websoroban.in): a browser IDE
for Soroban contracts on Stellar, an AI copilot, x402 paid APIs (WebSoroban Pay),
and PayLoop non-custodial USDC subscriptions.

Express + TypeScript, PostgreSQL through Prisma, Redis + BullMQ for jobs, and a
Rust toolchain in the worker image to compile and test contracts.

## Layout

```
server.ts              Express app; mounts every /api route
routes/                HTTP routes (auth, projects, compile, deploy, contracts,
                       ai, billing, pay, payloop, ideas, …)
services/              Domain logic: Stellar, compilation, x402, PayLoop, billing, AI
workers/               BullMQ workers: compile, deploy, test, agent, billing, payloop
prisma/                Schema and migrations
contracts/payloop/     PayLoop Soroban contract (Rust) + deployments/<network>.json
packages/websoroban-pay  @web-soroban/pay (x402 SDK for Express)
packages/payloop       @web-soroban/payloop (PayLoop SDK)
data/                  Template catalog and project bundles
scripts/               Operational scripts (PayLoop deploy/reconcile, x402 e2e, seeds)
tests/                 node:test unit tests; tests/integration needs a disposable DB
Dockerfile             API + Rust toolchain image (Railway: railway.toml)
Dockerfiles/           Worker and billing images (railway.worker-*.toml)
docs/                  Subsystem guides
```

## Run locally

Node 22+, Docker (for Redis and the Rust image), and a PostgreSQL database.

```bash
cp env.example .env          # fill DATABASE_URL, JWT_SECRET, WALLET_ENCRYPTION_KEY, OAuth keys
docker compose up -d redis
npm install
npm run migrate:deploy
npm run dev                  # API on PORT (3001 by default)
npm run worker:compile:dev   # and any other worker you need
```

`env.example` documents every variable, grouped by subsystem.

## Test

```bash
npm run typecheck
npm test                     # unit tests, both SDKs included
X402_TEST_DATABASE_URL=… npm run test:integration
```

## Deploy

Each service on Railway builds from this repository with its own config file:
`railway.toml` (API) and `railway.worker-<name>.toml` for the compile, deploy,
test, agent, billing, and PayLoop workers. PayLoop runs one worker per network
(`PAYLOOP_NETWORK=testnet|mainnet`).

## Guides

| Guide | Covers |
| --- | --- |
| [docs/X402_PAY.md](docs/X402_PAY.md) | x402 paid endpoints, facilitators, webhooks, spend caps, metrics |
| [docs/PAYLOOP.md](docs/PAYLOOP.md) | PayLoop contract, worker, API, deployments (testnet + mainnet) |
| [docs/NETWORKS.md](docs/NETWORKS.md) | Testnet vs mainnet, custody, RPC configuration |
| [docs/INVOKE_FLOW.md](docs/INVOKE_FLOW.md) | Typed contract invocation |
| [docs/MULTIFILE.md](docs/MULTIFILE.md) | Multi-file contracts and Cargo workspaces |
| [docs/COPILOT.md](docs/COPILOT.md) | The AI copilot |
| [docs/BILLING.md](docs/BILLING.md) | Credits and billing |
| [contracts/payloop/AUDIT.md](contracts/payloop/AUDIT.md) | PayLoop security review and mainnet status |

User-facing documentation lives at [websoroban.in/docs](https://websoroban.in/docs).

## SDKs

| Package | Source |
| --- | --- |
| [`@web-soroban/pay`](https://www.npmjs.com/package/@web-soroban/pay) | [packages/websoroban-pay](packages/websoroban-pay) |
| [`@web-soroban/payloop`](https://www.npmjs.com/package/@web-soroban/payloop) | [packages/payloop](packages/payloop) |
