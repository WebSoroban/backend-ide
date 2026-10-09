export interface AuthEntryWallet {
  id: string
  name: string
  platform: string
  /** The wallet can sign Soroban authorization entries (SEP-43 signAuthEntry). */
  authEntry: boolean
  /** WebSoroban's hosted checkout can drive this wallet directly. */
  checkout: boolean
  guidance: string
}

/**
 * Wallets that can sign Soroban authorization entries for x402 on Stellar.
 *
 * `checkout` reflects what the hosted checkout drives through Stellar Wallets
 * Kit 1.9: its Albedo module rejects signAuthEntry, and OneKey has no module,
 * so those two sign from the developer's own client instead.
 */
export const AUTH_ENTRY_WALLETS: AuthEntryWallet[] = [
  {
    id: 'freighter',
    name: 'Freighter',
    platform: 'Browser extension',
    authEntry: true,
    checkout: true,
    guidance: 'Supported in the hosted checkout. Match the extension network to the endpoint before approving.',
  },
  {
    id: 'hana',
    name: 'Hana',
    platform: 'Browser extension',
    authEntry: true,
    checkout: true,
    guidance: 'Supported in the hosted checkout.',
  },
  {
    id: 'hot-wallet',
    name: 'HOT',
    platform: 'Browser extension',
    authEntry: true,
    checkout: true,
    guidance: 'Supported in the hosted checkout.',
  },
  {
    id: 'klever',
    name: 'Klever',
    platform: 'Browser extension',
    authEntry: true,
    checkout: true,
    guidance: 'Supported in the hosted checkout.',
  },
  {
    id: 'albedo',
    name: 'Albedo',
    platform: 'Web',
    authEntry: true,
    checkout: false,
    guidance: 'Signs auth entries from your own x402 client. The hosted checkout cannot drive it yet.',
  },
  {
    id: 'onekey',
    name: 'OneKey',
    platform: 'Browser extension',
    authEntry: true,
    checkout: false,
    guidance: 'Signs auth entries from your own x402 client. The hosted checkout cannot drive it yet.',
  },
  {
    id: 'freighter-mobile',
    name: 'Freighter Mobile',
    platform: 'iOS and Android',
    authEntry: false,
    checkout: false,
    guidance: 'Not supported. Freighter Mobile cannot sign Soroban auth entries yet. Use the desktop extension.',
  },
]

export function walletCompatibility(walletId: string): AuthEntryWallet | null {
  const id = walletId.trim().toLowerCase()
  return AUTH_ENTRY_WALLETS.find((wallet) => wallet.id === id) || null
}
