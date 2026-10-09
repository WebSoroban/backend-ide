import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import prisma from '../lib/prisma'
import { decrypt, encrypt } from '../lib/crypto'

export const WEBHOOK_EVENTS = ['payment.settled', 'payment.failed', 'wallet.spend_limit_exceeded'] as const
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number]

const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000]
const timers = new Set<ReturnType<typeof setTimeout>>()

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
    return [part.slice(0, index), part.slice(index + 1)]
  }))
  const timestamp = Number(parts.t)
  const provided = parts.v1 || ''
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false
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

export function isWebhookUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

interface DispatchInput {
  endpointId: string
  type: string
  status: string
  errorCode?: string | null
  transaction?: string | null
  payer?: string | null
  amount?: string | null
  errorMessage?: string | null
}

export async function queuePaymentWebhooks(event: DispatchInput) {
  const name = webhookEventName(event)
  if (!name) return
  try {
    const endpoint = await prisma.x402Endpoint.findUnique({
      where: { id: event.endpointId },
      select: { id: true, userId: true, name: true, slug: true },
    })
    if (!endpoint) return
    const hooks = await prisma.x402Webhook.findMany({
      where: {
        userId: endpoint.userId,
        active: true,
        events: { has: name },
        OR: [{ endpointId: null }, { endpointId: endpoint.id }],
      },
    })
    await Promise.all(hooks.map(async (hook) => {
      const payload = {
        id: '',
        type: name,
        createdAt: new Date().toISOString(),
        data: {
          endpointId: endpoint.id,
          endpointName: endpoint.name,
          endpointSlug: endpoint.slug,
          status: event.status,
          transaction: event.transaction || null,
          payer: event.payer || null,
          amount: event.amount || null,
          errorCode: event.errorCode || null,
          errorMessage: event.errorMessage || null,
        },
      }
      const delivery = await prisma.x402WebhookDelivery.create({
        data: { webhookId: hook.id, eventType: name, payload, status: 'pending' },
      })
      payload.id = delivery.id
      await prisma.x402WebhookDelivery.update({ where: { id: delivery.id }, data: { payload } })
      void attemptDelivery(delivery.id)
    }))
  } catch (error) {
    console.error('[x402] Failed to queue webhook:', error)
  }
}

export async function attemptDelivery(deliveryId: string, fetchImpl: typeof fetch = fetch) {
  const delivery = await prisma.x402WebhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  })
  if (!delivery || !delivery.webhook.active || delivery.status === 'delivered') return
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
        'X-WebSoroban-Signature': signWebhook(secret, timestamp, body),
        'X-WebSoroban-Delivery': delivery.id,
        'X-WebSoroban-Event': delivery.eventType,
      },
      body,
      signal: AbortSignal.timeout(5_000),
    })
    statusCode = response.status
    if (!response.ok) errorMessage = `Receiver responded HTTP ${response.status}.`
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Webhook delivery failed.'
  }

  const delivered = statusCode !== null && statusCode >= 200 && statusCode < 300
  const retryDelay = RETRY_DELAYS_MS[attempt - 1]
  const retry = !delivered && retryDelay !== undefined && attempt < RETRY_DELAYS_MS.length
  await prisma.x402WebhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts: attempt,
      status: delivered ? 'delivered' : retry ? 'pending' : 'failed',
      lastStatusCode: statusCode,
      lastError: delivered ? null : errorMessage,
      nextAttemptAt: retry ? new Date(Date.now() + retryDelay) : null,
    },
  })
  if (retry) scheduleRetry(delivery.id, retryDelay)
}

function scheduleRetry(deliveryId: string, delayMs: number) {
  const timer = setTimeout(() => {
    timers.delete(timer)
    void attemptDelivery(deliveryId)
  }, delayMs)
  timers.add(timer)
  if (typeof timer.unref === 'function') timer.unref()
}
