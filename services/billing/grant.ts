/**
 * Purchase → credit grant. Shared by the billing worker (webhook-driven) and the
 * reconciliation endpoint (missed-webhook fallback). ALWAYS verifies the payment
 * with Dodo (server-to-server) before granting — we never trust client input, and
 * credits map server-side from the product id (config) with the verified payment
 * metadata as a fallback. Idempotent by payment id via the credit ledger.
 */
import prisma from '../../lib/prisma';
import { getDodo } from './dodo';
import { creditsForPurchase } from './config';
import { grantPurchaseCredits } from './credits';

export interface GrantResult {
  ok: boolean;
  reason?: string;
  userId?: string;
  credits?: number;
  balance?: number;
  /** false when the grant was already applied (idempotent no-op). */
  applied?: boolean;
}

/**
 * Verify a Dodo payment by id and grant the mapped credits to the buyer.
 * Returns ok:false (without throwing) for non-succeeded payments or unresolved
 * users so the caller can ack the webhook and move on.
 */
export async function processPaymentGrant(paymentId: string): Promise<GrantResult> {
  if (!paymentId) return { ok: false, reason: 'missing paymentId' };

  const payment: any = await getDodo().payments.retrieve(paymentId);
  const status = payment?.status;
  if (status && status !== 'succeeded') {
    return { ok: false, reason: `payment status is "${status}", not succeeded` };
  }

  // Resolve the buyer: prefer our metadata.userId (set at checkout), then map the
  // Dodo customer id back to a user.
  const metadata = payment?.metadata || {};
  let userId: string | undefined = typeof metadata.userId === 'string' ? metadata.userId : undefined;
  const dodoCustomerId: string | undefined = payment?.customer?.customer_id;
  if (!userId && dodoCustomerId) {
    const u = await prisma.user.findFirst({ where: { dodoCustomerId }, select: { id: true } });
    userId = u?.id;
  }
  if (!userId) return { ok: false, reason: 'could not resolve user for payment' };

  // Credits: server-side product map first, then trusted payment metadata.
  const productId: string | undefined = payment?.product_cart?.[0]?.product_id;
  const credits = creditsForPurchase(productId, Number(metadata.credits));
  if (credits <= 0) {
    return { ok: false, reason: `no credit mapping for product ${productId || '(unknown)'}` };
  }

  // Backfill the Dodo customer id mapping for future reconciliation.
  if (dodoCustomerId) {
    await prisma.user
      .update({ where: { id: userId }, data: { dodoCustomerId } })
      .catch(() => {});
  }

  const res = await grantPurchaseCredits(userId, credits, paymentId);
  return { ok: true, userId, credits, balance: res.balance, applied: res.applied };
}

export default { processPaymentGrant };
