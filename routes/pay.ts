import express, { type NextFunction, type Request, type Response } from 'express';
import { StrKey } from '@stellar/stellar-sdk';
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from '@x402/express';
import { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } from '@x402/stellar';
import type { X402Endpoint } from '@prisma/client';
import prisma from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';
import { rateLimit } from '../middleware/rateLimit';
import {
  X402_ASSET,
  createEndpointApiKey,
  endpointNetwork,
  fingerprintPayment,
  getActiveEndpointByPath,
  getEndpointByApiKey,
  normalizeEndpointSlug,
  normalizeUsdPrice,
  normalizeX402Error,
  recordX402Event,
  serializeEndpoint,
  settledRevenue,
  settlementMetrics,
  validatePayoutAddress,
} from '../services/x402PayService';
import { classifyFacilitatorReason, explainX402Error, X402_ERROR_CATALOG } from '../services/x402Errors';
import {
  enabledNetworks,
  facilitatorFor,
  facilitatorHeaders,
  isNetworkEnabled,
  networkLabel,
  networkSummary,
  parseX402Network,
  type X402Network,
} from '../services/x402Network';
import { FACILITATOR_PROXY_LIMIT, facilitatorProxyLimiter } from '../services/x402RateLimit';
import { AUTH_ENTRY_WALLETS } from '../services/x402Wallets';
import { DAY_LEDGERS, stroopsToUsdc, usdcToStroops } from '../services/x402SpendLimit';
import { commitAgentSpend, releaseAgentSpend, reserveAgentSpend } from '../services/x402AgentSpend';
import { decodeStellarTransfer, extractPayer } from '../services/x402Payload';
import { checkUsdcTrustline } from '../services/x402Trustline';
import {
  createWebhookSecret,
  isWebhookUrl,
  queueTestDelivery,
  WEBHOOK_EVENTS,
} from '../services/x402Webhooks';
import { encrypt } from '../lib/crypto';
import { adoptionReport } from '../services/x402Adoption';

const router = express.Router();
const railwayPublicDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
const defaultPublicApiBase = railwayPublicDomain
  ? `https://${railwayPublicDomain}/api`
  : process.env.NODE_ENV === 'production'
    ? 'https://backend-ide-production-003a.up.railway.app/api'
    : 'http://localhost:3001/api';
const PUBLIC_API_BASE = (process.env.PUBLIC_API_URL?.trim() || defaultPublicApiBase).replace(/\/$/, '');
const FRONTEND_BASE = (
  process.env.FRONTEND_URL?.trim() ||
  (process.env.NODE_ENV === 'production' ? 'https://websoroban.in' : 'http://localhost:3000')
).replace(/\/$/, '');

/** Path prefix of each network's hosted resource route, relative to /api/pay. */
const RESOURCE_PREFIX: Record<X402Network, string> = {
  'stellar:testnet': '/resource',
  'stellar:pubnet': '/live/resource',
};
const USDC_CONTRACT: Record<X402Network, string> = {
  'stellar:testnet': USDC_TESTNET_ADDRESS,
  'stellar:pubnet': USDC_PUBNET_ADDRESS,
};

const asyncRoute = (
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) => (req: Request, res: Response, next: NextFunction) => {
  void Promise.resolve(handler(req, res, next)).catch(next);
};

// The backend still compiles as CommonJS with legacy Node resolution. Runtime
// subpath exports work correctly, but TypeScript's node10 resolver cannot see
// their declarations, so keep these two boundary imports explicitly typed.
const { HTTPFacilitatorClient } = require('@x402/core/server') as {
  HTTPFacilitatorClient: new (config: Record<string, unknown>) => any;
};
const { ExactStellarScheme } = require('@x402/stellar/exact/server') as {
  ExactStellarScheme: new () => any;
};

function resourceUrlFor(endpoint: Pick<X402Endpoint, 'network' | 'slug'>) {
  return `${PUBLIC_API_BASE}/pay${RESOURCE_PREFIX[endpointNetwork(endpoint)]}/${endpoint.slug}`;
}

function serialize(endpoint: X402Endpoint) {
  return { ...serializeEndpoint(endpoint, PUBLIC_API_BASE), resourceUrl: resourceUrlFor(endpoint) };
}

function usdcAmount(atomic: string | bigint | undefined, fallback: string): string {
  try {
    if (atomic === undefined || atomic === null || atomic === '') return fallback;
    return `$${stroopsToUsdc(BigInt(atomic))}`;
  } catch {
    return fallback;
  }
}

async function endpointFromTransport(transportContext: unknown) {
  const path = (transportContext as any)?.request?.path;
  return typeof path === 'string' ? getActiveEndpointByPath(path).catch(() => null) : null;
}

