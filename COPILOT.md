# WebSoroban Copilot

A Cursor-style AI pair-programmer for Soroban (Stellar) smart contracts: chat +
agent panel that **generates, debugs, and optimizes** Rust contracts from natural
language, with 5 real modes, slash commands, `@`-context, model switching via
**OpenRouter**, and token/tool streaming — where **every generation is validated
against the real compile + security pipeline**. Testnet only.

This document is the contract for the subsystem: tool schemas, per-mode
permissions, the validation/security loop, the streaming protocol, and the API.

---

## 1. Architecture

```
Browser (Next.js)                         API (Express)                 Worker (BullMQ)
─────────────────                         ─────────────                 ───────────────
components/copilot/* ── POST /api/ai/* ──▶ routes/ai.ts ── addAgentJob ─▶ workers/agentWorker.ts
        ▲                                       │                               │
        │  socket.io  ◀── ai:run:<id> (Redis) ──┴── socketService.emitRunEvent ─┤
        │  (ai:event)                                                           ▼
   lib/aiApi.ts                                                       services/ai/harness.ts
   lib/socket.ts                                                          │  tool loop
                                                                          ▼
                                                              services/ai/toolExecutor.ts
                                                       (reuses compilationService / testService /
                                                        contractSpec / projectLayout / lib/paths)
                                                                          │
                                                              services/ai/openrouter.ts ──▶ OpenRouter
```

- **Model layer** (`services/ai/openrouter.ts`, `models.ts`): OpenAI-compatible
  streaming proxy to OpenRouter; curated model registry + Auto routing + MAX Mode.
  Keys are **server-side only**, never logged or returned.
- **Harness** (`services/ai/harness.ts`): the tool loop — stream → tool_calls →
  execute → append → repeat until stop / cap.
- **Tools** (`services/ai/tools.ts`, `toolExecutor.ts`): JSON-schema definitions
  + a working-copy executor scoped to the user's project.
- **Prompts** (`services/ai/prompts.ts`): the Soroban system prompt + per-mode
  operating contract, pinned to the build pipeline's SDK/target.
- **Security** (`services/ai/securityAudit.ts`): rule checklist + optional LLM pass.
- **Runs/queue/worker**: `queues/agentQueue.ts`, `workers/agentWorker.ts`.
- **Persistence** (Prisma): `ChatThread`, `ChatMessage`, `ToolCall`, `AgentRun`,
  `Plan`, `AiSetting`.

---

## 2. The 5 modes (enforced, not cosmetic)

Each mode **starts a fresh context window** (= a new `ChatThread`; the thread is
mode-pinned). Modes are enforced two ways: the model is only *given* the tools its
mode allows, and the executor re-checks every call (`isToolAllowed`). Project/user
rules (`.websoroban/rules.md`, `COPILOT_RULES.md`, `AGENTS.md`, `.cursorrules`)
apply to all modes.

| Mode | Loop shape | Can edit? | Can run pipeline? | Can deploy? |
|------|-----------|-----------|-------------------|-------------|
| **Ask** | answer w/ full reasoning | ❌ | ❌ | ❌ |
| **Agent** (default) | generate/edit → compile → fix → repeat | ✅ (diffs) | ✅ | ❌ (gated UI) |
| **Plan** | research → editable markdown plan (≤3 clarifying Qs) | ❌ | ❌ | ❌ |
| **Debug** | gather evidence → root cause → minimal fix diff | ✅ (propose_edit only) | ✅ | ❌ |
| **Multitask** | N parallel agent runs, each own working copy | ✅ (diffs) | ✅ | ❌ |

### Per-mode tool permission matrix

| tool | ask | agent | plan | debug | multitask |
|------|:---:|:---:|:---:|:---:|:---:|
| read_file, list_files, search_codebase | ✅ | ✅ | ✅ | ✅ | ✅ |
| get_errors, get_contract_spec, fetch_docs | ✅ | ✅ | ✅ | ✅ | ✅ |
| create_file | — | ✅ | — | — | ✅ |
| propose_edit | — | ✅ | — | ✅ | ✅ |
| delete_file | — | ✅ | — | — | ✅ |
| run_compile, run_tests, run_clippy | — | ✅ | — | ✅ | ✅ |
| run_security_audit | — | ✅ | — | ✅ | ✅ |
| **deploy_contract** | — | — | — | — | — |

