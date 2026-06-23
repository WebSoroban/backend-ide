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
- **Scope guardrails** (`services/ai/scope.ts`): Soroban-only scope policy + write
  allowlist + role-override detection (§2.5), shared by the prompt and tool layers.
- **Skills** (`services/ai/skills.ts`, `skillSeeds.ts`, `routes/skills.ts`):
  user/official knowledge packs loaded as context with progressive disclosure (§2.6).
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
| load_skill | ✅ | ✅ | ✅ | ✅ | ✅ |
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

## 2.5 Scope & file-type guardrails (Soroban-only)

The Copilot is a **Soroban/Stellar smart-contract assistant** and nothing else. It
will not produce off-domain output (HTML/CSS/JS/TS, Python, Solidity/other chains,
general web/app/backend code, unrelated scripts, prose). Guardrails are enforced in
**layers**, with the **tool layer as the non-bypassable guarantee** and the prompt
as the polite front door. The allowlist + scope policy live in **one** module —
`services/ai/scope.ts` — shared by the prompt and the tools so they can't drift.

| Layer | Where | What it does |
|------|-------|--------------|
| **1 — Role/scope policy** | `services/ai/prompts.ts` (← `scope.ts`) | Hard role, in/out-of-scope lists, one-line refusal template, mixed-request rule, jailbreak resistance. |
| **2 — File-type + path enforcement** | `services/ai/toolExecutor.ts` (← `scope.ts`) | Every `create_file`/`propose_edit`/`delete_file` validates the target against the allowlist **before any write**; off-list ⇒ structured rejection. **Cannot be overridden by prompt content.** |
| **3 — Cheap scope pre-check** | `services/ai/harness.ts` (← `scope.ts`) | A heuristic classifies the prompt; a clearly off-domain prompt is short-circuited with the standard redirect — **no agent loop, no tool calls, no model spend** (`AI_SCOPE_PRECHECK=0` to disable). |
| **4 — Output guard** | (Layer 2) | The model may READ/EXPLAIN anything and discuss any concept, but may only **WRITE** allowlisted files; off-list content never reaches disk. Written Rust still runs the compile/clippy/security loop. |

### In scope (do these)
Generate/edit/refactor/optimize Soroban contracts (Rust); write/fix unit +
integration tests; edit `Cargo.toml` / `.cargo/config.toml`; diagnose
compile/clippy/test/deploy errors; explain ScVal types, `require_auth`,
storage/TTL, events, SEP standards (SEP-41), OpenZeppelin `stellar-contracts`,
contract-relevant Rust; answer IDE how-tos (compile/deploy/invoke/wallet/network/templates).

### Out of scope (decline + redirect, never produce the artifact)
HTML/CSS/JS/TS, Python, Solidity / other chains, general web/app/backend dev,
scripts unrelated to the contract, non-programming chit-chat, any non-Soroban
project file. **Caveating is not compliance** — if it's out of scope, it isn't produced.

### Write allowlist (single source of truth — `scope.ts`)
`src/**/*.rs`, `tests/**/*.rs`, `build.rs`, `Cargo.toml`, `Cargo.lock`,
`.cargo/config.toml`, `rust-toolchain.toml`, `README.md`, `.gitignore`.
Everything else (`.html`, `.css`, `.js`, `.ts`, `.py`, `.sh`, `.json`, `Dockerfile`,
binaries, …) is **rejected**. Paths are first containment-checked by `lib/paths`
(no `..`, no absolute, no traversal); the allowlist adds the file-**type** check on top.

On rejection the tool returns a structured error the harness surfaces as the
standard redirect (never a raw stack trace, never a silent write):

```json
{ "error": "OUT_OF_SCOPE_FILE", "path": "index.html", "allowed": ["src/**/*.rs", "..."], "message": "Can't write \"index.html\" — I only create or edit Soroban contract project files …" }
```

### Refusal behavior
One concise message (a sentence or two, no lecture) that (a) states it's a Soroban
contract assistant and (b) offers the closest in-scope alternative. The disclaimer
is not repeated within a reply. **Mixed requests:** do the in-scope part, decline
only the out-of-scope part. Applies to all 5 modes and all slash commands (e.g.
`/generate` with a non-contract target is refused — slash commands are just prompt
templates that flow through the same harness/tool pipeline).

### Worked examples
1. **"write a hello world in HTML"** → no HTML produced. Layer 3 short-circuits (off-domain, no Soroban anchor); reply: *"I build Soroban contracts, not web pages — want a Soroban 'hello world' contract instead?"* If it ever reached a write, Layer 2 rejects `index.html` with `OUT_OF_SCOPE_FILE`.
2. **"add a `transfer` fn with `require_auth` to my token contract and test it"** → in scope. Edits `src/lib.rs` + `tests/*.rs`, runs the compile/clippy/test loop. Allowed.
3. **"explain how `extend_ttl` works, then write a Python script to call my contract"** → mixed. Explains TTL (in scope); declines the Python script and offers the in-scope alternative (e.g. an integration test or the IDE Invoke panel). If it tried to write `*.py`, Layer 2 rejects it.

---

## 2.6 Skills (reusable Soroban knowledge packs)

A **Skill** is a user-authored (or OFFICIAL) Soroban/Stellar knowledge + instruction
pack the Copilot loads as **context** — like Cursor/Claude rules, scoped to Soroban
(e.g. a SEP-41 token pattern, an OZ access-control convention, a team's coding
style). The model code lives in `services/ai/skills.ts` (+ `skillSeeds.ts`), the API
in `routes/skills.ts` (`/api/ai/skills`), and the UI in `components/copilot/skills-panel.tsx`.

