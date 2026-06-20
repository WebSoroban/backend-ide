/**
 * Per-user Stellar wallet service.
 *
 * Each user gets a server-managed Stellar keypair created on first login. The
 * secret key is AES-256-GCM encrypted at rest (see lib/crypto.ts) and is only
 * ever decrypted in-memory — at deploy/invoke sign time via loadKeypair(), or in
 * the single deliberate, gated, audited export path. It is NEVER logged and
 * NEVER returned by any API response except that gated export.
 *
 * The SAME keypair is the user's address on BOTH networks; only funding and the
 * rpc/horizon differ. Friendbot (the faucet) is TESTNET ONLY — mainnet has none.
 */
import { Keypair } from '@stellar/stellar-sdk';
import type { Wallet } from '@prisma/client';
import prisma from '../lib/prisma';
import { encrypt, decrypt } from '../lib/crypto';
import { getNetwork, coerceNetwork, type NetworkId } from '../lib/networks';

// Top up testnet again if the balance falls below this many XLM.
const LOW_BALANCE_THRESHOLD = 10;

// Back-compat exports (some callers import these directly).
export const FRIENDBOT_URL = getNetwork('testnet').friendbotUrl!;
export const HORIZON_URL = getNetwork('testnet').horizonUrl;

export type MainnetSigningMode = 'connected' | 'custodial';

/**
 * Fund a public key from the testnet Friendbot. Resolves true on success.
 * Returns false (without throwing) on failure so callers can decide what to do.
 */
async function fundViaFriendbot(publicKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);
    if (res.ok) return true;
    // 400 typically means "account already funded" — treat as success.
    const body = await res.text();
    if (res.status === 400 && /already funded|op_already_exists|createAccountAlreadyExist/i.test(body)) {
      return true;
    }
    console.warn(`[Wallet] Friendbot returned ${res.status} for ${publicKey}`);
    return false;
  } catch (err: any) {
    console.warn(`[Wallet] Friendbot request failed: ${err.message}`);
    return false;
  }
}

/**
 * Native XLM balance for a public key on the given network's Horizon.
 * Returns 0 if the account is not yet funded / not found.
 */
async function getBalance(publicKey: string, network: NetworkId = 'testnet'): Promise<number> {
  try {
    const horizon = getNetwork(network).horizonUrl;
    const res = await fetch(`${horizon}/accounts/${encodeURIComponent(publicKey)}`);
    if (!res.ok) return 0;
    const account: any = await res.json();
    const native = (account.balances || []).find((b: any) => b.asset_type === 'native');
    return native ? parseFloat(native.balance) : 0;
  } catch (err: any) {
    console.warn(`[Wallet] Balance lookup failed for ${publicKey} on ${network}: ${err.message}`);
    return 0;
  }
}

/**
 * Create a brand-new wallet for a user: generate a keypair, encrypt the secret,
 * persist it, fund it via testnet Friendbot, and mark funded. Returns the row.
 */
async function createWalletForUser(userId: string): Promise<Wallet> {
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  const secretKeyEncrypted = encrypt(keypair.secret());

  const funded = await fundViaFriendbot(publicKey);

  return prisma.wallet.create({
    data: { userId, publicKey, secretKeyEncrypted, funded }
  });
}

/** Return the user's wallet, creating (and testnet-funding) it if missing. */
async function getOrCreateWallet(userId: string): Promise<Wallet> {
  const existing = await prisma.wallet.findUnique({ where: { userId } });
  if (existing) {
    // Self-heal: if it was created but Friendbot failed earlier, retry once.
    if (!existing.funded) {
      const funded = await fundViaFriendbot(existing.publicKey);
      if (funded) {
        return prisma.wallet.update({ where: { userId }, data: { funded: true } });
      }
    }
    return existing;
  }
  return createWalletForUser(userId);
}

/** Return only the public key (G...) for a user's wallet, or null if none. */
async function getPublicKey(userId: string): Promise<string | null> {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: { publicKey: true }
  });
  return wallet ? wallet.publicKey : null;
}

