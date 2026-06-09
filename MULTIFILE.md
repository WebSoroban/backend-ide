# Multi-file (multi-page) contract support

WebSoroban contracts can now span many files and modules — and even Cargo
workspaces — instead of a single flat `lib.rs`. This doc covers the three things
that make that work: the **path model**, the **build-context assembly**, and the
**single-crate vs. workspace deploy logic**. Testnet only.

---

## 1. The path model

Files form a **tree**, addressed by a project-relative POSIX `path`.

- `File.path` — the project-relative path, e.g. `src/lib.rs`, `src/storage.rs`,
  `src/admin/mod.rs`, `tests/integration.rs`, `Cargo.toml`, `.cargo/config.toml`.
  `(projectId, path)` is **unique**.
- `File.name` — kept as the **leaf** (last path segment) for display and API
  back-compat.
- Folders are **derived from path segments** — there is no `Folder` table.
  Rust does not need empty directories, so empty folders are not persisted
  (the explorer shows a client-only placeholder until you add a file).
- `Project.manifestPath` — project-relative path of the driving `Cargo.toml`
  (default `"Cargo.toml"`).
- `Project.deployTarget` — for workspaces, the crate/package name whose wasm is
  deployed. Null for single-crate projects.
- `Deployment.deployTarget` — records which workspace member each deploy targeted.

The single source of truth for path rules is **`lib/paths.ts`** (server) and
**`web-soroban/lib/paths.ts`** (client, for fast UX feedback; the server is
authoritative).

### Sanitization (untrusted input)

`sanitizeRelPath()` rejects anything that could escape the build dir, and is
called for **every** file before it touches disk:

- no absolute paths / no leading `/`
- no `.` or `..` segments (no traversal)
- no backslashes, no Windows drive letters, no `scheme://`
- no NUL bytes, no whitespace inside a segment, no empty segments
- depth and segment-length caps

`materializeTree()` then re-checks containment with `path.resolve` (defense in
depth) so a crafted path can never write outside the per-build sandbox.

### Migration + backfill

`prisma/migrations/20260609000000_multifile_paths` adds the columns and
**backfills `File.path`** for every existing project, reproducing the flat→tree
mapping the build worker used to synthesize at compile time:

| legacy flat name      | tree path        |
| --------------------- | ---------------- |
| `lib.rs` / `main.rs`  | `src/lib.rs`     |
| `test.rs` / `tests.rs`| `tests/test.rs`  |
| `<other>.rs`          | `src/<other>.rs` |
| `Cargo.toml`          | `Cargo.toml`     |
| `.cargo/config.toml`  | `.cargo/config.toml` (unchanged) |

The same mapping is implemented in `lib/paths.ts#legacyNameToPath` and re-applied
by `scripts/backfill-file-paths.ts` (`npm run backfill:file-paths`) for projects
created by older code paths. The migration is self-contained — `prisma migrate
deploy` alone leaves existing single-file projects compiling and deploying
**identically** (verified: a migrated `src/lib.rs` + `Cargo.toml` builds with no
`[lib] path` injection).

> Collisions (e.g. a project with both `lib.rs` and `main.rs`) are de-duped by
> prefixing the 2nd+ occurrence with `dupN/` so the unique index always applies.

---

## 2. Build-context assembly

`services/projectLayout.ts` turns the flat `{path, content}[]` into a real,
validated Cargo build context. The compile, test, and deploy paths all share it.

1. **Materialize** (`materializeTree`) — write the full tree into a per-job temp
   dir at each file's exact relative path (`mkdir -p`), sanitized and
   containment-checked. No filename fixups, no `[lib] path` injection: the
   contract lives at its real `src/lib.rs`.
2. **Validate** (`validateProject`) — clear, file-attributed pre-flight errors:
   - the manifest exists at `manifestPath`;
   - `[package] name` is present (per crate);
   - every `mod NAME;` resolves to `NAME.rs` or `NAME/mod.rs` relative to the
     declaring file (lib/main/mod declare in their own dir; any other `foo.rs`
     declares in a `foo/` subdir);
   - a `#[contract]` entrypoint exists in the target crate's `src/`.
3. **Build cache** — keyed off `hashTree()` (sorted path+content of the **entire
   tree**), so a change in *any* file busts the cache, not just the entrypoint.
4. **Compile** — `stellar contract build` runs from the manifest's directory;
   modules and workspace members are picked up automatically from the files on
   disk.
5. **WASM discovery is path-agnostic** — `findWasm(buildDir, crateName)` locates
   `target/<triple>/release/<crate>.wasm` (hyphens → underscores), preferring the
   deploy-target crate. No hard-coded `contract.wasm`.
6. **Diagnostics route per file** — `services/diagnostics.ts` parses the `-->
   src/storage.rs:line:col` locations cargo emits (relative to the build dir), so
   an error in `storage.rs` highlights `storage.rs` in the editor gutter. The
   frontend matches markers by **full path** so two `mod.rs` in different folders
   never collide.

