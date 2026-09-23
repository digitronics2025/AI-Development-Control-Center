import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for credentials the broker stores (V2 plan §2).
 * AES-256-GCM with a fresh 96-bit nonce per value; the credential's id is
 * bound as additional data so a ciphertext cannot be moved to another row.
 * Where the key comes from (DPAPI on Windows) is the caller's concern.
 */

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

const ALGORITHM = 'aes-256-gcm';

export function newCredentialKey(): Buffer {
  return randomBytes(32);
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('Credential key must be 32 bytes');
}

export function sealSecret(key: Buffer, plaintext: string, boundTo: string): SealedSecret {
  assertKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(boundTo, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function openSecret(key: Buffer, sealed: SealedSecret, boundTo: string): string {
  assertKey(key);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(boundTo, 'utf8'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** Short, non-reversible identifier shown in the UI so a user can tell two values apart. */
export function secretFingerprint(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(0, 8);
}
