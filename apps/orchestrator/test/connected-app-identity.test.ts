import { readFileSync } from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signStatement, statementBytes, verifyStatement } from '../src/connected-apps/protocol.js';
import { generateBridgeKeyPair, newSessionId, signBridgeIdentity, verifyBridgeIdentity } from '../src/tools/vault-bridge-protocol.js';

/**
 * acc-connected-app-v1 (docs/systems/connected-apps.md). The vectors file is
 * committed byte-for-byte in Private Browser too
 * (electron/control-center-link.vectors.json); both suites verify every
 * statement, which is what keeps the two implementations interoperable.
 */

const vectors = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'acc-connected-app-v1.vectors.json'), 'utf8'));
const subtle = webcrypto.subtle;
const identityKey = vectors.identity.publicKey as string;
const importSigning = () => subtle.importKey('jwk', vectors.identity.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

describe('acc-connected-app-v1 statements', () => {
  it('verifies every committed vector', async () => {
    expect(vectors.statements.length).toBeGreaterThanOrEqual(2);
    for (const s of vectors.statements) {
      expect(await verifyStatement({ ...s, identityKey })).toBe(true);
    }
  });

  it('refuses a statement with any field changed', async () => {
    const [pair] = vectors.statements;
    expect(await verifyStatement({ ...pair, purpose: 'hello', identityKey })).toBe(false);
    expect(await verifyStatement({ ...pair, appId: 'vector-app-0000000002', identityKey })).toBe(false);
    expect(await verifyStatement({ ...pair, nonce: 'vector-nonce-00000000009', identityKey })).toBe(false);
    const other = await generateBridgeKeyPair();
    expect(await verifyStatement({ ...pair, identityKey: other.publicKey })).toBe(false);
  });

  it('signs statements that verify, and never throws on garbage', async () => {
    const key = await importSigning();
    const input = { purpose: 'hello' as const, appId: 'app-id-000000000000001', nonce: newSessionId() };
    expect(await verifyStatement({ ...input, identityKey, signature: await signStatement(key, input) })).toBe(true);
    expect(await verifyStatement({ ...input, identityKey, signature: 'not base64url!' })).toBe(false);
    expect(await verifyStatement({ ...input, identityKey: '', signature: '' })).toBe(false);
    expect(() => statementBytes({ ...input, nonce: 'short' })).toThrow();
  });

  it('cannot be confused with a MyVault bridge transcript, in either direction', async () => {
    const key = await importSigning();
    const a = await generateBridgeKeyPair();
    const b = await generateBridgeKeyPair();
    const sessionId = newSessionId();
    const transcript = { sessionId, myvaultPublicKey: a.publicKey, controlCenterPublicKey: b.publicKey };
    const bridgeSignature = await signBridgeIdentity(key, transcript);
    expect(await verifyBridgeIdentity({ ...transcript, identityKey, signature: bridgeSignature })).toBe(true);
    // The same key, the bridge signature offered as a link statement over the same id.
    expect(await verifyStatement({ purpose: 'hello', appId: sessionId, nonce: sessionId, identityKey, signature: bridgeSignature })).toBe(false);
    // And a link statement offered as a bridge transcript.
    const statement = { purpose: 'pair' as const, appId: sessionId, nonce: newSessionId() };
    const linkSignature = await signStatement(key, statement);
    expect(await verifyBridgeIdentity({ ...transcript, identityKey, signature: linkSignature })).toBe(false);
  });
});
