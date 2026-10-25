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
    cause: 'The payer account cannot cover the exact USDC amount.',
    fix: 'Fund the payer with USDC and confirm its USDC trustline, then approve the payment again.',
  },
  {
    code: 'TRUSTLINE_MISSING',
    message: 'An account in this payment has no USDC trustline.',
    cause: 'The payer or payout account cannot hold USDC on this network.',
    fix: 'Add a USDC trustline to the account from its wallet, then retry.',
  },
  {
    code: 'UNSUPPORTED_WALLET',
    message: 'This wallet cannot sign a Stellar authorization entry.',
    cause: 'Auth-entry signing is limited to Freighter (browser extension), Hana, HOT, Klever, Albedo, and OneKey.',
    fix: 'Switch to one of those wallets. Freighter Mobile cannot sign auth entries yet.',
  },
  {
    code: 'INVALID_SIGNATURE',
    message: 'The authorization signature does not match this payment.',
    cause: 'The wallet signed a different payload, account, or network.',
    fix: 'Reconnect the active account on the endpoint network and approve the exact authorization shown for this request.',
  },
  {
    code: 'STELLAR_NETWORK_ERROR',
    message: 'Stellar could not confirm the payment. Retry shortly.',
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
    code: 'NETWORK_MISMATCH',
    message: 'The payment targets a different Stellar network than this endpoint.',
    cause: 'The client or endpoint key is configured for testnet while the route settles on mainnet, or the reverse.',
    fix: 'Use the endpoint key and wallet network that match the endpoint shown in Payment Studio.',
  },
  {
    code: 'NETWORK_DISABLED',
    message: 'Settlement on this network is not enabled for this WebSoroban deployment.',
    cause: 'No facilitator is configured for the endpoint network.',
    fix: 'Use a testnet endpoint, or ask the operator to configure the mainnet facilitator.',
  },
  {
    code: 'FEE_BELOW_MINIMUM',
    message: 'Network fees moved between signing and verification, so the facilitator asked for a new signature.',
    cause: 'The payment transaction was simulated with a resource fee that was below the facilitator\'s fresh estimate a few seconds later. Nothing was charged.',
    fix: 'Retry the payment. The hosted checkout and `pnpm pay` retry once automatically.',
  },
  {
    code: 'FACILITATOR_REJECTED',
    message: 'The facilitator rejected the payment.',
    cause: 'The upstream facilitator returned an error that does not match a known failure.',
    fix: 'Read the activity row for the facilitator message, then retry with a supported wallet.',
  },
]

/** Failures caused by the client or by policy. They never reached the facilitator. */
export const NON_FACILITATOR_ERRORS = new Set(['SPEND_LIMIT_EXCEEDED', 'RATE_LIMITED', 'NETWORK_MISMATCH', 'NETWORK_DISABLED'])

const byCode = new Map(X402_ERROR_CATALOG.map((entry) => [entry.code, entry]))

export function explainX402Error(code: string | null | undefined): X402ErrorInfo | null {
  if (!code) return null
  return byCode.get(code) || {
    code,
    message: 'The payment could not be completed.',
    cause: 'Payment Studio stored a failure code that is not in the catalog.',
    fix: 'Retry the payment. If it fails again, use the activity row and the Stellar receipt to see the underlying reason.',
  }
}

// Facilitators report snake_case reasons (`network_mismatch`) while thrown
// errors use prose, so word gaps match either a space or an underscore.
const RULES: Array<{ test: RegExp; code: string }> = [
  { test: /timeout|timed[ _]out|abort/i, code: 'FACILITATOR_TIMEOUT' },
  { test: /fee[ _]below[ _]minimum/i, code: 'FEE_BELOW_MINIMUM' },
  { test: /spend[ _]limit/i, code: 'SPEND_LIMIT_EXCEEDED' },
  { test: /trustline|trust[ _]line|no[ _]trust/i, code: 'TRUSTLINE_MISSING' },
  { test: /insufficient|allowance|underfunded|balance/i, code: 'INSUFFICIENT_BALANCE_OR_ALLOWANCE' },
  { test: /invalid[ _]signature|signature[ _]mismatch|bad[ _]signature|signature doesn't match|missing[ _]payer[ _]signature/i, code: 'INVALID_SIGNATURE' },
  { test: /network[ _]mismatch|wrong[ _]network|invalid[ _]network|passphrase/i, code: 'NETWORK_MISMATCH' },
  { test: /unsupported[ _]wallet|freighter mobile|does not support auth/i, code: 'UNSUPPORTED_WALLET' },
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

/**
 * Facilitators return machine reasons such as `invalid_exact_stellar_payload_*`
 * or `insufficient_funds`. Map them onto the catalog so the dashboard shows a
 * readable reason; unknown reasons keep their raw code.
 */
export function classifyFacilitatorReason(reason: string | null | undefined, message?: string | null): string | null {
  if (!reason && !message) return null
  const text = `${reason || ''} ${message || ''}`
  const match = RULES.find((rule) => rule.test.test(text))
  if (match) return match.code
  return reason || 'FACILITATOR_REJECTED'
}
