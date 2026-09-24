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

export type BridgeErrorCode = 'MALFORMED' | 'WRONG_SESSION' | 'WRONG_DIRECTION' | 'REPLAY' | 'OUT_OF_ORDER' | 'TOO_LARGE' | 'INVALID_CIPHERTEXT' | 'INVALID_KEY' | 'CLOSED' | 'UNTRUSTED_SENDER' | 'WRONG_KEY';

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
 * The Control Center's long-term identity. The orchestrator signs every
 * session's transcript — the session id and both ephemeral keys — with one
 * ECDSA P-256 key, and MyVault pins that key per Control Center address. The
 * bridge page relays the signature but cannot make one, so neither a script in
 * that page nor a program answering on the loopback port can complete a
 * handshake MyVault accepts.
 */
const IDENTITY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const IDENTITY_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export function identityTranscript(input: { sessionId: string; myvaultPublicKey: string; controlCenterPublicKey: string }): Uint8Array {
  return encoder.encode(`${BRIDGE_PROTOCOL} identity\n${input.sessionId}\n${input.myvaultPublicKey}\n${input.controlCenterPublicKey}`);
}

/** The raw 64-byte signature Web Crypto verifies, base64url. */
export async function signBridgeIdentity(privateKey: CryptoKey, input: { sessionId: string; myvaultPublicKey: string; controlCenterPublicKey: string }): Promise<string> {
  return toBase64Url(new Uint8Array(await subtle.sign(IDENTITY_SIGN, privateKey, identityTranscript(input))));
}

/** False for anything that is not a valid signature by `identityKey` over this session — never throws. */
export async function verifyBridgeIdentity(input: { identityKey: string; signature: string; sessionId: string; myvaultPublicKey: string; controlCenterPublicKey: string }): Promise<boolean> {
  try {
    const raw = fromBase64Url(input.identityKey);
    const signature = fromBase64Url(input.signature);
    if (raw.length !== 65 || raw[0] !== 4 || signature.length !== 64) return false;
    const key = await subtle.importKey('raw', raw, IDENTITY_ALGORITHM, false, ['verify']);
    return await subtle.verify(IDENTITY_SIGN, key, signature, identityTranscript(input));
  } catch {
    return false;
  }
}

/** 128 bits of SHA-256 over the raw identity key, as eight groups of four hex characters: what a person compares. */
export async function identityFingerprint(identityKey: string): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', fromBase64Url(identityKey)));
  const hex = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{4}/g)!.join(' ');
}

/**
 * `mvcc-deposit-v1` — a secret the Control Center leaves in MyVault's delivery
 * box (its Worker) while no bridge session is open. Sealed to MyVault's
 * long-term delivery key and signed with the Control Center's identity key:
 *
 *  - ECDH P-256 between a fresh ephemeral key and the delivery key; HKDF-SHA-256
 *    salted with a hash of the protocol id, deposit id, vault id and both public
 *    keys → one AES-256-GCM key; a fresh 96-bit IV; AAD binds protocol, deposit
 *    id, vault id and delivery key id.
 *  - ECDSA P-256 / SHA-256 by the identity key over every field, so MyVault
 *    opens only what a Control Center it pinned sent, and nothing can be moved
 *    between deposits, vaults or keys.
 *
 * The Worker stores it and can read none of it.
 */
export const DEPOSIT_PROTOCOL = 'mvcc-deposit-v1';
export const DEPOSIT_LIMITS = { sealedChars: 60_000 } as const;
const DEPOSIT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;

export interface SealedDeposit {
  v: typeof DEPOSIT_PROTOCOL;
  id: string;
  vaultId: string;
  keyId: string;
  epk: string;
  iv: string;
  ct: string;
  identityKey: string;
  sig: string;
}

/** What a deposit carries: one generated secret, as a bridge push would. */
export interface DepositBody {
  ccId: string;
  name: string;
  kind: string;
  envVar: string | null;
  description: string;
  value: string;
  fingerprint: string;
  createdAt: string;
}

