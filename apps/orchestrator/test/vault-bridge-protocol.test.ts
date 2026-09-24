import { readFileSync } from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_LIMITS,
  BridgeProtocolError,
  depositKeyId,
  deriveBridgeChannel,
  fromBase64Url,
  generateBridgeKeyPair,
  generateDepositKeyPair,
  identityFingerprint,
  importDepositPrivateKey,
  newSessionId,
  openDeposit,
  sealDeposit,
  signBridgeIdentity,
  toBase64Url,
  valueFingerprint,
  verifyBridgeIdentity,
  type BridgeChannel,
  type SealedEnvelope,
} from '../src/tools/vault-bridge-protocol.js';
import { secretFingerprint } from '@acc/security';

/**
 * mvcc-bridge-v1 (docs/systems/credential-broker.md, "MyVault bridge"). The
 * vectors file is committed byte-for-byte in MyVault too
 * (src/integrations/controlCenter/mvcc-bridge-v1.vectors.json); both test
 * suites must reproduce every envelope exactly, which is what makes the two
 * implementations interoperable.
 */

const vectors = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'mvcc-bridge-v1.vectors.json'), 'utf8'));
const subtle = webcrypto.subtle;
const importPrivate = (jwk: webcrypto.JsonWebKey) => subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

async function vectorChannels(): Promise<{ mv: BridgeChannel; cc: BridgeChannel }> {
  const common = { sessionId: vectors.sessionId, myvaultPublicKey: vectors.myvault.publicKey, controlCenterPublicKey: vectors.controlCenter.publicKey };
  return {
    mv: await deriveBridgeChannel({ ...common, role: 'myvault', privateKey: await importPrivate(vectors.myvault.privateJwk) }),
    cc: await deriveBridgeChannel({ ...common, role: 'control-center', privateKey: await importPrivate(vectors.controlCenter.privateJwk) }),
  };
}

