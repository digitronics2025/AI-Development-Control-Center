import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { api, expectNoAxeViolations, trackConsoleErrors } from './helpers';

/**
 * The MyVault bridge popup (docs/systems/credential-broker.md). A stand-in
 * for the MyVault tab is served on a fake https origin; it implements the
 * MyVault end of mvcc-bridge-v1 with the browser's own Web Crypto, opens the
 * real /vault-bridge page as its popup and talks to it exactly as MyVault
 * does. The page relays sealed envelopes and nothing else.
 */

const TRUSTED = 'https://vault.e2e.test';
const UNTRUSTED = 'https://evil.e2e.test';

const STUB_VAULT = `<!doctype html><html><head><title>Stub vault</title></head><body><h1>Stub vault</h1><script>
const P = 'mvcc-bridge-v1';
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const fromB64u = (t) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
window.log = [];
window.startBridge = async (url) => {
  const target = new URL(url).origin;
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const popup = window.open(url, 'mvcc-bridge', 'popup,width=520,height=680');
  let keys = null, sid = null, seq = 0, nextId = 1;
  const pending = new Map();
  window.helloNow = () => popup.postMessage({ v: P, type: 'hello', vaultId: 'e2e-vault', publicKey: pub }, target);
  window.addEventListener('message', async (e) => {
    if (e.source !== popup || e.origin !== target) return;
    const d = e.data;
    window.log.push(d.type);
    if (d.type === 'ready') window.helloNow();
    if (d.type === 'accept') {
      sid = d.sessionId;
      const peer = await crypto.subtle.importKey('raw', fromB64u(d.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, kp.privateKey, 256);
      const salt = await crypto.subtle.digest('SHA-256', enc.encode(P + '\\n' + sid + '\\n' + pub + '\\n' + d.publicKey));
      const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey', 'deriveBits']);
      const key = (label) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(P + ' ' + label) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(P + ' code') }, ikm, 32));
      const hex = [...bits].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      keys = { send: await key('myvault->control-center'), recv: await key('control-center->myvault') };
      // What MyVault checks first: the orchestrator's identity key signed this session's keys.
      const idKey = await crypto.subtle.importKey('raw', fromB64u(d.identityKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const signed = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, idKey, fromB64u(d.signature), enc.encode(P + ' identity\\n' + sid + '\\n' + pub + '\\n' + d.publicKey));
      const fp = [...new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64u(d.identityKey)))].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g).join(' ');
      window.accepted = { code: d.code, derived: hex.slice(0, 4) + '-' + hex.slice(4), signed, fingerprint: fp };
    }
    if (d.type === 'response' || d.type === 'error') pending.get(d.id)?.(d);
  });
  const request = (envelope) => {
    const id = nextId++;
    const reply = new Promise((r) => pending.set(id, r));
    popup.postMessage({ v: P, type: 'request', id, envelope }, target);
    return reply;
  };
  window.send = async (type, body) => {
    seq += 1;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = enc.encode(P + '\\n' + sid + '\\nmv2cc\\n' + seq + '\\n' + type);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, keys.send, enc.encode(JSON.stringify(body))));
    const d = await request({ v: P, sid, dir: 'mv2cc', seq, type, iv: b64u(iv), ct: b64u(ct) });
    if (d.type === 'error') return { error: d.code };
    const opened = [];
    for (const e of d.envelopes) {
      const aad2 = enc.encode(P + '\\n' + sid + '\\ncc2mv\\n' + e.seq + '\\n' + e.type);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(e.iv), additionalData: aad2 }, keys.recv, fromB64u(e.ct));
      opened.push({ type: e.type, body: JSON.parse(dec.decode(pt)) });
    }
    return { opened, closed: d.closed, raw: JSON.stringify(d.envelopes) };
  };
  window.sendForged = () => request({ v: P, sid, dir: 'mv2cc', seq: seq + 1, type: 'sync.start', iv: b64u(new Uint8Array(12)), ct: b64u(new Uint8Array(32)) }).then((d) => d.code ?? d.type);
};
</script></body></html>`;