/** The first 16 hex characters of SHA-256 over the raw delivery key. */
export async function depositKeyId(publicKey: string): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', fromBase64Url(publicKey)));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A delivery key pair to keep: the private half comes back as a JWK for storage inside the vault. */
export async function generateDepositKeyPair(): Promise<{ privateJwk: webcrypto.JsonWebKey; publicKey: string }> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as webcrypto.CryptoKeyPair;
  return { privateJwk: await subtle.exportKey('jwk', pair.privateKey), publicKey: toBase64Url(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))) };
}

export async function importDepositPrivateKey(jwk: webcrypto.JsonWebKey): Promise<CryptoKey> {
  try {
    return await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } catch {
    throw new BridgeProtocolError('INVALID_KEY', 'The delivery key is not valid');
  }
}

function depositSigned(d: Omit<SealedDeposit, 'sig'>): Uint8Array {
  return encoder.encode(`${DEPOSIT_PROTOCOL} signed\n${d.id}\n${d.vaultId}\n${d.keyId}\n${d.epk}\n${d.iv}\n${d.ct}\n${d.identityKey}`);
}

async function depositKey(shared: ArrayBuffer, id: string, vaultId: string, recipientPublicKey: string, epk: string): Promise<CryptoKey> {
  const salt = await subtle.digest('SHA-256', encoder.encode(`${DEPOSIT_PROTOCOL}\n${id}\n${vaultId}\n${recipientPublicKey}\n${epk}`));
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`${DEPOSIT_PROTOCOL} key`) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function depositAad(id: string, vaultId: string, keyId: string): Uint8Array {
  return encoder.encode(`${DEPOSIT_PROTOCOL}\n${id}\n${vaultId}\n${keyId}`);
}

/**
 * Seal one secret for MyVault. `ephemeralPrivateKey` and `iv` exist for the
 * test vectors only; a real deposit always draws fresh ones.
 */
export async function sealDeposit(input: {
  id: string;
  vaultId: string;
  recipientPublicKey: string;
  identity: { signingKey: CryptoKey; publicKey: string };
  body: DepositBody;
  ephemeral?: { privateKey: CryptoKey; publicKey: string };
  iv?: Uint8Array;
}): Promise<SealedDeposit> {
  if (!DEPOSIT_ID.test(input.id)) throw new BridgeProtocolError('MALFORMED', 'Invalid deposit id');
  const recipient = await importPeerKey(input.recipientPublicKey);
  const eph = input.ephemeral ?? (await generateBridgeKeyPair());
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256);
  const key = await depositKey(shared, input.id, input.vaultId, input.recipientPublicKey, eph.publicKey);
  const keyId = await depositKeyId(input.recipientPublicKey);
  const nonce = input.iv ?? globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: depositAad(input.id, input.vaultId, keyId) }, key, encoder.encode(JSON.stringify(input.body))));
  const unsigned = { v: DEPOSIT_PROTOCOL, id: input.id, vaultId: input.vaultId, keyId, epk: eph.publicKey, iv: toBase64Url(nonce), ct: toBase64Url(ct), identityKey: input.identity.publicKey } as const;
  const sig = toBase64Url(new Uint8Array(await subtle.sign(IDENTITY_SIGN, input.identity.signingKey, depositSigned(unsigned))));
  const sealed = { ...unsigned, sig };
  if (JSON.stringify(sealed).length > DEPOSIT_LIMITS.sealedChars) throw new BridgeProtocolError('TOO_LARGE', 'The deposit is too large');
  return sealed;
}