Temp dirs and containers are always cleaned up in a `finally` block, even on
failure.

### Tests (`services/testService.ts`)

`cargo test --no-fail-fast` runs across the crate (or `-p <deployTarget>` for a
workspace). The libtest human output is parsed into per-test
`{file, name, passed, durationMs, output}`:

- the `Running <src>` line + the test's module path are walked against the file
  tree to map each test back to its **source file** — unit tests
  (`#[cfg(test)]` modules anywhere in `src/`) land on their module's file,
  integration tests land on their `tests/<file>.rs`;
- the "Tests N/M" counter reflects the real discovered test count across all
  files;
- a non-zero exit with zero parsed tests means the test binary failed to
  **compile** (vs. tests ran and failed) — surfaced with per-file diagnostics.

Runs as its own BullMQ queue/worker (`queues/testQueue.ts`,
`workers/testWorker.ts`, `POST /api/test`), mirroring compile/deploy.

---

## 3. Deploy: single-crate vs. workspace

Deploy still takes an already-compiled `wasmBase64` and signs with the user's
per-user testnet wallet — that is unchanged. What changed is **which** wasm and
**how the target is chosen**.

### Single crate (the common case)

Behavior is unchanged. Compile discovers the produced wasm by crate name
(path-agnostic), deploy uploads + instantiates it, and stores the contract id +
wasm hash + spec. One `Deployment` row per deploy.

### Workspace (`[workspace]` manifest)

- `validateProject` detects the workspace and lists **deployable members**
  (crates that are `cdylib` **and** have a `#[contract]` entrypoint).
- `GET /api/projects/:id/build-info` reports `{ isWorkspace, deployableCrates,
  deployTarget, requiresTargetSelection }`.
- If there is **more than one** deployable contract and no `deployTarget` is set,
  `POST /api/deploy` returns `400 DEPLOY_TARGET_REQUIRED` with the choices. The
  IDE prompts the user to pick one; the choice is persisted on the project
  (`PUT /api/projects/:id` → `deployTarget`) and used for compile (so the wasm is
  the chosen member's) and deploy.
- The compile worker surfaces the chosen member's wasm
  (`findWasm(buildDir, deployTarget)`); the deploy worker records `deployTarget`
  on the `Deployment` row, so multiple deployable members are tracked
  separately and can be deployed per-contract.
- **Idempotency by wasm hash**: each `Deployment` stores the SHA-256 of the wasm;
  re-uploading identical wasm is deduped by the network (the upload step is
  content-addressed by hash), while each instantiate yields its own contract id.

---

## Templates are bundles

`data/templateBundles.ts` defines the template format as a bundle:

```ts
{ manifestPath, deployTarget?, defaultTests?, files: [{ path, content }] }
```

"Use template" scaffolds the whole tree into a new project and persists
`manifestPath` / `deployTarget`. Single-file templates are just one-file bundles;
the legacy single-file templates keep working (their flat names are mapped to
tree paths by the same `legacyNameToPath` rules).

Seeded, verified multi-file templates (each **builds to wasm and passes
`cargo test`** out of the box):

- **`counter-mf`** — multi-module counter (`lib.rs` + `storage.rs` + `events.rs`),
  unit + integration tests.
- **`access-control-mf`** — admin module gating state changes.
- **`token-mf`** — SEP-41-style token split into `storage` / `admin` / `balance`
  / `allowance` / `metadata` modules.
- **`workspace-factory`** *(workspace)* — a `factory` contract that calls a
  `child` contract via a cross-contract call (`ChildClient`); two deployable
  members, default target `factory`.

> Contract crates use `crate-type = ["cdylib", "rlib"]` so integration tests
> under `tests/` can depend on the crate. The wasm build is unaffected — the
> Stellar CLI passes `--crate-type=cdylib` explicitly.

---

## Quick reference

| Concern                 | Where                                            |
| ----------------------- | ------------------------------------------------ |
| Path rules / sanitize   | `lib/paths.ts`, `web-soroban/lib/paths.ts`       |
| Layout validation, tree | `services/projectLayout.ts`                      |
| Compile                 | `services/compilationService.ts`, `workers/compileWorker.ts` |
| Tests                   | `services/testService.ts`, `workers/testWorker.ts`, `routes/test.ts` |
| Deploy                  | `services/deploymentService.ts`, `workers/deployWorker.ts`, `routes/deploy.ts` |
| Build info / target     | `GET /api/projects/:id/build-info`               |
| Templates               | `data/templateBundles.ts`, `data/templateCatalog.ts` |
| Migration + backfill    | `prisma/migrations/20260609000000_multifile_paths`, `scripts/backfill-file-paths.ts` |