async function stubVault(context: BrowserContext, origin: string): Promise<Page> {
  await context.route(`${origin}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: STUB_VAULT }));
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  return page;
}

async function openBridge(vault: Page, baseURL: string): Promise<Page> {
  const [popup] = await Promise.all([vault.context().waitForEvent('page'), vault.evaluate((url) => (window as unknown as { startBridge(u: string): Promise<void> }).startBridge(url), `${baseURL}/vault-bridge`)]);
  await popup.waitForLoadState();
  return popup;
}

test('opened directly, the bridge page explains where it comes from', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.goto('/vault-bridge');
  await expect(page.getByRole('heading', { name: 'Open this from MyVault' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an untrusted MyVault origin is refused and gets nothing back', async ({ context, page, baseURL }) => {
  await page.goto('/');
  await api(page, 'POST', '/api/vault-bridge/origins/remove', { origin: UNTRUSTED });
  const vault = await stubVault(context, UNTRUSTED);
  const popup = await openBridge(vault, baseURL!);
  await expect(popup.getByText('Waiting for MyVault')).toBeVisible();
  // The page judges no message before its trusted list has loaded.
  await expect(popup.locator('main')).toHaveAttribute('aria-busy', 'false');
  await vault.evaluate(() => (window as unknown as { helloNow(): void }).helloNow());
  await expect(popup.getByText('This address is not trusted')).toBeVisible();
  await expect(popup.getByText(UNTRUSTED)).toBeVisible();
  // No "ready" (it goes to trusted origins only) and no "accept".
  expect(await vault.evaluate(() => (window as unknown as { log: string[] }).log)).toEqual([]);
  expect((await api<{ sessions: unknown[] }>(page, 'GET', '/api/vault-bridge/status')).sessions).toEqual([]);
});

test('a trusted MyVault relays a sealed session end to end', async ({ context, page, baseURL }, testInfo) => {
  await page.goto('/');
  await api(page, 'POST', '/api/vault-bridge/origins', { origin: TRUSTED });
  const vault = await stubVault(context, TRUSTED);
  const popup = await openBridge(vault, baseURL!);
  const errors = trackConsoleErrors(popup);
  await expect(popup.getByRole('heading', { name: 'Connected' })).toBeVisible();
  const accepted = await vault.evaluate(() => (window as unknown as { accepted: { code: string; derived: string; signed: boolean; fingerprint: string } }).accepted);
  expect(accepted.code).toBe(accepted.derived);
  await expect(popup.getByText(accepted.code)).toBeVisible();
  // The session carries a signature this page could not have made, from the key the dashboard shows.
  expect(accepted.signed).toBe(true);
  expect((await api<{ identity: { fingerprint: string } }>(page, 'GET', '/api/vault-bridge/status')).identity.fingerprint).toBe(accepted.fingerprint);
  await expect(popup.getByText(accepted.fingerprint)).toBeVisible();
  const started = await vault.evaluate(() => (window as unknown as { send(t: string, b: unknown): Promise<{ opened: Array<{ type: string }> }> }).send('sync.start', {}));
  expect(started.opened.at(-1)!.type).toBe('snapshot.request');
  await expect(popup.getByText('Messages relayed')).toBeVisible();
  await expectNoAxeViolations(popup, testInfo);
  const result = await vault.evaluate(() => (window as unknown as { send(t: string, b: unknown): Promise<{ opened: Array<{ type: string; body: { imported: number } }> }> }).send('snapshot.part', { part: 1, final: true, items: [] }));
  expect(result.opened[0]!.type).toBe('snapshot.result');
  const bye = await vault.evaluate(() => (window as unknown as { send(t: string, b: unknown): Promise<{ closed: boolean }> }).send('bye', {}));
  expect(bye.closed).toBe(true);
  await expect(popup.getByText('The sync finished and the connection closed.')).toBeVisible();
  expect((await api<{ sessions: unknown[] }>(page, 'GET', '/api/vault-bridge/status')).sessions).toEqual([]);
  expect(errors).toEqual([]);
});

test('a forged envelope closes the session and the page says so', async ({ context, page, baseURL }) => {
  await page.goto('/');
  await api(page, 'POST', '/api/vault-bridge/origins', { origin: TRUSTED });
  const vault = await stubVault(context, TRUSTED);
  const popup = await openBridge(vault, baseURL!);
  await expect(popup.getByRole('heading', { name: 'Connected' })).toBeVisible();
  expect(await vault.evaluate(() => (window as unknown as { sendForged(): Promise<string> }).sendForged())).toBe('PROTOCOL');
  await expect(popup.getByText('The bridge stopped')).toBeVisible();
  expect((await api<{ sessions: unknown[] }>(page, 'GET', '/api/vault-bridge/status')).sessions).toEqual([]);
});

test('the session closes when a request fails or the window goes away', async ({ context, page, baseURL }) => {
  await page.goto('/');
  await api(page, 'POST', '/api/vault-bridge/origins', { origin: TRUSTED });
  const live = async () => (await api<{ sessions: unknown[] }>(page, 'GET', '/api/vault-bridge/status')).sessions.length;
  // A relayed request that never reaches the orchestrator: the page still closes the session.
  const vault = await stubVault(context, TRUSTED);
  const popup = await openBridge(vault, baseURL!);
  await expect(popup.getByRole('heading', { name: 'Connected' })).toBeVisible();
  await popup.route('**/api/vault-bridge/sessions/*/messages', (route) => route.abort());
  expect(await vault.evaluate(() => (window as unknown as { send(t: string, b: unknown): Promise<{ error?: string }> }).send('sync.start', {}))).toMatchObject({ error: 'UNREACHABLE' });
  await expect.poll(live).toBe(0);
  // MyVault locking mid-session closes the window: the close outlives the page.
  const again = await stubVault(context, TRUSTED);
  const popup2 = await openBridge(again, baseURL!);
  await expect(popup2.getByRole('heading', { name: 'Connected' })).toBeVisible();
  expect(await live()).toBe(1);
  await again.evaluate(() => window.open('', 'mvcc-bridge')?.close());
  await expect.poll(live).toBe(0);
});
test('Credentials shows source, scope and MyVault state, and never a value', async ({ context, page, baseURL }, testInfo) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tools/credentials');
  // Generate through the real tool layer: the page learns a name and a fingerprint, nothing else.
  await page.getByRole('button', { name: 'Generate secret' }).click();
  const generate = page.getByRole('dialog', { name: 'Generate a secret' });
  await generate.getByLabel('Name').fill('E2E_SESSION_SECRET');
  await generate.getByRole('combobox', { name: 'Repository' }).click();
  await page.getByRole('option', { name: 'docs-site' }).click();
  await generate.getByRole('button', { name: 'Generate' }).click();
  await expect(generate).toBeHidden();
  const row = page.getByRole('row', { name: /E2E_SESSION_SECRET/ });
  await expect(row).toContainText('Generated');
  await expect(row).toContainText('Pending MyVault');
  await expect(row).toContainText('docs-site');
  await expect(page.getByText(/generated secrets? waits? for MyVault/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect MyVault to finish sync' })).toBeVisible();
  // The Connect dialog shows the key MyVault will be asked to trust.
  await page.getByRole('button', { name: 'Connect MyVault to finish sync' }).click();
  const connect = page.getByRole('dialog', { name: 'Connect MyVault' });
  const identity = (await api<{ identity: { fingerprint: string } }>(page, 'GET', '/api/vault-bridge/status')).identity;
  await expect(connect.getByTestId('identity-fingerprint')).toHaveText(identity.fingerprint);
  // No MyVault has set up a delivery box yet: the dialog says what one would do.
  await expect(connect.getByTestId('delivery-box')).toContainText('Not set up yet');
  await connect.getByRole('button', { name: 'Close' }).first().click();
  await expect(connect).toBeHidden();

  // MyVault shares one item: it arrives with no repository and MyVault owns its value.
  await api(page, 'POST', '/api/vault-bridge/origins', { origin: TRUSTED });
  const shared = ['e2e', 'shared', 'value', String(Date.now())].join('-');
  const vault = await stubVault(context, TRUSTED);
  const popup = await openBridge(vault, baseURL!);
  await expect(popup.getByRole('heading', { name: 'Connected' })).toBeVisible();
  await vault.evaluate(async (value) => {
    const w = window as unknown as { send(t: string, b: unknown): Promise<unknown> };
    await w.send('sync.start', {});
    await w.send('snapshot.part', { part: 1, final: true, items: [{ itemId: 'e2e-item-1', title: 'E2E Stripe key', kind: 'other', envVar: 'STRIPE_KEY', value, updatedAt: null, ccId: null, authority: 'myvault' }] });
    await w.send('bye', {});
  }, shared);
  const imported = page.getByRole('row', { name: /E2E-Stripe-key/ });
  await expect(imported).toContainText('MyVault');
  await expect(imported).toContainText('No repository yet');
  await expect(imported).toContainText('Synced');
  await expect(imported.getByRole('button', { name: 'Replace value' })).toHaveCount(0);
  await imported.getByRole('button', { name: 'Manage' }).click();
  const drawer = page.getByRole('dialog', { name: 'E2E-Stripe-key' });
  await expect(drawer).toContainText('Managed by MyVault');
  await drawer.getByRole('checkbox', { name: 'docs-site' }).click();
  await drawer.getByRole('button', { name: 'Save access' }).click();
  await expect(drawer.getByRole('listitem').filter({ hasText: 'scope' })).toBeVisible();
  await expectNoAxeViolations(page, testInfo);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(imported).toContainText('docs-site');
  expect(await page.content()).not.toContain(shared);
  expect(JSON.stringify(await api(page, 'GET', '/api/credentials'))).not.toContain(shared);
  expect(errors).toEqual([]);
});
