import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { isIP } from 'net'
import prisma from '../lib/prisma'
import { decrypt } from '../lib/crypto'

export const WEBHOOK_EVENTS = ['payment.settled', 'payment.failed', 'wallet.spend_limit_exceeded'] as const
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number]
export const WEBHOOK_TEST_EVENT = 'webhook.test'

/**
 * Delay before each retry. A delivery is attempted once immediately and then
 * once per entry here, so a receiver that stays down is tried six times over
 * roughly two and a half hours before the delivery is marked failed.
 */
export const RETRY_DELAYS_MS = [10_000, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]
/** A claimed delivery is invisible to other workers for this long. */
export const DELIVERY_LEASE_MS = 60_000
export const DELIVERY_TIMEOUT_MS = 5_000
export const SIGNATURE_TOLERANCE_SECONDS = 300
const SWEEP_INTERVAL_MS = 5_000
const SWEEP_BATCH = 25

export function createWebhookSecret() {
  const raw = `wsp_whsec_${randomBytes(24).toString('base64url')}`
  return { raw, prefix: `${raw.slice(0, 16)}…` }
}

export function signWebhook(secret: string, timestamp: number, body: string) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${signature}`
}

export function verifyWebhookSignature(secret: string, header: string, body: string, now = Date.now()) {
  const parts = Object.fromEntries(header.split(',').map((part) => {
    const index = part.indexOf('=')
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()]
  }))
  const timestamp = Number(parts.t)
  const provided = parts.v1 || ''
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false
  const expected = signWebhook(secret, timestamp, body).split('v1=')[1] || ''
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function webhookEventName(event: { status: string; type: string; errorCode?: string | null }): WebhookEventName | null {
  if (event.errorCode === 'SPEND_LIMIT_EXCEEDED') return 'wallet.spend_limit_exceeded'
  if (event.status === 'settled') return 'payment.settled'
  if (event.status === 'failed' && (event.type === 'verification' || event.type === 'settlement')) return 'payment.failed'
  return null
}

/** Next retry delay after `attempt` (1-based) failed, or null when retries are exhausted. */
export function nextRetryDelay(attempt: number): number | null {
  return RETRY_DELAYS_MS[attempt - 1] ?? null
}

function isPrivateIPv4(host: string) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function isPrivateIPv6(host: string) {
  const value = host.toLowerCase()
  if (value === '::1' || value === '::') return true
  if (value.startsWith('::ffff:')) return isPrivateIPv4(value.slice(7))
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(value)
}

/**
 * Webhook targets must be public HTTPS. Plain http is accepted only for
 * localhost outside production, so developers can test with a local receiver.
 * Literal private and link-local addresses are rejected to keep the dispatcher
 * from being pointed at internal services.
 */
export function isWebhookUrl(value: string, production = process.env.NODE_ENV === 'production') {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (local) return !production && (url.protocol === 'http:' || url.protocol === 'https:')
  if (url.protocol !== 'https:') return false
  if (host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false
  const ipVersion = isIP(host)
  if (ipVersion === 4 && isPrivateIPv4(host)) return false
  if (ipVersion === 6 && isPrivateIPv6(host)) return false
  return true
}

interface DispatchInput {
  id: string
  endpointId: string
  type: string
  status: string
  errorCode?: string | null
  transaction?: string | null
  payer?: string | null
  amount?: string | null
  errorMessage?: string | null
  createdAt?: Date
}

/** Persist one delivery per matching webhook, then try each once right away. */
export async function queuePaymentWebhooks(event: DispatchInput) {
  const name = webhookEventName(event)
  if (!name) return
  try {
    const endpoint = await prisma.x402Endpoint.findUnique({
      where: { id: event.endpointId },
      select: { id: true, userId: true, name: true, slug: true, network: true },
    })
    if (!endpoint) return
    const hooks = await prisma.x402Webhook.findMany({
      where: {
        userId: endpoint.userId,
        active: true,
        events: { has: name },
        OR: [{ endpointId: null }, { endpointId: endpoint.id }],
      },
      select: { id: true },
    })
    if (!hooks.length) return
    const payload = {
      id: event.id,
      type: name,
      createdAt: (event.createdAt || new Date()).toISOString(),
      data: {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        endpointSlug: endpoint.slug,
        network: endpoint.network,
        status: event.status,
        transaction: event.transaction || null,
        payer: event.payer || null,
        amount: event.amount || null,
        errorCode: event.errorCode || null,
        errorMessage: event.errorMessage || null,
      },
    }
    const now = new Date()
    const deliveries = await prisma.$transaction(hooks.map((hook) => prisma.x402WebhookDelivery.create({
      data: { webhookId: hook.id, eventType: name, payload, status: 'pending', nextAttemptAt: now },
      select: { id: true },
    })))
    for (const delivery of deliveries) void attemptDelivery(delivery.id).catch(logDispatchError)
  } catch (error) {
    console.error('[x402] Failed to queue webhook:', error)
  }
}

/** Queue a signed `webhook.test` delivery so developers can check their receiver. */
export async function queueTestDelivery(webhookId: string) {
  const delivery = await prisma.x402WebhookDelivery.create({
    data: {
      webhookId,
      eventType: WEBHOOK_TEST_EVENT,
      status: 'pending',
      nextAttemptAt: new Date(),
      payload: {
        id: `evt_test_${randomUUID()}`,
        type: WEBHOOK_TEST_EVENT,
        createdAt: new Date().toISOString(),
        data: { message: 'WebSoroban Pay test delivery. Verify the signature, then return HTTP 2xx.' },
      },
    },
  })
  await attemptDelivery(delivery.id)
  return prisma.x402WebhookDelivery.findUnique({ where: { id: delivery.id } })
}

/**
 * Atomically take a due delivery. Only one process wins the conditional
 * update, so the API and any other instance never double-send.
 */
async function claimDelivery(deliveryId: string, now: Date) {
  const claimed = await prisma.x402WebhookDelivery.updateMany({
    where: { id: deliveryId, status: 'pending', nextAttemptAt: { lte: now } },
    data: { nextAttemptAt: new Date(now.getTime() + DELIVERY_LEASE_MS) },
  })
  return claimed.count === 1
}

export async function attemptDelivery(deliveryId: string, fetchImpl: typeof fetch = fetch) {
  const now = new Date()
  if (!(await claimDelivery(deliveryId, now))) return
  const delivery = await prisma.x402WebhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  })
  if (!delivery) return
  if (!delivery.webhook.active) {
    await prisma.x402WebhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'cancelled', nextAttemptAt: null, lastError: 'Webhook is paused.' },
    })
    return
  }

  const attempt = delivery.attempts + 1
  let statusCode: number | null = null
  let errorMessage: string | null = null
  try {
    const secret = decrypt(delivery.webhook.secretEncrypted)
    const body = JSON.stringify(delivery.payload)
    const timestamp = Math.floor(Date.now() / 1000)
    const response = await fetchImpl(delivery.webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WebSoroban-Webhooks/1.0',
        'X-WebSoroban-Signature': signWebhook(secret, timestamp, body),
        'X-WebSoroban-Delivery': delivery.id,
        'X-WebSoroban-Event': delivery.eventType,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    })
    statusCode = response.status
    if (response.status >= 300 && response.status < 400) errorMessage = `Receiver redirected (HTTP ${response.status}); redirects are not followed.`
    else if (!response.ok) errorMessage = `Receiver responded HTTP ${response.status}.`
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Webhook delivery failed.'
  }

  const delivered = statusCode !== null && statusCode >= 200 && statusCode < 300
  const retryDelay = delivered ? null : nextRetryDelay(attempt)
  await prisma.x402WebhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts: attempt,
      status: delivered ? 'delivered' : retryDelay !== null ? 'pending' : 'failed',
      lastStatusCode: statusCode,
      lastError: delivered ? null : errorMessage,
      deliveredAt: delivered ? new Date() : null,
      nextAttemptAt: retryDelay !== null ? new Date(Date.now() + retryDelay) : null,
    },
  })
}

/** Attempt every pending delivery whose retry time has passed. */
export async function sweepDueDeliveries(limit = SWEEP_BATCH) {
  const due = await prisma.x402WebhookDelivery.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
    select: { id: true },
  })
  await Promise.all(due.map((delivery) => attemptDelivery(delivery.id).catch(logDispatchError)))
  return due.length
}

let sweepTimer: ReturnType<typeof setInterval> | null = null
let sweeping = false

/**
 * Durable retry loop. Pending deliveries live in Postgres, so a restart or a
 * second API instance picks up where the last one stopped.
 */
export function startWebhookDispatcher() {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    if (sweeping) return
    sweeping = true
    sweepDueDeliveries()
      .catch(logDispatchError)
      .finally(() => { sweeping = false })
  }, SWEEP_INTERVAL_MS)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
}

export function stopWebhookDispatcher() {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
}

function logDispatchError(error: unknown) {
  console.error('[x402] Webhook dispatch error:', error instanceof Error ? error.message : error)
}
