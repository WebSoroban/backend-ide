import express, { type Request, type Response, type NextFunction } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { Strategy as DiscordStrategy } from 'passport-discord';
import prisma from '../lib/prisma';
import userService from '../services/userService';
import walletService from '../services/wallet';
import { generateToken, generateChallenge } from '../utils/auth';
import { authenticate } from '../middleware/auth';
import { ensureSignupGrant } from '../services/billing/credits';

const router = express.Router();

function hasOAuthProvider(user: any): boolean {
  return !!(user && (user.googleId || user.githubId || user.discordId));
}

/** Default JSON blobs for a brand-new free-plan user. */
function newUserDefaults() {
  return {
    subscription: userService.defaultSubscription('free'),
    usage: userService.defaultUsage('free')
  };
}

async function oauthSuccessRedirect(req: Request, res: Response, providerLabel: string) {
  try {
    const user = req.user as any;

    // On successful OAuth login, ensure the user has a funded testnet wallet.
    // Never block login if wallet creation/funding fails.
    try {
      await walletService.getOrCreateWallet(user.id);
    } catch (walletErr: any) {
      console.error(`[Auth] Wallet provisioning failed for ${user.id}:`, walletErr.message);
    }

    const token = generateToken(user);
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/auth/callback?token=${token}&success=true`);
  } catch (error: any) {
    console.error(`${providerLabel} OAuth callback error:`, error);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/auth/callback?success=false&error=${encodeURIComponent(error.message)}`);
  }
}

// Configure Google OAuth Strategy
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback'
}, async (accessToken: string, refreshToken: string, profile: any, done: any) => {
  try {
    let user = await prisma.user.findUnique({ where: { googleId: profile.id } });

    if (!user) {
      const email = profile.emails[0].value;
      user = await prisma.user.findUnique({ where: { email } });

      if (user) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            googleId: profile.id,
            authMethod: user.walletAddress ? 'both' : 'gmail',
            name: profile.displayName,
            picture: profile.photos[0]?.value
          }
        });
      } else {
        user = await prisma.user.create({
          data: {
            email,
            googleId: profile.id,
            authMethod: 'gmail',
            name: profile.displayName,
            picture: profile.photos[0]?.value,
            ...newUserDefaults()
          }
        });
      }
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          lastLogin: new Date(),
          name: profile.displayName,
          picture: profile.photos[0]?.value
        }
      });
    }

    return done(null, user);
  } catch (error) {
    return done(error, null);
  }
}));

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: process.env.GITHUB_CALLBACK_URL || '/api/auth/github/callback'
  }, async (accessToken: string, refreshToken: string, profile: any, done: any) => {
    try {
      const githubId = String(profile.id);
      const email = profile.emails && profile.emails[0] && profile.emails[0].value
        ? profile.emails[0].value.toLowerCase().trim()
        : `${githubId}+${profile.username || 'user'}@users.noreply.github.com`;
      const displayName = profile.displayName || profile.username || 'GitHub User';
      const picture = profile.photos && profile.photos[0] ? profile.photos[0].value : null;

      let user = await prisma.user.findUnique({ where: { githubId } });
      if (!user) {
        user = await prisma.user.findUnique({ where: { email } });
        if (user) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: {
              githubId,
              authMethod: user.walletAddress ? 'both' : 'github',
              name: displayName,
              ...(picture ? { picture } : {})
            }
          });
        } else {
          user = await prisma.user.create({
            data: {
              email,
              githubId,
              authMethod: 'github',
              name: displayName,
              picture,
              ...newUserDefaults()
            }
          });
        }
      } else {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { lastLogin: new Date(), name: displayName, ...(picture ? { picture } : {}) }
        });
      }
      return done(null, user);
    } catch (error) {
      return done(error, null);
    }
  }));
}

