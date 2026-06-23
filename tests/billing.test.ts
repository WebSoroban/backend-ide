/**
 * Billing tests — the pure cost→credit and product→credit mapping that the
 * metering, gating, and grant paths all depend on. No DB/network.
 *
 * Run with: npm test  (node --import tsx --test tests/*.test.ts)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  costToCredits,
  creditsForPurchase,
  packForProductId,
  productIdForPack,
  publicPacks,
  CREDIT_PACKS,
  CREDITS_PER_USD,
  CREDIT_MARGIN,
} from '../services/billing/config';

// ---------------------------------------------------------------------------
// cost → credits (charged on ACTUAL OpenRouter cost; rounded up; min 1 if > 0)
// ---------------------------------------------------------------------------
test('costToCredits: zero / invalid cost charges nothing', () => {
  assert.equal(costToCredits(0), 0);
  assert.equal(costToCredits(-1), 0);
  assert.equal(costToCredits(NaN), 0);
});

test('costToCredits: rounds up and never undercharges a real run', () => {
  // Defaults: CREDITS_PER_USD=100, CREDIT_MARGIN=1 → 1 credit ≈ $0.01.
  assert.equal(CREDITS_PER_USD, 100);
  assert.equal(CREDIT_MARGIN, 1);
  assert.equal(costToCredits(0.002), 1); // ceil(0.2) → min 1
  assert.equal(costToCredits(0.013), 2); // ceil(1.3)
  assert.equal(costToCredits(0.05), 5); // ceil(5.0)
});

test('costToCredits: scales with the configured rate', () => {
  const cost = 0.04;
  assert.equal(costToCredits(cost), Math.ceil(cost * CREDITS_PER_USD * CREDIT_MARGIN));
});

// ---------------------------------------------------------------------------
// product → credits (server-side entitlement map; never client input)
// ---------------------------------------------------------------------------
test('creditsForPurchase: falls back to TRUSTED metadata when product is unmapped', () => {
  // No env product ids set in test → unmapped product uses the verified metadata.
  assert.equal(creditsForPurchase('prod_unknown', 250), 250);
  // Nothing to go on → 0 (caller must not grant).
  assert.equal(creditsForPurchase(undefined, undefined), 0);
  assert.equal(creditsForPurchase('prod_unknown', 0), 0);
});

test('creditsForPurchase: prefers the server-side pack map over metadata', () => {
  const starter = CREDIT_PACKS.find((p) => p.key === 'starter')!;
  const prev = process.env[starter.productEnvVar];
  process.env[starter.productEnvVar] = 'prod_test_starter';
  try {
    assert.equal(productIdForPack(starter), 'prod_test_starter');
    assert.equal(packForProductId('prod_test_starter')?.key, 'starter');
    // Server map wins even if (spoofed) metadata claims a different number.
    assert.equal(creditsForPurchase('prod_test_starter', 999999), starter.credits);
  } finally {
    if (prev === undefined) delete process.env[starter.productEnvVar];
    else process.env[starter.productEnvVar] = prev;
  }
});

// ---------------------------------------------------------------------------
// public pack listing (pricing UI)
// ---------------------------------------------------------------------------
test('publicPacks: exposes the 3 packs with a price label and no secrets', () => {
  const packs = publicPacks();
  assert.equal(packs.length, 3);
  assert.deepEqual(packs.map((p) => p.key), ['starter', 'pro', 'max']);
  const starter = packs[0];
  assert.equal(starter.priceLabel, `$${(starter.priceCents / 100).toFixed(2)}`);
  assert.ok(starter.credits > 0);
  // Client-safe shape: no product ids / env leakage.
  assert.equal((starter as any).productEnvVar, undefined);
});
