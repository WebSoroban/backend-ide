# PayLoop: audit package

This is the package for the **independent** security review that must be
completed before any mainnet funds (OKR KR2.7). The internal review below does
not replace that review.

## Scope

| Item | Value |
| --- | --- |
| Source | `contracts/payloop/src/lib.rs` (single contract, no dependencies beyond `soroban-sdk`) |
| SDK | `soroban-sdk` 29.0.0, protocol 29 |
| Build | `stellar contract build` (stellar-cli ≥ 25.2), `Cargo.lock` committed |
| Wasm hash | see `deployments/testnet.json` (`wasmHash`); must match a fresh build of the audited commit |
| Tests | `cargo test`: 26 unit tests |
| Upgradeability | None. No admin and no upgrade path; a fix means a new deployment |
| Token | Fixed at construction: the USDC Stellar Asset Contract for the network |

Out of scope, but context for the reviewers: the off-chain relayer and indexer
(`services/payloop/`, `workers/payloopWorker.ts`). The contract must stay safe
even if they are malicious.

## Roles

- **Subscriber:** signs `create_policy`, `pause`, `resume`, `revoke`, `refresh_allowance`.
- **Merchant:** receives charges; may `cancel`.
- **Anyone (relayer):** may call `charge`.

## Invariants to verify

1. A charge pays only `policy.merchant`, exactly `policy.amount`, only while
   the policy is `Active`, only when `now ≥ next_charge_at`, and never so that
   `spent > cap`.
2. Consecutive successful charges of one policy are at least
   `interval − min(interval/10, 3600)` seconds apart.
3. `committed(subscriber)` equals the sum of `cap − spent` over the
   subscriber's `Active` and `Paused` policies.
4. The contract can move subscriber funds only through `charge` and the first
   charge inside `create_policy`; it never holds a balance.
5. `create_policy` is atomic: on any failure there is no policy, no
   commitment, and no allowance change.
6. `revoke` and `cancel` are final, and a final policy can never be charged.
7. A subscriber's allowance expiry is never shortened by the contract.
8. Only the subscriber can pause, resume, revoke, or refresh, and only the
   merchant can cancel.

## Internal review (2026-10-09)

This was an adversarial review by a separate reviewer with no shared context.
It added 14 exploratory tests on a copy of the crate. It found no Critical or
High issues and no way for a non-subscriber to move more than a policy permits.

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| M1 | Medium | A charge `interval−1`s late kept the anchored schedule, so the next charge was due ~1s later. A late top-up after a failed charge effectively back-billed a period. | **Fixed.** A charge later than the grace period re-anchors: next = max(due + interval, now + interval − grace). Tests `late_charges_are_never_followed…` and `a_late_top_up_does_not_back_bill…`. |
| M2 | Medium | Anyone could call `charge` repeatedly on an uncovered policy to inflate `failed_attempts` and flood `ChargeFailed` events. | **Fixed.** A failure counts at most once per `min(interval, 1 day)` (`last_failed_at`). Test `uncovered_charge_is_recorded…` (mutation-checked). |
| M3 | Medium | `MAX_INTERVAL` (366d) exceeded the longest allowance a network allows (~180d), so long-interval policies could never charge twice. | **Fixed.** `MAX_INTERVAL_SECONDS` = 90 days. |
| L1 | Low | The allowance can be above `committed` (leftover after completion or cancel) or below it (the subscriber lowers it directly on the SAC). | **Accepted, documented.** Above: not spendable, because each policy is capped. Below: charges report `InsufficientAllowance`; `refresh_allowance` restores it. |
| L2 | Low | A shorter `allowance_live_until` on a later call shortened the expiry for every live policy. | **Fixed.** The expiry is tracked per subscriber and never shortened. Test `a_shorter_expiry_never_shortens…` (mutation-checked). |
| L3 | Low | `revoke`'s signed approve amount depended on `committed` at simulation; a concurrent charge or cancel made revoke fail auth. | **Fixed.** `revoke` no longer touches the allowance; `refresh_allowance` trims separately. Test `revocation_cannot_be_blocked…`. |
| I1 | Info | The merchant could be the token contract. | **Fixed.** Rejected as `InvalidParty`. |
| I2 | Info | An unbounded cap allowed an i128::MAX allowance. | **Fixed.** `MAX_CAP` = 100M USDC. |
| I3 | Info | Identical duplicate policies are allowed. | **Accepted.** Front ends guard against double submission. |
| S1 | Low | Only `create_policy` extended the instance TTL. | **Fixed.** Every mutating entry point extends it. |
| S2 | Low | A frozen or deauthorized trustline, or a merchant without a trustline, makes `transfer_from` revert instead of recording `ChargeFailed`. | **Accepted, documented.** The relayer records the error off-chain; only the merchant can grief themselves. |
| S3 | Info | The token is not validated at construction and cannot be changed. | **Mitigated** by the deploy script, which reads `token()` back and refuses a mismatch. |
| Events | Info | Revoke and cancel were indistinguishable. | **Fixed.** `StatusChanged.actor` names the subscriber, the merchant, or the contract (completion). |

## Accepted design risks (for the reviewers to challenge)

- One SAC allowance is shared by all of a subscriber's policies (L1).
- Subscriptions longer than an allowance (~100 days by default) need the
  subscriber to sign `refresh_allowance`. Until then charges report
  `InsufficientAllowance`.
- `pause` and `resume` let a subscriber skip periods; that is the merchant's risk.
- `create_policy`'s signed approve amount depends on `committed` at simulation
  time. A charge on another of the subscriber's policies in that window makes
  creation fail auth, and the client retries.
- No admin, no pause switch, no upgrade.

## Mainnet status

Deployed to mainnet on 2026-10-25 as
`CDQ6I65CP3JHLNGMEHWE4BP2OMLWOUMZ77U53JPAURFZPZBVH6PYEXPN`
(wasm `d42be154c35ac597792f41d83ccf1d70abd29edebdec135a44ce31fd78a19318`, the
same build as testnet), **after the internal review only**. No independent
audit has been completed; `deployments/mainnet.json` records `"audited": false`,
the API reports it, and the PayLoop page shows an unaudited notice on mainnet.
When an independent review of this wasm completes, set `"audited": true` in
the manifest. Any contract change requires a new deployment.

## Reproduce

```bash
cd contracts/payloop
cargo test
stellar contract build
shasum -a 256 target/wasm32v1-none/release/payloop.wasm   # compare with deployments/<network>.json
```

Live behaviour on testnet: `npx tsx scripts/payloop-soak.ts 3 20 60` with the
worker running (see `docs/PAYLOOP.md`).
