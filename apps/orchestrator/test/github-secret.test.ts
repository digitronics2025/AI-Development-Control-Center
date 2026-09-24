import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VAULT_SYNC_REQUIRED } from '../src/tools/credentials.js';
import { addRepo, createTestApp, makeRepo, type TestApp } from './helpers.js';

/**
 * `github.secret_put` (docs/systems/tool-system.md): the value reaches `gh
 * secret set` on stdin only, the vault-before-deploy gate applies, and success
 * is proved by the secret list and its update time. A stand-in `gh` on PATH
 * records what it was given.
 */

const FAKE_GH = `
const fs = require('fs');
const state = process.env.FAKE_GH_STATE;
const mode = fs.existsSync(state + '.mode') ? fs.readFileSync(state + '.mode', 'utf8').trim() : 'ok';
const log = (entry) => fs.appendFileSync(state + '.log', JSON.stringify(entry) + '\\n');
const args = process.argv.slice(2);
const data = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {};
const envOf = (a) => (a.includes('--env') ? a[a.indexOf('--env') + 1] : 'repo');
if (args[0] === 'secret' && args[1] === 'set') {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const value = Buffer.concat(chunks).toString('utf8');
    log({ args, envHasValue: Object.values(process.env).includes(value) });
    if (mode === 'auth') { console.error('HTTP 401: Bad credentials (https://api.github.com/)'); process.exit(1); }
    data[args[2] + '@' + envOf(args)] = { value, updatedAt: mode === 'stale' ? '2020-01-01T00:00:00Z' : new Date().toISOString() };
    fs.writeFileSync(state, JSON.stringify(data));
    console.log('✓ Set Actions secret ' + args[2]);
  });
} else if (args[0] === 'secret' && args[1] === 'list') {
  log({ args });
  const env = envOf(args);
  const rows = Object.entries(data).filter(([k]) => k.endsWith('@' + env)).map(([k, v]) => ({ name: k.split('@')[0], updatedAt: v.updatedAt }));
  console.log(JSON.stringify(mode === 'unverified' ? [] : rows));
} else if (args[0] === 'auth') {
  console.log('Logged in to github.com account tester');
} else {
  console.log('gh version 2.80.0 (2026-09-01)');
}
`;