/**
 * Re-run Friendbot if the wallet balance is low (TESTNET top-up only).
 * Returns { funded, balance }.
 */
async function topUpIfLow(userId: string): Promise<{ funded: boolean; balance: number }> {
  const wallet = await getOrCreateWallet(userId);
  const balance = await getBalance(wallet.publicKey, 'testnet');
  if (balance < LOW_BALANCE_THRESHOLD) {
    const ok = await fundViaFriendbot(wallet.publicKey);
    if (ok && !wallet.funded) {
      await prisma.wallet.update({ where: { userId }, data: { funded: true } });
    }
    return { funded: true, balance: await getBalance(wallet.publicKey, 'testnet') };
  }
  return { funded: wallet.funded, balance };
}

/**
 * INTERNAL ONLY — decrypt the secret and return a Stellar Keypair for signing.
 * Must never be exposed through any route response (the gated export goes through
 * exportSecret + an audit log instead).
 */
async function loadKeypair(userId: string): Promise<Keypair> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error('No wallet found for user');
  const secret = decrypt(wallet.secretKeyEncrypted);
  return Keypair.fromSecret(secret);
}

/**
 * Public-safe wallet view for a network: { publicKey, balance, network, funded }.
 * On mainnet `funded` means "has a positive balance" (there is no faucet).
 */
async function getPublicWalletInfo(
  userId: string,
  network: NetworkId = 'testnet'
): Promise<{ publicKey: string; funded: boolean; balance: number; network: NetworkId; mainnetSigningMode: MainnetSigningMode }> {
  const wallet = await getOrCreateWallet(userId);
  const balance = await getBalance(wallet.publicKey, network);
  const funded = network === 'mainnet' ? balance > 0 : wallet.funded;
  return {
    publicKey: wallet.publicKey,
    funded,
    balance,
    network,
    mainnetSigningMode: (wallet.mainnetSigningMode as MainnetSigningMode) || 'connected',
  };
}

/** Read the user's mainnet signing mode (default "connected" = non-custodial). */
async function getMainnetSigningMode(userId: string): Promise<MainnetSigningMode> {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { mainnetSigningMode: true } });
  return (wallet?.mainnetSigningMode as MainnetSigningMode) || 'connected';
}

/** Persist the user's mainnet signing mode. Custodial requires explicit opt-in. */
async function setMainnetSigningMode(userId: string, mode: MainnetSigningMode): Promise<MainnetSigningMode> {
  await getOrCreateWallet(userId);
  const updated = await prisma.wallet.update({
    where: { userId },
    data: { mainnetSigningMode: mode },
    select: { mainnetSigningMode: true },
  });
  return updated.mainnetSigningMode as MainnetSigningMode;
}

/**
 * GATED export — decrypt and return the secret ONCE. The caller MUST have already
 * performed the re-auth/confirmation checks and MUST write a KeyExportAudit row.
 * The secret is held in memory only and is never logged here.
 */
async function exportSecret(userId: string): Promise<{ publicKey: string; secret: string }> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error('No wallet found for user');
  return { publicKey: wallet.publicKey, secret: decrypt(wallet.secretKeyEncrypted) };
}

export {
  createWalletForUser,
  getOrCreateWallet,
  getPublicKey,
  getPublicWalletInfo,
  getBalance,
  topUpIfLow,
  fundViaFriendbot,
  loadKeypair,
  getMainnetSigningMode,
  setMainnetSigningMode,
  exportSecret,
};

export default {
  createWalletForUser,
  getOrCreateWallet,
  getPublicKey,
  getPublicWalletInfo,
  getBalance,
  topUpIfLow,
  fundViaFriendbot,
  loadKeypair,
  getMainnetSigningMode,
  setMainnetSigningMode,
  exportSecret,
  HORIZON_URL,
  FRIENDBOT_URL,
};