`deploy_contract` is in **no** mode's set. Deployment is a **gated UI action**
(`POST /api/ai/runs/:id/deploy` with `confirm: true`, or the existing Deploy
button) — never auto-called inside the loop.

---

## 3. Tool schemas

All tools are OpenAI "function" tools (`services/ai/tools.ts`). Paths are
project-relative POSIX and are sanitized with the shared `lib/paths` sanitizer
(no `..`, no absolute, no traversal) and scoped to the user's project.

| Tool | Params | Returns |
|------|--------|---------|
| `read_file` | `path` | file contents (truncated at 60 KB) |
| `list_files` | — | the project file tree |
| `search_codebase` | `query` | matching `file:line: snippet` (≤50) |
| `get_errors` | — | last compile diagnostics (level/file/line/msg) |
| `get_contract_spec` | — | functions (name, inputs, outputs) from the WASM spec |
| `fetch_docs` | `query` | bundled Soroban/OZ doc snippets |
| `create_file` | `path`, `content`, `summary?` | a **diff** for review (no silent write) |
| `propose_edit` | `path`, `content` (full new file), `summary?` | a **diff** for review |
| `delete_file` | `path` | a review entry (no silent delete) |
| `run_compile` | — | `{ success, diagnostics[], wasmBytes }` (real Stellar build) |
| `run_tests` | — | `{ success, total, passed, failed, tests[] }` (`cargo test`) |
| `run_clippy` | — | clippy findings (diagnostics) |
| `run_security_audit` | — | findings `{ severity, file, line, detail, suggestedFix }` |
| `deploy_contract` | — | **gated** — not exposed to the model |

`propose_edit`/`create_file` take the **complete new file content**; the executor
computes a unified diff (`services/ai/diff.ts`) vs the working copy. Editing
mutates an in-memory **working copy** so the agent's own `run_compile`/`run_tests`
validate the in-progress code; the net diffs (vs the pre-run snapshot) are what the
user reviews. Nothing is written to the DB until the user accepts.

---

## 4. Validation + security loop (the differentiator)

System prompt is pinned to the build pipeline: **soroban-sdk 22.x**, target
**wasm32v1-none**, **stellar-cli 25.2.0**, **Rust 1.89** (`services/ai/prompts.ts`).

**Validation loop** (Agent/Debug, mandated by the system prompt):

```
edit → run_compile → read diagnostics → fix → repeat
                  → run_clippy (safety/correctness)
                  → run_tests (must pass when tests exist/were written)
```

"Compatible with Stellar" = it builds for the testnet wasm target **and** the
contract spec extracts (i.e. it will actually deploy). `run_compile` reuses
`compilationService` (the same `stellar contract build` the IDE uses);
`run_tests` reuses `testService`. The harness caps the loop at
`AI_MAX_TOOL_ITERATIONS` and the per-run output-token budget.

**Security pass** (`run_security_audit`) — a curated Soroban rule checklist, run
deterministically and (best-effort) augmented by an LLM pass over the same rules:

| rule | severity | checks for |
|------|----------|-----------|
| `missing-require-auth` | high/med | state-mutating / admin fns without `require_auth` |
| `unchecked-arithmetic` | high | raw `+ - *` on amounts when `overflow-checks` is off |
| `storage-ttl` | medium | `persistent()` writes with no `extend_ttl` (expiry risk) |
| `panic-on-input` | medium | `unwrap()/expect()/panic!` reachable from inputs |
| `unbounded-loop` | low | loops over user-growable `Vec`/`Map` (budget/DoS) |
| `secrets-in-code` | critical | Stellar secret seeds / private keys in source |

Findings carry `severity + file/line + suggestedFix`. (If OpenZeppelin's Soroban
Security Detector is wired in later, it slots in alongside the static pass.)

