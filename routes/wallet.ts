import express, { type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { authenticate } from '../middleware/auth';
import walletService, { type MainnetSigningMode } from '../services/wallet';
import prisma from '../lib/prisma';
import { coerceNetwork } from '../lib/networks';

const router = express.Router();

/**
 * GET /api/wallet/me?network=testnet|mainnet
 * The logged-in user's server-managed wallet, scoped to a network.
 * Returns ONLY { publicKey, funded, balance, network, mainnetSigningMode } — never the secret.
 */
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const network = coerceNetwork(req.query.network);
    const info = await walletService.getPublicWalletInfo(req.userId!, network);
    res.json({ success: true, ...info });
  } catch (error: any) {
    console.error('[Wallet] /me error:', error);
    res.status(500).json({ success: false, error: 'Failed to load wallet', message: error.message });
  }
});

/**
 * GET /api/wallet/balance?network=testnet|mainnet&address=G...
 * Native XLM balance on the given network. Defaults to the user's own wallet;
 * pass `address` to look up an arbitrary account (e.g. a connected external
 * wallet that signs mainnet). Balances are public ledger data.
 */
router.get('/balance', authenticate, async (req: Request, res: Response) => {
  try {
    const network = coerceNetwork(req.query.network);
    const requested = typeof req.query.address === 'string' ? req.query.address.trim() : '';
    const valid = /^G[A-Z2-7]{55}$/.test(requested);
    const publicKey = valid ? requested : await walletService.getPublicKey(req.userId!);
    if (!publicKey) return res.status(404).json({ success: false, error: 'No wallet' });
    const balance = await walletService.getBalance(publicKey, network);
    res.json({ success: true, publicKey, balance, network, funded: balance > 0 });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to load balance', message: error.message });
  }
});

/**
 * POST /api/wallet/ensure — create + fund the wallet if missing.
 */
router.post('/ensure', authenticate, async (req: Request, res: Response) => {
  try {
    await walletService.getOrCreateWallet(req.userId!);
    const info = await walletService.getPublicWalletInfo(req.userId!, coerceNetwork(req.body?.network));
    res.json({ success: true, ...info });
  } catch (error: any) {
    console.error('[Wallet] /ensure error:', error);
    res.status(500).json({ success: false, error: 'Failed to ensure wallet', message: error.message });
  }
});

/**
 * POST /api/wallet/fund — TESTNET faucet only. Mainnet has no faucet.
 */
router.post('/fund', authenticate, async (req: Request, res: Response) => {
  try {
    const network = coerceNetwork(req.body?.network);
    if (network === 'mainnet') {
      return res.status(400).json({
        success: false,
        error: 'No faucet on mainnet. Send real XLM to your wallet address (see the funding guide).',
        code: 'NO_MAINNET_FAUCET',
      });
    }
    const result = await walletService.topUpIfLow(req.userId!);
    const publicKey = await walletService.getPublicKey(req.userId!);
    res.json({ success: true, publicKey, network, ...result });
  } catch (error: any) {
    console.error('[Wallet] /fund error:', error);
    res.status(500).json({ success: false, error: 'Failed to fund wallet', message: error.message });
  }
});

/**
 * GET /api/wallet/signing-mode — the user's mainnet signing mode.
 */
router.get('/signing-mode', authenticate, async (req: Request, res: Response) => {
  try {
    const mode = await walletService.getMainnetSigningMode(req.userId!);
    res.json({ success: true, mainnetSigningMode: mode });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to read signing mode', message: error.message });
  }
});

/**
 * PUT /api/wallet/signing-mode — set mainnet signing mode.
 * Switching to "custodial" requires explicit acknowledgement (real funds at risk).
 */
router.put('/signing-mode', authenticate, async (req: Request, res: Response) => {
  try {
    const mode = req.body?.mode as MainnetSigningMode;
    if (mode !== 'connected' && mode !== 'custodial') {
      return res.status(400).json({ success: false, error: 'mode must be "connected" or "custodial"' });
    }
    if (mode === 'custodial' && req.body?.acknowledged !== true) {
      return res.status(400).json({
        success: false,
        error: 'Custodial mainnet signing requires explicit acknowledgement that a server-held key will sign real-fund transactions.',
        code: 'ACK_REQUIRED',
      });
    }
    const saved = await walletService.setMainnetSigningMode(req.userId!, mode);
    res.json({ success: true, mainnetSigningMode: saved });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to set signing mode', message: error.message });
  }
});

/**
 * POST /api/wallet/export — GATED private-key reveal (both networks, same key).
 *
 * Hard gate: the caller must re-confirm by typing "EXPORT", and — if the account
 * has a password — re-enter it. Every call writes a KeyExportAudit row
 * (userId, ip, userAgent, time). The secret is decrypted in memory only, returned
 * exactly once, and never logged or cached. The client must show it copy-once.
 */
router.post('/export', authenticate, async (req: Request, res: Response) => {
  try {
    const { confirm, password } = req.body || {};
    if (confirm !== 'EXPORT') {
      return res.status(400).json({
        success: false,
        error: 'Type EXPORT to confirm you understand this reveals your secret key.',
        code: 'CONFIRM_REQUIRED',
      });
    }

    // Re-authenticate: verify the password when the account has one.
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { passwordHash: true },
    });
    if (user?.passwordHash) {
      if (!password || !(await bcrypt.compare(String(password), user.passwordHash))) {
        return res.status(401).json({ success: false, error: 'Incorrect password.', code: 'REAUTH_FAILED' });
      }
    }

    const { publicKey, secret } = await walletService.exportSecret(req.userId!);

    // Audit EVERY export (never the key itself).
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null;
    const userAgent = (req.headers['user-agent'] as string) || null;
    await prisma.keyExportAudit
      .create({ data: { userId: req.userId!, ip, userAgent } })
      .catch((e) => console.warn('[Wallet] export audit write failed:', e.message));
    console.log(`[Wallet] SECRET EXPORTED for user ${req.userId} from ${ip ?? 'unknown ip'}`);

    // Returned once. Do NOT log `secret`. Tell intermediaries not to cache it.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, publicKey, secret });
  } catch (error: any) {
    console.error('[Wallet] /export error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to export key', message: error.message });
  }
});

export default router;
