import type { webcrypto } from 'node:crypto';
import { fromBase64Url, toBase64Url } from '../tools/vault-bridge-protocol.js';

/**
 * `acc-connected-app-v1` — statements the Control Center signs for a paired
 * local app (Private Browser) with its long-term identity key, the same key
 * MyVault pins (docs/systems/connected-apps.md). The app pins that key when it
 * pairs and checks a fresh `hello` statement before it sends anything, so a
 * program answering on the loopback port instead of the orchestrator is
 * refused.
 *
 * The protocol id prefixes every statement, so nothing signed here can be read
 * as a MyVault bridge transcript (`mvcc-bridge-v1 identity`) or a deposit
 * (`mvcc-deposit-v1 signed`), and the reverse.
 */

type CryptoKey = webcrypto.CryptoKey;

export const CONNECTED_APP_PROTOCOL = 'acc-connected-app-v1';
export type StatementPurpose = 'pair' | 'hello';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const IDENTITY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const IDENTITY_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;
/** App ids and nonces: base64url, 16–64 characters. */
export const STATEMENT_FIELD = /^[A-Za-z0-9_-]{16,64}$/;

export interface StatementInput {
  purpose: StatementPurpose;
  appId: string;
  nonce: string;
}

export function statementBytes(input: StatementInput): Uint8Array {
  if (input.purpose !== 'pair' && input.purpose !== 'hello') throw new Error('Unknown statement purpose');
  if (!STATEMENT_FIELD.test(input.appId) || !STATEMENT_FIELD.test(input.nonce)) throw new Error('Invalid statement field');
  return encoder.encode(`${CONNECTED_APP_PROTOCOL} ${input.purpose}\n${input.appId}\n${input.nonce}`);
}

/** The raw 64-byte signature Web Crypto verifies, base64url. */
export async function signStatement(privateKey: CryptoKey, input: StatementInput): Promise<string> {
  return toBase64Url(new Uint8Array(await subtle.sign(IDENTITY_SIGN, privateKey, statementBytes(input))));
}

/** False for anything that is not a valid signature by `identityKey` over this statement — never throws. */
export async function verifyStatement(input: StatementInput & { identityKey: string; signature: string }): Promise<boolean> {
  try {
    const raw = fromBase64Url(input.identityKey);
    const signature = fromBase64Url(input.signature);
    if (raw.length !== 65 || raw[0] !== 4 || signature.length !== 64) return false;
    const key = await subtle.importKey('raw', raw, IDENTITY_ALGORITHM, false, ['verify']);
    return await subtle.verify(IDENTITY_SIGN, key, signature, statementBytes(input));
  } catch {
    return false;
  }
}