if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
  passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL || '/api/auth/discord/callback',
    scope: ['identify', 'email']
  }, async (accessToken: string, refreshToken: string, profile: any, done: any) => {
    try {
      const discordId = String(profile.id);
      const email = profile.email
        ? profile.email.toLowerCase().trim()
        : `discord_${discordId}@oauth.local`;
      const displayName = profile.global_name || profile.username || 'Discord User';
      const picture = profile.avatar
        ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
        : null;

      let user = await prisma.user.findUnique({ where: { discordId } });
      if (!user) {
        user = await prisma.user.findUnique({ where: { email } });
        if (user) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: {
              discordId,
              authMethod: user.walletAddress ? 'both' : 'discord',
              name: displayName,
              ...(picture ? { picture } : {})
            }
          });
        } else {
          user = await prisma.user.create({
            data: {
              email,
              discordId,
              authMethod: 'discord',
              name: displayName,
              picture,
              ...newUserDefaults()
            }
          });
        }
      } else {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { lastLogin: new Date(), name: displayName, ...(picture ? { picture } : {}) }
        });
      }
      return done(null, user);
    } catch (error) {
      return done(error, null);
    }
  }));
}

// Serialize user for session
passport.serializeUser((user: any, done) => {
  done(null, user.id);
});

// Deserialize user from session
passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

/**
 * GET /api/auth/google
 * Initiate Google OAuth flow
 */
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email']
}));

/**
 * GET /api/auth/google/callback
 * Google OAuth callback
 */
router.get('/google/callback',
  passport.authenticate('google', { session: false }),
  (req: Request, res: Response) => oauthSuccessRedirect(req, res, 'Google')
);

/**
 * GET /api/auth/github
 */
router.get('/github', (req: Request, res: Response, next: NextFunction) => {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    return res.status(503).json({ success: false, error: 'GitHub sign-in is not configured' });
  }
  passport.authenticate('github', { scope: ['user:email'] })(req, res, next);
});

/**
 * GET /api/auth/github/callback
 */
router.get('/github/callback',
  (req: Request, res: Response, next: NextFunction) => {
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}/auth/callback?success=false&error=${encodeURIComponent('GitHub sign-in is not configured')}`);
    }
    passport.authenticate('github', { session: false })(req, res, next);
  },
  (req: Request, res: Response) => oauthSuccessRedirect(req, res, 'GitHub')
);

/**
 * GET /api/auth/discord
 */
router.get('/discord', (req: Request, res: Response, next: NextFunction) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return res.status(503).json({ success: false, error: 'Discord sign-in is not configured' });
  }
  passport.authenticate('discord', { scope: ['identify', 'email'] })(req, res, next);
});

/**
 * GET /api/auth/discord/callback
 */
router.get('/discord/callback',
  (req: Request, res: Response, next: NextFunction) => {
    if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}/auth/callback?success=false&error=${encodeURIComponent('Discord sign-in is not configured')}`);
    }
    passport.authenticate('discord', { session: false })(req, res, next);
  },
  (req: Request, res: Response) => oauthSuccessRedirect(req, res, 'Discord')
);

/**
 * POST /api/auth/wallet/challenge
 * Generate challenge for wallet authentication
 */
router.post('/wallet/challenge', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress) {
      return res.status(400).json({ success: false, error: 'Wallet address is required' });
    }

    if (!walletAddress.startsWith('G') || walletAddress.length !== 56) {
      return res.status(400).json({ success: false, error: 'Invalid Stellar wallet address format' });
    }

    const challenge = generateChallenge(walletAddress);
    res.json({
      success: true,
      challenge: challenge.message,
      timestamp: challenge.timestamp,
      expiresAt: challenge.expiresAt
    });
  } catch (error: any) {
    console.error('Wallet challenge error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate challenge', message: error.message });
  }
});

/**
 * POST /api/auth/wallet/verify
 * Verify wallet signature and authenticate. NOTE: `walletAddress` here is the
 * user's EXTERNAL connect-wallet used for sign-in — distinct from the
 * server-managed deploy wallet.
 */
