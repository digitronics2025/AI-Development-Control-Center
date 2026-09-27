import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { git } from '@acc/git';
import { createTestApp, type TestApp } from './helpers.js';

/**
 * Add repository → Create new (docs/systems/repository-automation.md): the
 * local repository is always made; `github: true` also runs
 * `github.repo_create` through the tool layer. A stand-in `gh` on PATH plays
 * GitHub: it makes a bare repository, sets it as `origin` and pushes, the way
 * `gh repo create --source . --remote origin --push` does.
 */

const FAKE_GH = `
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const state = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);
if (args[0] === 'repo' && args[1] === 'create') {
  fs.appendFileSync(state + '.log', JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
  if (fs.existsSync(state + '.fail')) { console.error('GraphQL: Name already exists on this account (createRepository)'); process.exit(1); }
  const bare = path.join(path.dirname(state), 'remotes', args[2] + '.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['remote', 'add', 'origin', bare]);
  execFileSync('git', ['push', '-q', '-u', 'origin', 'HEAD']);
  console.log('https://github.com/tester/' + args[2]);
} else if (args[0] === 'auth') {
  console.log('Logged in to github.com account tester');
} else {
  console.log('gh version 2.80.0 (2026-09-01)');
}
`;

describe('POST /api/repositories/new', () => {
  let t: TestApp;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-fake-gh-new-'));
  const state = path.join(dir, 'state.json');
  const calls = (): Array<{ args: string[]; cwd: string }> => (existsSync(`${state}.log`) ? readFileSync(`${state}.log`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const parentDir = () => mkdtempSync(path.join(os.tmpdir(), 'acc-new-dst-'));
  const out = async (cwd: string, args: string[]) => (await git(cwd, args)).stdout.trim();

  beforeAll(async () => {
    // The first commit needs a Git identity; CI runners have none configured.
    for (const [key, value] of [['GIT_AUTHOR_NAME', 'Test'], ['GIT_AUTHOR_EMAIL', 'test@example.com'], ['GIT_COMMITTER_NAME', 'Test'], ['GIT_COMMITTER_EMAIL', 'test@example.com']] as const) process.env[key] ??= value;
    writeFileSync(path.join(dir, 'fake-gh.cjs'), FAKE_GH);
    writeFileSync(path.join(dir, 'gh.cmd'), '@node "%~dp0fake-gh.cjs" %*\r\n');
    writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-gh.cjs" "$@"\n');
    if (process.platform !== 'win32') chmodSync(path.join(dir, 'gh'), 0o755);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    t = await createTestApp({ baseEnv: { ...process.env, [pathKey]: `${dir}${path.delimiter}${process.env[pathKey] ?? ''}`, FAKE_GH_STATE: state } });
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('creates a local repository with a first commit and registers it', async () => {
    const parent = parentDir();
    const res = await t.api('POST', '/api/repositories/new', { name: 'local-only', parentFolder: parent, description: 'A calculator' });
    expect(res.status).toBe(201);
    expect(res.body.github).toBeNull();
    const folder = path.join(parent, 'local-only');
    expect(res.body.repository.name).toBe('local-only');
    expect(res.body.repository.status.branch).toBe('main');
    expect(res.body.repository.status.head).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(path.join(folder, 'README.md'), 'utf8')).toBe('# local-only\n\nA calculator\n');
    expect(await out(folder, ['log', '--format=%s'])).toBe('Initial commit');
    expect(calls()).toEqual([]);
  });

  it('also creates it on GitHub through github.repo_create and uploads the first commit', async () => {
    const parent = parentDir();
    const res = await t.api('POST', '/api/repositories/new', { name: 'calc-new', parentFolder: parent, github: true, visibility: 'public' });
    expect(res.status).toBe(201);
    expect(res.body.github).toEqual({ ok: true, summary: 'Created https://github.com/tester/calc-new' });
    expect(res.body.repository.status.upstream).toBe('origin/main');
    const [call] = calls();
    expect(call!.args).toEqual(['repo', 'create', 'calc-new', '--public', '--source', '.', '--remote', 'origin', '--push']);
    expect(call!.cwd.toLowerCase()).toBe(path.join(parent, 'calc-new').toLowerCase());
    // The call is on the tool layer's record like any other operator call.
    const executions = t.services.toolStore.listExecutions({ capability: 'github.repo_create', limit: 10 });
    expect(executions.map((e) => [e.origin, e.status])).toEqual([['operator', 'succeeded']]);
  });

  it('keeps the local repository and says so when GitHub refuses', async () => {
    writeFileSync(`${state}.fail`, '1');
    try {
      const parent = parentDir();
      const res = await t.api('POST', '/api/repositories/new', { name: 'taken-name', parentFolder: parent, github: true });
      expect(res.status).toBe(201);
      expect(res.body.github.ok).toBe(false);
      expect(res.body.github.message).toMatch(/Name already exists/);
      expect(res.body.repository.status.upstream).toBeNull();
      expect(existsSync(path.join(parent, 'taken-name', '.git'))).toBe(true);
    } finally {
      writeFileSync(`${state}.fail`, '');
      const { rmSync } = await import('node:fs');
      rmSync(`${state}.fail`);
    }
  });

  it('never lets an agent publish a public repository on its own', async () => {
    const created = await t.api('POST', '/api/repositories/new', { name: 'agent-scope', parentFolder: parentDir() });
    const repo = created.body.repository;
    const before = calls().length;
    const outcome = await t.services.tools.invoke({
      capability: 'github.repo_create',
      input: { name: 'agent-scope', visibility: 'public' },
      origin: 'agent',
      scope: { taskId: null, stageId: null, sessionId: null, repositoryId: repo.id, cwd: repo.path, roots: [repo.path], stageLevel: 4, autoApproveUpToLevel: 4, mode: 'autopilot', profile: 'operator', escalated: new Set(), protectedPaths: [] },
    });
    expect(outcome.result.ok).toBe(false);
    expect(outcome.execution.permissionLevel).toBe(5);
    expect(calls().length).toBe(before);
  });

  it('refuses a bad name or an existing folder and leaves nothing behind', async () => {
    const parent = parentDir();
    for (const name of ['../escape', 'has space', '-x', '.']) {
      const res = await t.api('POST', '/api/repositories/new', { name, parentFolder: parent });
      expect(res.status).toBe(400);
    }
    writeFileSync(path.join(parent, 'exists'), 'a file');
    const clash = await t.api('POST', '/api/repositories/new', { name: 'exists', parentFolder: parent });
    expect(clash.status).toBe(409);
    expect(t.services.store.listRepositories().map((r) => r.name)).not.toContain('exists');
  });
});
