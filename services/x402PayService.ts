import { createHash, randomBytes } from 'crypto';
import type { Prisma, X402Endpoint } from '@prisma/client';
import { validateStellarDestinationAddress } from '@x402/stellar';
import prisma from '../lib/prisma';
import { queuePaymentWebhooks } from './x402Webhooks';

export { normalizeX402Error } from './x402Errors';

export const X402_NETWORK = 'stellar:testnet' as const;
export const X402_ASSET = 'USDC' as const;
export const OPENZEPPELIN_TESTNET_FACILITATOR = 'https://channels.openzeppelin.com/x402/testnet';
export const PUBLIC_TESTNET_FACILITATOR = 'https://www.x402.org/facilitator';

export const facilitatorApiKey = process.env.X402_FACILITATOR_API_KEY?.trim() || '';
export const facilitatorUrl =
  process.env.X402_FACILITATOR_URL?.trim() ||
  (facilitatorApiKey ? OPENZEPPELIN_TESTNET_FACILITATOR : PUBLIC_TESTNET_FACILITATOR);

export function facilitatorLabel(): string {
  if (facilitatorUrl.includes('channels.openzeppelin.com')) return 'OpenZeppelin Channels';
  if (facilitatorUrl.includes('x402.org')) return 'x402.org public testnet';
  return 'Custom x402 facilitator';
}

export function normalizeEndpointSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

export function normalizeUsdPrice(value: string | number): string {
  const raw = String(value).trim().replace(/^\$/, '');
  if (!/^\d+(?:\.\d{1,7})?$/.test(raw)) {
    throw new Error('Price must be a positive USDC amount with up to 7 decimal places.');
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 10_000) {
    throw new Error('Price must be greater than 0 and no more than 10,000 USDC.');
  }
  return `$${raw}`;
}

export function validatePayoutAddress(value: string): string {
  const address = value.trim();
  if (!validateStellarDestinationAddress(address)) {
    throw new Error('Enter a valid Stellar G-address for the testnet USDC payout wallet.');
  }
  return address;
}

export function createEndpointApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `wsp_test_${randomBytes(24).toString('base64url')}`;
  return {
    raw,
    hash: hashEndpointApiKey(raw),
    prefix: `${raw.slice(0, 13)}…`,
  };
}
export function hashEndpointApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function fingerprintPayment(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(serialized).digest('hex');
}

export function slugFromResourcePath(path: string): string | null {
  const match = path.match(/\/resource\/([^/?#]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export async function getActiveEndpointByPath(path: string): Promise<X402Endpoint> {
  const slug = slugFromResourcePath(path);
  if (!slug) throw new Error('Paid endpoint was not found.');
  const endpoint = await prisma.x402Endpoint.findUnique({ where: { slug } });
  if (!endpoint || !endpoint.active) throw new Error('Paid endpoint is not active.');
  return endpoint;
}

export async function getEndpointByApiKey(rawKey: string): Promise<X402Endpoint | null> {
  if (!rawKey.startsWith('wsp_test_')) return null;
  return prisma.x402Endpoint.findUnique({ where: { apiKeyHash: hashEndpointApiKey(rawKey) } });
}

export interface X402EventInput {
  endpointId: string;
  type: string;
  status: string;
  requestFingerprint?: string;
  transaction?: string;
  payer?: string;
  amount?: string;
  errorCode?: string;
  errorMessage?: string;
  latencyMs?: number;
  metadata?: Prisma.InputJsonValue;
}

/** Observability must never interrupt verification or settlement. */
export async function recordX402Event(input: X402EventInput): Promise<void> {
  try {
    const created = await prisma.x402Event.create({
      data: {
        endpointId: input.endpointId,
        type: input.type,
        status: input.status,
        requestFingerprint: input.requestFingerprint,
        transaction: input.transaction,
        payer: input.payer,
        amount: input.amount,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        latencyMs: input.latencyMs,
        metadata: input.metadata || {},
      },
    });
    void queuePaymentWebhooks(created);
  } catch (error) {
    console.error('[x402] Failed to persist payment event:', error);
  }
}

export function serializeEndpoint(endpoint: X402Endpoint, publicApiBase: string) {
  const responseBody = endpoint.responseBody as Record<string, unknown>;
  return {
    id: endpoint.id,
    projectId: endpoint.projectId,
    name: endpoint.name,
    slug: endpoint.slug,
    method: endpoint.method,
    price: endpoint.price,
    asset: endpoint.asset,
    network: endpoint.network,
    payTo: endpoint.payTo,
    responseBody,
    apiKeyPrefix: endpoint.apiKeyPrefix,
    active: endpoint.active,
    resourceUrl: `${publicApiBase}/pay/resource/${endpoint.slug}`,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  };
}