describe('github.secret_put', () => {
  let t: TestApp;
  let repoId: string;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-fake-gh-'));
  const state = path.join(dir, 'state.json');
  const readLog = (): Array<{ args: string[]; envHasValue?: boolean }> => (existsSync(`${state}.log`) ? readFileSync(`${state}.log`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const stored = (): Record<string, { value: string }> => (existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {});
  const mode = (m: 'ok' | 'auth' | 'unverified' | 'stale') => writeFileSync(`${state}.mode`, m);
  const put = (input: Record<string, unknown>, confirm = true) => t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'github.secret_put', input, ...(confirm ? { confirmation: 'github.secret_put' } : {}) });

  beforeAll(async () => {
    writeFileSync(path.join(dir, 'fake-gh.cjs'), FAKE_GH);
    writeFileSync(path.join(dir, 'gh.cmd'), '@node "%~dp0fake-gh.cjs" %*\r\n');
    writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-gh.cjs" "$@"\n');
    if (process.platform !== 'win32') chmodSync(path.join(dir, 'gh'), 0o755);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    t = await createTestApp({ baseEnv: { ...process.env, [pathKey]: `${dir}${path.delimiter}${process.env[pathKey] ?? ''}`, FAKE_GH_STATE: state } });
    repoId = await addRepo(t, await makeRepo({ files: { 'README.md': '# fixture\n' } }));
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('refuses a generated secret MyVault has not saved, then deploys the same value by stdin', async () => {
    mode('ok');
    await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'credential.generate', input: { name: 'GH_DEPLOY_SECRET' } });
    const blocked = await put({ credential: 'GH_DEPLOY_SECRET', secretName: 'SESSION_SECRET' });
    expect(blocked.body.result).toMatchObject({ ok: false, summary: VAULT_SYNC_REQUIRED });
    expect(readLog().filter((e) => e.args[1] === 'set')).toEqual([]);

    // MyVault saves it (what the bridge records on a good acknowledgement).
    const id = t.services.toolStore.credential('GH_DEPLOY_SECRET')!.id;
    const [push] = (await t.services.credentials.pendingPushes('https://vault.example', 'v1', 100)).filter((p) => p.credentialId === id);
    t.services.credentials.recordPushAck(id, 'https://vault.example', 'v1', push!.fingerprint, { itemId: randomUUID(), status: 'saved', fingerprint: push!.fingerprint, vaultFingerprint: push!.fingerprint, updatedAt: null, cloudPending: false, detail: null });
    const value = (await t.services.credentials.value('GH_DEPLOY_SECRET', repoId))!;

    const done = await put({ credential: 'GH_DEPLOY_SECRET', secretName: 'SESSION_SECRET' });
    expect(done.body.result).toMatchObject({ ok: true, output: { secretName: 'SESSION_SECRET', environment: null, verified: true } });
    expect(done.body.execution.permissionLevel).toBe(4);
    expect(stored()['SESSION_SECRET@repo']!.value).toBe(value);
    const call = readLog().find((e) => e.args[1] === 'set')!;
    expect(call.args).toEqual(['secret', 'set', 'SESSION_SECRET']);
    expect(call.envHasValue).toBe(false);
    const everything = JSON.stringify(done.body) + JSON.stringify(t.services.db.prepare('SELECT * FROM tool_executions').all()) + readFileSync(`${state}.log`, 'utf8');
    expect(everything).not.toContain(value);
  });

  it('targets a deployment environment, and a production one needs a typed approval', async () => {
    mode('ok');
    const staging = await put({ credential: 'GH_DEPLOY_SECRET', secretName: 'API_KEY', environment: 'staging' });
    expect(staging.body.result.ok).toBe(true);
    expect(readLog().filter((e) => e.args[1] === 'set').at(-1)!.args).toEqual(['secret', 'set', 'API_KEY', '--env', 'staging']);
    const prod = await put({ credential: 'GH_DEPLOY_SECRET', secretName: 'API_KEY', environment: 'production' }, false);
    expect(prod.body.decision).toBe('approval');
    expect(prod.body.execution.permissionLevel).toBe(5);
    expect(stored()['API_KEY@production']).toBeUndefined();
  });

  it('reports an auth failure, an unlisted and a stale write as not done, and keeps the same value', async () => {
    const before = t.services.credentials.get('GH_DEPLOY_SECRET')!.fingerprint;
    mode('auth');
    expect((await put({ credential: 'GH_DEPLOY_SECRET', secretName: 'OTHER' })).body.result.error.code).toBe('AUTH_REQUIRED');
    mode('unverified');
    const unlisted = await put({ credential: 'GH_DEPLOY_SECRET', secretName: 'OTHER' });
    expect(unlisted.body.result).toMatchObject({ ok: false, output: { verified: false } });
    expect(unlisted.body.result.summary).toMatch(/^Deployment unverified: .*not in the secret list/);
    mode('stale');
    expect((await put({ credential: 'GH_DEPLOY_SECRET', secretName: 'OTHER' })).body.result.summary).toMatch(/older update time/);
    mode('ok');
    expect((await put({ credential: 'GH_DEPLOY_SECRET', secretName: 'OTHER' })).body.result.ok).toBe(true);
    expect(t.services.credentials.get('GH_DEPLOY_SECRET')!.fingerprint).toBe(before);
  });

  it('refuses a reserved name and a credential outside the repository', async () => {
    expect((await put({ credential: 'GH_DEPLOY_SECRET', secretName: 'GITHUB_TOKEN' })).body.result.error.code).toBe('INVALID_INPUT');
    await t.services.credentials.create({ name: 'elsewhere-gh', kind: 'other', value: ['x', randomUUID()].join('-'), repositoryIds: ['another-repository'] });
    expect((await put({ credential: 'elsewhere-gh', secretName: 'X' })).body.result.error.code).toBe('INVALID_INPUT');
  });
});
