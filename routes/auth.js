const express = require('express');
const router = express.Router();
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const DiscordStrategy = require('passport-discord').Strategy;
const User = require('../models/User');
const { generateToken, generateChallenge } = require('../utils/auth');
const { authenticate } = require('../middleware/auth');

function hasOAuthProvider(user) {
  return !!(user && (user.googleId || user.githubId || user.discordId));
}

function oauthSuccessRedirect(req, res, providerLabel) {
  try {
    const user = req.user;
    const token = generateToken(user);
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/auth/callback?token=${token}&success=true`);
  } catch (error) {
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
}, async (accessToken, refreshToken, profile, done) => {
  try {
    // Find or create user
    let user = await User.findOne({ googleId: profile.id });
    
    if (!user) {
      // Check if user exists with this email
      user = await User.findOne({ email: profile.emails[0].value });
      
      if (user) {
        // Link Google account to existing user
        user.googleId = profile.id;
        user.authMethod = user.walletAddress ? 'both' : 'gmail';
        user.name = profile.displayName;
        user.picture = profile.photos[0]?.value;
        await user.save();
      } else {
        // Create new user
        user = new User({
          email: profile.emails[0].value,
          googleId: profile.id,
          authMethod: 'gmail',
          name: profile.displayName,
          picture: profile.photos[0]?.value,
          subscription: {
            plan: 'free',
            status: 'active'
          }
        });
        user.updateUsageLimits('free');
        await user.save();
      }
    } else {
      // Update last login
      user.lastLogin = new Date();
      user.name = profile.displayName;
      user.picture = profile.photos[0]?.value;
      await user.save();
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
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const githubId = String(profile.id);
      let email = profile.emails && profile.emails[0] && profile.emails[0].value
        ? profile.emails[0].value.toLowerCase().trim()
        : `${githubId}+${profile.username || 'user'}@users.noreply.github.com`;
      const displayName = profile.displayName || profile.username || 'GitHub User';
      const picture = profile.photos && profile.photos[0] ? profile.photos[0].value : null;

      let user = await User.findOne({ githubId });
      if (!user) {
        user = await User.findOne({ email });
        if (user) {
          user.githubId = githubId;
          user.authMethod = user.walletAddress ? 'both' : 'github';
          user.name = displayName;
          if (picture) user.picture = picture;
          await user.save();
        } else {
          user = new User({
            email,
            githubId,
            authMethod: 'github',
            name: displayName,
            picture,
            subscription: {
              plan: 'free',
              status: 'active'
            }
          });
          user.updateUsageLimits('free');
          await user.save();
        }
      } else {
        user.lastLogin = new Date();
        user.name = displayName;
        if (picture) user.picture = picture;
        await user.save();
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
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const discordId = String(profile.id);
      const email = profile.email
        ? profile.email.toLowerCase().trim()
        : `discord_${discordId}@oauth.local`;
      const displayName = profile.global_name || profile.username || 'Discord User';
      const picture = profile.avatar
        ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
        : null;

      let user = await User.findOne({ discordId });
      if (!user) {
        user = await User.findOne({ email });
        if (user) {
          user.discordId = discordId;
          user.authMethod = user.walletAddress ? 'both' : 'discord';
          user.name = displayName;
          if (picture) user.picture = picture;
          await user.save();
        } else {
          user = new User({
            email,
            discordId,
            authMethod: 'discord',
            name: displayName,
            picture,
            subscription: {
              plan: 'free',
              status: 'active'
            }
          });
          user.updateUsageLimits('free');
          await user.save();
        }
      } else {
        user.lastLogin = new Date();
        user.name = displayName;
        if (picture) user.picture = picture;
        await user.save();
      }
      return done(null, user);
    } catch (error) {
      return done(error, null);
    }
  }));
}

// Serialize user for session
passport.serializeUser((user, done) => {
  done(null, user._id);
});

// Deserialize user from session
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
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
  (req, res) => oauthSuccessRedirect(req, res, 'Google')
);

/**
 * GET /api/auth/github
 */
router.get('/github', (req, res, next) => {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    return res.status(503).json({ success: false, error: 'GitHub sign-in is not configured' });
  }
  passport.authenticate('github', { scope: ['user:email'] })(req, res, next);
});

/**
 * GET /api/auth/github/callback
 */
router.get('/github/callback',
  (req, res, next) => {
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}/auth/callback?success=false&error=${encodeURIComponent('GitHub sign-in is not configured')}`);
    }
    passport.authenticate('github', { session: false })(req, res, next);
  },
  (req, res) => oauthSuccessRedirect(req, res, 'GitHub')
);

/**
 * GET /api/auth/discord
 */
router.get('/discord', (req, res, next) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return res.status(503).json({ success: false, error: 'Discord sign-in is not configured' });
  }
  passport.authenticate('discord', { scope: ['identify', 'email'] })(req, res, next);
});

/**
 * GET /api/auth/discord/callback
 */
