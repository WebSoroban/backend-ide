/**
 * Dodo Payments client + webhook verification. SERVER-SIDE ONLY — the API key and
 * webhook secret never reach the browser.
 *
 * Environment is gated by env (DODO_PAYMENTS_ENVIRONMENT). In `live_mode` Dodo
 * creates REAL, purchasable products and processes REAL charges; use `test_mode`
 * for development (test card 4242 4242 4242 4242). See BILLING.md.
 */
import DodoPayments from 'dodopayments';
import { Webhook } from 'standardwebhooks';

export type DodoEnvironment = 'live_mode' | 'test_mode';

export function dodoEnvironment(): DodoEnvironment {
  return process.env.DODO_PAYMENTS_ENVIRONMENT === 'test_mode' ? 'test_mode' : 'live_mode';
}

export function isLiveMode(): boolean {
  return dodoEnvironment() === 'live_mode';
}

let client: DodoPayments | null = null;

/**
 * Lazily build the Dodo client from env. Defaults to live_mode (per the SDK), so
 * be explicit with DODO_PAYMENTS_ENVIRONMENT=test_mode in dev.
 */
export function getDodo(): DodoPayments {
  const bearerToken = process.env.DODO_PAYMENTS_API_KEY;
  if (!bearerToken) {
    throw new Error('Dodo Payments is not configured. Set DODO_PAYMENTS_API_KEY (and DODO_PAYMENTS_ENVIRONMENT).');
  }
  if (!client) {
    client = new DodoPayments({ bearerToken, environment: dodoEnvironment() });
  }
  return client;
}

export function isDodoConfigured(): boolean {
  return !!process.env.DODO_PAYMENTS_API_KEY;
}

/** The return URL Dodo sends the customer back to after checkout. */
export function returnUrl(): string {
  return (
    process.env.DODO_RETURN_URL ||
    `${process.env.FRONTEND_URL || 'https://websoroban.in'}/billing?checkout=complete`
  );
}

// ---------------------------------------------------------------------------
// Webhook verification (Standard Webhooks spec). Dodo sends webhook-id,
// webhook-signature, webhook-timestamp headers; the signature is an HMAC over the
// RAW request body. We MUST verify against the raw bytes — never the parsed JSON.
// ---------------------------------------------------------------------------

let webhook: Webhook | null = null;

function getWebhook(): Webhook {
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
  if (!secret) throw new Error('DODO_PAYMENTS_WEBHOOK_SECRET is not set.');
  if (!webhook) webhook = new Webhook(secret);
  return webhook;
}

export interface DodoWebhookHeaders {
  'webhook-id'?: string | string[];
  'webhook-signature'?: string | string[];
  'webhook-timestamp'?: string | string[];
}

/**
 * Verify a raw webhook body + headers and return the parsed event. Throws if the
 * signature is invalid or the secret is missing — callers must NOT act on an
 * unverified event.
 */
export function verifyWebhook(rawBody: string, headers: DodoWebhookHeaders): any {
  const h = {
    'webhook-id': single(headers['webhook-id']),
    'webhook-signature': single(headers['webhook-signature']),
    'webhook-timestamp': single(headers['webhook-timestamp']),
  };
  // standardwebhooks throws WebhookVerificationError on a bad signature.
  return getWebhook().verify(rawBody, h);
}

function single(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] || '';
  return v || '';
}

export default { getDodo, isLiveMode, dodoEnvironment, isDodoConfigured, returnUrl, verifyWebhook };
