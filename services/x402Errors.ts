export interface X402ErrorInfo {
  code: string
  message: string
  cause: string
  fix: string
}

export const X402_ERROR_CATALOG: X402ErrorInfo[] = [
  {
    code: 'FACILITATOR_TIMEOUT',
    message: 'The facilitator timed out. Retry the payment in a moment.',
    cause: 'Verify or settle did not return within 20 seconds.',
    fix: 'Retry once. If it keeps timing out, check Payment Studio for a facilitator outage before changing your route.',
  },
  {
    code: 'INSUFFICIENT_BALANCE_OR_ALLOWANCE',
    message: 'The payer does not have enough USDC balance or allowance.',
    cause: 'The testnet account cannot cover the exact USDC amount.',
    fix: 'Fund the payer with testnet USDC and confirm the trustline, then approve the payment again.',
  },
  {
    code: 'UNSUPPORTED_WALLET',
    message: 'This wallet cannot sign a Stellar authorization entry.',
    cause: 'Auth-entry signing is limited to Freighter (browser extension), Albedo, Hana, HOT, Klever, and OneKey.',
    fix: 'Switch to one of those wallets. Freighter Mobile cannot sign auth entries yet.',
  },
  {
    code: 'INVALID_SIGNATURE',
    message: 'The authorization signature does not match this payment.',
    cause: 'The wallet signed a different payload, account, or network.',
    fix: 'Reconnect the active testnet account and approve the exact authorization shown for this request.',
  },
  {
    code: 'STELLAR_NETWORK_ERROR',
    message: 'Stellar testnet could not confirm the payment. Retry shortly.',
    cause: 'The Soroban RPC or ledger was unavailable while the facilitator submitted the transfer.',
    fix: 'Wait a few seconds and retry. The activity feed records the failed attempt.',
  },
  {
    code: 'SPEND_LIMIT_EXCEEDED',
    message: 'This agent wallet has used its USDC spending limit for the current day.',
    cause: 'The payment would push the signer past the daily cap registered in Payment Studio.',
    fix: 'Raise the daily limit or wait for the window to reset. The facilitator is not called when the cap is exceeded.',
  },
  {
    code: 'RATE_LIMITED',
    message: 'This endpoint exceeded 120 facilitator calls per minute.',
    cause: 'The managed proxy rejected the call before it reached the facilitator.',
    fix: 'Slow the client and retry after the minute resets.',
  },
  {
    code: 'FACILITATOR_REJECTED',
    message: 'The facilitator rejected the payment.',
    cause: 'The upstream facilitator returned an error that does not match a known testnet failure.',
    fix: 'Read the activity row for the facilitator message, then retry with a supported testnet wallet.',
  },
]

const byCode = new Map(X402_ERROR_CATALOG.map((entry) => [entry.code, entry]))

export function explainX402Error(code: string | null | undefined): X402ErrorInfo | null {
  if (!code) return null
  return byCode.get(code) || {
    code,
    message: 'The payment could not be completed.',
    cause: 'Payment Studio stored a failure code that is not in the testnet catalog.',
    fix: 'Retry the payment. If it fails again, use the activity row and the Stellar receipt to see the underlying reason.',
  }
}

const RULES: Array<{ test: RegExp; code: string }> = [
  { test: /timeout|timed out|abort/i, code: 'FACILITATOR_TIMEOUT' },
  { test: /spend limit/i, code: 'SPEND_LIMIT_EXCEEDED' },
  { test: /insufficient|allowance|underfunded|balance/i, code: 'INSUFFICIENT_BALANCE_OR_ALLOWANCE' },
  { test: /invalid signature|signature mismatch|bad signature/i, code: 'INVALID_SIGNATURE' },
  { test: /unsupported wallet|freighter mobile|does not support auth/i, code: 'UNSUPPORTED_WALLET' },
  { test: /auth.?entr|signing|wallet/i, code: 'UNSUPPORTED_WALLET' },
  { test: /network|rpc|ledger/i, code: 'STELLAR_NETWORK_ERROR' },
]

export function normalizeX402Error(error: unknown): X402ErrorInfo {
  const raw = error instanceof Error ? error.message : String(error || 'Payment processing failed.')
  const match = RULES.find((rule) => rule.test.test(raw))
  const info = explainX402Error(match?.code || 'FACILITATOR_REJECTED')!
  if (!match) return { ...info, message: raw || info.message }
  return info
}
