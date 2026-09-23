import { sha256Hex, type PublicJwk } from '@acc/shared';
import type { Env } from '../env.js';
import { base64url, fromBase64url, HttpError } from '../http.js';

/**
 * Execution-node authentication (docs/systems/cloud-control.md §Nodes).
 * A node proves possession of its P-256 key by signing a single-use nonce and
 * receives a short-lived HMAC session bound to node id, key version and
 * protocol. Rotating the key invalidates every older session.
 */

export const SESSION_TTL_MS = 10 * 60_000;
export const CHALLENGE_TTL_MS = 60_000;
export const PAIRING_TTL_MS = 15 * 60_000;

export interface NodeSession {
  nodeId: string;
  keyVersion: number;
  protocolVersion: number;
  expiresAt: number;
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  const secret = env.NODE_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, 'RELAY_NOT_CONFIGURED', 'The relay is not configured (session secret missing).');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function issueSession(env: Env, s: NodeSession): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ n: s.nodeId, k: s.keyVersion, p: s.protocolVersion, e: s.expiresAt })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(`accs1.${payload}`));
  return `accs1.${payload}.${base64url(sig)}`;
}

/** Signature and expiry only; the caller checks the node row (revocation, key version). */
export async function readSession(env: Env, token: string | null): Promise<NodeSession | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'accs1') return null;
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(env), fromBase64url(parts[2]!), new TextEncoder().encode(`accs1.${parts[1]}`));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return null;
  }
  if (!ok) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]!))) as { n: string; k: number; p: number; e: number };
    if (typeof p.n !== 'string' || typeof p.k !== 'number' || typeof p.e !== 'number' || p.e < Date.now()) return null;
    return { nodeId: p.n, keyVersion: p.k, protocolVersion: p.p, expiresAt: p.e };
  } catch {
    return null;
  }
}

export function bearer(request: Request): string | null {
  const h = request.headers.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export async function verifyNodeSignature(publicKey: PublicJwk, message: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('jwk', { ...publicKey, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64url(signature), new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

/** Pairing codes and nonces are stored only as SHA-256. */
export const secretHash = (value: string): Promise<string> => sha256Hex(`acc-cloud:${value}`);

export function newNodeId(): string {
  const buf = new Uint8Array(15);
  crypto.getRandomValues(buf);
  return `node_${base64url(buf)}`;
}
