import type { webcrypto } from 'node:crypto';

/**
 * `mvcc-bridge-v1` — the sealed channel between an unlocked MyVault tab and
 * this orchestrator (docs/systems/credential-broker.md, "MyVault bridge").
 *
 * The Control Center bridge page relays these envelopes between the two ends
 * and never holds a key, so a value crosses the browser only as ciphertext.
 * Web Crypto only, so MyVault runs the same code in the browser
 * (`src/integrations/controlCenter/protocol.ts` there); the committed vectors
 * pin both implementations to the same bytes.
 *
 *  - ECDH P-256, one ephemeral key pair per side per session.
 *  - HKDF-SHA-256 over the shared secret, salted with a hash of the protocol
 *    id, the session id and both public keys, derives one AES-256-GCM key per
 *    direction and a short code both screens show.
 *  - Every message: a fresh 96-bit IV; AAD binds protocol, session,
 *    direction, sequence number and message type; sequence numbers start at 1
 *    and must be exactly one more than the last accepted message.
 */

type CryptoKey = webcrypto.CryptoKey;

export const BRIDGE_PROTOCOL = 'mvcc-bridge-v1';
export type BridgeRole = 'myvault' | 'control-center';
export type BridgeDirection = 'mv2cc' | 'cc2mv';

export const BRIDGE_LIMITS = {
  /** Characters of base64url ciphertext in one envelope. */
  envelopeChars: 400_000,
  /** Bytes of JSON inside one envelope. */
  plaintextBytes: 256 * 1024,
  /** Shared items in one snapshot part, and in one session. */
  itemsPerPart: 50,
  itemsPerSession: 500,
  /** A credential value, as the broker accepts it. */
  valueChars: 20_000,
} as const;

export type BridgeErrorCode = 'MALFORMED' | 'WRONG_SESSION' | 'WRONG_DIRECTION' | 'REPLAY' | 'OUT_OF_ORDER' | 'TOO_LARGE' | 'INVALID_CIPHERTEXT' | 'INVALID_KEY' | 'CLOSED';

export class BridgeProtocolError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SealedEnvelope {
  v: typeof BRIDGE_PROTOCOL;
  sid: string;
  dir: BridgeDirection;
  seq: number;
  type: string;
  iv: string;
  ct: string;
}

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const B64URL = /^[A-Za-z0-9_-]*$/;
const TYPE = /^[a-z][a-z.]{0,40}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!B64URL.test(text)) throw new BridgeProtocolError('MALFORMED', 'Not base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** The first 8 hex characters of SHA-256: the same short fingerprint the broker shows. */
export async function valueFingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newSessionId(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(18)));
}

/** A fresh key pair; the private key is not extractable and lives only in memory. */
export async function generateBridgeKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as webcrypto.CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: toBase64Url(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))) };
}

async function importPeerKey(publicKey: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(publicKey);
  } catch {
    throw new BridgeProtocolError('INVALID_KEY', 'The peer public key is not valid');
  }
  // Uncompressed P-256 point only; importKey rejects a point that is not on the curve.
  if (raw.length !== 65 || raw[0] !== 4) throw new BridgeProtocolError('INVALID_KEY', 'The peer public key is not valid');
  try {
    return await subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    throw new BridgeProtocolError('INVALID_KEY', 'The peer public key is not valid');
  }
}

function aad(sid: string, dir: BridgeDirection, seq: number, type: string): Uint8Array {
  return encoder.encode(`${BRIDGE_PROTOCOL}\n${sid}\n${dir}\n${seq}\n${type}`);
}

/**
 * One end of a session. `seal` numbers outgoing messages; `open` accepts only
 * the next incoming number, and only after the ciphertext authenticates, so a
 * forged or replayed envelope can never move the counter.
 */
export class BridgeChannel {
  private sent = 0;
  private received = 0;
  private keys: { send: CryptoKey; receive: CryptoKey } | null;

  constructor(
    readonly sessionId: string,
    readonly role: BridgeRole,
    keys: { send: CryptoKey; receive: CryptoKey },
    /** Eight hex characters as `XXXX-XXXX`, identical on both ends of a genuine session. */
    readonly code: string,
  ) {
    this.keys = keys;
  }

  get sendDirection(): BridgeDirection {
    return this.role === 'myvault' ? 'mv2cc' : 'cc2mv';
  }

  get receiveDirection(): BridgeDirection {
    return this.role === 'myvault' ? 'cc2mv' : 'mv2cc';
  }

  get closed(): boolean {
    return this.keys === null;
  }

  /** Forget the keys; every later seal or open fails. */
  destroy(): void {
    this.keys = null;
  }

