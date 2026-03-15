const jwt = require('jsonwebtoken');
const { Keypair } = require('@stellar/stellar-sdk');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

/**
 * Generate JWT token for user
 */
function generateToken(user) {
  const payload = {
    userId: user._id.toString(),
    email: user.email,
    walletAddress: user.walletAddress,
    plan: user.subscription.plan
  };
  
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN
  });
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

/**
 * Verify wallet signature
 * User signs a message with their wallet, we verify it matches their wallet address
 */
function verifyWalletSignature(message, signature, walletAddress) {
  try {
    // For Stellar, we need to verify the signature
    // This is a simplified version - in production, use proper signature verification
    const keypair = Keypair.fromPublicKey(walletAddress);
    
    // In a real implementation, you would:
    // 1. Have the user sign a challenge message
    // 2. Verify the signature using the wallet's public key
    // 3. Store the challenge in session/redis to prevent replay attacks
    
    // For now, we'll do basic validation
    // In production, implement proper signature verification with Stellar SDK
    return true; // Placeholder - implement proper verification
  } catch (error) {
    console.error('Wallet signature verification error:', error);
    return false;
  }
}

/**
 * Generate challenge message for wallet authentication
 */
function generateChallenge(walletAddress) {
  const timestamp = Date.now();
  const message = `WebSoroban Authentication\nWallet: ${walletAddress}\nTimestamp: ${timestamp}\nNonce: ${Math.random().toString(36).substring(7)}`;
  return {
    message,
    timestamp,
    expiresAt: timestamp + (5 * 60 * 1000) // 5 minutes
  };
}

module.exports = {
  generateToken,
  verifyToken,
  verifyWalletSignature,
  generateChallenge
};
