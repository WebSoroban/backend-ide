import { createHmac, timingSafeEqual } from 'crypto';
import type { RequestHandler } from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactStellarScheme } from '@x402/stellar/exact/server';

export type StellarNetwork = 'stellar:testnet' | 'stellar:pubnet';

const KEY_PREFIX: Record<StellarNetwork, string> = {
  'stellar:testnet': 'wsp_test_',
  'stellar:pubnet': 'wsp_live_',
};

const HORIZON: Record<StellarNetwork, string> = {
  'stellar:testnet': 'https://horizon-testnet.stellar.org',
  'stellar:pubnet': 'https://horizon.stellar.org',
};

export const USDC_ISSUERS: Record<StellarNetwork, string> = {
  'stellar:testnet': 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  'stellar:pubnet': 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};

export interface WebSorobanPayOptions {
  /** WebSoroban API root, for example https://api.example.com/api. */
  apiUrl: string;
  /** Scoped endpoint key returned once by the WebSoroban Pay studio. */
  apiKey: string | undefined;
  /** Endpoint id shown in the studio. Reserved for telemetry correlation. */
  endpointId: string;
  /** Stellar address that receives USDC. Must match the endpoint's payout address. */
  payTo: string;
  /**
   * Settlement network. Inferred from the key prefix (`wsp_test_` or
   * `wsp_live_`); passing a different value throws, so a testnet key can never
   * be wired to a mainnet route by accident.
   */
  network?: StellarNetwork;
  /** Horizon base URL override, used by `preflight()` for the trustline check. */
  horizonUrl?: string;
}

export interface ProtectOptions {
  description?: string;
  maxTimeoutSeconds?: number;
}

export interface PreflightReport {
  ok: boolean;
  network: StellarNetwork;
  facilitator: { ok: boolean; message: string };
  payout: TrustlineReport;
}

function keyNetwork(apiKey: string): StellarNetwork | null {
  if (apiKey.startsWith(KEY_PREFIX['stellar:pubnet'])) return 'stellar:pubnet';
  if (apiKey.startsWith(KEY_PREFIX['stellar:testnet'])) return 'stellar:testnet';
  return null;
}

/**
 * Creates x402 Express middleware backed by WebSoroban's managed facilitator.
 * The endpoint key is sent only to the WebSoroban server, never to a browser.
 */
