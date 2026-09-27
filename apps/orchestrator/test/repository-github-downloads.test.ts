import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { git } from '@acc/git';
import type { RepositoryAutomationSettings } from '@acc/shared';
import { createTestApp, makeRepo, type TestApp } from './helpers.js';

/**
 * GitHub downloads (docs/systems/repository-automation.md): a run lists the
 * watched accounts through `github.repo_list` and downloads the repositories
 * that no registered repository has as a remote. A stand-in `gh` on PATH
 * answers the listing; `url.<file>.insteadOf=https://github.com/` makes Git
 * fetch those github.com addresses from local bare repositories, so remotes
 * keep their real-looking github.com identity.
 */

const FAKE_GH = `
const fs = require('fs');
const args = process.argv.slice(2);
const state = process.env.FAKE_GH_STATE;
if (args[0] === 'repo' && args[1] === 'list') {
  const owner = args[2];
  const accounts = JSON.parse(fs.readFileSync(state, 'utf8'));
  if (!accounts[owner]) { console.error('GraphQL: Could not resolve to a RepositoryOwner with the login of ' + owner + '.'); process.exit(1); }
  console.log(JSON.stringify(accounts[owner]));
} else if (args[0] === 'auth') {
  console.log('Logged in to github.com account tester');
} else {
  console.log('gh version 2.80.0 (2026-09-01)');
}
`;

const row = (owner: string, name: string, extra: Record<string, unknown> = {}) => ({
  name,
  nameWithOwner: `${owner}/${name}`,
  url: `https://github.com/${owner}/${name}`,
  isArchived: false,
  isFork: false,
  isEmpty: false,
  diskUsage: 12,
  ...extra,
});

