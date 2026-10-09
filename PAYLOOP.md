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
| `charge(policy_id)` | anyone | Takes a due charge. Returns `Charged`, or records `InsufficientBalance` / `InsufficientAllowance` on-chain without moving funds. |
| `pause` / `resume(policy_id)` | subscriber | Resuming after a missed date starts a new period now. |
| `revoke(policy_id, allowance_live_until)` | subscriber | Final. Shrinks the allowance to the remaining policies' commitment. |
| `cancel(policy_id)` | merchant | Final. |
| `refresh_allowance(subscriber, allowance_live_until)` | subscriber | Re-grants exactly the committed allowance. |
| `get_policy`, `committed`, `policy_count`, `token` | — | Reads. |

Invariants:

- The allowance granted to the contract equals what the subscriber's live
  policies may still charge. Every charge consumes exactly `amount`.
- A policy never charges more than `cap`. It completes when less than one
  charge remains.
- Charges stay on the original schedule but never back-bill missed periods.
- `allowance_live_until` is an explicit, signed argument. The token `approve`
  is part of the subscriber's signed auth tree, so its arguments must be the
  same at simulation and execution; reading the ledger inside the contract
  would fail auth on a live network.

```bash
cd contracts/payloop
cargo test                 # 21 unit tests
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

Last soak (testnet, 2026-10-09): 3 policies, 21 recurring charges with no
manual intervention, all within one interval of their due time (p50 5s,
max 15s). A failed first charge left no policy. Pause, resume, and revoke
worked from the subscriber key, and reconciliation matched 4/4 policies.

## API

- `GET /api/payloop/config`: network, contract id, token, explorer
- `GET /api/payloop/policies?subscriber=…|merchant=…[&status=]`
- `GET /api/payloop/policies/:id`: policy plus its last 50 charges
- `GET /api/payloop/stats`: policies by status, charge outcomes, on-schedule metrics
- `POST /api/payloop/reconcile`: admin only

## Before mainnet

- Independent security review of `contracts/payloop` (no mainnet funds before it).
- A dedicated relayer account with fee monitoring and alerting.
- Alerting on worker tick failures, retention gaps, and reconciliation mismatches.
