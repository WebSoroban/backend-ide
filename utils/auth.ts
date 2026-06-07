import jwt, { type SignOptions } from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';

const JWT_SECRET = process.env.JWT_SECRET as string;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

export interface JwtUserPayload {
  userId: string;
  email: string | null;
  walletAddress?: string | null;
  plan: string;
  iat?: number;
  exp?: number;
}

interface TokenUser {
  id: string;
  email?: string | null;
  walletAddress?: string | null;
  subscription?: any;
}

/**
 * Generate JWT token for user
 */
export function generateToken(user: TokenUser): string {
  const payload = {
    userId: user.id,
    email: user.email,
    walletAddress: user.walletAddress,
    plan: user.subscription?.plan || 'free'
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN
  } as SignOptions);
}

/**
 * Verify JWT token
 */
export function verifyToken(token: string): JwtUserPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtUserPayload;
  } catch (error) {
    return null;
  }
}

/**
 * Verify wallet signature
 * User signs a message with their wallet, we verify it matches their wallet address
 */
export function verifyWalletSignature(
  message: string,
  signature: string,
  walletAddress: string
): boolean {
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
export function generateChallenge(walletAddress: string): {
  message: string;
  timestamp: number;
  expiresAt: number;
} {
  const timestamp = Date.now();
  const message = `WebSoroban Authentication\nWallet: ${walletAddress}\nTimestamp: ${timestamp}\nNonce: ${Math.random().toString(36).substring(7)}`;
  return {
    message,
    timestamp,
    expiresAt: timestamp + 5 * 60 * 1000 // 5 minutes
  };
}

export default {
  generateToken,
  verifyToken,
  verifyWalletSignature,
  generateChallenge
};
