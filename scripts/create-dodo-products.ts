import 'dotenv/config';
import { getDodo, dodoEnvironment } from '../services/billing/dodo';
import { CREDIT_PACKS } from '../services/billing/config';

/**
 * Create (or reuse) the 3 one-time credit-pack products in Dodo Payments.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  WARNING: with DODO_PAYMENTS_ENVIRONMENT=live_mode this creates REAL,      │
 * │  purchasable products that take REAL money. Use test_mode while developing │
 * │  (test card 4242 4242 4242 4242). See BILLING.md.                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * IDEMPOTENT: matches existing products by metadata.pack (our key) or name and
 * reuses them instead of creating duplicates. Prints the product ids to copy into
 * env (DODO_PRODUCT_STARTER / _PRO / _MAX) so credit grants map server-side.
 *
 * Run: npm run dodo:products
 */
async function main() {
  const env = dodoEnvironment();
  const client = getDodo();

  console.log(`\nDodo Payments — creating credit-pack products in ${env.toUpperCase()}`);
  if (env === 'live_mode') {
    console.log('  ⚠️  LIVE MODE: these are REAL products and will accept REAL charges.\n');
  } else {
    console.log('  (test_mode: safe — no real money. Switch DODO_PAYMENTS_ENVIRONMENT=live_mode for production.)\n');
  }

  // Pull existing products once for idempotent matching.
  const existing: any[] = [];
  try {
    for await (const p of client.products.list()) {
      existing.push(p);
    }
  } catch (e: any) {
    console.warn('  Could not list existing products (continuing):', e.message);
  }

  const results: { pack: string; envVar: string; productId: string; reused: boolean }[] = [];

  for (const pack of CREDIT_PACKS) {
    const match = existing.find(
      (p) => (p?.metadata?.pack === pack.key) || (p?.name && p.name === pack.name)
    );

    if (match) {
      results.push({ pack: pack.key, envVar: pack.productEnvVar, productId: match.product_id, reused: true });
      console.log(`  • ${pack.name}: reusing ${match.product_id}`);
      continue;
    }

    const created = await client.products.create({
      name: pack.name,
      tax_category: 'saas',
      price: {
        type: 'one_time_price',
        currency: pack.currency,
        price: pack.priceCents,
        discount: 0,
        purchasing_power_parity: false,
        tax_inclusive: true,
      },
      description: `${pack.credits} WebSoroban AI credits (one-time top-up).`,
      // Credits live here too, but the SERVER plan config (config.ts) is the
      // authoritative product_id → credits map used when granting.
      metadata: { pack: pack.key, credits: String(pack.credits) },
    });
    results.push({ pack: pack.key, envVar: pack.productEnvVar, productId: created.product_id, reused: false });
    console.log(`  • ${pack.name}: created ${created.product_id} ($${(pack.priceCents / 100).toFixed(2)} → ${pack.credits} credits)`);
  }

  console.log('\nAdd these to your env (and to config if you change packs):\n');
  for (const r of results) {
    console.log(`  ${r.envVar}=${r.productId}`);
  }
  console.log('');
}

main()
  .catch((e) => {
    console.error('create-dodo-products failed:', e?.message || e);
    process.exit(1);
  });
