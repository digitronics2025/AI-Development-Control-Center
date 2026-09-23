import { webcrypto } from 'node:crypto';
import type { PublicJwk } from '@acc/shared';

/**
 * The node's signing identity (docs/systems/remote-node.md): a P-256 key
 * pair generated on this machine. The public half is registered with the
 * cloud at pairing; the private half is sealed with the DPAPI-protected
 * credential key and never leaves this process unsealed.
 */
export interface NodeKeyPair {
  publicKey: PublicJwk;
  /** PKCS#8, base64 — only ever handed to the sealer. */
  privatePkcs8: string;
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export async function generateNodeKeyPair(): Promise<NodeKeyPair> {
  const pair = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  return { publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! }, privatePkcs8: pkcs8 };
}

/** Sign with the unsealed private key; the signature is the raw 64-byte form Web Crypto verifies, base64url. */
export async function signWithNodeKey(privatePkcs8: string, message: string): Promise<string> {
  const key = await webcrypto.subtle.importKey('pkcs8', Buffer.from(privatePkcs8, 'base64'), ALGORITHM, false, ['sign']);
  const signature = await webcrypto.subtle.sign(SIGN, key, new TextEncoder().encode(message));
  return Buffer.from(signature).toString('base64url');
}