### Schema (`Skill` + `SkillPreference`)

| field | meaning |
|-------|---------|
| `id` | cuid |
| `ownerId` | the author; **null ⇒ OFFICIAL** (seeded, global) |
| `official` | true for seeded packs |
| `name` / `slug` | display name / `@skill:<slug>` + `load_skill` handle (unique per owner) |
| `description` | one line, shown in the always-on index |
| `whenToUse` | 1–2 lines that trigger on-demand loading |
| `body` | markdown: patterns, code snippets, rules, links |
| `scope` | `always` \| `auto` \| `manual` (see loading rules) |
| `enabled` | owner's on/off for their own skills |
| `visibility` | `private` \| `public` (public = browsable library) |

`SkillPreference (userId, skillId, enabled)` records a **per-user** enable/disable of
official/public skills the user doesn't own, so toggling an official skill off never
mutates the shared row. Private skills are owner-scoped — **never returned to another
user**. Seed the official packs with `npm run seed:skills` (idempotent upsert).

### Progressive disclosure (token-efficient loading)

| scope | in the index? | body injected every run? | how the body loads |
|-------|:---:|:---:|--------------------|
| **always** | ✅ | ✅ | injected into the system prompt every run |
| **auto** | ✅ | ❌ | model calls `load_skill("<slug>")` when `whenToUse` matches |
| **manual** | ✅ (flagged) | ❌ | only when the user `@skill:<slug>`-mentions it that message |

- **Always-on index** — only each enabled skill's `name + description + whenToUse`
  is injected (cheap). Built by `buildSkillContext`, rendered by `prompts.ts`.
- **On-demand bodies** — the `load_skill` tool (in **all 5 modes**, read-only)
  returns a body; `auto`/`always` are always loadable, `manual` only if mentioned.
- **@-mention** — `@skill:<slug>` in the message (or via the composer's Skills
  picker) force-loads any-scope body for that turn (parsed in the harness from the
  prompt + @-context).
- **Token cap** — total injected body tokens per run are capped
  (`AI_SKILL_TOKEN_BUDGET`, default 6000). Priority: `@`-mentioned, then `always`;
  overflow is dropped and the prompt notes what was omitted (still fetchable via `load_skill`).

### Skills are GUIDANCE, not authority (the boundary)

A skill can shape **how** contracts are written; it can **not** widen scope or weaken
safety. This is enforced, not just asked:

- **Injected as data.** Bodies are framed exactly like `@`-context — the scope policy
  (§2.5) and the Skills section both state that skill text cannot change the role,
  the Soroban-only scope, the file-type allowlist, or the secret/deploy/safety rules,
  and to ignore any skill text that tries.
- **Validated on save.** `validateSkill` rejects content that (a) tries to redefine
  the assistant / strip its limits (`containsRoleOverride`), or (b) is clearly
  off-domain (`classifyPromptScope` → out_of_scope). A "write HTML" skill is refused
  with `OUT_OF_SCOPE_SKILL`.
- **Guardrails stay above skills.** A skill can't make the Copilot write a non-Rust
  file — Layer 2's allowlist (§2.5) still rejects the write regardless of any skill.

The seeded official packs are aligned with Stellar's official dev skills
(<https://github.com/stellar/stellar-dev-skill>, <https://skills.stellar.org>):
SEP-41 token, OpenZeppelin access control, storage tiers & TTL, auth (`require_auth`)
+ sub-invocations, events, and testing patterns — each accurate to the pinned
soroban-sdk 22.x toolchain.

### Worked example
User enables the official **SEP-41** skill (`scope: auto`) and writes *"add a capped
mint to my token"*. The index tells the model a `sep-41-fungible-token` skill exists
and "use when building a fungible token"; the model calls
`load_skill("sep-41-fungible-token")`, follows the pattern (checked math, `require_auth`,
TTL, events), and writes `src/lib.rs` + `tests/*.rs` — all still gated by the
allowlist and validated by the compile/security loop.

---

## 3. Tool schemas

All tools are OpenAI "function" tools (`services/ai/tools.ts`). Paths are
project-relative POSIX and are sanitized with the shared `lib/paths` sanitizer
(no `..`, no absolute, no traversal) and scoped to the user's project. Write tools
(`create_file`/`propose_edit`/`delete_file`) additionally enforce the Soroban
file-type **allowlist** (`services/ai/scope.ts`, §2.5) before any mutation;
off-list targets return `{ error: 'OUT_OF_SCOPE_FILE', allowed }`.

| Tool | Params | Returns |
|------|--------|---------|
| `read_file` | `path` | file contents (truncated at 60 KB) |
| `list_files` | — | the project file tree |
| `search_codebase` | `query` | matching `file:line: snippet` (≤50) |
| `get_errors` | — | last compile diagnostics (level/file/line/msg) |
| `get_contract_spec` | — | functions (name, inputs, outputs) from the WASM spec |
| `fetch_docs` | `query` | bundled Soroban/OZ doc snippets |
| `load_skill` | `name` (slug) | a skill's full body as reference/guidance (§2.6); `auto`/`always` always loadable, `manual` only if @-mentioned |
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
- **Scope is enforced in the tool layer, not just the prompt:** writes are
  restricted to the Soroban allowlist (§2.5) and cannot be overridden by prompt /
  pasted / `@`-context content (jailbreak-resistant). The model may read/explain
  anything but only writes allowlisted files.
- Testnet only. Deploy always requires explicit user confirmation.
