/**
 * Smoke tests — fast, deterministic guards over the pure core logic that the
 * deploy/invoke/analytics features depend on. No network, no DB, no Redis.
 *
 * Run with: npm test  (node --import tsx --test tests/*.test.ts)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getNetwork,
  coerceNetwork,
  isNetworkId,
  explorerContract,
  explorerTx,
  explorerAccount,
} from '../lib/networks';
import { sanitizeRelPath, isValidRelPath } from '../lib/paths';
import { computeHunks, applyHunks, unifiedDiff } from '../services/ai/diff';
import { auditStatic } from '../services/ai/securityAudit';
import { validateProject } from '../services/projectLayout';

// ---------------------------------------------------------------------------
// networks — the config the per-network deploy/invoke/explorer logic reads
// ---------------------------------------------------------------------------
test('networks: mainnet vs testnet passphrase + explorer base', () => {
  const main = getNetwork('mainnet');
  const test_ = getNetwork('testnet');
  assert.equal(main.id, 'mainnet');
  assert.equal(main.passphrase, 'Public Global Stellar Network ; September 2015');
  assert.equal(main.faucet, null); // no friendbot on mainnet
  assert.equal(main.explorerBase, 'https://stellar.expert/explorer/public');

  assert.equal(test_.passphrase, 'Test SDF Network ; September 2015');
  assert.equal(test_.faucet, 'friendbot');
  assert.equal(test_.explorerBase, 'https://stellar.expert/explorer/testnet');
});

test('networks: coerce + guards default to testnet, never throw', () => {
  assert.equal(coerceNetwork('mainnet'), 'mainnet');
  assert.equal(coerceNetwork('testnet'), 'testnet');
  assert.equal(coerceNetwork('PRODUCTION'), 'testnet'); // unknown → testnet
  assert.equal(coerceNetwork(undefined), 'testnet');
  assert.equal(coerceNetwork(null), 'testnet');
  assert.equal(isNetworkId('mainnet'), true);
  assert.equal(isNetworkId('lol'), false);
});

test('networks: explorer URLs use the right base per network (the analytics bug)', () => {
  assert.equal(
    explorerContract('mainnet', 'CABC'),
    'https://stellar.expert/explorer/public/contract/CABC',
  );
  assert.equal(
    explorerContract('testnet', 'CABC'),
    'https://stellar.expert/explorer/testnet/contract/CABC',
  );
  assert.equal(explorerTx('mainnet', 'TXHASH'), 'https://stellar.expert/explorer/public/tx/TXHASH');
  assert.equal(explorerAccount('mainnet', 'GABC'), 'https://stellar.expert/explorer/public/account/GABC');
});

// ---------------------------------------------------------------------------
// paths — the sanitizer that guards every file write
// ---------------------------------------------------------------------------
test('paths: accepts plain relative paths', () => {
  assert.equal(sanitizeRelPath('src/lib.rs'), 'src/lib.rs');
  assert.equal(sanitizeRelPath(' Cargo.toml '), 'Cargo.toml'); // trims
  assert.equal(isValidRelPath('contracts/token/src/lib.rs'), true);
});

test('paths: rejects traversal, absolute, backslash, drive, scheme, NUL', () => {
  assert.throws(() => sanitizeRelPath('../etc/passwd'));
  assert.throws(() => sanitizeRelPath('/etc/passwd'));
  assert.throws(() => sanitizeRelPath('a\\b'));
  assert.throws(() => sanitizeRelPath('C:/win'));
  assert.throws(() => sanitizeRelPath('file://x'));
  assert.throws(() => sanitizeRelPath('a\0b'));
  assert.equal(isValidRelPath('../x'), false);
});

// ---------------------------------------------------------------------------
// diff — the apply engine behind reviewable Copilot edits
// ---------------------------------------------------------------------------
test('diff: identical content produces no hunks', () => {
  const s = 'line1\nline2\nline3\n';
  assert.equal(computeHunks(s, s).length, 0);
});

test('diff: a change produces hunks and applyHunks("all") yields the new content', () => {
  const oldStr = 'fn main() {\n    let x = 1;\n}\n';
  const newStr = 'fn main() {\n    let x = 2;\n    let y = 3;\n}\n';
  const hunks = computeHunks(oldStr, newStr);
  assert.ok(hunks.length > 0, 'expected at least one hunk');
  assert.equal(applyHunks(oldStr, newStr, 'all'), newStr);
  // Accepting zero hunks restores the original.
  assert.equal(applyHunks(oldStr, newStr, []), oldStr);
  assert.match(unifiedDiff('src/main.rs', oldStr, newStr), /^--- a\/src\/main\.rs/);
});

// ---------------------------------------------------------------------------
// security audit — the deterministic Soroban rule checklist
// ---------------------------------------------------------------------------
test('audit: flags a state-mutating admin fn with no require_auth', () => {
  const src = `
#[contractimpl]
impl Token {
    pub fn set_admin(env: Env, new_admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }
}`;
  const findings = auditStatic([{ path: 'src/lib.rs', content: src }]);
  const f = findings.find((x) => x.rule === 'missing-require-auth');
  assert.ok(f, 'expected a missing-require-auth finding');
  assert.equal(f!.severity, 'high'); // admin fn → high
});

test('audit: a guarded admin fn is NOT flagged for missing auth', () => {
  const src = `
impl Token {
    pub fn set_admin(env: Env, new_admin: Address) {
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }
}`;
  const findings = auditStatic([{ path: 'src/lib.rs', content: src }]);
  assert.equal(findings.find((x) => x.rule === 'missing-require-auth'), undefined);
});

test('audit: flags a hardcoded Stellar secret seed as critical', () => {
  const seed = 'S' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' + 'ABCDEFGHIJKLMNOPQRSTUVW'; // S + 55 base32
  assert.equal(seed.length, 56);
  const src = `pub const KEY: &str = "${seed}";`;
  const findings = auditStatic([{ path: 'src/lib.rs', content: src }]);
  const f = findings.find((x) => x.rule === 'secrets-in-code');
  assert.ok(f, 'expected a secrets-in-code finding');
  assert.equal(f!.severity, 'critical');
});

// ---------------------------------------------------------------------------
// project layout — what deploy/compile validate before doing real work
// ---------------------------------------------------------------------------
const CARGO = `[package]
name = "hello"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
soroban-sdk = "22"
`;

const LIB = `#![no_std]
use soroban_sdk::{contract, contractimpl, Env, Symbol, symbol_short};

#[contract]
pub struct Hello;

#[contractimpl]
impl Hello {
    pub fn hello(_env: Env) -> Symbol { symbol_short!("hi") }
}
`;

test('layout: a valid single-crate contract validates ok', () => {
  const res = validateProject([
    { path: 'Cargo.toml', content: CARGO },
    { path: 'src/lib.rs', content: LIB },
  ]);
  assert.equal(res.ok, true, `errors: ${res.errors.join('; ')}`);
  assert.equal(res.isWorkspace, false);
  assert.equal(res.deployableCrates.length, 1);
});

test('layout: a missing Cargo.toml fails validation', () => {
  const res = validateProject([{ path: 'src/lib.rs', content: LIB }]);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /Manifest not found/i.test(e)));
});

test('cors: allows production, this project\'s Vercel previews, and nothing else', async () => {
  const { isAllowedOrigin } = await import('../lib/cors');
  const preview = 'https://web-soroban-git-x402-harsh-sharmas-projects-edd77f1e.vercel.app';
  assert.equal(isAllowedOrigin('https://websoroban.in', true), true);
  assert.equal(isAllowedOrigin(undefined, true), true);
  assert.equal(isAllowedOrigin(preview, true), true);
  assert.equal(isAllowedOrigin('https://web-soroban-abc123def-harsh-sharmas-projects-edd77f1e.vercel.app', true), true);
  assert.equal(isAllowedOrigin('https://evil-harsh-sharmas-projects-edd77f1e.vercel.app', true), false);
  assert.equal(isAllowedOrigin('https://web-soroban-x.evil.app?.harsh-sharmas-projects-edd77f1e.vercel.app', true), false);
  assert.equal(isAllowedOrigin('http://web-soroban-git-x402-harsh-sharmas-projects-edd77f1e.vercel.app', true), false);
  assert.equal(isAllowedOrigin('https://web-soroban-git-x402-other-team.vercel.app', true), false);
  assert.equal(isAllowedOrigin('http://localhost:5173', true), false);
  assert.equal(isAllowedOrigin('http://localhost:5173', false), true);
});
