import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { env } from '../config/env';

// AES-256-GCM at-rest encryption for OAuth/API tokens (connected_accounts.encrypted_token).
// Key: 32 bytes supplied as 64 hex chars in MASTER_ENCRYPTION_KEY. Never log plaintext.

const KEY = Buffer.from(env.masterEncryptionKey, 'hex');
if (KEY.length !== 32) {
  throw new Error('MASTER_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
}

const IV_BYTES = 12; // GCM standard nonce size

/** Returns "iv.tag.ciphertext" (each base64). */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decryptToken(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted token');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final()
  ]).toString('utf8');
}
