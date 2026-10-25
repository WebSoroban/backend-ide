# Networks (testnet + mainnet)

WebSoroban runs on both Stellar networks. Testnet is the default and stays fully
custodial + faucet-funded; mainnet is opt-in, real-XLM, and **non-custodial by
default**. This document is the contract for the per-network signing model, the
custody tradeoff, and the funding/export flows.

## 1. Network config

Central config lives in `lib/networks.ts` (backend) and `lib/networks.ts`
(frontend), keyed by `"testnet" | "mainnet"`:

| | testnet | mainnet |
|---|---|---|
| passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| Soroban RPC | `SOROBAN_RPC_URL` (public testnet) | `MAINNET_SOROBAN_RPC_URL` — **SDF runs no public mainnet RPC; set a provider** |
| Horizon | `horizon-testnet.stellar.org` | `MAINNET_HORIZON_URL` (default SDF Horizon) |
| explorer | stellar.expert/explorer/testnet | stellar.expert/explorer/public |
| faucet | Friendbot | **none** |

A Stellar keypair is the **same address on both networks** — the user's existing
`G…` is also their mainnet deposit address. Each network is funded separately, and
a contract deployed on one network is distinct from the other (tracked by
`Deployment.network`; `Project.network` records the latest deploy's network).

Compile is network-agnostic — the same wasm deploys to either network.

## 2. Signing model (the core security design)

| Path | Who signs | Key location |
|------|-----------|--------------|
| **Testnet** (always) | backend, with the generated wallet | encrypted at rest, decrypted in memory at sign time |
| **Mainnet — connected** (default) | the user's browser wallet (Freighter/xBull/Albedo/Lobstr/Hana) | never touches the server |
| **Mainnet — custodial** (explicit opt-in) | backend, with the generated wallet | encrypted at rest, decrypted in memory at sign time |

`Wallet.mainnetSigningMode` (`"connected" | "custodial"`, default `connected`)
persists the choice. Switching to custodial requires an explicit acknowledgement
(`PUT /api/wallet/signing-mode { mode:"custodial", acknowledged:true }`).

### Non-custodial flow (mainnet default)

Deploy is two browser-signed transactions; invoke (write) is one:

```
DEPLOY                                    INVOKE (write)
backend  POST /deploy/prepare (upload)    backend  POST /contracts/:id/invoke (execute,sourcePk)
         → unsigned XDR + fee                      → { needsSignature, xdr, feeXlm }
browser  wallet signs                     browser  wallet signs
backend  POST /deploy/submit  (upload)    backend  POST /contracts/:id/invoke/submit
backend  POST /deploy/prepare (create)             → send + poll → result
browser  wallet signs
backend  POST /deploy/submit  (create) → records Deployment
```

The backend builds + simulates + `prepareTransaction`, returns the XDR, and only
ever submits a signed XDR. It never holds or sees the mainnet secret on this path
(`services/stellarService.ts`).

### Custodial flow

Testnet uses the Stellar CLI with the decrypted key in `STELLAR_ACCOUNT`
(`services/deploymentService.ts`, generalized per-network). Mainnet custodial
reuses the same CLI path behind the opt-in + a `confirm:true` gate
(`POST /api/deploy/custodial`). The secret is decrypted in memory only, never
logged or returned.

## 3. Funding

- **Testnet:** `POST /api/wallet/fund` runs Friendbot. The wallet widget shows a
  "Fund via faucet" button.
- **Mainnet:** no faucet. The widget's button becomes "How to fund" → the
  instruction manual: buy XLM on an exchange or another wallet, send it to your
  `G…` address (no memo for your own account), keep a buffer for the ~1 XLM base
  reserve + ~0.5 XLM/entry + fees/rent. `GET /api/wallet/balance?network=` reports
  the per-network balance.

## 4. Mainnet guarantees

- Mainnet actions **always** simulate first and show the estimated fee in XLM
  before submitting, and **always** require an explicit confirmation. Nothing
  auto-deploys/auto-invokes on mainnet.
- The **AI Copilot can never deploy to mainnet** (`POST /api/ai/runs/:id/deploy`
  rejects mainnet) — only a human at the Deploy panel can.
- Mainnet is rendered amber everywhere (switcher, status bar, badges) so it's
  never confused with testnet green.

## 5. Export private key (self-custody)

`POST /api/wallet/export` reveals the secret once, gated hard:

1. Caller must type `EXPORT` and, if the account has a password, re-enter it.
2. The secret is decrypted in memory, returned with `Cache-Control: no-store`,
   never logged.
3. Every export writes a `KeyExportAudit` row (userId, ip, userAgent, time).

The UI shows it in a copy-once modal (clears on close) with a "download keypair"
option. The same key controls funds on **both** networks — exporting is the
recommended path to self-custody before relying on mainnet.

## 6. Config

```
MAINNET_SOROBAN_RPC_URL=   # required for mainnet — a provider RPC endpoint
MAINNET_HORIZON_URL=https://horizon.stellar.org
```

Migration `20260620000000_mainnet_support` adds `network` to Project/Invocation,
`Wallet.mainnetSigningMode`, and the `KeyExportAudit` table. Existing rows default
to testnet, so nothing changes for current projects.