/**
 * One isolated x402 resource server per network. Each talks to exactly one
 * facilitator, so a testnet facilitator can never be asked to settle mainnet
 * funds, and a misbehaving mainnet facilitator cannot affect testnet routes.
 */
function buildNetworkMiddleware(network: X402Network) {
  const config = facilitatorFor(network)!;
  const facilitator = new HTTPFacilitatorClient({
    url: config.url,
    createAuthHeaders: async () => {
      const headers = facilitatorHeaders(config);
      return { verify: headers, settle: headers, supported: headers };
    },
  });
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactStellarScheme());
  const metadata = { network, facilitator: config.label, source: 'hosted_resource' };

  resourceServer.onAfterVerify(async (context) => {
    const endpoint = await endpointFromTransport(context.transportContext);
    if (!endpoint) return;
    const transfer = decodeStellarTransfer(context.paymentPayload, network);
    await recordX402Event({
      endpointId: endpoint.id,
      type: 'verification',
      status: context.result.isValid ? 'verified' : 'failed',
      requestFingerprint: fingerprintPayment(context.paymentPayload),
      payer: context.result.payer || transfer?.from,
      amount: usdcAmount(transfer?.amount, endpoint.price),
      errorCode: context.result.isValid ? undefined : classifyFacilitatorReason(context.result.invalidReason, context.result.invalidMessage) || undefined,
      errorMessage: context.result.invalidMessage || context.result.invalidReason,
      metadata: { ...metadata, facilitatorReason: context.result.invalidReason || null },
    });
  });

  resourceServer.onVerifyFailure(async (context) => {
    const endpoint = await endpointFromTransport(context.transportContext);
    if (!endpoint) return;
    const normalized = normalizeX402Error(context.error);
    await recordX402Event({
      endpointId: endpoint.id,
      type: 'verification',
      status: 'failed',
      requestFingerprint: fingerprintPayment(context.paymentPayload),
      payer: extractPayer(context.paymentPayload) || undefined,
      amount: endpoint.price,
      errorCode: normalized.code,
      errorMessage: normalized.message,
      metadata,
    });
  });

  resourceServer.onBeforeSettle(async (context) => {
    const endpoint = await endpointFromTransport(context.transportContext);
    if (!endpoint) return;
    const gate = await reserveAgentSpend({
      userId: endpoint.userId,
      endpointId: endpoint.id,
      payer: extractPayer(context.paymentPayload),
      price: endpoint.price,
      fingerprint: fingerprintPayment(context.paymentPayload),
    });
    if (!gate.allowed) {
      return { abort: true, reason: 'SPEND_LIMIT_EXCEEDED', message: gate.message };
    }
  });

  resourceServer.onAfterSettle(async (context) => {
    const fingerprint = fingerprintPayment(context.paymentPayload);
    if (context.result.success) await commitAgentSpend(fingerprint);
    else await releaseAgentSpend(fingerprint);
    const endpoint = await endpointFromTransport(context.transportContext);
    if (!endpoint) return;
    const transfer = decodeStellarTransfer(context.paymentPayload, network);
    await recordX402Event({
      endpointId: endpoint.id,
      type: 'settlement',
      status: context.result.success ? 'settled' : 'failed',
      requestFingerprint: fingerprint,
      transaction: context.result.transaction,
      payer: context.result.payer || transfer?.from,
      amount: usdcAmount(transfer?.amount, endpoint.price),
      errorCode: context.result.success ? undefined : classifyFacilitatorReason(context.result.errorReason, context.result.errorMessage) || undefined,
      errorMessage: context.result.errorMessage || context.result.errorReason,
      metadata: { ...metadata, phase: context.phase, facilitatorReason: context.result.errorReason || null },
    });
  });

  resourceServer.onSettleFailure(async (context) => {
    const fingerprint = fingerprintPayment(context.paymentPayload);
    await releaseAgentSpend(fingerprint);
    const endpoint = await endpointFromTransport(context.transportContext);
    if (!endpoint) return;
    const normalized = normalizeX402Error(context.error);
    await recordX402Event({
      endpointId: endpoint.id,
      type: 'settlement',
      status: 'failed',
      requestFingerprint: fingerprint,
      payer: extractPayer(context.paymentPayload) || undefined,
      amount: endpoint.price,
      errorCode: normalized.code,
      errorMessage: normalized.message,
      metadata: { ...metadata, phase: context.phase },
    });
  });

  const route = `GET ${RESOURCE_PREFIX[network]}/*`;
  const label = networkLabel(network);
  const httpResourceServer = new x402HTTPResourceServer(resourceServer, {
    [route]: {
      accepts: {
        scheme: 'exact',
        network,
        price: async (context) => (await getActiveEndpointByPath(context.path)).price,
        payTo: async (context) => (await getActiveEndpointByPath(context.path)).payTo,
        maxTimeoutSeconds: 60,
      },
      serviceName: 'WebSoroban Pay',
      description: `A ${label} API protected by x402.`,
      mimeType: 'application/json',
      tags: ['stellar', 'x402', network === 'stellar:pubnet' ? 'mainnet' : 'testnet'],
      unpaidResponseBody: async (context) => {
        const endpoint = await getActiveEndpointByPath(context.path);
        return {
          contentType: 'application/json',
          body: {
            error: 'payment_required',
            message: `Pay ${endpoint.price.replace(/^\$/, '')} ${X402_ASSET} on ${label} to access ${endpoint.name}.`,
            endpoint: endpoint.name,
            price: endpoint.price,
            asset: endpoint.asset,
            network: endpointNetwork(endpoint),
          },
        };
      },
      settlementFailedResponseBody: async (context, result) => {
        const endpoint = await getActiveEndpointByPath(context.path);
        const code = classifyFacilitatorReason(result.errorReason, result.errorMessage);
        const info = explainX402Error(code);
        return {
          contentType: 'application/json',
          body: {
            error: code || 'payment_failed',
            message: result.errorMessage || info?.message || 'The payment could not be settled.',
            fix: info?.fix || null,
            endpoint: endpoint.name,
          },
        };
      },
    },
  }).onProtectedRequest(async (context) => {
    const endpoint = await getActiveEndpointByPath(context.path);
    await recordX402Event({
      endpointId: endpoint.id,
      type: 'request',
      status: context.paymentHeader ? 'payment_submitted' : 'payment_required',
      requestFingerprint: context.paymentHeader ? fingerprintPayment(context.paymentHeader) : undefined,
      amount: endpoint.price,
      metadata: { method: context.method, path: context.path, network },
    });
  });

  return paymentMiddlewareFromHTTPServer(
    httpResourceServer,
    { appName: 'WebSoroban Pay', testnet: network === 'stellar:testnet' },
    browserPaywall(network),
    true,
  );
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function browserPaywall(network: X402Network) {
  const mainnet = network === 'stellar:pubnet';
  const label = networkLabel(network).replace('Stellar ', '').toUpperCase();
  return {
    generateHtml(paymentRequired: any): string {
      const resourceUrl = String(paymentRequired?.resource?.url || '');
      const option = paymentRequired?.accepts?.[0] || {};
      const amount = escapeHtml(usdcAmount(option.amount, '—').replace(/^\$/, ''));
      const checkoutUrl = escapeHtml(`${FRONTEND_BASE}/pay/checkout?resource=${encodeURIComponent(resourceUrl)}`);
      const foot = mainnet ? 'Real USDC on Stellar Mainnet · network fee sponsored' : 'Testnet assets only · network fee sponsored';
      return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment required · WebSoroban Pay</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f9f8f3;color:#15141d;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background-image:linear-gradient(rgba(86,57,234,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(86,57,234,.045) 1px,transparent 1px);background-size:72px 72px}.card{width:min(92vw,520px);overflow:hidden;border:1px solid rgba(21,20,29,.16);border-radius:28px;background:#fff;box-shadow:0 24px 70px rgba(21,20,29,.12)}.top{display:flex;align-items:center;gap:14px;padding:22px 26px;border-bottom:1px solid rgba(21,20,29,.1)}.mark{display:grid;place-items:center;width:44px;height:44px;border-radius:15px;background:#5b35ed;color:#fff;font-weight:800}.eyebrow{margin:0;font:11px ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em;color:#6e6a78}.title{margin:4px 0 0;font-size:18px}.body{padding:30px 26px}.label{font:11px ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em;color:${mainnet ? '#a15c00' : '#6e6a78'}}.amount{margin:10px 0 0;font-size:48px;font-weight:700;letter-spacing:-.04em}.amount span{font-size:14px;font-weight:500;letter-spacing:0;color:#6e6a78}.note{margin:24px 0;padding:15px 16px;border-radius:16px;background:#f2f0fa;color:#565160;font-size:14px;line-height:1.5}.button{display:flex;align-items:center;justify-content:center;min-height:52px;border-radius:999px;background:#5b35ed;color:#fff;text-decoration:none;font-weight:650;transition:transform .15s ease,background .15s ease}.button:hover{background:#4e2bd8;transform:translateY(-1px)}.button:focus-visible{outline:3px solid rgba(91,53,237,.35);outline-offset:3px}.foot{margin:14px 0 0;text-align:center;font-size:12px;color:#77727f}</style></head>
<body><main class="card"><header class="top"><div class="mark">✦</div><div><p class="eyebrow">WEBSOROBAN PAY</p><h1 class="title">Payment required</h1></div></header><section class="body"><p class="label">STELLAR ${label} · EXACT</p><p class="amount">${amount} <span>USDC</span></p><div class="note">Connect a Stellar wallet to review and approve this single-use payment authorization. No WebSoroban account is required.</div><a class="button" href="${checkoutUrl}">Continue to checkout →</a><p class="foot">${foot}</p></section></main></body></html>`;
    },
  };
}

function getBearerToken(req: Request): string {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '').trim() || '';
}

function sendError(res: Response, status: number, code: string, message?: string) {
  const info = explainX402Error(code);
  return res.status(status).json({
    success: false,
    error: code,
    message: message || info?.message || code,
    cause: info?.cause,
    fix: info?.fix,
  });
}

async function authenticateEndpointKey(req: Request, res: Response, next: NextFunction) {
  try {
    const rawKey = getBearerToken(req);
    const endpoint = rawKey ? await getEndpointByApiKey(rawKey) : null;
    if (!endpoint || !endpoint.active) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_PAY_KEY',
        message: 'Use an active WebSoroban Pay endpoint key.',
      });
    }
    if (!facilitatorProxyLimiter.allow(endpoint.id)) return sendError(res, 429, 'RATE_LIMITED');
    (req as any).x402Endpoint = endpoint;
    next();
  } catch (error) {
    next(error);
  }
}

// Shared across API instances through Redis. The in-memory facilitatorProxyLimiter
// above still caps each instance if Redis is unavailable (this limiter fails open).
const proxyLimit = rateLimit({
  windowSec: 60,
  max: FACILITATOR_PROXY_LIMIT,
  prefix: 'x402-proxy',
  keyFor: (req) => (req as any).x402Endpoint?.id,
});
const trustlineLimit = rateLimit({ windowSec: 60, max: 30, prefix: 'x402-trustline', keyFor: (req) => req.ip });

router.get('/wallets', (_req, res) => {
  res.json({ success: true, wallets: AUTH_ENTRY_WALLETS });
});

router.get('/networks', (_req, res) => {
  res.json({ success: true, networks: networkSummary() });
});

// Public so the checkout can tell a payer to add a trustline before signing.
router.get('/trustline', trustlineLimit, asyncRoute(async (req: Request, res: Response) => {
  const network = parseX402Network(req.query.network);
  const address = String(req.query.address || '').trim();
  if (!network) return res.status(400).json({ success: false, error: 'Network must be stellar:testnet or stellar:pubnet.' });
  try {
    res.json({ success: true, trustline: await checkUsdcTrustline(address, network) });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || 'Enter a valid Stellar address.' });
  }
}));

router.get('/overview', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const endpoints = await prisma.x402Endpoint.findMany({
    where: { userId: req.user!.id },
    orderBy: { updatedAt: 'desc' },
  });
  const endpointIds = endpoints.map((endpoint) => endpoint.id);
  const scope = { endpointId: { in: endpointIds } };
  const [events, requestCount, settledCount, failedCount, revenue, reliability, webhooks, agentWallets] = await Promise.all([
    endpointIds.length
      ? prisma.x402Event.findMany({
          where: scope,
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { endpoint: { select: { name: true, slug: true, network: true } } },
        })
      : Promise.resolve([]),
    prisma.x402Event.count({ where: { ...scope, type: 'request' } }),
    prisma.x402Event.count({ where: { ...scope, type: 'settlement', status: 'settled' } }),
    prisma.x402Event.count({ where: { ...scope, type: 'settlement', status: 'failed' } }),
    settledRevenue(endpointIds),
    settlementMetrics(endpointIds),
    prisma.x402Webhook.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      include: { deliveries: { orderBy: { createdAt: 'desc' }, take: 1 } },
    }),
    prisma.x402AgentWallet.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' } }),
  ]);
  const networks = networkSummary();

  res.json({
    success: true,
    networks,
    facilitator: networks[0].facilitator,
    metrics: {
      endpoints: endpoints.length,
      requests: requestCount,
      settled: settledCount,
      failed: failedCount,
      revenueUsdc: revenue,
      settlement: reliability.windows,
    },
    failureReasons: reliability.failureReasons,
    endpoints: endpoints.map(serialize),
    events: events.map((event) => {
      const info = explainX402Error(event.errorCode);
      return {
        id: event.id,
        endpointId: event.endpointId,
        endpointName: event.endpoint.name,
        endpointSlug: event.endpoint.slug,
        network: endpointNetwork(event.endpoint),
        type: event.type,
        status: event.status,
        transaction: event.transaction,
        payer: event.payer,
        amount: event.amount,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        errorCause: info?.cause || null,
        errorFix: info?.fix || null,
        latencyMs: event.latencyMs,
        createdAt: event.createdAt.toISOString(),
      };
    }),
    wallets: AUTH_ENTRY_WALLETS,
    errors: X402_ERROR_CATALOG,
    webhooks: webhooks.map((hook) => {
      const last = hook.deliveries[0];
      return {
        id: hook.id,
        endpointId: hook.endpointId,
        url: hook.url,
        events: hook.events,
        secretPrefix: hook.secretPrefix,
        active: hook.active,
        createdAt: hook.createdAt.toISOString(),
        lastDelivery: last ? {
          id: last.id,
          eventType: last.eventType,
          status: last.status,
          attempts: last.attempts,
          lastStatusCode: last.lastStatusCode,
          lastError: last.lastError,
          createdAt: last.createdAt.toISOString(),
        } : null,
      };
    }),
    agentWallets: agentWallets.map((wallet) => ({
      id: wallet.id,
      endpointId: wallet.endpointId,
      name: wallet.name,
      publicKey: wallet.publicKey,
      spendLimitUsdc: wallet.spendLimitUsdc,
      spentUsdc: Date.now() - wallet.windowStartedAt.getTime() >= wallet.periodSeconds * 1000
        ? '0'
        : stroopsToUsdc(BigInt(wallet.spentStroops)),
      periodSeconds: wallet.periodSeconds,
      periodLedgers: wallet.periodLedgers,
      asset: wallet.asset,
      active: wallet.active,
      createdAt: wallet.createdAt.toISOString(),
    })),
  });
}));

// Team-only KR report: external adopters and time to first paid request.
router.get('/adoption', authenticate, requireAdmin, asyncRoute(async (_req: Request, res: Response) => {
  res.json({ success: true, ...(await adoptionReport()) });
}));

router.post('/endpoints', authenticate, async (req: Request, res: Response) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const slug = normalizeEndpointSlug(String(req.body?.slug || name));
    const price = normalizeUsdPrice(req.body?.price || '0.01');
    const payTo = validatePayoutAddress(String(req.body?.payTo || ''));
    const projectId = req.body?.projectId ? String(req.body.projectId) : null;
    const message = String(req.body?.responseMessage || 'Paid access granted.').trim().slice(0, 280);
    const network = parseX402Network(req.body?.network);

    if (!network) {
      return res.status(400).json({ success: false, error: 'Network must be stellar:testnet or stellar:pubnet.' });
    }
    if (!isNetworkEnabled(network)) return sendError(res, 400, 'NETWORK_DISABLED');
    if (!name || name.length < 3) {
      return res.status(400).json({ success: false, error: 'Endpoint name must be at least 3 characters.' });
    }
    if (!slug || slug.length < 3) {
      return res.status(400).json({ success: false, error: 'Endpoint slug must be at least 3 characters.' });
    }
    if (projectId) {
      const project = await prisma.project.findFirst({ where: { id: projectId, userId: req.user!.id } });
      if (!project) return res.status(404).json({ success: false, error: 'Project was not found.' });
    }

    // Settlement to an account without a USDC trustline always fails, so catch it here.
    const trustline = await checkUsdcTrustline(payTo, network);
    if (!trustline.ready && trustline.status !== 'unknown') {
      return res.status(400).json({
        success: false,
        error: 'PAYOUT_NOT_READY',
        message: `Payout address: ${trustline.message}`,
        fix: trustline.fix,
        trustline,
      });
    }

    const key = createEndpointApiKey(network);
    const endpoint = await prisma.x402Endpoint.create({
      data: {
        userId: req.user!.id,
        projectId,
        name,
        slug,
        price,
        network,
        payTo,
        responseBody: { message },
        apiKeyHash: key.hash,
        apiKeyPrefix: key.prefix,
      },
    });

    return res.status(201).json({
      success: true,
      endpoint: serialize(endpoint),
      apiKey: key.raw,
      trustline,
      warning: trustline.status === 'unknown'
        ? 'Copy this endpoint key now. WebSoroban stores only its hash. The payout trustline could not be confirmed; check it before going live.'
        : 'Copy this endpoint key now. WebSoroban stores only its hash.',
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'That endpoint slug is already in use.' });
    }
    return res.status(400).json({ success: false, error: error?.message || 'Could not create the endpoint.' });
  }
});

router.patch('/endpoints/:id', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const endpoint = await prisma.x402Endpoint.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!endpoint) return res.status(404).json({ success: false, error: 'Endpoint was not found.' });
  if (typeof req.body?.active !== 'boolean') {
    return res.status(400).json({ success: false, error: 'The active field must be true or false.' });
  }
  const updated = await prisma.x402Endpoint.update({
    where: { id: endpoint.id },
    data: { active: req.body.active },
  });
  res.json({ success: true, endpoint: serialize(updated) });
}));

router.post('/endpoints/:id/rotate-key', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const endpoint = await prisma.x402Endpoint.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!endpoint) return res.status(404).json({ success: false, error: 'Endpoint was not found.' });
  const key = createEndpointApiKey(endpointNetwork(endpoint));
  const updated = await prisma.x402Endpoint.update({
    where: { id: endpoint.id },
    data: { apiKeyHash: key.hash, apiKeyPrefix: key.prefix },
  });
  res.json({
    success: true,
    endpoint: serialize(updated),
    apiKey: key.raw,
    warning: 'The previous key stopped working. Copy this replacement now.',
  });
}));

router.post('/webhooks', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const url = String(req.body?.url || '').trim();
  const events: string[] = Array.isArray(req.body?.events) ? Array.from(new Set(req.body.events.map(String))) : [];
  const endpointId = req.body?.endpointId ? String(req.body.endpointId) : null;
  if (!isWebhookUrl(url)) {
    return res.status(400).json({
      success: false,
      error: 'Webhook URL must be public https (http://localhost is allowed outside production).',
    });
  }
  if (!events.length || events.some((event) => !WEBHOOK_EVENTS.includes(event as typeof WEBHOOK_EVENTS[number]))) {
    return res.status(400).json({ success: false, error: `Events must be one or more of: ${WEBHOOK_EVENTS.join(', ')}.` });
  }
  if (endpointId) {
    const endpoint = await prisma.x402Endpoint.findFirst({ where: { id: endpointId, userId: req.user!.id } });
    if (!endpoint) return res.status(404).json({ success: false, error: 'Endpoint was not found.' });
  }
  const secret = createWebhookSecret();
  const webhook = await prisma.x402Webhook.create({
    data: {
      userId: req.user!.id,
      endpointId,
      url,
      events,
      secretEncrypted: encrypt(secret.raw),
      secretPrefix: secret.prefix,
    },
  });
  res.status(201).json({
    success: true,
    secret: secret.raw,
    warning: 'Copy this signing secret now. WebSoroban stores only an encrypted copy.',
    webhook: {
      id: webhook.id,
      endpointId: webhook.endpointId,
      url: webhook.url,
      events: webhook.events,
      secretPrefix: webhook.secretPrefix,
      active: webhook.active,
      createdAt: webhook.createdAt.toISOString(),
      lastDelivery: null,
    },
  });
}));

router.patch('/webhooks/:id', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const webhook = await prisma.x402Webhook.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!webhook) return res.status(404).json({ success: false, error: 'Webhook was not found.' });
  if (typeof req.body?.active !== 'boolean') {
    return res.status(400).json({ success: false, error: 'The active field must be true or false.' });
  }
  const updated = await prisma.x402Webhook.update({ where: { id: webhook.id }, data: { active: req.body.active } });
  res.json({ success: true, webhook: { id: updated.id, active: updated.active } });
}));

router.post('/webhooks/:id/test', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const webhook = await prisma.x402Webhook.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!webhook) return res.status(404).json({ success: false, error: 'Webhook was not found.' });
  if (!webhook.active) return res.status(409).json({ success: false, error: 'Resume the webhook before sending a test delivery.' });
  const delivery = await queueTestDelivery(webhook.id);
  res.json({
    success: true,
    delivery: delivery && {
      id: delivery.id,
      status: delivery.status,
      attempts: delivery.attempts,
      lastStatusCode: delivery.lastStatusCode,
      lastError: delivery.lastError,
    },
  });
}));

router.get('/webhooks/:id/deliveries', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const webhook = await prisma.x402Webhook.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!webhook) return res.status(404).json({ success: false, error: 'Webhook was not found.' });
  const deliveries = await prisma.x402WebhookDelivery.findMany({
    where: { webhookId: webhook.id },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
  res.json({
    success: true,
    deliveries: deliveries.map((delivery) => ({
      id: delivery.id,
      eventType: delivery.eventType,
      status: delivery.status,
      attempts: delivery.attempts,
      lastStatusCode: delivery.lastStatusCode,
      lastError: delivery.lastError,
      nextAttemptAt: delivery.nextAttemptAt?.toISOString() || null,
      deliveredAt: delivery.deliveredAt?.toISOString() || null,
      createdAt: delivery.createdAt.toISOString(),
    })),
  });
}));

router.delete('/webhooks/:id', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const webhook = await prisma.x402Webhook.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!webhook) return res.status(404).json({ success: false, error: 'Webhook was not found.' });
  await prisma.x402Webhook.delete({ where: { id: webhook.id } });
  res.json({ success: true });
}));

router.post('/agent-wallets', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const publicKey = String(req.body?.publicKey || '').trim();
  const spendLimitUsdc = String(req.body?.spendLimit || '').trim().replace(/^\$/, '');
  const endpointId = req.body?.endpointId ? String(req.body.endpointId) : null;
  if (name.length < 2) return res.status(400).json({ success: false, error: 'Agent wallet name must be at least 2 characters.' });
  if (!StrKey.isValidEd25519PublicKey(publicKey) && !StrKey.isValidContract(publicKey)) {
    return res.status(400).json({ success: false, error: 'Enter the agent signer as a Stellar G-address or C-address.' });
  }
  let limitStroops: bigint;
  try {
    limitStroops = usdcToStroops(spendLimitUsdc);
  } catch (error: any) {
    return res.status(400).json({ success: false, error: error.message });
  }
  if (endpointId) {
    const endpoint = await prisma.x402Endpoint.findFirst({ where: { id: endpointId, userId: req.user!.id } });
    if (!endpoint) return res.status(404).json({ success: false, error: 'Endpoint was not found.' });
  }
  const wallet = await prisma.x402AgentWallet.create({
    data: {
      userId: req.user!.id,
      endpointId,
      name,
      publicKey,
      spendLimitUsdc,
      limitStroops: limitStroops.toString(),
      periodLedgers: DAY_LEDGERS,
    },
  });
  res.status(201).json({
    success: true,
    wallet: {
      id: wallet.id,
      name: wallet.name,
      publicKey: wallet.publicKey,
      spendLimitUsdc: wallet.spendLimitUsdc,
      periodLedgers: wallet.periodLedgers,
      enforcement: 'settle-proxy',
      policy: {
        standard: 'openzeppelin-stellar-spending-limit',
        spendingLimitStroops: wallet.limitStroops,
        periodLedgers: wallet.periodLedgers,
      },
    },
  });
}));

router.patch('/agent-wallets/:id', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const wallet = await prisma.x402AgentWallet.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!wallet) return res.status(404).json({ success: false, error: 'Agent wallet was not found.' });
  if (typeof req.body?.active !== 'boolean') {
    return res.status(400).json({ success: false, error: 'The active field must be true or false.' });
  }
  const updated = await prisma.x402AgentWallet.update({ where: { id: wallet.id }, data: { active: req.body.active } });
  res.json({ success: true, wallet: { id: updated.id, active: updated.active } });
}));

/**
 * Check that a verify/settle body pays this endpoint, in USDC, on its network.
 * The managed facilitator sponsors fees, so a leaked key must not be usable
 * to settle arbitrary transfers.
 */
function validateProxyPayment(endpoint: X402Endpoint, body: any): { code: string; message: string } | null {
  const network = endpointNetwork(endpoint);
  const requirements = body?.paymentRequirements;
  if (!requirements || typeof requirements !== 'object') {
    return { code: 'FACILITATOR_REJECTED', message: 'The request is missing paymentRequirements.' };
  }
  if (requirements.network !== network || (body?.paymentPayload?.accepted?.network && body.paymentPayload.accepted.network !== network)) {
    return { code: 'NETWORK_MISMATCH', message: `This endpoint key settles on ${networkLabel(network)} only.` };
  }
  if (requirements.payTo !== endpoint.payTo) {
    return { code: 'FACILITATOR_REJECTED', message: 'paymentRequirements.payTo must match the payout address registered for this endpoint.' };
  }
  if (requirements.asset !== USDC_CONTRACT[network]) {
    return { code: 'FACILITATOR_REJECTED', message: 'Only USDC payments can be settled through WebSoroban Pay.' };
  }
  const transfer = decodeStellarTransfer(body, network);
  if (transfer && (transfer.to !== endpoint.payTo || transfer.asset !== USDC_CONTRACT[network])) {
    return { code: 'FACILITATOR_REJECTED', message: 'The signed transfer does not pay this endpoint in USDC.' };
  }
  return null;
}

// Managed facilitator proxy for the SDK. Developer keys never reach the facilitator.
router.all('/facilitator/:operation', authenticateEndpointKey, proxyLimit, async (req: Request, res: Response) => {
  const operation = String(req.params.operation || '').toLowerCase();
  if (!['verify', 'settle', 'supported'].includes(operation)) {
    return res.status(404).json({ success: false, error: 'Unsupported facilitator operation.' });
  }

  const endpoint: X402Endpoint = (req as any).x402Endpoint;
  const network = endpointNetwork(endpoint);
  const config = facilitatorFor(network);
  if (!config) return sendError(res, 503, 'NETWORK_DISABLED');

  const startedAt = Date.now();
  const transfer = operation === 'supported' ? null : decodeStellarTransfer(req.body, network);
  const amount = usdcAmount(transfer?.amount ?? req.body?.paymentRequirements?.amount, endpoint.price);
  const fingerprint = fingerprintPayment(req.body?.paymentPayload ?? req.body ?? {});
  const metadata = { source: 'managed_proxy', facilitator: config.label, network };
  let reserved = false;

  try {
    if (operation !== 'supported') {
      const problem = validateProxyPayment(endpoint, req.body);
      if (problem) {
        await recordX402Event({
          endpointId: endpoint.id,
          type: operation === 'verify' ? 'verification' : 'settlement',
          status: 'failed',
          requestFingerprint: fingerprint,
          payer: transfer?.from,
          amount,
          errorCode: problem.code,
          errorMessage: problem.message,
          metadata,
        });
        return sendError(res, 400, problem.code, problem.message);
      }
    }

    if (operation === 'settle') {
      const gate = await reserveAgentSpend({
        userId: endpoint.userId,
        endpointId: endpoint.id,
        payer: transfer?.from || extractPayer(req.body),
        price: amount,
        fingerprint,
      });
      if (!gate.allowed) return sendError(res, 402, 'SPEND_LIMIT_EXCEEDED', gate.message);
      reserved = Boolean(gate.walletId);
    }

    const upstream = await fetch(`${config.url}/${operation}`, {
      method: operation === 'supported' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...facilitatorHeaders(config) },
      body: operation === 'supported' ? undefined : JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await upstream.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text || 'Invalid facilitator response.' }; }

    if (operation !== 'supported') {
      const succeeded = upstream.ok && (operation === 'verify' ? body?.isValid === true : body?.success === true);
      if (operation === 'settle' && reserved) {
        if (succeeded) await commitAgentSpend(fingerprint);
        else await releaseAgentSpend(fingerprint);
      }
      const reason = body?.invalidReason || body?.errorReason;
      const reasonMessage = body?.invalidMessage || body?.errorMessage;
      await recordX402Event({
        endpointId: endpoint.id,
        type: operation === 'verify' ? 'verification' : 'settlement',
        status: succeeded ? (operation === 'verify' ? 'verified' : 'settled') : 'failed',
        requestFingerprint: fingerprint,
        transaction: body?.transaction,
        payer: body?.payer || transfer?.from,
        amount,
        errorCode: succeeded ? undefined : classifyFacilitatorReason(reason, reasonMessage) || `HTTP_${upstream.status}`,
        errorMessage: succeeded ? undefined : reasonMessage || reason || (upstream.ok ? undefined : `Facilitator returned HTTP ${upstream.status}.`),
        latencyMs: Date.now() - startedAt,
        metadata: { ...metadata, facilitatorReason: reason || null, httpStatus: upstream.status },
      });
    }

    res.status(upstream.status).type('application/json').send(JSON.stringify(body));
  } catch (error) {
    if (operation === 'settle' && reserved) await releaseAgentSpend(fingerprint);
    const normalized = normalizeX402Error(error);
    if (operation !== 'supported') {
      await recordX402Event({
        endpointId: endpoint.id,
        type: operation === 'verify' ? 'verification' : 'settlement',
        status: 'failed',
        requestFingerprint: fingerprint,
        payer: transfer?.from,
        amount,
        errorCode: normalized.code,
        errorMessage: normalized.message,
        latencyMs: Date.now() - startedAt,
        metadata,
      });
    }
    res.status(502).json({
      success: false,
      error: normalized.code,
      message: normalized.message,
      cause: normalized.cause,
      fix: normalized.fix,
    });
  }
});

// Resolve missing, paused, or wrong-network slugs before x402 builds payment requirements.
for (const network of ['stellar:testnet', 'stellar:pubnet'] as X402Network[]) {
  router.use(`${RESOURCE_PREFIX[network]}/:slug`, asyncRoute(async (req: Request, res: Response, next: NextFunction) => {
    const endpoint = await prisma.x402Endpoint.findUnique({ where: { slug: String(req.params.slug) } });
    if (!endpoint) return res.status(404).json({ success: false, error: 'Paid endpoint was not found.' });
    if (endpointNetwork(endpoint) !== network) {
      return res.status(404).json({ success: false, error: 'NETWORK_MISMATCH', message: `This endpoint lives at ${resourceUrlFor(endpoint)}.` });
    }
    if (!isNetworkEnabled(network)) return sendError(res, 503, 'NETWORK_DISABLED');
    if (!endpoint.active) return res.status(410).json({ success: false, error: 'This paid endpoint is paused.' });
    next();
  }));
}

for (const network of enabledNetworks()) router.use(buildNetworkMiddleware(network));

const serveResource = asyncRoute(async (req: Request, res: Response) => {
  const endpoint = await prisma.x402Endpoint.findUnique({ where: { slug: String(req.params.slug) } });
  if (!endpoint) return res.status(404).json({ success: false, error: 'Paid endpoint was not found.' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    success: true,
    endpoint: endpoint.name,
    ...(endpoint.responseBody as Record<string, unknown>),
    settlement: { network: endpointNetwork(endpoint), asset: endpoint.asset },
  });
});

router.get(`${RESOURCE_PREFIX['stellar:testnet']}/:slug`, serveResource);
router.get(`${RESOURCE_PREFIX['stellar:pubnet']}/:slug`, serveResource);

export default router;