---

## 5. Streaming protocol (Socket.IO)

The frontend subscribes to a run room and receives `ai:event`:

```
client: socket.emit('subscribe:run', runId)
server: socket.emit('ai:event', { runId, type, payload })
```

| `type` | `payload` |
|--------|-----------|
| `status` | `{ phase: 'running' \| 'thinking' \| 'budget' \| 'capped' \| 'done' \| 'failed' \| 'cancelled', ... }` |
| `token` | `{ delta }` — visible assistant text |
| `reasoning` | `{ delta }` — collapsible chain-of-thought |
| `tool` | `{ phase: 'call' \| 'result', callId, name, args, ok?, summary?, data?, edit? }` |
| `error` | `{ message }` |

On `status.done`, `payload.edits` holds the reviewable diff set and `payload.planId`
(plan mode). Cross-process delivery uses Redis (`ai:run:<runId>`), like the existing
`job:log`/`job:status` channels.

---

## 6. API (`/api/ai`, all authenticated)

| Method/Path | Purpose |
|-------------|---------|
| `GET /models` | curated registry + live catalog (`?refresh=1`) |
| `GET/PUT /settings` | persist model/mode/maxMode; set BYO key (encrypted) |
| `GET/POST /threads`, `GET/PATCH/DELETE /threads/:id` | thread CRUD |
| `POST /threads/:id/messages` | send a turn → starts an `AgentRun`, returns `runId` |
| `GET /runs`, `GET /runs/:id` | run state + tool calls + diffs (dashboard) |
| `POST /runs/:id/cancel` | cooperative cancel (next loop boundary) |
| `POST /runs/:id/apply` | apply accepted diffs — `accept: 'all' \| { path: 'all'\|'reject'\|number[] }` (per-hunk) |
| `POST /runs/:id/undo` | restore the project to the run's checkpoint |
| `POST /runs/:id/deploy` | **gated** deploy (`confirm: true`) — compile then deploy to testnet |
| `GET/PUT/DELETE /plans/:id`, `GET /plans` | plan artifacts (editable markdown) |
| `POST /plans/:id/build` | hand the approved plan to an Agent run |
| `POST /multitask` | spawn N parallel runs (`tasks[]`), grouped under a parent run |

### Diff review + checkpoints

Every run snapshots the project tree before executing (`AgentRun.checkpoint`).
The UI shows per-hunk accept/reject + accept-all (`components/copilot/diff-view.tsx`);
`apply` reconstructs file content with `applyHunks`; `undo` restores the checkpoint.
Agent may auto-apply, but always with a visible diff + undo.

---

## 7. Configuration

```
OPENROUTER_API_KEY=          # server-side shared key (required for the shared tier)
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=         # sent as HTTP-Referer (attribution)
OPENROUTER_APP_NAME=         # sent as X-Title
AI_DEFAULT_MODEL=openrouter/auto
AI_MAX_TOOL_ITERATIONS=24
AI_MAX_OUTPUT_TOKENS=8000
AI_RUN_TOKEN_BUDGET=120000
AI_MAX_MODE_TOKEN_BUDGET=400000
AGENT_WORKER_CONCURRENCY=4
# Per-user BYO keys are encrypted with WALLET_ENCRYPTION_KEY (AES-256-GCM).
```

**Run it:** `npm run worker:agent` (prod) / `npm run worker:agent:dev` (watch),
alongside the API and the existing compile/deploy/test workers (they share Redis).
Apply the schema with `npm run migrate:deploy` (migration
`20260619000000_ai_copilot`).

### Security invariants
- The OpenRouter key (shared or BYO) never reaches the browser, is never logged,
  and is never returned by any endpoint.
- BYO keys are AES-256-GCM encrypted at rest (same as wallet secrets) and only
  decrypted inside the worker.
- All file paths are sanitized + containment-checked; tools are scoped to the
  user's own project (ownership checked on every route).
- Testnet only. Deploy always requires explicit user confirmation.
