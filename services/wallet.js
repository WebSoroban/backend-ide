/**
 * Per-user Stellar TESTNET wallet service.
 *
 * Each user gets a server-managed Stellar keypair created on first login. The
 * secret key is AES-256-GCM encrypted at rest (see lib/crypto.js) and is only
 * ever decrypted in-memory at deploy time via loadKeypair(). It is NEVER logged
 * and NEVER returned by any API response.
 *
 * TESTNET ONLY. The network passphrase, Friendbot and Horizon endpoints are
 * hardcoded — there is intentionally no mainnet code path here.
 */
const { Keypair } = require('@stellar/stellar-sdk');
const prisma = require('../lib/prisma');
const { encrypt, decrypt } = require('../lib/crypto');

// --- Testnet constants (hardcoded on purpose; do not parameterize for mainnet) ---
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
// Top up again if the balance falls below this many XLM.
const LOW_BALANCE_THRESHOLD = 10;

/**
 * Fund a public key from the testnet Friendbot. Resolves true on success.
 * Returns false (without throwing) on failure so callers can decide what to do.
 */
async function fundViaFriendbot(publicKey) {
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
  } catch (err) {
    console.warn(`[Wallet] Friendbot request failed: ${err.message}`);
    return false;
  }
}

/**
 * Get the native XLM balance for a public key from Horizon.
 * Returns a number (0 if the account is not yet funded / not found).
 */
async function getBalance(publicKey) {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(publicKey)}`);
    if (!res.ok) return 0;
    const account = await res.json();
    const native = (account.balances || []).find((b) => b.asset_type === 'native');
    return native ? parseFloat(native.balance) : 0;
  } catch (err) {
    console.warn(`[Wallet] Balance lookup failed for ${publicKey}: ${err.message}`);
    return 0;
  }
}

/**
 * Create a brand-new wallet for a user: generate a keypair, encrypt the secret,
 * persist it, fund it via Friendbot, and mark funded. Returns the Wallet row.
 */
async function createWalletForUser(userId) {
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  const secretKeyEncrypted = encrypt(keypair.secret());

  const funded = await fundViaFriendbot(publicKey);

  return prisma.wallet.create({
    data: { userId, publicKey, secretKeyEncrypted, funded }
  });
}

/**
 * Return the user's wallet, creating (and funding) it if it doesn't exist yet.
 */
async function getOrCreateWallet(userId) {
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

/**
 * Return only the public key (G...) for a user's wallet, or null if none.
 */
async function getPublicKey(userId) {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: { publicKey: true }
  });
  return wallet ? wallet.publicKey : null;
}

/**
 * Re-run Friendbot if the wallet balance is low (testnet top-up).
 * Returns { funded, balance }.
 */
async function topUpIfLow(userId) {
  const wallet = await getOrCreateWallet(userId);
  const balance = await getBalance(wallet.publicKey);
  if (balance < LOW_BALANCE_THRESHOLD) {
    const ok = await fundViaFriendbot(wallet.publicKey);
    if (ok && !wallet.funded) {
      await prisma.wallet.update({ where: { userId }, data: { funded: true } });
    }
    return { funded: true, balance: await getBalance(wallet.publicKey) };
  }
  return { funded: wallet.funded, balance };
}

/**
 * INTERNAL ONLY — decrypt the secret and return a Stellar Keypair for signing.
 * Must never be exposed through any route response.
 */
async function loadKeypair(userId) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) {
    throw new Error('No wallet found for user');
  }
  const secret = decrypt(wallet.secretKeyEncrypted);
  return Keypair.fromSecret(secret);
}

/**
 * Public-safe view of a wallet: { publicKey, funded, balance }. Never the secret.
 */
async function getPublicWalletInfo(userId) {
  const wallet = await getOrCreateWallet(userId);
  const balance = await getBalance(wallet.publicKey);
  return { publicKey: wallet.publicKey, funded: wallet.funded, balance };
}

module.exports = {
  createWalletForUser,
  getOrCreateWallet,
  getPublicKey,
  getPublicWalletInfo,
  getBalance,
  topUpIfLow,
  fundViaFriendbot,
  loadKeypair,
  HORIZON_URL,
  FRIENDBOT_URL
};
