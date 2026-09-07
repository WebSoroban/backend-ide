import express, { type NextFunction, type Request, type Response } from 'express';
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from '@x402/express';
import prisma from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import {
  X402_ASSET,
  X402_NETWORK,
  createEndpointApiKey,
  facilitatorApiKey,
  facilitatorLabel,
  facilitatorUrl,
  fingerprintPayment,
  getActiveEndpointByPath,
  getEndpointByApiKey,
  normalizeEndpointSlug,
  normalizeUsdPrice,
  normalizeX402Error,
  recordX402Event,
  serializeEndpoint,
  validatePayoutAddress,
} from '../services/x402PayService';

const router = express.Router();
const PUBLIC_API_BASE = (process.env.PUBLIC_API_URL || 'http://localhost:3001/api').replace(/\/$/, '');
const FRONTEND_BASE = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

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

function facilitatorHeaders(): Record<string, string> {
  return facilitatorApiKey ? { Authorization: `Bearer ${facilitatorApiKey}` } : {};
}

const upstreamFacilitator = new HTTPFacilitatorClient({
  url: facilitatorUrl,
  createAuthHeaders: async () => {
    const headers = facilitatorHeaders();
    return { verify: headers, settle: headers, supported: headers };
  },
});

const resourceServer = new x402ResourceServer(upstreamFacilitator)
  .register(X402_NETWORK, new ExactStellarScheme());

async function endpointFromTransport(transportContext: unknown) {
  const path = (transportContext as any)?.request?.path;
  return typeof path === 'string' ? getActiveEndpointByPath(path) : null;
}

resourceServer.onAfterVerify(async (context) => {
  const endpoint = await endpointFromTransport(context.transportContext);
  if (!endpoint) return;
  await recordX402Event({
    endpointId: endpoint.id,
    type: 'verification',
    status: context.result.isValid ? 'verified' : 'failed',
    requestFingerprint: fingerprintPayment(context.paymentPayload),
    payer: context.result.payer,
    amount: endpoint.price,
    errorCode: context.result.invalidReason,
    errorMessage: context.result.invalidMessage,
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
    amount: endpoint.price,
    errorCode: normalized.code,
    errorMessage: normalized.message,
  });
});

resourceServer.onAfterSettle(async (context) => {
  const endpoint = await endpointFromTransport(context.transportContext);
  if (!endpoint) return;
  await recordX402Event({
    endpointId: endpoint.id,
    type: 'settlement',
    status: context.result.success ? 'settled' : 'failed',
    requestFingerprint: fingerprintPayment(context.paymentPayload),
    transaction: context.result.transaction,
    payer: context.result.payer,
    amount: endpoint.price,
    errorCode: context.result.errorReason,
    errorMessage: context.result.errorMessage,
    metadata: { phase: context.phase, network: context.result.network },
  });
});

resourceServer.onSettleFailure(async (context) => {
  const endpoint = await endpointFromTransport(context.transportContext);
  if (!endpoint) return;
  const normalized = normalizeX402Error(context.error);
  await recordX402Event({
    endpointId: endpoint.id,
    type: 'settlement',
    status: 'failed',
    requestFingerprint: fingerprintPayment(context.paymentPayload),
    amount: endpoint.price,
    errorCode: normalized.code,
    errorMessage: normalized.message,
    metadata: { phase: context.phase },
  });
});

