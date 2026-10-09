# KR1.1 study: scaffold to first paid request in under 30 minutes

Goal: a developer with no x402 experience goes from the Paid API template to
their first successful paid request in **≤ 30 minutes (median of 5)**.

## Participants

- 5 developers outside the WebSoroban team, comfortable with Node/TypeScript.
- No prior x402 or Soroban payment experience (ask before booking).
- Their own laptop, Node 22+, a browser with Freighter installed.
- Sign them up with a non-team email so the adoption report counts them.

## Setup (observer, before the session)

- Production backend on the `x402` release, with migrations applied.
- `X402_INTERNAL_DOMAINS` and `ADMIN_EMAILS` set, so team accounts are excluded.
- A blank screen recording, a stopwatch, and the data sheet below.
- Do **not** pre-fund their wallet: funding is part of the measured path.

## Script (read aloud, then stay silent)

> "Using WebSoroban, create an API endpoint that charges 0.01 USDC per request
> on Stellar testnet, run it on your machine, and make one paid request to it.
> Think out loud. I can't help unless you're stuck for five minutes."

**Start the clock** when they open the **Paid API endpoint** template.
**Stop the clock** when a paid request returns HTTP 200 with a settlement
receipt, either from `pnpm pay` or from the hosted checkout.

Intervene only after five minutes stuck on one step. Log every intervention,
and count the session as *assisted* if you intervened.

## Data sheet (one row per participant)

| Field | Notes |
| --- | --- |
| Participant id | P1–P5 |
| Start / stop time | Stopwatch |
| Total minutes | Primary metric |
| Assisted? | yes/no, with intervention notes |
| Step where most time went | template, endpoint, env, trustline, funding, pay |
| Errors seen | Exact message text |
| Wallet | Freighter / other |
| Payment path | `pnpm pay` / hosted checkout |

## Cross-check from data

The backend measures each account's time from **endpoint creation** to its
first payment from a payer other than the endpoint itself:

```bash
npx tsx scripts/x402-adoption.ts
```

`Endpoint → first paid request` should agree with the stopwatch minus the time
spent before creating the endpoint. A large gap means the clock or the account
was wrong.

## Pass criteria

- **Pass:** median of the 5 unassisted totals ≤ 30 minutes.
- Report the median, the slowest participant, and the top 3 friction steps.
- Fix the friction steps, then repeat in P2 with 5 new participants, as the OKR
  requires.

## Debrief questions

1. What was the most confusing step?
2. Was any error message unclear? Which one?
3. Would you put this in front of a real API today? What would stop you?