router.get('/discord/callback',
  (req, res, next) => {
    if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}/auth/callback?success=false&error=${encodeURIComponent('Discord sign-in is not configured')}`);
    }
    passport.authenticate('discord', { session: false })(req, res, next);
  },
  (req, res) => oauthSuccessRedirect(req, res, 'Discord')
);

/**
 * POST /api/auth/wallet/challenge
 * Generate challenge for wallet authentication
 */
router.post('/wallet/challenge', async (req, res) => {
  try {
    const { walletAddress } = req.body;
    
    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        error: 'Wallet address is required'
      });
    }
    
    // Validate Stellar address format
    if (!walletAddress.startsWith('G') || walletAddress.length !== 56) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Stellar wallet address format'
      });
    }
    
    const challenge = generateChallenge(walletAddress);
    
    // Store challenge in session/redis (in production, use Redis)
    // For now, we'll return it and verify on the next step
    res.json({
      success: true,
      challenge: challenge.message,
      timestamp: challenge.timestamp,
      expiresAt: challenge.expiresAt
    });
  } catch (error) {
    console.error('Wallet challenge error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate challenge',
      message: error.message
    });
  }
});

/**
 * POST /api/auth/wallet/verify
 * Verify wallet signature and authenticate
 */
router.post('/wallet/verify', async (req, res) => {
  try {
    const { walletAddress, signature, challenge, challengeTimestamp } = req.body;
    
    if (!walletAddress || !signature || !challenge) {
      return res.status(400).json({
        success: false,
        error: 'Wallet address, signature, and challenge are required'
      });
    }
    
    // Validate Stellar address format
    if (!walletAddress.startsWith('G') || walletAddress.length !== 56) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Stellar wallet address format'
      });
    }
    
    // Verify challenge hasn't expired
    if (challengeTimestamp) {
      const expiresAt = challengeTimestamp + (5 * 60 * 1000); // 5 minutes
      if (Date.now() > expiresAt) {
        return res.status(400).json({
          success: false,
          error: 'Challenge expired. Please request a new one.'
        });
      }
    }
    
    // TODO: Implement proper signature verification with Stellar SDK
    // For now, we'll accept the signature if wallet address is valid
    // In production, verify the signature properly
    
    // Find or create user
    const { email } = req.body;
    
    // Email is required
    if (!email || !email.trim() || !email.includes('@')) {
      return res.status(400).json({
        success: false,
        error: 'Email is required and must be a valid email address'
      });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    let user = await User.findOne({ walletAddress });
    
    if (!user) {
      // Check if user exists with email
      user = await User.findOne({ email: normalizedEmail });
      if (user) {
        // Link wallet to existing user
        user.walletAddress = walletAddress;
        user.authMethod = hasOAuthProvider(user) ? 'both' : 'wallet';
        await user.save();
      }
      
      if (!user) {
        // Create new user with wallet (email is required)
        user = new User({
          walletAddress,
          authMethod: 'wallet',
          email: normalizedEmail,
          subscription: {
            plan: 'free',
            status: 'active'
          }
        });
        user.updateUsageLimits('free');
        await user.save();
      }
    } else {
      // Update email if provided and different
      if (normalizedEmail !== user.email && !user.email.includes('@wallet.local')) {
        // Check if email is already taken
        const emailUser = await User.findOne({ email: normalizedEmail });
        if (emailUser && emailUser._id.toString() !== user._id.toString()) {
          return res.status(400).json({
            success: false,
            error: 'This email is already associated with another account'
          });
        }
        user.email = normalizedEmail;
        await user.save();
      }
      // Update last login
      user.lastLogin = new Date();
      await user.save();
    }
    
    const token = generateToken(user);
    
    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    
    res.json({
      success: true,
      token,
      user: {
        _id: user._id,
        email: user.email,
        walletAddress: user.walletAddress,
        name: user.name,
        picture: user.picture,
        subscription: user.subscription,
        usage: user.usage,
        purchasedTemplates: user.purchasedTemplates || []
      }
    });
  } catch (error) {
    console.error('Wallet verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Wallet verification failed',
      message: error.message
    });
  }
});

/**
 * GET /api/auth/me
 * Get current authenticated user
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = req.user;
    
    res.json({
      success: true,
      user: {
        _id: user._id,
        email: user.email,
        walletAddress: user.walletAddress,
        name: user.name,
        picture: user.picture,
        authMethod: user.authMethod,
        subscription: user.subscription,
        usage: user.usage,
        purchasedTemplates: user.purchasedTemplates || [],
        createdAt: user.createdAt,
        lastLogin: user.lastLogin
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user',
      message: error.message
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout user
 */
router.post('/logout', authenticate, (req, res) => {
  res.clearCookie('token');
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

/**
 * POST /api/auth/link-wallet
 * Link wallet address to existing user account
 */
router.post('/link-wallet', authenticate, async (req, res) => {
  try {
    const { walletAddress, signature, challenge } = req.body;
    const user = req.user;
    
    if (!walletAddress || !signature) {
      return res.status(400).json({
        success: false,
        error: 'Wallet address and signature are required'
      });
    }
    
    // Validate Stellar address format
    if (!walletAddress.startsWith('G') || walletAddress.length !== 56) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Stellar wallet address format'
      });
    }
    
    // Check if wallet is already linked to another account
    const existingUser = await User.findOne({ walletAddress });
    if (existingUser && existingUser._id.toString() !== user._id.toString()) {
      return res.status(400).json({
        success: false,
        error: 'This wallet is already linked to another account'
      });
    }
    
    // TODO: Verify signature
    
    // Link wallet to user
    user.walletAddress = walletAddress;
    user.authMethod = hasOAuthProvider(user) ? 'both' : 'wallet';
    await user.save();
    
    res.json({
      success: true,
      message: 'Wallet linked successfully',
      user: {
        _id: user._id,
        email: user.email,
        walletAddress: user.walletAddress,
        authMethod: user.authMethod
      }
    });
  } catch (error) {
    console.error('Link wallet error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to link wallet',
      message: error.message
    });
  }
});

module.exports = router;
