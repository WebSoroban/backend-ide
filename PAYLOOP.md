# PayLoop

Non-custodial USDC subscriptions on Soroban. A subscriber signs one policy
(merchant, amount, interval, safety cap). The first charge settles atomically,
a relayer submits later charges on schedule, and the subscriber can pause,
resume, or revoke from their own wallet.

```
contracts/payloop/        Soroban contract (Rust, soroban-sdk 29) + unit tests
  deployments/<net>.json  deployed contract id, wasm hash, start ledger
services/payloop/         config, Soroban RPC helpers, indexer, relayer
workers/payloopWorker.ts  indexer + relayer loop (one active instance via lease)
routes/payloop.ts         /api/payloop: config, policies, charges, stats, reconcile
scripts/payloop-*.ts      deploy, reconcile, live soak test
```

## Contract

| Function | Signer | Behaviour |
| --- | --- | --- |
| `create_policy(subscriber, merchant, amount, interval, cap, allowance_live_until)` | subscriber | Validates terms, grants the allowance, takes the first charge. Any failure reverts everything. |
| `charge(policy_id)` | anyone | Takes a due charge. Returns `Charged`, or reports `InsufficientBalance` / `InsufficientAllowance` without moving funds (recorded on-chain at most once per `min(interval, 1 day)`). |
| `pause` / `resume(policy_id)` | subscriber | Resuming after a missed date starts a new period now. |
| `revoke(policy_id)` | subscriber | Final. Releases the commitment without touching the allowance, so nothing can make it fail. |
| `cancel(policy_id)` | merchant | Final. |
| `refresh_allowance(subscriber, allowance_live_until)` | subscriber | Re-grants exactly the committed allowance: renews before expiry and trims leftovers. |
| `get_policy`, `committed`, `policy_count`, `token` | — | Reads. |

Invariants:

- The allowance covers what the subscriber's live policies may still charge.
  Every charge consumes exactly `amount`. Leftover allowance from ended
  policies cannot be spent, because each policy is capped; `refresh_allowance`
  trims it.
- A policy never charges more than `cap` (at most 100M USDC). It completes when
  less than one charge remains.
- On-time charges keep the schedule. A charge later than
  `min(interval/10, 1h)` re-anchors, so charges are always at least
  `interval − grace` apart and missed periods are never back-billed.
- Intervals run from 1 minute to 90 days, inside the longest allowance a
  network allows. The allowance expiry is never shortened.
- `allowance_live_until` is an explicit, signed argument. The token `approve`
  is part of the subscriber's signed auth tree, so its arguments must be the
  same at simulation and execution; reading the ledger inside the contract
  would fail auth on a live network.

```bash
cd contracts/payloop
cargo test                 # 26 unit tests
stellar contract build     # stellar-cli 25.2+ (soroban-sdk 29 requires its spec shaking)
```

## Deploy

```bash
npm run payloop:deploy -- testnet
```

The script uploads the wasm, creates the instance with the USDC SAC as its
token, reads `token()` back, and writes `contracts/payloop/deployments/testnet.json`.
On testnet it funds a throwaway deployer; set `PAYLOOP_DEPLOYER_SECRET` to use
your own. **Mainnet is refused until the independent review is complete**
(`PAYLOOP_MAINNET_AUDITED=yes`).

Current testnet deployment: see `contracts/payloop/deployments/testnet.json`.

## Run the worker

```env
PAYLOOP_NETWORK=testnet
PAYLOOP_RELAYER_SECRET=S…   # funded with XLM for fees; holds no customer funds
```

```bash
npm run migrate:deploy
npm run worker:payloop:dev     # or worker:payloop after build; Railway: railway.worker-payloop.toml
```

Each tick (default 5s) the worker takes the database lease, then:

1. Indexes new contract events from its stored cursor. Each charge is recorded
   once per RPC event id, and every touched policy is re-read from the
   contract, so the index converges on chain state.
2. Submits `charge` for every due, active policy, one at a time from the
   relayer account. Uncovered charges back off at 1m, 5m, 30m, then 1h. A
   stale index can only cost a fee: the contract rejects anything not due.
3. Indexes again so the API reflects the new charges immediately.

If the RPC's retention window has moved past the cursor, the worker resumes
from the oldest available ledger and logs a gap. Run reconciliation afterwards.

## Verify

```bash
npm run payloop:reconcile                     # exit 1 on any index/chain difference
npx tsx scripts/payloop-soak.ts 3 20 60       # live testnet soak (worker must be running)
```

Reconciliation compares every policy's terms and state, plus its number of
successful charges against the indexed payment rows. `GET /api/payloop/stats`
reports how many recurring charges landed within `PAYLOOP_ON_SCHEDULE_SECONDS`
(default 60) of their due time, and the p50 and p95 lateness.

Last soak (testnet, 2026-10-09, after the security-review fixes): 3 policies,
21 recurring charges with no manual intervention, all within one interval of
their due time (p50 5s, max 10s). A failed first charge left no policy. Pause,
resume, and revoke worked from the subscriber key, and reconciliation matched
3/3 policies.

## API

- `GET /api/payloop/config`: network, contract id, token, explorer
- `GET /api/payloop/policies?subscriber=…|merchant=…[&status=]`
- `GET /api/payloop/policies/:id`: policy plus its last 50 charges
- `GET /api/payloop/stats`: policies by status, charge outcomes, on-schedule metrics
- `POST /api/payloop/reconcile`: admin only

## Before mainnet

- Independent security review of `contracts/payloop` (no mainnet funds before
  it). The package for the reviewers, including the internal review's
  findings and their fixes, is `contracts/payloop/AUDIT.md`.
- A dedicated relayer account with fee monitoring and alerting.
- Alerting on worker tick failures, retention gaps, and reconciliation mismatches.

## Mainnet launch runbook

Already prepared on Railway (project `soothing-appreciation`):

- Service `payloop-worker-mainnet`, **no source connected**, so it cannot
  deploy. Variables: `PAYLOOP_NETWORK=mainnet`, database and mainnet
  RPC/Horizon referenced from `backend-ide`, start command
  `node dist/workers/payloopWorker.js`, Dockerfile `/Dockerfiles/Dockerfile.billing`.
- A dedicated mainnet relayer account, `GDHWVODNRWJZGKWMXXIOYU4AX35BG5XKYT3NIQALVNS44KQRRWOS3U7E`.
  Its secret is stored only in that service's `PAYLOOP_RELAYER_SECRET`. It is
  not funded and holds no customer funds.

Launch, in order, only after the independent review is complete:

1. Confirm the reviewed commit builds to the reviewed wasm hash
   (`stellar contract build`, then `shasum -a 256`).
2. Deploy: `PAYLOOP_DEPLOYER_SECRET=<funded mainnet key> PAYLOOP_MAINNET_AUDITED=yes npm run payloop:deploy -- mainnet`.
   Commit `contracts/payloop/deployments/mainnet.json`.
3. Fund the relayer account with XLM for fees (each charge costs well under
   0.01 XLM; 50 XLM covers thousands).
4. Push the commit to `main`, then connect `payloop-worker-mainnet` to
   `harshdev2909/backend-ide` on `main`. Check its first log line names the
   mainnet contract, and that `npm run payloop:reconcile` with
   `PAYLOOP_NETWORK=mainnet` reports 0 mismatches.
5. Decide how the API exposes mainnet. `/api/payloop` serves the single
   network in the API's `PAYLOOP_NETWORK`. Switching it to `mainnet` moves the
   public demo to real funds. Serving both networks side by side needs a
   network parameter on the PayLoop routes and pages.
