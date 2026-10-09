export interface AuthEntryWallet {
  id: string
  name: string
  platform: string
  authEntry: boolean
  guidance: string
}

/** Wallets that can sign Soroban authorization entries for x402 on Stellar today. */
export const AUTH_ENTRY_WALLETS: AuthEntryWallet[] = [
  {
    id: 'freighter',
    name: 'Freighter',
    platform: 'Browser extension',
    authEntry: true,
    guidance: 'Supported. Set the extension to Testnet before approving.',
  },
  {
    id: 'albedo',
    name: 'Albedo',
    platform: 'Web',
    authEntry: true,
    guidance: 'Supported for auth-entry signing on testnet.',
  },
  {
    id: 'hana',
    name: 'Hana',
    platform: 'Browser extension',
    authEntry: true,
    guidance: 'Supported for auth-entry signing on testnet.',
  },
  {
    id: 'hot',
    name: 'HOT',
    platform: 'Browser extension',
    authEntry: true,
    guidance: 'Supported for auth-entry signing on testnet.',
  },
  {
    id: 'klever',
    name: 'Klever',
    platform: 'Browser extension',
    authEntry: true,
    guidance: 'Supported for auth-entry signing on testnet.',
  },
  {
    id: 'onekey',
    name: 'OneKey',
    platform: 'Browser extension',
    authEntry: true,
    guidance: 'Supported for auth-entry signing on testnet.',
  },
  {
    id: 'freighter-mobile',
    name: 'Freighter Mobile',
    platform: 'iOS and Android',
    authEntry: false,
    guidance: 'Not supported. Freighter Mobile cannot sign Soroban auth entries yet. Use the desktop extension.',
  },
]