describe('GitHub downloads in repository automation', () => {
  let t: TestApp;
  const fake = mkdtempSync(path.join(os.tmpdir(), 'acc-fake-gh-list-'));
  const state = path.join(fake, 'accounts.json');
  /** Bare repositories standing in for github.com, laid out as <owner>/<name>.git. */
  const hub = mkdtempSync(path.join(os.tmpdir(), 'acc-hub-'));
  let root = '';

  async function run(cwd: string, args: string[]) {
    const r = await git(cwd, args);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** A bare repository at hub/<owner>/<name>.git with one commit. */
  async function publish(owner: string, name: string) {
    const src = await makeRepo();
    const bare = path.join(hub, owner, `${name}.git`);
    mkdirSync(path.dirname(bare), { recursive: true });
    await run(hub, ['init', '-q', '--bare', '-b', 'main', bare]);
    await run(src, ['push', '-q', bare, 'main']);
  }

  async function automation(patch: Partial<RepositoryAutomationSettings>) {
    const current = t.services.settings.get().repositoryAutomation;
    const res = await t.api('PATCH', '/api/settings', { repositoryAutomation: { ...current, ...patch } });
    expect(res.status).toBe(200);
  }

  const accounts = (value: Record<string, unknown[]>) => writeFileSync(state, JSON.stringify(value));

  beforeAll(async () => {
    writeFileSync(path.join(fake, 'fake-gh.cjs'), FAKE_GH);
    writeFileSync(path.join(fake, 'gh.cmd'), '@node "%~dp0fake-gh.cjs" %*\r\n');
    writeFileSync(path.join(fake, 'gh'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-gh.cjs" "$@"\n');
    if (process.platform !== 'win32') chmodSync(path.join(fake, 'gh'), 0o755);
    // Every git process in this test (the orchestrator's included) fetches github.com from the hub.
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(hub).href}/.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/';
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    t = await createTestApp({ baseEnv: { ...process.env, [pathKey]: `${fake}${path.delimiter}${process.env[pathKey] ?? ''}`, FAKE_GH_STATE: state } });
    for (const [owner, name] of [['tester', 'new-app'], ['tester', 'known-app'], ['acme-org', 'org-tool'], ['tester', 'removed-app'], ['tester', 'fresh-app'], ['tester', 'clash-app']]) await publish(owner!, name!);
  }, 120_000);

  afterAll(async () => {
    await t.close();
    for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[key];
  });

  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'acc-downloads-'));
    await automation({ roots: [root], maxDepth: 1, githubAccounts: [], ignoredRemotes: [], sync: false });
  });

  it('downloads what is missing, recognises copies by remote, and skips archived, forks and oversized', async () => {
    // Already here under another folder name: recognised by its remote, not its name.
    const elsewhere = await makeRepo();
    await run(elsewhere, ['remote', 'add', 'origin', 'https://github.com/tester/known-app.git']);
    expect((await t.api('POST', '/api/repositories', { path: elsewhere })).status).toBe(201);

    accounts({
      tester: [row('tester', 'new-app'), row('tester', 'known-app'), row('tester', 'old', { isArchived: true }), row('tester', 'copy', { isFork: true }), row('tester', 'huge', { diskUsage: 600 * 1024 })],
      'acme-org': [row('acme-org', 'org-tool')],
    });
    await automation({ githubAccounts: ['tester', 'acme-org'] });
    const result = await t.services.repositoryAutomation.run('manual');

    expect(result.downloads!.downloaded.map((d) => d.remote).sort()).toEqual(['github.com/acme-org/org-tool', 'github.com/tester/new-app']);
    expect(result.downloads!.skipped.map((s) => [s.remote, s.kind]).sort()).toEqual([['github.com/tester/copy', 'fork'], ['github.com/tester/huge', 'too-large'], ['github.com/tester/old', 'archived']]);
    expect(result.downloads!.skipped.find((s) => s.remote.endsWith('huge'))!.reason).toMatch(/600 MB, over the 500 MB limit/);
    expect(result.downloads!.errors).toEqual([]);
    expect(existsSync(path.join(root, 'new-app', 'README.md'))).toBe(true);
    const repo = await t.services.repositories.get(result.downloads!.downloaded.find((d) => d.remote.endsWith('new-app'))!.id, true);
    expect(repo.status.upstream).toBe('origin/main');
    expect(await run(repo.path, ['config', 'remote.origin.url'])).toBe('https://github.com/tester/new-app');

    // A second run finds nothing new.
    const again = await t.services.repositoryAutomation.run('manual');
    expect(again.downloads!.downloaded).toEqual([]);
  });

  it('never downloads again a repository you removed', async () => {
    accounts({ tester: [row('tester', 'removed-app')] });
    await automation({ githubAccounts: ['tester'] });
    const first = await t.services.repositoryAutomation.run('manual');
    const id = first.downloads!.downloaded[0]!.id;
    expect((await t.api('DELETE', `/api/repositories/${id}`)).status).toBe(204);
    expect(t.services.settings.get().repositoryAutomation.ignoredRemotes).toContain('github.com/tester/removed-app');

    // Even with its folder gone, it stays removed.
    const { rmSync } = await import('node:fs');
    rmSync(path.join(root, 'removed-app'), { recursive: true, force: true });
    const second = await t.services.repositoryAutomation.run('manual');
    expect(second.downloads!.downloaded).toEqual([]);
    expect(existsSync(path.join(root, 'removed-app'))).toBe(false);
  });

  it('reports an account it cannot list and still downloads from the others', async () => {
    accounts({ tester: [row('tester', 'fresh-app')] });
    await automation({ githubAccounts: ['nobody-here', 'tester'] });
    const result = await t.services.repositoryAutomation.run('manual');
    expect(result.downloads!.errors).toEqual([{ subject: 'nobody-here', message: expect.stringMatching(/Could not resolve/) }]);
    expect(result.downloads!.downloaded.map((d) => d.remote)).toEqual(['github.com/tester/fresh-app']);
  });

  it('leaves a different folder with the same name alone', async () => {
    mkdirSync(path.join(root, 'clash-app'));
    writeFileSync(path.join(root, 'clash-app', 'notes.txt'), 'mine');
    accounts({ tester: [row('tester', 'clash-app')] });
    await automation({ githubAccounts: ['tester'] });
    const result = await t.services.repositoryAutomation.run('manual');
    expect(result.downloads!.downloaded).toEqual([]);
    expect(result.downloads!.skipped).toEqual([{ remote: 'github.com/tester/clash-app', kind: 'folder-taken', reason: expect.stringMatching(/already exists and is not this repository/) }]);
  });

  it('does nothing with no watched account', async () => {
    const result = await t.services.repositoryAutomation.run('manual');
    expect(result.downloads).toBeNull();
  });
});
