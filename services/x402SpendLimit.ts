/** USDC on Stellar uses 7 decimal places, the same scale as stroops. */
export const USDC_STROOPS = 10_000_000n
/** Approximate Stellar ledgers in one day at a 5 second close time. */
export const DAY_LEDGERS = 17_280
export const DAY_MS = 86_400_000

export function usdcToStroops(value: string): bigint {
  const raw = value.trim().replace(/^\$/, '')
  if (!/^\d+(?:\.\d{1,7})?$/.test(raw)) {
    throw new Error('Enter a USDC amount with up to 7 decimal places.')
  }
  const [whole, fraction = ''] = raw.split('.')
  const padded = `${fraction}0000000`.slice(0, 7)
  const stroops = BigInt(whole) * USDC_STROOPS + BigInt(padded)
  if (stroops <= 0n) throw new Error('The spending limit must be greater than 0.')
  return stroops
}

export function stroopsToUsdc(value: bigint): string {
  const negative = value < 0n
  const absolute = negative ? -value : value
  const whole = absolute / USDC_STROOPS
  const fraction = (absolute % USDC_STROOPS).toString().padStart(7, '0').replace(/0+$/, '')
  const text = fraction ? `${whole}.${fraction}` : `${whole}`
  return negative ? `-${text}` : text
}

export interface SpendState {
  spentStroops: bigint
  limitStroops: bigint
  windowStartedAt: number
  periodMs: number
}

export interface SpendDecision {
  ok: boolean
  spentStroops: bigint
  windowStartedAt: number
}

/** Rolling-window check. A new window starts when the previous period has elapsed. */
export function applySpend(state: SpendState, amountStroops: bigint, now: number): SpendDecision {
  const expired = now - state.windowStartedAt >= state.periodMs
  const windowStartedAt = expired ? now : state.windowStartedAt
  const spent = expired ? 0n : state.spentStroops
  if (amountStroops <= 0n || spent + amountStroops > state.limitStroops) {
    return { ok: false, spentStroops: spent, windowStartedAt }
  }
  return { ok: true, spentStroops: spent + amountStroops, windowStartedAt }
}

/** Pull a Stellar G-address out of an x402 verify/settle body when the facilitator has not echoed payer yet. */
export function extractPayer(body: unknown): string | null {
  const record = body as Record<string, any> | null
  const candidates = [
    record?.payer,
    record?.paymentPayload?.payload?.authorization?.from,
    record?.paymentPayload?.payload?.payer,
    record?.paymentPayload?.from,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^G[A-Z2-7]{55}$/.test(candidate)) return candidate
  }
  return null
}
