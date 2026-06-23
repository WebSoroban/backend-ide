/**
 * Billing API (mounted at /api/billing). Credit balance, ledger/usage history,
 * credit-pack listing, Dodo checkout, and a reconciliation fallback.
 *
 * This is the fiat/credits system (Dodo Payments) — entirely separate from the
 * testnet-XLM plan/template flow in routes/payments.ts. All Dodo secrets stay
 * server-side; entitlement only ever comes from a verified webhook (or this
 * server-to-server reconcile), never from client input.
 */
import express, { type Request, type Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { getBalance } from '../services/billing/credits';
import { CREDIT_PACKS, productIdForPack, publicPacks, allowedPaymentMethods, ENABLE_CRYPTO } from '../services/billing/config';
import { getDodo, isDodoConfigured, returnUrl } from '../services/billing/dodo';
import { processPaymentGrant } from '../services/billing/grant';

const router = express.Router();

const checkoutLimiter = rateLimit({ windowSec: 60, max: 10, prefix: 'billing-checkout' });

// GET /api/billing/balance — the user's current credit balance.
router.get('/balance', authenticate, async (req: Request, res: Response) => {
  try {
    const balance = await getBalance(req.user!.id);
    res.json({ balance });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load balance', message: error.message });
  }
});

// GET /api/billing/plans — the public credit packs (price + credits) for the UI.
router.get('/plans', authenticate, async (_req: Request, res: Response) => {
  res.json({ plans: publicPacks(), configured: isDodoConfigured(), crypto: ENABLE_CRYPTO });
});

// GET /api/billing/ledger?limit= — recent credit movements (grants/purchases/usage).
router.get('/ledger', authenticate, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 200);
    const entries = await prisma.creditLedger.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ entries });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load ledger', message: error.message });
  }
});

// GET /api/billing/usage?limit= — recent per-run AI usage (model + cost + credits).
router.get('/usage', authenticate, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 200);
    const usage = await prisma.aiUsage.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ usage });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load usage', message: error.message });
  }
});

// POST /api/billing/checkout { pack } — create a Dodo checkout session for a pack.
router.post('/checkout', authenticate, checkoutLimiter, async (req: Request, res: Response) => {
  try {
    if (!isDodoConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured.' });
    }
    const user = req.user!;
    const packKey = req.body.pack;
    const pack = CREDIT_PACKS.find((p) => p.key === packKey);
    if (!pack) return res.status(400).json({ error: 'Unknown pack.' });

    const productId = productIdForPack(pack);
    if (!productId) {
      return res.status(503).json({ error: `Product for "${pack.key}" not configured. Run the products script and set ${pack.productEnvVar}.` });
    }

    const client = getDodo();

    // Create or reuse the Dodo customer; store the id for reconciliation.
    let customerId = (user as any).dodoCustomerId as string | null | undefined;
    if (!customerId) {
      const customer = await client.customers.create({ email: user.email, name: user.name || user.email });
      customerId = customer.customer_id;
      await prisma.user.update({ where: { id: user.id }, data: { dodoCustomerId: customerId } }).catch(() => {});
    }

    const session = await client.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { customer_id: customerId },
      return_url: returnUrl(),
      // Card (fallback) + stablecoin/crypto when enabled. The grant flow is
      // identical regardless of which the customer picks.
      allowed_payment_method_types: allowedPaymentMethods(),
      // Server-trusted metadata mirrored onto the payment — used as a fallback for
      // the user/credits mapping at grant time (the product map is authoritative).
      metadata: { userId: user.id, credits: String(pack.credits), pack: pack.key },
    });

    res.json({ checkout_url: session.checkout_url, session_id: session.session_id });
  } catch (error: any) {
    console.error('[billing] checkout error:', error?.message);
    res.status(500).json({ error: 'Failed to start checkout', message: error.message });
  }
});

// POST /api/billing/reconcile { paymentId } — fallback for a missed webhook. Verifies
// the payment with Dodo and grants (idempotently). Only credits the rightful owner.
router.post('/reconcile', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isDodoConfigured()) return res.status(503).json({ error: 'Billing is not configured.' });
    const paymentId = req.body.paymentId;
    if (!paymentId || typeof paymentId !== 'string') return res.status(400).json({ error: 'paymentId is required' });

    const result = await processPaymentGrant(paymentId);
    if (!result.ok) return res.status(400).json({ error: result.reason || 'Could not reconcile payment' });
    // A payment always grants to its rightful owner (from verified metadata). If
    // that isn't the caller, don't leak another user's balance.
    if (result.userId !== req.user!.id) {
      return res.status(200).json({ ok: true, note: 'Payment already attributed to its owner.' });
    }
    res.json({ ok: true, credits: result.credits, balance: result.balance, applied: result.applied });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to reconcile', message: error.message });
  }
});

export default router;
