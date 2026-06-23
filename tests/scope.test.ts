/**
 * Scope + file-type guardrail tests — the Soroban-only enforcement.
 *
 * Covers all three layers' pure cores, no network/DB/Redis:
 *   - the allowlist predicate (the single source of truth),
 *   - the cheap scope pre-check classifier (Layer 3),
 *   - the non-bypassable write-tool rejection (Layer 2),
 *   - the out-of-scope redirect output (no artifact produced).
 *
 * Run with: npm test  (node --import tsx --test tests/*.test.ts)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAllowedProjectFile,
  classifyPromptScope,
  rejectOutOfScopeFile,
  SCOPE_REDIRECT,
  ALLOWED_PATTERNS,
} from '../services/ai/scope';
import { ProjectWorkspace } from '../services/ai/toolExecutor';
import { scopeRedirectOutput } from '../services/ai/harness';

// ---------------------------------------------------------------------------
// Allowlist — the file-type single source of truth
// ---------------------------------------------------------------------------
test('allowlist: accepts Soroban project files (rust, manifests, configs, docs)', () => {
  for (const p of [
    'src/lib.rs',
    'src/admin/mod.rs',
    'tests/integration.rs',
    'contracts/token/src/lib.rs',
    'build.rs',
    'Cargo.toml',
    'Cargo.lock',
    'contracts/token/Cargo.toml',
    '.cargo/config.toml',
    'rust-toolchain.toml',
    'README.md',
    '.gitignore',
  ]) {
    assert.equal(isAllowedProjectFile(p), true, `expected ALLOWED: ${p}`);
  }
});

test('allowlist: rejects off-domain files (html/js/ts/py/css/json/docker/binaries)', () => {
  for (const p of [
    'index.html',
    'styles.css',
    'app.js',
    'main.ts',
    'server.py',
    'deploy.sh',
    'package.json',
    'Dockerfile',
    'public/logo.png',
    'src/index.html', // .html never allowed, even under src/
    'notes.md', // only README.md is allowed, not arbitrary markdown
    'lib.rs', // .rs must live under src/ or tests/ (or be build.rs)
    'scripts/foo.rs',
  ]) {
    assert.equal(isAllowedProjectFile(p), false, `expected REJECTED: ${p}`);
  }
});

// ---------------------------------------------------------------------------
// Layer 3 — cheap scope pre-check classifier
// ---------------------------------------------------------------------------
test('scope classifier: clearly off-domain prompts are out_of_scope', () => {
  assert.equal(classifyPromptScope('write a hello world in HTML'), 'out_of_scope');
  assert.equal(classifyPromptScope('build me a landing page with React and Tailwind'), 'out_of_scope');
  assert.equal(classifyPromptScope('write a python script to scrape a website'), 'out_of_scope');
  assert.equal(classifyPromptScope('write me a poem about the ocean'), 'out_of_scope');
});

test('scope classifier: legitimate Soroban/Rust/IDE work stays in_scope (no false positives)', () => {
  assert.equal(classifyPromptScope('add a transfer function with require_auth to my token contract'), 'in_scope');
  assert.equal(classifyPromptScope('explain how extend_ttl works for persistent storage'), 'in_scope');
  assert.equal(classifyPromptScope('fix the errors in my Cargo.toml'), 'in_scope');
  assert.equal(classifyPromptScope('optimize this contract for wasm size'), 'in_scope');
  assert.equal(classifyPromptScope('how do I deploy and invoke from the IDE?'), 'in_scope');
  // In-domain anchor overrides an off-domain mention (e.g. a TS SDK client).
  assert.equal(classifyPromptScope('how do I invoke my Soroban contract from a TypeScript SDK?'), 'in_scope');
  // In-domain anchor can come from attached @-context (a pasted contract).
  assert.equal(classifyPromptScope('explain this', '#![no_std]\nuse soroban_sdk::contract;'), 'in_scope');
});

test('scope classifier: neutral prompts are ambiguous (proceed, let Layers 1–2 handle it)', () => {
  assert.equal(classifyPromptScope('write a hello world'), 'ambiguous');
  assert.equal(classifyPromptScope(''), 'ambiguous');
});

// ---------------------------------------------------------------------------
// Layer 2 — non-bypassable write-tool enforcement
// ---------------------------------------------------------------------------
function newWorkspace() {
  return new ProjectWorkspace(
    [
      { path: 'Cargo.toml', content: '[package]\nname = "demo"\n' },
      { path: 'src/lib.rs', content: '#![no_std]\n' },
    ],
    {
      runId: 'test-run',
      projectId: 'p1',
      userId: 'u1',
      mode: 'agent',
      manifestPath: 'Cargo.toml',
      model: 'test-model',
    },
  );
}

test('tool layer: create_file of an off-scope file is rejected, nothing written', async () => {
  const ws = newWorkspace();
  const res = await ws.execute('create_file', {
    path: 'index.html',
    content: '<!doctype html><h1>hello</h1>',
    summary: 'a web page',
  });
  assert.equal(res.ok, false);
  assert.equal(res.data?.error, 'OUT_OF_SCOPE_FILE');
  assert.deepEqual(res.data?.allowed, ALLOWED_PATTERNS);
  assert.equal(res.edit, undefined, 'no edit may be produced for a rejected write');
  // The non-bypassable guarantee: the working copy is untouched.
  assert.equal(ws.hasEdits(), false);
  assert.ok(!ws.netEdits().some((e) => e.path === 'index.html'));
});

test('tool layer: delete_file of an off-scope path is rejected', async () => {
  const ws = newWorkspace();
  const res = await ws.execute('delete_file', { path: 'secrets.env' });
  assert.equal(res.ok, false);
  assert.equal(res.data?.error, 'OUT_OF_SCOPE_FILE');
});

test('tool layer: an in-scope contract file still writes (produces a reviewable diff)', async () => {
  const ws = newWorkspace();
  const res = await ws.execute('create_file', {
    path: 'src/token.rs',
    content: '#![no_std]\npub fn transfer() {}\n',
    summary: 'add token module',
  });
  assert.equal(res.ok, true);
  assert.ok(res.edit, 'expected a proposed edit');
  assert.equal(res.edit!.op, 'create');
  assert.equal(res.edit!.path, 'src/token.rs');
  assert.equal(ws.hasEdits(), true);
  assert.ok(ws.netEdits().some((e) => e.path === 'src/token.rs'));
});

// ---------------------------------------------------------------------------
// Redirect — an out-of-scope request yields the redirect and NO artifact
// ---------------------------------------------------------------------------
test('redirect: out-of-scope short-circuit output has the redirect and no edits/tools/iterations', () => {
  // The HTML prompt classifies out_of_scope...
  assert.equal(classifyPromptScope('write a hello world in HTML'), 'out_of_scope');
  // ...and the short-circuit produces only the redirect — no artifact, no loop.
  const out = scopeRedirectOutput();
  assert.equal(out.content, SCOPE_REDIRECT);
  assert.equal(out.edits.length, 0);
  assert.equal(out.toolCalls.length, 0);
  assert.equal(out.iterations, 0);
  assert.equal(out.tokensOut, 0);
});

test('redirect: the structured file rejection echoes the allowlist and a polite message', () => {
  const r = rejectOutOfScopeFile('app.py');
  assert.equal(r.error, 'OUT_OF_SCOPE_FILE');
  assert.equal(r.path, 'app.py');
  assert.deepEqual(r.allowed, ALLOWED_PATTERNS);
  assert.match(r.message, /Soroban contract project files/);
});