async function livePair(): Promise<{ mv: BridgeChannel; cc: BridgeChannel }> {
  const a = await generateBridgeKeyPair();
  const b = await generateBridgeKeyPair();
  const sessionId = newSessionId();
  const common = { sessionId, myvaultPublicKey: a.publicKey, controlCenterPublicKey: b.publicKey };
  return { mv: await deriveBridgeChannel({ ...common, role: 'myvault', privateKey: a.privateKey }), cc: await deriveBridgeChannel({ ...common, role: 'control-center', privateKey: b.privateKey }) };
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(BridgeProtocolError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('mvcc-bridge-v1 vectors', () => {
  it('derives the same session code on both ends', async () => {
    const { mv, cc } = await vectorChannels();
    expect(mv.code).toBe(vectors.code);
    expect(cc.code).toBe(vectors.code);
  });

  it('reproduces every envelope byte for byte and opens it on the other end', async () => {
    const { mv, cc } = await vectorChannels();
    const [fromVault, fromCc] = vectors.messages;
    const sealedByVault = await mv.seal(fromVault.type, fromVault.body, fromBase64Url(fromVault.iv));
    expect(sealedByVault).toEqual(fromVault.envelope);
    expect(await cc.open(fromVault.envelope)).toEqual({ type: fromVault.type, body: fromVault.body });
    const sealedByCc = await cc.seal(fromCc.type, fromCc.body, fromBase64Url(fromCc.iv));
    expect(sealedByCc).toEqual(fromCc.envelope);
    expect(await mv.open(fromCc.envelope)).toEqual({ type: fromCc.type, body: fromCc.body });
  });

  it('computes the broker fingerprint with Web Crypto', async () => {
    for (const [value, fp] of Object.entries(vectors.fingerprints)) {
      expect(await valueFingerprint(value)).toBe(fp);
      expect(secretFingerprint(value)).toBe(fp);
    }
  });
});

describe('mvcc-bridge-v1 Control Center identity', () => {
  const session = { sessionId: vectors.sessionId, myvaultPublicKey: vectors.myvault.publicKey, controlCenterPublicKey: vectors.controlCenter.publicKey };
  const signed = { ...session, identityKey: vectors.identity.publicKey, signature: vectors.identity.signature };

  it('verifies the vector signature and reproduces the fingerprint', async () => {
    expect(await verifyBridgeIdentity(signed)).toBe(true);
    expect(await identityFingerprint(vectors.identity.publicKey)).toBe(vectors.identity.fingerprint);
  });

  it('signs a session that verifies, and nothing else does', async () => {
    const key = await subtle.importKey('jwk', vectors.identity.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const signature = await signBridgeIdentity(key, session);
    expect(await verifyBridgeIdentity({ ...signed, signature })).toBe(true);
    const other = await generateBridgeKeyPair();
    // Every transcript field is bound: another session id, either ephemeral key.
    expect(await verifyBridgeIdentity({ ...signed, sessionId: newSessionId() })).toBe(false);
    expect(await verifyBridgeIdentity({ ...signed, myvaultPublicKey: other.publicKey })).toBe(false);
    expect(await verifyBridgeIdentity({ ...signed, controlCenterPublicKey: other.publicKey })).toBe(false);
    // Another identity key cannot claim the signature.
    const stranger = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as webcrypto.CryptoKeyPair;
    expect(await verifyBridgeIdentity({ ...signed, identityKey: toBase64Url(new Uint8Array(await subtle.exportKey('raw', stranger.publicKey))) })).toBe(false);
  });

  it('returns false rather than throwing for malformed identity input', async () => {
    const flipped = fromBase64Url(vectors.identity.signature);
    flipped[10] = flipped[10]! ^ 1;
    for (const broken of [{ signature: toBase64Url(flipped) }, { signature: '' }, { signature: 'not base64!' }, { identityKey: '' }, { identityKey: toBase64Url(new Uint8Array(65)) }, { identityKey: vectors.controlCenter.publicKey.slice(0, 40) }]) {
      expect(await verifyBridgeIdentity({ ...signed, ...broken })).toBe(false);
    }
  });
});

describe('mvcc-deposit-v1 delivery box', () => {
  const dv = vectors.deposit;
  const recipient = async () => ({ privateKey: await importDepositPrivateKey(dv.recipient.privateJwk), publicKey: dv.recipient.publicKey });
  const identitySigner = async () => ({ signingKey: await subtle.importKey('jwk', vectors.identity.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']), publicKey: vectors.identity.publicKey });

  it('reproduces the vector ciphertext and opens the committed deposit', async () => {
    const eph = { privateKey: await subtle.importKey('jwk', dv.ephemeral.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']), publicKey: dv.ephemeral.publicKey };
    const sealed = await sealDeposit({ id: dv.id, vaultId: dv.vaultId, recipientPublicKey: dv.recipient.publicKey, identity: await identitySigner(), body: dv.body, ephemeral: eph, iv: fromBase64Url(dv.iv) });
    const { sig, ...rest } = sealed;
    const { sig: vectorSig, ...vectorRest } = dv.sealed;
    expect(rest).toEqual(vectorRest);
    expect(sig).not.toBe(vectorSig); // ECDSA is randomized; both verify.
    expect(await depositKeyId(dv.recipient.publicKey)).toBe(dv.recipient.keyId);
    for (const deposit of [dv.sealed, sealed]) {
      expect(await openDeposit({ deposit, vaultId: dv.vaultId, recipient: await recipient(), trustedIdentityKeys: [vectors.identity.publicKey] })).toEqual(dv.body);
    }
  });

  it('opens only what a trusted Control Center sealed for this vault and key', async () => {
    const r = await recipient();
    const open = (deposit: unknown, over: Partial<{ vaultId: string; trustedIdentityKeys: string[]; recipient: typeof r }> = {}) =>
      openDeposit({ deposit, vaultId: dv.vaultId, recipient: r, trustedIdentityKeys: [vectors.identity.publicKey], ...over });
    await rejects(open(dv.sealed, { trustedIdentityKeys: [] }), 'UNTRUSTED_SENDER');
    const flipped = fromBase64Url(dv.sealed.ct);
    flipped[3] = flipped[3]! ^ 1;
    // Every field is signed: a changed ciphertext, IV or key id fails the signature before anything is decrypted.
    await rejects(open({ ...dv.sealed, ct: toBase64Url(flipped) }), 'UNTRUSTED_SENDER');
    await rejects(open({ ...dv.sealed, keyId: '0000000000000000' }), 'UNTRUSTED_SENDER');
    await rejects(open(dv.sealed, { vaultId: 'another-vault-00000001' }), 'WRONG_KEY');
    const other = await generateDepositKeyPair();
    await rejects(open(dv.sealed, { recipient: { privateKey: await importDepositPrivateKey(other.privateJwk), publicKey: other.publicKey } }), 'WRONG_KEY');
    for (const broken of [null, { ...dv.sealed, v: 'mvcc-deposit-v0' }, { ...dv.sealed, id: 'short' }, { ...dv.sealed, iv: 'AAAA' }]) await rejects(open(broken), 'MALFORMED');
    // A stranger's key signing honestly is still not a trusted sender.
    const stranger = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const strangerKey = toBase64Url(new Uint8Array(await subtle.exportKey('raw', stranger.publicKey)));
    const forged = await sealDeposit({ id: newSessionId(), vaultId: dv.vaultId, recipientPublicKey: dv.recipient.publicKey, identity: { signingKey: stranger.privateKey, publicKey: strangerKey }, body: dv.body });
    await rejects(open(forged), 'UNTRUSTED_SENDER');
    await expect(open(forged, { trustedIdentityKeys: [strangerKey] })).resolves.toEqual(dv.body);
  });
});

describe('mvcc-bridge-v1 fails closed', () => {
  it('round-trips live keys in both directions with fresh IVs', async () => {
    const { mv, cc } = await livePair();
    expect(mv.code).toBe(cc.code);
    const a = await mv.seal('sync.start', {});
    const b = await mv.seal('sync.start', {});
    expect(a.iv).not.toBe(b.iv);
    expect(await cc.open(a)).toEqual({ type: 'sync.start', body: {} });
    expect(await cc.open(b)).toEqual({ type: 'sync.start', body: {} });
    expect(await mv.open(await cc.seal('snapshot.request', { x: 1 }))).toEqual({ type: 'snapshot.request', body: { x: 1 } });
  });

  it('rejects a replay, a duplicate and a skipped sequence number', async () => {
    const { mv, cc } = await livePair();
    const first = await mv.seal('sync.start', {});
    await cc.open(first);
    await rejects(cc.open(first), 'REPLAY');
    const second = await mv.seal('bye', {});
    const third = await mv.seal('bye', {});
    await rejects(cc.open(third), 'OUT_OF_ORDER');
    expect((await cc.open(second)).type).toBe('bye');
    expect((await cc.open(third)).type).toBe('bye');
  });

  it('binds session, direction, sequence and type into the ciphertext', async () => {
    const { mv, cc } = await livePair();
    const e = await mv.seal('sync.start', {});
    await rejects(cc.open({ ...e, type: 'bye' }), 'INVALID_CIPHERTEXT');
    await rejects(cc.open({ ...e, sid: newSessionId() }), 'WRONG_SESSION');
    await rejects(cc.open({ ...e, dir: 'cc2mv' }), 'WRONG_DIRECTION');
    // The forged copies did not advance the counter: the genuine message still opens.
    expect((await cc.open(e)).type).toBe('sync.start');
    const next = await mv.seal('bye', {});
    const flipped = fromBase64Url(next.ct);
    flipped[0] = flipped[0]! ^ 1;
    await rejects(cc.open({ ...next, ct: toBase64Url(flipped) }), 'INVALID_CIPHERTEXT');
    await rejects(cc.open({ ...next, iv: toBase64Url(new Uint8Array(12)) }), 'INVALID_CIPHERTEXT');
  });

  it('does not open a message sealed for another session with the same peer keys', async () => {
    const a = await generateBridgeKeyPair();
    const b = await generateBridgeKeyPair();
    const one = await deriveBridgeChannel({ role: 'myvault', sessionId: newSessionId(), privateKey: a.privateKey, myvaultPublicKey: a.publicKey, controlCenterPublicKey: b.publicKey });
    const sid = newSessionId();
    const other = await deriveBridgeChannel({ role: 'control-center', sessionId: sid, privateKey: b.privateKey, myvaultPublicKey: a.publicKey, controlCenterPublicKey: b.publicKey });
    const e = await one.seal('sync.start', {});
    await rejects(other.open({ ...e, sid }), 'INVALID_CIPHERTEXT');
  });

  it('refuses malformed and off-curve public keys', async () => {
    const own = await generateBridgeKeyPair();
    const bad = ['', 'not base64!', toBase64Url(new Uint8Array(65)), toBase64Url(Uint8Array.from([4, ...new Uint8Array(64).fill(1)])), toBase64Url(new Uint8Array(33).fill(2))];
    for (const key of bad) {
      await rejects(deriveBridgeChannel({ role: 'control-center', sessionId: newSessionId(), privateKey: own.privateKey, myvaultPublicKey: key, controlCenterPublicKey: own.publicKey }), 'INVALID_KEY');
    }
  });

  it('refuses oversized, malformed and closed-session traffic', async () => {
    const { mv, cc } = await livePair();
    await rejects(mv.seal('snapshot.part', { blob: 'x'.repeat(BRIDGE_LIMITS.plaintextBytes) }), 'TOO_LARGE');
    const e = await mv.seal('sync.start', {});
    await rejects(cc.open({ ...e, ct: 'A'.repeat(BRIDGE_LIMITS.envelopeChars + 1) }), 'TOO_LARGE');
    for (const broken of [null, 'text', { ...e, v: 'mvcc-bridge-v0' }, { ...e, seq: 0 }, { ...e, seq: 1.5 }, { ...e, type: 'Bad Type' }, { ...e, iv: 'short' }, { ...e, ct: 'has space' }]) {
      await rejects(cc.open(broken as SealedEnvelope), 'MALFORMED');
    }
    cc.destroy();
    await rejects(cc.open(e), 'CLOSED');
    await rejects(cc.seal('bye', {}), 'CLOSED');
  });
});