  /** `iv` exists for the test vectors only; real messages always draw a fresh one. */
  async seal(type: string, body: unknown, iv?: Uint8Array): Promise<SealedEnvelope> {
    if (!this.keys) throw new BridgeProtocolError('CLOSED', 'The session is closed');
    if (!TYPE.test(type)) throw new BridgeProtocolError('MALFORMED', 'Invalid message type');
    const plaintext = encoder.encode(JSON.stringify(body ?? {}));
    if (plaintext.length > BRIDGE_LIMITS.plaintextBytes) throw new BridgeProtocolError('TOO_LARGE', 'The message is too large');
    const nonce = iv ?? globalThis.crypto.getRandomValues(new Uint8Array(12));
    const seq = this.sent + 1;
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(this.sessionId, this.sendDirection, seq, type) }, this.keys.send, plaintext));
    this.sent = seq;
    return { v: BRIDGE_PROTOCOL, sid: this.sessionId, dir: this.sendDirection, seq, type, iv: toBase64Url(nonce), ct: toBase64Url(ct) };
  }

  async open(envelope: unknown): Promise<{ type: string; body: unknown }> {
    if (!this.keys) throw new BridgeProtocolError('CLOSED', 'The session is closed');
    const e = parseEnvelope(envelope);
    if (e.sid !== this.sessionId) throw new BridgeProtocolError('WRONG_SESSION', 'The message belongs to another session');
    if (e.dir !== this.receiveDirection) throw new BridgeProtocolError('WRONG_DIRECTION', 'The message travels the wrong way');
    if (e.seq <= this.received) throw new BridgeProtocolError('REPLAY', 'The message was already received');
    if (e.seq !== this.received + 1) throw new BridgeProtocolError('OUT_OF_ORDER', 'A message is missing before this one');
    // Claimed before the first await, so two copies arriving together cannot both
    // pass the check; given back only if this one fails to authenticate.
    const previous = this.received;
    this.received = e.seq;
    let plaintext: Uint8Array;
    try {
      const iv = fromBase64Url(e.iv);
      if (iv.length !== 12) throw new Error('iv');
      plaintext = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(e.sid, e.dir, e.seq, e.type) }, this.keys.receive, fromBase64Url(e.ct)));
    } catch {
      this.received = previous;
      throw new BridgeProtocolError('INVALID_CIPHERTEXT', 'The message could not be authenticated');
    }
    if (plaintext.length > BRIDGE_LIMITS.plaintextBytes) throw new BridgeProtocolError('TOO_LARGE', 'The message is too large');
    let body: unknown;
    try {
      body = JSON.parse(decoder.decode(plaintext));
    } catch {
      throw new BridgeProtocolError('MALFORMED', 'The message is not JSON');
    }
    return { type: e.type, body };
  }
}

export function parseEnvelope(value: unknown): SealedEnvelope {
  const e = value as Partial<SealedEnvelope> | null;
  if (!e || typeof e !== 'object') throw new BridgeProtocolError('MALFORMED', 'Not an envelope');
  if (e.v !== BRIDGE_PROTOCOL) throw new BridgeProtocolError('MALFORMED', 'Unknown protocol version');
  if (typeof e.sid !== 'string' || !SESSION_ID.test(e.sid)) throw new BridgeProtocolError('MALFORMED', 'Invalid session id');
  if (e.dir !== 'mv2cc' && e.dir !== 'cc2mv') throw new BridgeProtocolError('MALFORMED', 'Invalid direction');
  if (typeof e.seq !== 'number' || !Number.isSafeInteger(e.seq) || e.seq < 1) throw new BridgeProtocolError('MALFORMED', 'Invalid sequence number');
  if (typeof e.type !== 'string' || !TYPE.test(e.type)) throw new BridgeProtocolError('MALFORMED', 'Invalid message type');
  if (typeof e.iv !== 'string' || e.iv.length !== 16 || !B64URL.test(e.iv)) throw new BridgeProtocolError('MALFORMED', 'Invalid IV');
  if (typeof e.ct !== 'string' || !B64URL.test(e.ct)) throw new BridgeProtocolError('MALFORMED', 'Invalid ciphertext');
  if (e.ct.length > BRIDGE_LIMITS.envelopeChars) throw new BridgeProtocolError('TOO_LARGE', 'The message is too large');
  return { v: e.v, sid: e.sid, dir: e.dir, seq: e.seq, type: e.type, iv: e.iv, ct: e.ct };
}

/**
 * Derive this end's channel. Both ends pass the same session id and the two
 * public keys by role, so the salt — and so every key — is the same only
 * when both saw the same keys.
 */
export async function deriveBridgeChannel(input: { role: BridgeRole; sessionId: string; privateKey: CryptoKey; myvaultPublicKey: string; controlCenterPublicKey: string }): Promise<BridgeChannel> {
  if (!SESSION_ID.test(input.sessionId)) throw new BridgeProtocolError('MALFORMED', 'Invalid session id');
  const peer = await importPeerKey(input.role === 'myvault' ? input.controlCenterPublicKey : input.myvaultPublicKey);
  // Our own key is checked too: a malformed value here is a caller bug, not a peer attack.
  await importPeerKey(input.role === 'myvault' ? input.myvaultPublicKey : input.controlCenterPublicKey);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer }, input.privateKey, 256);
  const salt = await subtle.digest('SHA-256', encoder.encode(`${BRIDGE_PROTOCOL}\n${input.sessionId}\n${input.myvaultPublicKey}\n${input.controlCenterPublicKey}`));
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const directionKey = (label: string) =>
    subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`${BRIDGE_PROTOCOL} ${label}`) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const toControlCenter = await directionKey('myvault->control-center');
  const toMyVault = await directionKey('control-center->myvault');
  const codeBits = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`${BRIDGE_PROTOCOL} code`) }, ikm, 32));
  const hex = Array.from(codeBits, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const keys = input.role === 'myvault' ? { send: toControlCenter, receive: toMyVault } : { send: toMyVault, receive: toControlCenter };
  return new BridgeChannel(input.sessionId, input.role, keys, `${hex.slice(0, 4)}-${hex.slice(4)}`);
}
