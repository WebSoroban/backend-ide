import { MuxedAccount, StrKey } from '@stellar/stellar-sdk'
import { networkConfig, USDC_ISSUERS, type X402Network } from './x402Network'

/**
 * USDC readiness for an x402 payer or payout account.
 *
 * - `ready`              account exists and holds an authorized USDC trustline
 * - `missing_account`    the account is not funded on this network
 * - `missing_trustline`  the account exists but cannot hold USDC yet
 * - `not_authorized`     the issuer has not authorized (or has frozen) the trustline
 * - `not_applicable`     a contract (C…) address; SAC balances need no trustline
 * - `unknown`            Horizon could not be reached; callers decide whether to block
 */
export type TrustlineStatus =
  | 'ready'
  | 'missing_account'
  | 'missing_trustline'
  | 'not_authorized'
  | 'not_applicable'
  | 'unknown'

export interface TrustlineReport {
  address: string
  network: X402Network
  status: TrustlineStatus
  ready: boolean
  balance: string | null
  message: string
  fix: string | null
}

type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<any>
}>

const HORIZON_TIMEOUT_MS = 5_000

/** Resolve the classic account that holds trustlines for an address, or null for contracts. */
export function trustlineAccount(address: string): string | null {
  if (StrKey.isValidEd25519PublicKey(address)) return address
  if (StrKey.isValidMed25519PublicKey(address)) return MuxedAccount.fromAddress(address, '0').baseAccount().accountId()
  return null
}

export function evaluateBalances(
  address: string,
  network: X402Network,
  balances: Array<Record<string, any>>,
): TrustlineReport {
  const issuer = USDC_ISSUERS[network]
  const line = balances.find((balance) => balance.asset_code === 'USDC' && balance.asset_issuer === issuer)
  if (!line) {
    return report(address, network, 'missing_trustline', null)
  }
  if (line.is_authorized === false) {
    return report(address, network, 'not_authorized', String(line.balance))
  }
  return report(address, network, 'ready', String(line.balance))
}

function report(address: string, network: X402Network, status: TrustlineStatus, balance: string | null): TrustlineReport {
  const testnet = network === 'stellar:testnet'
  const copy: Record<TrustlineStatus, { message: string; fix: string | null }> = {
    ready: { message: 'The account can send and receive USDC.', fix: null },
    missing_account: {
      message: 'This account does not exist on the network yet.',
      fix: testnet
        ? 'Fund it with Friendbot (https://friendbot.stellar.org), then add a USDC trustline.'
        : 'Send at least 1.5 XLM to activate the account, then add a USDC trustline.',
    },
    missing_trustline: {
      message: 'This account has no USDC trustline, so it cannot hold USDC.',
      fix: `Add a trustline to USDC issued by ${USDC_ISSUERS[network]} from your wallet's asset list.`,
    },
    not_authorized: {
      message: 'The USDC issuer has not authorized this trustline.',
      fix: 'Contact the issuer or use a different account. Payments to or from this account will fail.',
    },
    not_applicable: { message: 'Contract accounts hold USDC through the asset contract and need no trustline.', fix: null },
    unknown: {
      message: 'Horizon could not confirm the USDC trustline right now.',
      fix: 'Retry in a moment. Payments may still succeed if the trustline exists.',
    },
  }
  return {
    address,
    network,
    status,
    ready: status === 'ready' || status === 'not_applicable',
    balance,
    ...copy[status],
  }
}

export async function checkUsdcTrustline(
  address: string,
  network: X402Network,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<TrustlineReport> {
  const account = trustlineAccount(address)
  if (!account) {
    if (StrKey.isValidContract(address)) return report(address, network, 'not_applicable', null)
    throw new Error('Enter a valid Stellar G-, M-, or C-address.')
  }
  const horizon = networkConfig(network).horizonUrl.replace(/\/$/, '')
  try {
    const response = await fetchImpl(`${horizon}/accounts/${account}`, {
      signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    })
    if (response.status === 404) return report(address, network, 'missing_account', null)
    if (!response.ok) return report(address, network, 'unknown', null)
    const body = await response.json()
    return evaluateBalances(address, network, Array.isArray(body?.balances) ? body.balances : [])
  } catch {
    return report(address, network, 'unknown', null)
  }
}
