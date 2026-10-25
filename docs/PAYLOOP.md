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
packages/payloop/         @web-soroban/payloop SDK (testnet + mainnet)
```

PayLoop runs on testnet and mainnet side by side: one contract, one relayer
worker, and one index per network. The API serves both, selected with
`?network=`.

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
your own. On mainnet the script requires one of two explicit acknowledgements:

- `PAYLOOP_MAINNET_AUDITED=yes`: an independent review of this exact wasm is
  complete. Records `"audited": true`.
- `PAYLOOP_ACCEPT_UNAUDITED_MAINNET=yes`: launch on the internal review only.
  Records `"audited": false`; the API reports it and the PayLoop page shows an
  unaudited notice on mainnet.

Deployments: `contracts/payloop/deployments/<network>.json`.

## Run the worker

One worker per network. Each worker reads only `PAYLOOP_NETWORK`:

```env
PAYLOOP_NETWORK=testnet     # or mainnet
PAYLOOP_RELAYER_SECRET=S…   # that network's relayer; XLM for fees, no customer funds
```

Per-network overrides for the API process: `PAYLOOP_CONTRACT_ID_MAINNET`,
`PAYLOOP_START_LEDGER_MAINNET` (and `_TESTNET`). The unsuffixed variables apply
to `PAYLOOP_NETWORK` only. Demo merchants: `PAYLOOP_DEMO_MERCHANT` (testnet),
`PAYLOOP_MAINNET_DEMO_MERCHANT` (mainnet).

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
npm run payloop:reconcile -- mainnet          # exit 1 on any index/chain difference (default: PAYLOOP_NETWORK)
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

Every route takes `?network=testnet|mainnet` (default `testnet`). A network
with no deployment returns 404.

- `GET /api/payloop/config`: network, contract id, token, explorer, demo
  merchant, `networks` (which are deployed), `audited` (mainnet)
- `GET /api/payloop/policies?subscriber=…|merchant=…[&status=]`
- `GET /api/payloop/policies/:id`: policy plus its last 50 charges
- `GET /api/payloop/stats`: policies by status, charge outcomes, on-schedule metrics
- `POST /api/payloop/reconcile`: admin only

## SDK

`packages/payloop` is published as `@web-soroban/payloop`. It builds unsigned
contract calls for any wallet, submits with confirmed-failure retry, reads
policies from the contract and the API, and verifies SEP-53 signatures. See its
README. Build and publish: `cd packages/payloop && npm publish`.

## Mainnet operations

- `contracts/payloop/AUDIT.md` is the reviewer package and records whether the
  live deployment was independently audited.
- Watch the mainnet relayer's XLM balance; each charge costs well under
  0.01 XLM. Alert on worker tick failures, retention gaps, and reconciliation
  mismatches.

## Deployments

| | Testnet | Mainnet |
| --- | --- | --- |
| Contract | `CCNMZWP2NQMTJF2J42W4DNYNOAQQYWOCJ2IQROXWYSJVOI3DKSH7YRIH` | `CDQ6I65CP3JHLNGMEHWE4BP2OMLWOUMZ77U53JPAURFZPZBVH6PYEXPN` |
| Wasm hash | `d42be154…a19318` | `d42be154…a19318` (same build) |
| Token | Circle test USDC | Circle USDC (`CCW67TSZ…MI75`) |
| Review | internal | internal only (`audited: false`) |
| Relayer | Railway `payloop-worker` | Railway `payloop-worker-mainnet`, `GDHWVODN…3U7E` |
| Deployed | 2026-10-09 | 2026-10-25, ledger 65131811 |

Mainnet launched on 2026-10-25 after the internal review, without an
independent audit; `contracts/payloop/AUDIT.md` records the decision. The
mainnet demo merchant is the deployer account (`GAS3763…MKVQ`), which holds a
Circle USDC trustline. Relayer secrets live only in the Railway service
variables.

To redeploy on mainnet: build the reviewed commit, check the wasm hash
(`shasum -a 256`), run
`PAYLOOP_DEPLOYER_SECRET=<funded key> PAYLOOP_MAINNET_AUDITED=yes npm run payloop:deploy -- mainnet`
(the upload alone costs about 19 XLM in storage fees), commit the manifest,
redeploy the API and `payloop-worker-mainnet`, and reconcile.
