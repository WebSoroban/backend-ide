# Invoke flow — compile → deploy → invoke

How WebSoroban turns a compiled contract into a real, type-aware invoke
experience. **Testnet only.** User secret keys are AES-256-GCM encrypted at rest
and decrypted **in memory only** at sign time — never logged, never returned.

## 1. The spec is the foundation

Every Soroban WASM embeds its interface in a custom section named
`contractspecv0` — a concatenated stream of XDR `ScSpecEntry` values.

- `services/contractSpec.ts` parses that section directly from the WASM bytes
  (no CLI dependency): it walks the WASM sections, finds `contractspecv0`, and
  decodes entries one-by-one with `cereal.XdrReader` + `xdr.ScSpecEntry.read`.
- On **successful compile** (`workers/compileWorker.ts`) and on **deploy**
  (`workers/deployWorker.ts`) the parsed spec `{ entries, functions }` and the
  WASM sha-256 are persisted on `Project.spec` / `Project.wasmHash` (and the
  `Deployment` row).
- `GET /api/contracts/:contractId/spec` returns the function list
  (`{ name, doc, inputs:[{name,type}], outputs }`) the frontend builds the form
  from. If a contract was deployed before specs were stored, the endpoint falls
  back to `rpc.getContractWasmByContractId` and caches the result.

## 2. ScVal encoding — never hand-rolled

Args are **always** encoded through the spec:

```
const spec = buildSpec(project.spec.entries)        // contract.Spec
const scVals = spec.funcArgsToScVals(fnName, argsByName)
```

`argsByName` is an object keyed by parameter name (the frontend form produces
exactly this). The only pre-coercion is `Bytes/BytesN` hex strings → `Buffer`;
everything else (ints as strings, `bool`, `Address` G…/C…, `Vec`/`Map`/structs
as JSON) is handled by the SDK from the spec types.

Results are decoded with `spec.funcResToNative(fnName, retval)` and made
JSON-safe (BigInt → string, Buffer → hex, Map → object).

## 3. Read vs write — `POST /api/contracts/:contractId/invoke`

Body: `{ functionName, args, execute?, clientRef? }`. The service **always
simulates first**, then branches:

### READ (simulate) — fast, synchronous, no signature
1. Build the op: `new Contract(id).call(fn, ...scVals)`.
2. `rpc.simulateTransaction(tx)`.
3. Decode `retval` with `funcResToNative`.
4. Read-only is inferred from the simulation: **no footprint writes and no auth
   entries ⇒ read-only**.
5. Return `{ readOnly:true, status:'simulated', result, resourceFee, cost }`.

### WRITE (sign + submit) — only when state-changing AND `execute === true`
1. `rpc.prepareTransaction(tx)` — assembles footprint, auth, and resource fees
   from the simulation.
2. Load the requesting user's keypair (`walletService.loadKeypair`, decrypted in
   memory only) and `prepared.sign(keypair)`.
3. `rpc.sendTransaction(prepared)` → `rpc.pollTransaction(hash)` until
   `SUCCESS` / `FAILED` / timeout.
4. Decode the return value + diagnostic events; return
   `{ status, txHash, returnValue, events, resourceFee }`.

If the call is state-changing but `execute` is `false`, the endpoint returns the
**simulated** result with `readOnly:false` so the UI can show
“Invoke & sign”. Live status (`submitted → pending → confirmed/failed`) is
published over socket.io to the room named by `clientRef`.

Every call is persisted as an `Invocation` row (status, txHash, decoded
returnValue, resourceFee, humanized error). **Return values are stored; secret
keys are not.**

## 4. Errors

`humanizeError()` maps raw host/RPC errors to actionable messages — contract
error codes, auth failures, insufficient balance (offers the faucet), expired
footprints, missing account — never a stack trace.

## 5. Function tests

Saved per-function cases (`FunctionTest`): `{ name, args, expected }` where
`expected` is `{ mode: 'success' | 'equals' | 'contains', value? }`.
`POST /api/contracts/:contractId/tests/run` executes each via the **simulate**
path and reports `passed/total` with actual vs expected. This is what gives the
“Function tests N/M” counter real meaning.

## 6. Compile hardening

- `services/diagnostics.ts` parses cargo/rustc output into structured
  diagnostics (`level/code/file/line/column/message`); the compile worker
  attaches them to the job result and the frontend renders them as Monaco gutter
  markers on the active file.
- `services/compilationService.ts` caches builds by source hash (bounded,
  in-process) to skip redundant compiles, and always extracts + stores the spec
  on success.

## 7. Deploy hardening

- WASM hash + spec are recorded on the `Project` and `Deployment` rows.
- The deploy is signed with the user's per-user testnet wallet, which is
  auto-created and Friendbot-funded (and self-heals if a previous funding
  failed) via `walletService.getOrCreateWallet`.

## Schema migration

The invoke pipeline adds `Project.spec`, `Project.wasmHash`,
`Deployment.wasmHash`, `Deployment.spec`, and the `Invocation` + `FunctionTest`
models. After pulling these changes, run:

```
npx prisma migrate dev --name invoke_pipeline   # local
npx prisma migrate deploy                        # production
```

No new environment variables are required (`SOROBAN_RPC_URL`,
`WALLET_ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_*` already exist).
