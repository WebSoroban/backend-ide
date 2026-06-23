/**
 * Billing config — the SERVER-SIDE source of truth for the AI credit economy.
 *
 *   cost (USD, from OpenRouter)  ──▶  credits charged   (metering)
 *   Dodo product_id              ──▶  credits granted   (entitlement)
 *
 * Credit grants NEVER depend on client input: the product→credits map lives here
 * (keyed by the Dodo product ids in env), and metering converts the actual model
 * cost OpenRouter reports. This is the fiat/credits system — distinct from the
 * testnet-XLM plan/template payment flow.
 */

// ---------------------------------------------------------------------------
// cost → credits
// ---------------------------------------------------------------------------

/**
 * Credits per USD of actual model cost. Set this ABOVE 1/price so it embeds your
 * margin (e.g. 100 ⇒ 1 credit ≈ $0.01 of model cost). CREDIT_MARGIN multiplies on
 * top for an explicit markup. Both are env-configurable so the rate stays fair
 * across Auto / MAX / cheap / expensive models — we always bill on real cost.
 */
export const CREDITS_PER_USD = numEnv('CREDITS_PER_USD', 100);
export const CREDIT_MARGIN = numEnv('CREDIT_MARGIN', 1);

/** New users get this many free credits, once (idempotent signup grant). */
export const SIGNUP_GRANT_CREDITS = Math.max(0, Math.floor(numEnv('SIGNUP_GRANT_CREDITS', 50)));

// ---------------------------------------------------------------------------
// Payment methods. Dodo exposes `crypto_currency` for crypto/stablecoin checkout
// (USDC/USDT etc.). We always keep card (credit/debit) as the required fallback
// per Dodo's guidance, and add crypto when enabled (default on; set
// DODO_ENABLE_CRYPTO=false to disable). Method choice does NOT affect the grant
// flow — payment.succeeded fires the same way and credits map server-side.
// ---------------------------------------------------------------------------
export const ENABLE_CRYPTO = process.env.DODO_ENABLE_CRYPTO !== 'false';

/** Subset of Dodo's PaymentMethodTypes we allow at checkout. */
export type AllowedPaymentMethod = 'credit' | 'debit' | 'crypto_currency';

export function allowedPaymentMethods(): AllowedPaymentMethod[] {
  // Always include card as a fallback (Dodo: if all methods are unavailable the
  // session fails), then stablecoin/crypto when enabled.
  const methods: AllowedPaymentMethod[] = ['credit', 'debit'];
  if (ENABLE_CRYPTO) methods.push('crypto_currency');
  return methods;
}

/**
 * Convert a USD model cost into integer credits (rounded UP so we never
 * undercharge). A run that reports zero cost charges zero credits.
 */
export function costToCredits(costUsd: number): number {
  if (!costUsd || costUsd <= 0 || !Number.isFinite(costUsd)) return 0;
  return Math.max(1, Math.ceil(costUsd * CREDITS_PER_USD * CREDIT_MARGIN));
}

// ---------------------------------------------------------------------------
// Credit packs (one-time top-ups). Amounts + granted credits are configurable;
// the Dodo product ids are filled in by scripts/create-dodo-products.ts and set
// in env. credits live in the product metadata too, but THIS map is authoritative.
// ---------------------------------------------------------------------------

export interface CreditPack {
  key: 'starter' | 'pro' | 'max';
  name: string;
  /** Price in the smallest currency unit (USD cents). */
  priceCents: number;
  currency: 'USD';
  /** Credits granted on a successful purchase. */
  credits: number;
  /** Env var holding the Dodo product id for this pack. */
  productEnvVar: string;
}

export const CREDIT_PACKS: CreditPack[] = [
  { key: 'starter', name: 'Starter Pack', priceCents: numEnv('CREDIT_PACK_STARTER_CENTS', 500), currency: 'USD', credits: numEnv('CREDIT_PACK_STARTER_CREDITS', 500), productEnvVar: 'DODO_PRODUCT_STARTER' },
  { key: 'pro', name: 'Pro Pack', priceCents: numEnv('CREDIT_PACK_PRO_CENTS', 2000), currency: 'USD', credits: numEnv('CREDIT_PACK_PRO_CREDITS', 2500), productEnvVar: 'DODO_PRODUCT_PRO' },
  { key: 'max', name: 'Max Pack', priceCents: numEnv('CREDIT_PACK_MAX_CENTS', 5000), currency: 'USD', credits: numEnv('CREDIT_PACK_MAX_CREDITS', 7000), productEnvVar: 'DODO_PRODUCT_MAX' },
];

/** The Dodo product id configured for a pack (env), or undefined if unset. */
export function productIdForPack(pack: CreditPack): string | undefined {
  const v = process.env[pack.productEnvVar];
  return v && v.trim() ? v.trim() : undefined;
}

/** Find the pack a Dodo product_id maps to (server-side entitlement lookup). */
export function packForProductId(productId: string): CreditPack | undefined {
  if (!productId) return undefined;
  return CREDIT_PACKS.find((p) => productIdForPack(p) === productId);
}

/**
 * Credits to grant for a verified purchase of `productId`. Prefers the
 * server-side pack map; falls back to a credits value carried in TRUSTED
 * server-side metadata (the Dodo payment object, never client input).
 */
export function creditsForPurchase(productId: string | undefined, trustedMetaCredits?: number): number {
  const pack = productId ? packForProductId(productId) : undefined;
  if (pack) return pack.credits;
  const meta = Number(trustedMetaCredits);
  return Number.isFinite(meta) && meta > 0 ? Math.floor(meta) : 0;
}

/** Public, client-safe pack listing (no secrets) for the pricing UI. */
export function publicPacks() {
  return CREDIT_PACKS.map((p) => ({
    key: p.key,
    name: p.name,
    priceCents: p.priceCents,
    currency: p.currency,
    credits: p.credits,
    priceLabel: `$${(p.priceCents / 100).toFixed(2)}`,
    available: !!productIdForPack(p),
  }));
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export default {
  CREDITS_PER_USD,
  CREDIT_MARGIN,
  SIGNUP_GRANT_CREDITS,
  costToCredits,
  CREDIT_PACKS,
  productIdForPack,
  packForProductId,
  creditsForPurchase,
  publicPacks,
};
