/**
 * AES-256-GCM encryption for wallet secret keys at rest.
 *
 * The encryption key comes from WALLET_ENCRYPTION_KEY (a base64-encoded 32-byte
 * key). Generate one with:
 *
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Ciphertext format (single base64 string): iv(12) || authTag(16) || ciphertext
 * so the IV and auth tag travel with the payload and we never reuse an IV.
 */
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM
const AUTH_TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.WALLET_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'WALLET_ENCRYPTION_KEY is not set. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `WALLET_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). It must be a base64-encoded 32-byte key.`
    );
  }
  cachedKey = key;
  return cachedKey;
}

/**
 * Encrypt a plaintext string. Returns base64(iv || authTag || ciphertext).
 */
export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new Error('encrypt() expects a string');
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Decrypt a value produced by encrypt(). Returns the original plaintext string.
 */
export function decrypt(payload: string): string {
  if (typeof payload !== 'string') {
    throw new Error('decrypt() expects a base64 string');
  }
  const data = Buffer.from(payload, 'base64');
  if (data.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext is malformed or too short');
  }
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export default { encrypt, decrypt };