export function createWebSorobanPay(options: WebSorobanPayOptions) {
  if (!options.apiKey) throw new Error('WEBSOROBAN_PAY_KEY is required.');
  if (!options.apiUrl) throw new Error('A WebSoroban API URL is required.');
  if (!options.endpointId) throw new Error('A WebSoroban endpoint id is required.');
  if (!options.payTo) throw new Error('A payout address (payTo) is required.');
  const inferred = keyNetwork(options.apiKey);
  if (!inferred) throw new Error('WEBSOROBAN_PAY_KEY must start with wsp_test_ or wsp_live_.');
  if (options.network && options.network !== inferred) {
    throw new Error(`This endpoint key settles on ${inferred}, but network is set to ${options.network}.`);
  }
  const network = inferred;
  const apiKey = options.apiKey;
  const apiRoot = options.apiUrl.replace(/\/$/, '');

  const url = `${apiRoot}/pay/facilitator`;
  const auth = { Authorization: `Bearer ${apiKey}` };
  const facilitator = new HTTPFacilitatorClient({
    url,
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
  });
  const server = new x402ResourceServer(facilitator).register(network, new ExactStellarScheme());

  return {
    network,

    protect(route: `${'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} /${string}`, price: string, config: ProtectOptions = {}): RequestHandler {
      return paymentMiddleware({
        [route]: {
          accepts: {
            scheme: 'exact',
            network,
            price,
            payTo: options.payTo,
            maxTimeoutSeconds: config.maxTimeoutSeconds ?? 60,
          },
          serviceName: 'WebSoroban Pay',
          description: config.description || `A Stellar ${network === 'stellar:pubnet' ? 'mainnet' : 'testnet'} endpoint protected by x402.`,
          mimeType: 'application/json',
        },
      }, server, undefined, undefined, true);
    },

    /**
     * Check the setup before taking traffic: the endpoint key reaches the
     * managed facilitator, and the payout address can receive USDC.
     */
    async preflight(): Promise<PreflightReport> {
      let facilitatorStatus = { ok: false, message: '' };
      try {
        const response = await fetch(`${url}/supported`, { headers: auth, signal: AbortSignal.timeout(10_000) });
        const body: any = await response.json().catch(() => ({}));
        facilitatorStatus = response.ok
          ? { ok: true, message: 'The endpoint key reaches the WebSoroban facilitator.' }
          : { ok: false, message: body?.message || body?.error || `Facilitator proxy returned HTTP ${response.status}.` };
      } catch (error) {
        facilitatorStatus = { ok: false, message: error instanceof Error ? error.message : 'Facilitator proxy is unreachable.' };
      }
      const payout = await checkUsdcTrustline(options.payTo, network, { horizonUrl: options.horizonUrl });
      return {
        ok: facilitatorStatus.ok && payout.ready,
        network,
        facilitator: facilitatorStatus,
        payout,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// USDC trustline check
// ---------------------------------------------------------------------------

export type TrustlineStatus =
  | 'ready'
  | 'missing_account'
  | 'missing_trustline'
  | 'not_authorized'
  | 'not_applicable'
  | 'unknown';

export interface TrustlineReport {
  address: string;
  network: StellarNetwork;
  status: TrustlineStatus;
  ready: boolean;
  balance: string | null;
  message: string;
}

const MESSAGES: Record<TrustlineStatus, string> = {
  ready: 'The account can send and receive USDC.',
  missing_account: 'The account does not exist on this network yet. Fund it with XLM first.',
  missing_trustline: 'The account has no USDC trustline. Add USDC from the wallet asset list.',
  not_authorized: 'The USDC issuer has not authorized this trustline.',
  not_applicable: 'Contract accounts hold USDC through the asset contract and need no trustline.',
  unknown: 'Horizon could not confirm the trustline. Retry shortly.',
};

/**
 * Check whether a classic Stellar account can hold USDC on a network.
 * Contract (C…) addresses need no trustline and report `not_applicable`.
 */
export async function checkUsdcTrustline(
  address: string,
  network: StellarNetwork = 'stellar:testnet',
  options: { horizonUrl?: string } = {},
): Promise<TrustlineReport> {
  const result = (status: TrustlineStatus, balance: string | null = null): TrustlineReport => ({
    address,
    network,
    status,
    ready: status === 'ready' || status === 'not_applicable',
    balance,
    message: MESSAGES[status],
  });
  if (/^C[A-Z2-7]{55}$/.test(address)) return result('not_applicable');
  if (!/^G[A-Z2-7]{55}$/.test(address)) {
    throw new Error('Pass a Stellar G-address (or a C-address for contract accounts).');
  }
  const horizon = (options.horizonUrl || HORIZON[network]).replace(/\/$/, '');
  try {
    const response = await fetch(`${horizon}/accounts/${address}`, { signal: AbortSignal.timeout(5_000) });
    if (response.status === 404) return result('missing_account');
    if (!response.ok) return result('unknown');
    const body: any = await response.json();
    const line = (Array.isArray(body?.balances) ? body.balances : []).find(
      (balance: any) => balance.asset_code === 'USDC' && balance.asset_issuer === USDC_ISSUERS[network],
    );
    if (!line) return result('missing_trustline');
    if (line.is_authorized === false) return result('not_authorized', String(line.balance));
    return result('ready', String(line.balance));
  } catch {
    return result('unknown');
  }
}

// ---------------------------------------------------------------------------
// Wallet compatibility
// ---------------------------------------------------------------------------

export interface AuthEntryWallet {
  id: string;
  name: string;
  platform: string;
  /** Can sign Soroban authorization entries (SEP-43 signAuthEntry). */
  authEntry: boolean;
  /** WebSoroban's hosted checkout can drive this wallet. */
  checkout: boolean;
  guidance: string;
}

/** x402 on Stellar needs auth-entry signing. Keep in sync with services/x402Wallets.ts. */
export const AUTH_ENTRY_WALLETS: AuthEntryWallet[] = [
  { id: 'freighter', name: 'Freighter', platform: 'Browser extension', authEntry: true, checkout: true, guidance: 'Supported in the hosted checkout. Match the extension network to the endpoint before approving.' },
  { id: 'hana', name: 'Hana', platform: 'Browser extension', authEntry: true, checkout: true, guidance: 'Supported in the hosted checkout.' },
  { id: 'hot-wallet', name: 'HOT', platform: 'Browser extension', authEntry: true, checkout: true, guidance: 'Supported in the hosted checkout.' },
  { id: 'klever', name: 'Klever', platform: 'Browser extension', authEntry: true, checkout: true, guidance: 'Supported in the hosted checkout.' },
  { id: 'albedo', name: 'Albedo', platform: 'Web', authEntry: true, checkout: false, guidance: 'Signs auth entries from your own x402 client. The hosted checkout cannot drive it yet.' },
  { id: 'onekey', name: 'OneKey', platform: 'Browser extension', authEntry: true, checkout: false, guidance: 'Signs auth entries from your own x402 client. The hosted checkout cannot drive it yet.' },
  { id: 'freighter-mobile', name: 'Freighter Mobile', platform: 'iOS and Android', authEntry: false, checkout: false, guidance: 'Not supported. Freighter Mobile cannot sign Soroban auth entries yet. Use the desktop extension.' },
];

/** Returns whether a wallet can pay an x402 Stellar challenge, with guidance either way. */
export function checkWalletCompatibility(walletId: string): { supported: boolean; wallet: AuthEntryWallet | null; guidance: string } {
  const wallet = AUTH_ENTRY_WALLETS.find((item) => item.id === walletId.trim().toLowerCase()) || null;
  if (!wallet) {
    return {
      supported: false,
      wallet: null,
      guidance: 'Unknown wallet. x402 on Stellar needs a wallet that can sign Soroban auth entries: Freighter, Hana, HOT, Klever, Albedo, or OneKey.',
    };
  }
  return { supported: wallet.authEntry, wallet, guidance: wallet.guidance };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export type PayWebhookEvent = 'payment.settled' | 'payment.failed' | 'wallet.spend_limit_exceeded';

export interface PayWebhookPayload {
  id: string;
  type: PayWebhookEvent | 'webhook.test';
  createdAt: string;
  data: Record<string, unknown>;
}

/**
 * Verify an `X-WebSoroban-Signature` header (`t=<unix>,v1=<hex hmac>`) against
 * the raw request body. Use the raw bytes, not a re-serialized JSON object.
 */
export function verifyWebhook(
  secret: string,
  signatureHeader: string | undefined,
  rawBody: string | Buffer,
  options: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  if (!signatureHeader) return false;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const parts = Object.fromEntries(signatureHeader.split(',').map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  const timestamp = Number(parts.t);
  const tolerance = options.toleranceSeconds ?? 300;
  const now = (options.now ?? Date.now()) / 1000;
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > tolerance) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const provided = Buffer.from(parts.v1 || '');
  const wanted = Buffer.from(expected);
  return provided.length > 0 && provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

/** Verify and parse a delivery in one step. Throws when the signature is invalid. */
export function constructWebhookEvent(secret: string, signatureHeader: string | undefined, rawBody: string | Buffer): PayWebhookPayload {
  if (!verifyWebhook(secret, signatureHeader, rawBody)) {
    throw new Error('Invalid WebSoroban webhook signature.');
  }
  return JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) as PayWebhookPayload;
}

async function studioRequest(apiUrl: string, accessToken: string, path: string, body: unknown) {
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!response.ok) throw new Error(data.error || data.message || 'WebSoroban Pay request failed.');
  return data;
}

/** Register a signed webhook. The signing secret is returned once. */
export function registerWebhook(options: {
  apiUrl: string;
  accessToken: string;
  url: string;
  events: PayWebhookEvent[];
  endpointId?: string;
}) {
  return studioRequest(options.apiUrl, options.accessToken, '/pay/webhooks', {
    url: options.url,
    events: options.events,
    endpointId: options.endpointId,
  });
}

/**
 * Register an agent signer with a daily USDC cap.
 * Settlement is rejected before the facilitator when the cap would be exceeded.
 */
export function createAgentWallet(options: {
  apiUrl: string;
  accessToken: string;
  name: string;
  publicKey: string;
  spendLimit: string;
  endpointId?: string;
}) {
  return studioRequest(options.apiUrl, options.accessToken, '/pay/agent-wallets', {
    name: options.name,
    publicKey: options.publicKey,
    spendLimit: options.spendLimit,
    endpointId: options.endpointId,
  });
}