router.post('/wallet/verify', async (req: Request, res: Response) => {
  try {
    const { walletAddress, signature, challenge, challengeTimestamp } = req.body;

    if (!walletAddress || !signature || !challenge) {
      return res.status(400).json({
        success: false,
        error: 'Wallet address, signature, and challenge are required'
      });
    }

    if (!walletAddress.startsWith('G') || walletAddress.length !== 56) {
      return res.status(400).json({ success: false, error: 'Invalid Stellar wallet address format' });
    }

    if (challengeTimestamp) {
      const expiresAt = challengeTimestamp + (5 * 60 * 1000);
      if (Date.now() > expiresAt) {
        return res.status(400).json({ success: false, error: 'Challenge expired. Please request a new one.' });
      }
    }

    const { email } = req.body;
    if (!email || !email.trim() || !email.includes('@')) {
      return res.status(400).json({
        success: false,
        error: 'Email is required and must be a valid email address'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    let user = await prisma.user.findUnique({ where: { walletAddress } });

    if (!user) {
      user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (user) {
        // Link external wallet to existing user
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            walletAddress,
            authMethod: hasOAuthProvider(user) ? 'both' : 'wallet'
          }
        });
      } else {
        // Create new user with external wallet (email required)
        user = await prisma.user.create({
          data: {
            walletAddress,
            authMethod: 'wallet',
            email: normalizedEmail,
            ...newUserDefaults()
          }
        });
      }
    } else {
      if (normalizedEmail !== user.email && !user.email!.includes('@wallet.local')) {
        const emailUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        if (emailUser && emailUser.id !== user.id) {
          return res.status(400).json({
            success: false,
            error: 'This email is already associated with another account'
          });
        }
        user = await prisma.user.update({
          where: { id: user.id },
          data: { email: normalizedEmail, lastLogin: new Date() }
        });
      } else {
        user = await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });
      }
    }

    // Provision the server-managed deploy wallet on login (non-blocking on failure).
    try {
      await walletService.getOrCreateWallet(user.id);
    } catch (walletErr: any) {
      console.error(`[Auth] Wallet provisioning failed for ${user.id}:`, walletErr.message);
    }

    const token = generateToken(user);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      token,
      user: {
        _id: user.id,
        email: user.email,
        walletAddress: user.walletAddress,
        name: user.name,
        picture: user.picture,
        subscription: user.subscription,
        usage: user.usage,
        purchasedTemplates: user.purchasedTemplates || []
      }
    });
  } catch (error: any) {
    console.error('Wallet verification error:', error);
    res.status(500).json({ success: false, error: 'Wallet verification failed', message: error.message });
  }
});

/**
 * GET /api/auth/me
 * Get current authenticated user
 */
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const user = req.user!;

    // Idempotently grant the one-time free AI credits. /me is the universal
    // post-login chokepoint, so this also backfills pre-existing users exactly
    // once (guarded by the signup_grant ledger row + unique constraint).
    let credits = (user as any).credits ?? 0;
    try {
      const res = await ensureSignupGrant(user.id);
      credits = res.balance;
    } catch (e: any) {
      console.warn('[auth/me] signup grant check failed:', e.message);
    }

    res.json({
      success: true,
      user: {
        _id: user.id,
        email: user.email,
        walletAddress: user.walletAddress,
        name: user.name,
        picture: user.picture,
        authMethod: user.authMethod,
        subscription: user.subscription,
        usage: user.usage,
        credits,
        purchasedTemplates: user.purchasedTemplates || [],
        createdAt: user.createdAt,
        lastLogin: user.lastLogin
      }
    });
  } catch (error: any) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, error: 'Failed to get user', message: error.message });
  }
});

/**
 * POST /api/auth/logout
 * Logout user
 */
router.post('/logout', authenticate, (req: Request, res: Response) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully' });
});

/**
 * POST /api/auth/link-wallet
 * Link external wallet address to existing user account
 */
router.post('/link-wallet', authenticate, async (req: Request, res: Response) => {
  try {
    const { walletAddress, signature } = req.body;
    const user = req.user!;

    if (!walletAddress || !signature) {
      return res.status(400).json({ success: false, error: 'Wallet address and signature are required' });
    }

    if (!walletAddress.startsWith('G') || walletAddress.length !== 56) {
      return res.status(400).json({ success: false, error: 'Invalid Stellar wallet address format' });
    }

    const existingUser = await prisma.user.findUnique({ where: { walletAddress } });
    if (existingUser && existingUser.id !== user.id) {
      return res.status(400).json({ success: false, error: 'This wallet is already linked to another account' });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { walletAddress, authMethod: hasOAuthProvider(user) ? 'both' : 'wallet' }
    });

    res.json({
      success: true,
      message: 'Wallet linked successfully',
      user: {
        _id: updated.id,
        email: updated.email,
        walletAddress: updated.walletAddress,
        authMethod: updated.authMethod
      }
    });
  } catch (error: any) {
    console.error('Link wallet error:', error);
    res.status(500).json({ success: false, error: 'Failed to link wallet', message: error.message });
  }
});

export default router;
