import { createHash, randomBytes } from 'crypto';
import { Prisma, type X402Endpoint } from '@prisma/client';
import { validateStellarDestinationAddress } from '@x402/stellar';
import prisma from '../lib/prisma';
import { queuePaymentWebhooks } from './x402Webhooks';
import { explainX402Error, NON_FACILITATOR_ERRORS } from './x402Errors';
import {
  API_KEY_PREFIX,
  isX402Network,
  networkFromApiKey,
  type X402Network,
} from './x402Network';

export { normalizeX402Error } from './x402Errors';

export const X402_ASSET = 'USDC' as const;

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
    throw new Error('Enter a valid Stellar address (G…, M…, or C…) for the USDC payout wallet.');
  }
  return address;
}

export function createEndpointApiKey(network: X402Network = 'stellar:testnet'): { raw: string; hash: string; prefix: string } {
  const raw = `${API_KEY_PREFIX[network]}${randomBytes(24).toString('base64url')}`;
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

export function endpointNetwork(endpoint: Pick<X402Endpoint, 'network'>): X402Network {
  return isX402Network(endpoint.network) ? endpoint.network : 'stellar:testnet';
}

export async function getActiveEndpointByPath(path: string): Promise<X402Endpoint> {
  const slug = slugFromResourcePath(path);
  if (!slug) throw new Error('Paid endpoint was not found.');
  const endpoint = await prisma.x402Endpoint.findUnique({ where: { slug } });
  if (!endpoint || !endpoint.active) throw new Error('Paid endpoint is not active.');
  return endpoint;
}

/** Resolve an endpoint from its raw key. The key prefix must match the endpoint network. */
export async function getEndpointByApiKey(rawKey: string): Promise<X402Endpoint | null> {
  const network = networkFromApiKey(rawKey);
  if (!network) return null;
  const endpoint = await prisma.x402Endpoint.findUnique({ where: { apiKeyHash: hashEndpointApiKey(rawKey) } });
  if (!endpoint || endpointNetwork(endpoint) !== network) return null;
  return endpoint;
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
        transaction: input.transaction || undefined,
        payer: input.payer,
        amount: input.amount,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage?.slice(0, 1000),
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
    network: endpointNetwork(endpoint),
    payTo: endpoint.payTo,
    responseBody,
    apiKeyPrefix: endpoint.apiKeyPrefix,
    active: endpoint.active,
    resourceUrl: `${publicApiBase}/pay/resource/${endpoint.slug}`,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  };
}

export interface SettlementWindow {
  label: '24h' | '7d' | '30d';
  attempts: number;
  settled: number;
  failed: number;
  /** settled / attempts that reached the facilitator; null without data. */
  successRate: number | null;
}

export interface FailureReason {
  code: string;
  count: number;
  message: string;
  cause: string;
  fix: string;
}

const WINDOWS: Array<{ label: SettlementWindow['label']; ms: number }> = [
  { label: '24h', ms: 86_400_000 },
  { label: '7d', ms: 7 * 86_400_000 },
  { label: '30d', ms: 30 * 86_400_000 },
];

export function successRate(settled: number, facilitatorFailures: number): number | null {
  const attempts = settled + facilitatorFailures;
  if (!attempts) return null;
  return Math.round((settled / attempts) * 10_000) / 10_000;
}

/**
 * Settlement reliability for KR tracking. Only settlement events count, and
 * failures that never reached the facilitator (spend caps, rate limits,
 * network mismatches) are excluded from the rate but still listed as reasons.
 */
export async function settlementMetrics(endpointIds: string[], now = Date.now()) {
  if (!endpointIds.length) {
    return {
      windows: WINDOWS.map(({ label }) => ({ label, attempts: 0, settled: 0, failed: 0, successRate: null })),
      failureReasons: [] as FailureReason[],
    };
  }
  const windows: SettlementWindow[] = await Promise.all(WINDOWS.map(async (window) => {
    const rows = await prisma.x402Event.groupBy({
      by: ['status', 'errorCode'],
      where: { endpointId: { in: endpointIds }, type: 'settlement', createdAt: { gte: new Date(now - window.ms) } },
      _count: { _all: true },
    });
    let settled = 0;
    let failed = 0;
    let facilitatorFailures = 0;
    for (const row of rows) {
      if (row.status === 'settled') settled += row._count._all;
      if (row.status !== 'failed') continue;
      failed += row._count._all;
      if (!NON_FACILITATOR_ERRORS.has(row.errorCode || '')) facilitatorFailures += row._count._all;
    }
    return {
      label: window.label,
      attempts: settled + facilitatorFailures,
      settled,
      failed,
      successRate: successRate(settled, facilitatorFailures),
    };
  }));

  const reasons = await prisma.x402Event.groupBy({
    by: ['errorCode'],
    where: {
      endpointId: { in: endpointIds },
      status: 'failed',
      type: { in: ['verification', 'settlement'] },
      createdAt: { gte: new Date(now - 7 * 86_400_000) },
    },
    _count: { _all: true },
  });
  const failureReasons = reasons
    .map((row) => {
      const info = explainX402Error(row.errorCode || 'FACILITATOR_REJECTED')!;
      return { code: info.code, count: row._count._all, message: info.message, cause: info.cause, fix: info.fix };
    })
    .sort((left, right) => right.count - left.count);

  return { windows, failureReasons };
}

/** Exact USDC revenue from settled events, summed in Postgres. */
export async function settledRevenue(endpointIds: string[]): Promise<string> {
  if (!endpointIds.length) return '0';
  const rows = await prisma.$queryRaw<Array<{ total: string | null }>>`
    SELECT COALESCE(SUM(CAST(REPLACE("amount", '$', '') AS NUMERIC)), 0)::TEXT AS total
    FROM "X402Event"
    WHERE "status" = 'settled' AND "amount" ~ '^\\$?[0-9]+(\\.[0-9]+)?$'
      AND "endpointId" IN (${Prisma.join(endpointIds)})
  `;
  const total = rows[0]?.total || '0';
  return total.includes('.') ? total.replace(/0+$/, '').replace(/\.$/, '') : total;
}