export function parseDeposit(value: unknown): SealedDeposit {
  const d = value as Partial<SealedDeposit> | null;
  if (!d || typeof d !== 'object' || d.v !== DEPOSIT_PROTOCOL) throw new BridgeProtocolError('MALFORMED', 'Not a deposit');
  const text = (x: unknown, max: number) => typeof x === 'string' && x.length > 0 && x.length <= max && B64URL.test(x);
  if (typeof d.id !== 'string' || !DEPOSIT_ID.test(d.id)) throw new BridgeProtocolError('MALFORMED', 'Invalid deposit id');
  if (typeof d.vaultId !== 'string' || !/^[\w-]{1,128}$/.test(d.vaultId)) throw new BridgeProtocolError('MALFORMED', 'Invalid vault id');
  if (typeof d.keyId !== 'string' || !KEY_ID.test(d.keyId)) throw new BridgeProtocolError('MALFORMED', 'Invalid key id');
  if (!text(d.epk, 200) || !text(d.identityKey, 200) || !text(d.sig, 200) || !text(d.iv, 16) || d.iv!.length !== 16 || !text(d.ct, DEPOSIT_LIMITS.sealedChars)) {
    throw new BridgeProtocolError('MALFORMED', 'Invalid deposit fields');
  }
  return { v: DEPOSIT_PROTOCOL, id: d.id, vaultId: d.vaultId, keyId: d.keyId, epk: d.epk!, iv: d.iv!, ct: d.ct!, identityKey: d.identityKey!, sig: d.sig! };
}

/**
 * Open a deposit: only one signed by a trusted identity key, sealed for this
 * vault and this delivery key. Every failure is a BridgeProtocolError.
 */
export async function openDeposit(input: { deposit: unknown; vaultId: string; recipient: { privateKey: CryptoKey; publicKey: string }; trustedIdentityKeys: readonly string[] }): Promise<DepositBody> {
  const d = parseDeposit(input.deposit);
  if (!input.trustedIdentityKeys.includes(d.identityKey)) throw new BridgeProtocolError('UNTRUSTED_SENDER', 'The deposit was not sent by a trusted Control Center');
  let signed: boolean;
  try {
    const verifyKey = await subtle.importKey('raw', fromBase64Url(d.identityKey), IDENTITY_ALGORITHM, false, ['verify']);
    const { sig, ...unsigned } = d;
    signed = await subtle.verify(IDENTITY_SIGN, verifyKey, fromBase64Url(sig), depositSigned(unsigned));
  } catch {
    signed = false;
  }
  if (!signed) throw new BridgeProtocolError('UNTRUSTED_SENDER', 'The deposit signature is not valid');
  if (d.vaultId !== input.vaultId) throw new BridgeProtocolError('WRONG_KEY', 'The deposit is for another vault');
  if (d.keyId !== (await depositKeyId(input.recipient.publicKey))) throw new BridgeProtocolError('WRONG_KEY', 'The deposit is sealed to another delivery key');
  const eph = await importPeerKey(d.epk);
  let body: unknown;
  try {
    const shared = await subtle.deriveBits({ name: 'ECDH', public: eph }, input.recipient.privateKey, 256);
    const key = await depositKey(shared, d.id, d.vaultId, input.recipient.publicKey, d.epk);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(d.iv), additionalData: depositAad(d.id, d.vaultId, d.keyId) }, key, fromBase64Url(d.ct));
    body = JSON.parse(decoder.decode(plain));
  } catch {
    throw new BridgeProtocolError('INVALID_CIPHERTEXT', 'The deposit could not be opened');
  }
  const b = body as Partial<DepositBody> | null;
  if (!b || typeof b.ccId !== 'string' || typeof b.name !== 'string' || typeof b.value !== 'string' || typeof b.fingerprint !== 'string') {
    throw new BridgeProtocolError('MALFORMED', 'The deposit body is not a secret');
  }
  return { ccId: b.ccId, name: b.name, kind: typeof b.kind === 'string' ? b.kind : 'other', envVar: typeof b.envVar === 'string' ? b.envVar : null, description: typeof b.description === 'string' ? b.description : '', value: b.value, fingerprint: b.fingerprint, createdAt: typeof b.createdAt === 'string' ? b.createdAt : '' };
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
