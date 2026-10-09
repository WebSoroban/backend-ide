import { getNetwork, type NetworkId } from '../lib/networks'

/**
 * x402 network registry. CAIP-2 ids (`stellar:testnet`, `stellar:pubnet`) are
 * what the x402 protocol carries; WebSoroban's NetworkId ('testnet' | 'mainnet')
 * is what the rest of the backend uses for RPC, Horizon, and explorer links.
 *
 * Mainnet is opt-in. It is enabled only when an operator configures both a
 * mainnet facilitator URL and its API key — there is deliberately no public
 * mainnet fallback, so real funds never route through an unmanaged service.
 */
export type X402Network = 'stellar:testnet' | 'stellar:pubnet'

export const X402_NETWORKS: X402Network[] = ['stellar:testnet', 'stellar:pubnet']

export const OPENZEPPELIN_TESTNET_FACILITATOR = 'https://channels.openzeppelin.com/x402/testnet'
export const PUBLIC_TESTNET_FACILITATOR = 'https://www.x402.org/facilitator'

/** Classic USDC issuers. The SAC contract for each is what x402 transfers. */
export const USDC_ISSUERS: Record<X402Network, string> = {
  'stellar:testnet': 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  'stellar:pubnet': 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
}

/** Endpoint key prefixes. The prefix states the network a key may settle on. */
export const API_KEY_PREFIX: Record<X402Network, string> = {
  'stellar:testnet': 'wsp_test_',
  'stellar:pubnet': 'wsp_live_',
}

export interface FacilitatorConfig {
  network: X402Network
  url: string
  apiKey: string
  label: string
  /** True when the operator supplied credentials (not a public fallback). */
  managed: boolean
}

function labelFor(url: string): string {
  if (url.includes('channels.openzeppelin.com')) return 'OpenZeppelin Channels'
  if (url.includes('x402.org')) return 'x402.org public testnet'
  return 'Custom x402 facilitator'
}

function env(name: string): string {
  return process.env[name]?.trim() || ''
}

function buildFacilitators(): Partial<Record<X402Network, FacilitatorConfig>> {
  const testnetKey = env('X402_FACILITATOR_API_KEY')
  const testnetUrl = env('X402_FACILITATOR_URL') ||
    (testnetKey ? OPENZEPPELIN_TESTNET_FACILITATOR : PUBLIC_TESTNET_FACILITATOR)
  const facilitators: Partial<Record<X402Network, FacilitatorConfig>> = {
    'stellar:testnet': {
      network: 'stellar:testnet',
      url: testnetUrl.replace(/\/$/, ''),
      apiKey: testnetKey,
      label: labelFor(testnetUrl),
      managed: Boolean(testnetKey),
    },
  }

  const mainnetUrl = env('X402_MAINNET_FACILITATOR_URL')
  const mainnetKey = env('X402_MAINNET_FACILITATOR_API_KEY')
  if (mainnetUrl && mainnetKey) {
    facilitators['stellar:pubnet'] = {
      network: 'stellar:pubnet',
      url: mainnetUrl.replace(/\/$/, ''),
      apiKey: mainnetKey,
      label: labelFor(mainnetUrl),
      managed: true,
    }
  } else if (mainnetUrl || mainnetKey) {
    console.warn('[x402] Mainnet is disabled: set both X402_MAINNET_FACILITATOR_URL and X402_MAINNET_FACILITATOR_API_KEY.')
  }
  return facilitators
}

const FACILITATORS = buildFacilitators()

export function isX402Network(value: unknown): value is X402Network {
  return value === 'stellar:testnet' || value === 'stellar:pubnet'
}

/** Accepts CAIP-2 ids and WebSoroban NetworkIds; anything else is rejected. */
export function parseX402Network(value: unknown): X402Network | null {
  if (value === undefined || value === null || value === '') return 'stellar:testnet'
  if (isX402Network(value)) return value
  if (value === 'testnet') return 'stellar:testnet'
  if (value === 'mainnet' || value === 'pubnet') return 'stellar:pubnet'
  return null
}

export function toNetworkId(network: X402Network): NetworkId {
  return network === 'stellar:pubnet' ? 'mainnet' : 'testnet'
}

export function networkConfig(network: X402Network) {
  return getNetwork(toNetworkId(network))
}

export function networkLabel(network: X402Network): string {
  return network === 'stellar:pubnet' ? 'Stellar Mainnet' : 'Stellar Testnet'
}

export function isNetworkEnabled(network: X402Network): boolean {
  return Boolean(FACILITATORS[network])
}

export function enabledNetworks(): X402Network[] {
  return X402_NETWORKS.filter(isNetworkEnabled)
}

export function facilitatorFor(network: X402Network): FacilitatorConfig | null {
  return FACILITATORS[network] || null
}

export function facilitatorHeaders(config: FacilitatorConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
}

/** Public summary for the studio. Never includes credentials. */
export function networkSummary() {
  return X402_NETWORKS.map((network) => {
    const facilitator = FACILITATORS[network]
    return {
      network,
      label: networkLabel(network),
      enabled: Boolean(facilitator),
      facilitator: facilitator ? { name: facilitator.label, managed: facilitator.managed } : null,
    }
  })
}

export function networkFromApiKey(rawKey: string): X402Network | null {
  for (const network of X402_NETWORKS) {
    if (rawKey.startsWith(API_KEY_PREFIX[network])) return network
  }
  return null
}
