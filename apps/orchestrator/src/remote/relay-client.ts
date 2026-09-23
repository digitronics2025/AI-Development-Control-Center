import {
  challengeResponseSchema,
  pairResponseSchema,
  sessionProofMessage,
  sessionResponseSchema,
  REMOTE_PROTOCOL_VERSION,
  type NodeInfo,
  type PublicJwk,
} from '@acc/shared';
import type { z } from 'zod';
import { signWithNodeKey } from './identity.js';

export class RelayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

/** The relay base URL, normalized: https only, except loopback for development and tests. */
export function normalizeRelayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RelayError('Enter the relay address, for example https://acc-relay.example.com', 'INVALID', 400);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new RelayError('The relay address must use https://', 'INVALID', 400);
  }
  if (url.username || url.password || url.search || url.hash) throw new RelayError('The relay address must not carry credentials, a query or a fragment', 'INVALID', 400);
  return url.origin;
}

async function post<S extends z.ZodType>(base: string, path: string, body: unknown, schema: S, bearer?: string): Promise<z.infer<S>> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    throw new RelayError(`The relay is not reachable: ${(error as Error).message}`, 'CLOUD_UNAVAILABLE', 0);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: reported below */
  }
  if (!response.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new RelayError(err?.message ?? `The relay answered ${response.status}`, err?.code ?? 'HTTP_ERROR', response.status);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new RelayError('The relay sent an unexpected answer', 'REMOTE_INVALID', response.status);
  return parsed.data;
}

/** HTTP half of the node protocol: pairing, challenge-response sessions, key rotation. */
export class RelayClient {
  constructor(readonly baseUrl: string) {}

  pair(token: string, publicKey: PublicJwk, info: NodeInfo) {
    return post(this.baseUrl, '/node/v1/pair', { token, publicKey, ...info }, pairResponseSchema);
  }

  /** Prove possession of the key for `nodeId` and receive a short-lived session. */
  async session(nodeId: string, privatePkcs8: string) {
    const { nonce } = await post(this.baseUrl, '/node/v1/challenge', { nodeId }, challengeResponseSchema);
    const signature = await signWithNodeKey(privatePkcs8, sessionProofMessage('session', nodeId, nonce));
    return post(this.baseUrl, '/node/v1/session', { nodeId, nonce, signature, protocolVersion: REMOTE_PROTOCOL_VERSION }, sessionResponseSchema);
  }

  /** Replace the node's key: the new key signs a fresh challenge; the current session authorizes the change. */
  async rotate(nodeId: string, session: string, newPublicKey: PublicJwk, newPrivatePkcs8: string) {
    const { nonce } = await post(this.baseUrl, '/node/v1/challenge', { nodeId }, challengeResponseSchema);
    const signature = await signWithNodeKey(newPrivatePkcs8, sessionProofMessage('rotate', nodeId, nonce));
    return post(this.baseUrl, '/node/v1/rotate', { nonce, publicKey: newPublicKey, signature }, pairResponseSchema, session);
  }

  /** Upload an artifact or log chunk; R2 verifies the SHA-256 on write. */
  async upload(path: string, session: string, body: Buffer, sha256: string, contentType: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${session}`, 'content-type': contentType, 'x-acc-sha256': sha256, 'content-length': String(body.length) },
        body,
        signal: AbortSignal.timeout(120_000),
        redirect: 'error',
      });
    } catch (error) {
      throw new RelayError(`Upload failed: ${(error as Error).message}`, 'CLOUD_UNAVAILABLE', 0);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = `Upload refused (${response.status})`;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        /* keep the status message */
      }
      throw new RelayError(message, 'UPLOAD_FAILED', response.status);
    }
  }
}