const httpResourceServer = new x402HTTPResourceServer(resourceServer, {
  'GET /resource/*': {
    accepts: {
      scheme: 'exact',
      network: X402_NETWORK,
      price: async (context) => (await getActiveEndpointByPath(context.path)).price,
      payTo: async (context) => (await getActiveEndpointByPath(context.path)).payTo,
      maxTimeoutSeconds: 60,
    },
    serviceName: 'WebSoroban Pay',
    description: 'A Stellar testnet API protected by x402.',
    mimeType: 'application/json',
    tags: ['stellar', 'x402', 'testnet'],
    unpaidResponseBody: async (context) => {
      const endpoint = await getActiveEndpointByPath(context.path);
      return {
        contentType: 'application/json',
        body: {
          error: 'payment_required',
          message: `Pay ${endpoint.price} ${X402_ASSET} on Stellar testnet to access ${endpoint.name}.`,
          endpoint: endpoint.name,
          price: endpoint.price,
          asset: endpoint.asset,
          network: endpoint.network,
        },
      };
    },
    settlementFailedResponseBody: async (context, result) => {
      const endpoint = await getActiveEndpointByPath(context.path);
      return {
        contentType: 'application/json',
        body: {
          error: result.errorReason || 'payment_failed',
          message: result.errorMessage || 'The payment could not be settled. Retry with a supported Stellar wallet.',
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
    metadata: { method: context.method, path: context.path },
  });
});

const browserPaywall = {
  generateHtml(paymentRequired: any): string {
    const resourceUrl = String(paymentRequired?.resource?.url || '');
    const option = paymentRequired?.accepts?.[0] || {};
    const amount = option.amount ? (Number(option.amount) / 10_000_000).toFixed(7).replace(/0+$/, '').replace(/\.$/, '') : '—';
    const checkoutUrl = `${FRONTEND_BASE}/pay/checkout?resource=${encodeURIComponent(resourceUrl)}`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pay with Freighter · WebSoroban</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f9f8f3;color:#15141d;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background-image:linear-gradient(rgba(86,57,234,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(86,57,234,.045) 1px,transparent 1px);background-size:72px 72px}.card{width:min(92vw,520px);overflow:hidden;border:1px solid rgba(21,20,29,.16);border-radius:28px;background:#fff;box-shadow:0 24px 70px rgba(21,20,29,.12)}.top{display:flex;align-items:center;gap:14px;padding:22px 26px;border-bottom:1px solid rgba(21,20,29,.1)}.mark{display:grid;place-items:center;width:44px;height:44px;border-radius:15px;background:#5b35ed;color:#fff;font-weight:800}.eyebrow{margin:0;font:11px ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em;color:#6e6a78}.title{margin:4px 0 0;font-size:18px}.body{padding:30px 26px}.label{font:11px ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em;color:#6e6a78}.amount{margin:10px 0 0;font-size:48px;font-weight:700;letter-spacing:-.04em}.amount span{font-size:14px;font-weight:500;letter-spacing:0;color:#6e6a78}.note{margin:24px 0;padding:15px 16px;border-radius:16px;background:#f2f0fa;color:#565160;font-size:14px;line-height:1.5}.button{display:flex;align-items:center;justify-content:center;min-height:52px;border-radius:999px;background:#5b35ed;color:#fff;text-decoration:none;font-weight:650;transition:transform .15s ease,background .15s ease}.button:hover{background:#4e2bd8;transform:translateY(-1px)}.button:focus-visible{outline:3px solid rgba(91,53,237,.35);outline-offset:3px}.foot{margin:14px 0 0;text-align:center;font-size:12px;color:#77727f}</style></head>
<body><main class="card"><header class="top"><div class="mark">✦</div><div><p class="eyebrow">WEBSOROBAN PAY</p><h1 class="title">Payment required</h1></div></header><section class="body"><p class="label">STELLAR TESTNET · EXACT</p><p class="amount">${amount} <span>USDC</span></p><div class="note">Connect Freighter to review and approve this single-use payment authorization. No WebSoroban account is required.</div><a class="button" href="${checkoutUrl}">Continue with Freighter →</a><p class="foot">Testnet assets only · network fee sponsored</p></section></main></body></html>`;
  },
};

const resourcePaymentMiddleware = paymentMiddlewareFromHTTPServer(
  httpResourceServer,
  { appName: 'WebSoroban Pay', testnet: true },
  browserPaywall,
  true,
);

function getBearerToken(req: Request): string {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '').trim() || '';
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function enforceProxyRateLimit(key: string): boolean {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count += 1;
  return current.count <= 120;
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
    if (!enforceProxyRateLimit(endpoint.id)) {
      return res.status(429).json({
        success: false,
        error: 'RATE_LIMITED',
        message: 'This endpoint exceeded 120 facilitator calls per minute. Retry shortly.',
      });
    }
    (req as any).x402Endpoint = endpoint;
    next();
  } catch (error) {
    next(error);
  }
}

// Dashboard overview.
router.get('/overview', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const endpoints = await prisma.x402Endpoint.findMany({
    where: { userId: req.user!.id },
    orderBy: { updatedAt: 'desc' },
  });
  const endpointIds = endpoints.map((endpoint) => endpoint.id);
  const events = endpointIds.length
    ? await prisma.x402Event.findMany({
        where: { endpointId: { in: endpointIds } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { endpoint: { select: { name: true, slug: true } } },
      })
    : [];

  const requestCount = await prisma.x402Event.count({
    where: { endpointId: { in: endpointIds }, type: 'request' },
  });
  const settledEvents = await prisma.x402Event.findMany({
    where: { endpointId: { in: endpointIds }, status: 'settled' },
    select: { amount: true },
  });
  const failedCount = await prisma.x402Event.count({
    where: { endpointId: { in: endpointIds }, status: 'failed' },
  });
  const revenue = settledEvents.reduce((sum, event) => {
    const amount = Number(String(event.amount || '0').replace(/^\$/, ''));
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);

  res.json({
    success: true,
    mode: 'testnet',
    facilitator: { name: facilitatorLabel(), managed: Boolean(facilitatorApiKey) },
    metrics: {
      endpoints: endpoints.length,
      requests: requestCount,
      settled: settledEvents.length,
      failed: failedCount,
      revenueUsdc: revenue.toFixed(7).replace(/0+$/, '').replace(/\.$/, '') || '0',
    },
    endpoints: endpoints.map((endpoint) => serializeEndpoint(endpoint, PUBLIC_API_BASE)),
    events: events.map((event) => ({
      id: event.id,
      endpointId: event.endpointId,
      endpointName: event.endpoint.name,
      endpointSlug: event.endpoint.slug,
      type: event.type,
      status: event.status,
      transaction: event.transaction,
      payer: event.payer,
      amount: event.amount,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
      latencyMs: event.latencyMs,
      createdAt: event.createdAt.toISOString(),
    })),
  });
}));

router.post('/endpoints', authenticate, async (req: Request, res: Response) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const slug = normalizeEndpointSlug(String(req.body?.slug || name));
    const price = normalizeUsdPrice(req.body?.price || '0.01');
    const payTo = validatePayoutAddress(String(req.body?.payTo || ''));
    const projectId = req.body?.projectId ? String(req.body.projectId) : null;
    const message = String(req.body?.responseMessage || 'Paid access granted.').trim().slice(0, 280);

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

    const key = createEndpointApiKey();
    const endpoint = await prisma.x402Endpoint.create({
      data: {
        userId: req.user!.id,
        projectId,
        name,
        slug,
        price,
        payTo,
        responseBody: { message },
        apiKeyHash: key.hash,
        apiKeyPrefix: key.prefix,
      },
    });

    return res.status(201).json({
      success: true,
      endpoint: serializeEndpoint(endpoint, PUBLIC_API_BASE),
      apiKey: key.raw,
      warning: 'Copy this endpoint key now. WebSoroban stores only its hash.',
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
  res.json({ success: true, endpoint: serializeEndpoint(updated, PUBLIC_API_BASE) });
}));

router.post('/endpoints/:id/rotate-key', authenticate, asyncRoute(async (req: Request, res: Response) => {
  const endpoint = await prisma.x402Endpoint.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!endpoint) return res.status(404).json({ success: false, error: 'Endpoint was not found.' });
  const key = createEndpointApiKey();
  const updated = await prisma.x402Endpoint.update({
    where: { id: endpoint.id },
    data: { apiKeyHash: key.hash, apiKeyPrefix: key.prefix },
  });
  res.json({
    success: true,
    endpoint: serializeEndpoint(updated, PUBLIC_API_BASE),
    apiKey: key.raw,
    warning: 'The previous key stopped working. Copy this replacement now.',
  });
}));

// Managed facilitator proxy for the SDK. Developer keys never reach OpenZeppelin.
router.all('/facilitator/:operation', authenticateEndpointKey, async (req: Request, res: Response) => {
  const operation = String(req.params.operation || '').toLowerCase();
  if (!['verify', 'settle', 'supported'].includes(operation)) {
    return res.status(404).json({ success: false, error: 'Unsupported facilitator operation.' });
  }

  const endpoint = (req as any).x402Endpoint;
  const startedAt = Date.now();
  try {
    const upstream = await fetch(`${facilitatorUrl}/${operation}`, {
      method: req.method === 'GET' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...facilitatorHeaders() },
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await upstream.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text || 'Invalid facilitator response.' }; }

    if (operation !== 'supported') {
      const succeeded = operation === 'verify' ? body?.isValid === true : body?.success === true;
      await recordX402Event({
        endpointId: endpoint.id,
        type: operation === 'verify' ? 'verification' : 'settlement',
        status: succeeded ? (operation === 'verify' ? 'verified' : 'settled') : 'failed',
        requestFingerprint: fingerprintPayment(req.body || {}),
        transaction: body?.transaction,
        payer: body?.payer,
        amount: endpoint.price,
        errorCode: body?.invalidReason || body?.errorReason,
        errorMessage: body?.invalidMessage || body?.errorMessage,
        latencyMs: Date.now() - startedAt,
        metadata: { source: 'managed_proxy', facilitator: facilitatorLabel() },
      });
    }

    res.status(upstream.status).type('application/json').send(JSON.stringify(body));
  } catch (error) {
    const normalized = normalizeX402Error(error);
    await recordX402Event({
      endpointId: endpoint.id,
      type: operation,
      status: 'failed',
      amount: endpoint.price,
      errorCode: normalized.code,
      errorMessage: normalized.message,
      latencyMs: Date.now() - startedAt,
      metadata: { source: 'managed_proxy', facilitator: facilitatorLabel() },
    });
    res.status(502).json({ success: false, error: normalized.code, message: normalized.message });
  }
});

// Resolve missing/inactive slugs before x402 tries to build payment requirements.
router.use('/resource/:slug', asyncRoute(async (req: Request, res: Response, next: NextFunction) => {
  const endpoint = await prisma.x402Endpoint.findUnique({ where: { slug: String(req.params.slug) } });
  if (!endpoint) return res.status(404).json({ success: false, error: 'Paid endpoint was not found.' });
  if (!endpoint.active) return res.status(410).json({ success: false, error: 'This paid endpoint is paused.' });
  next();
}));

router.use(resourcePaymentMiddleware);

router.get('/resource/:slug', asyncRoute(async (req: Request, res: Response) => {
  const endpoint = await prisma.x402Endpoint.findUnique({ where: { slug: String(req.params.slug) } });
  if (!endpoint) return res.status(404).json({ success: false, error: 'Paid endpoint was not found.' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    success: true,
    endpoint: endpoint.name,
    ...(endpoint.responseBody as Record<string, unknown>),
    settlement: { network: endpoint.network, asset: endpoint.asset },
  });
}));

export default router;
