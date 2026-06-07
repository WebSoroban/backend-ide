import express, { type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth';
import walletService from '../services/wallet';

const router = express.Router();

/**
 * GET /api/wallet/me
 * Return the logged-in user's server-managed testnet wallet.
 * Returns ONLY { publicKey, funded, balance } — never the secret key.
 */
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const info = await walletService.getPublicWalletInfo(req.userId!);
    res.json({ success: true, ...info });
  } catch (error: any) {
    console.error('[Wallet] /me error:', error);
    res.status(500).json({ success: false, error: 'Failed to load wallet', message: error.message });
  }
});

/**
 * POST /api/wallet/ensure
 * Create + fund the wallet if missing (called by the frontend post-login when
 * the frontend owns OAuth, e.g. NextAuth). Returns { publicKey, funded, balance }.
 */
router.post('/ensure', authenticate, async (req: Request, res: Response) => {
  try {
    await walletService.getOrCreateWallet(req.userId!);
    const info = await walletService.getPublicWalletInfo(req.userId!);
    res.json({ success: true, ...info });
  } catch (error: any) {
    console.error('[Wallet] /ensure error:', error);
    res.status(500).json({ success: false, error: 'Failed to ensure wallet', message: error.message });
  }
});

/**
 * POST /api/wallet/fund
 * Re-run Friendbot if the testnet balance is low. Returns { publicKey, funded, balance }.
 */
router.post('/fund', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await walletService.topUpIfLow(req.userId!);
    const publicKey = await walletService.getPublicKey(req.userId!);
    res.json({ success: true, publicKey, ...result });
  } catch (error: any) {
    console.error('[Wallet] /fund error:', error);
    res.status(500).json({ success: false, error: 'Failed to fund wallet', message: error.message });
  }
});

export default router;
