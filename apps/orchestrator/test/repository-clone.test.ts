import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '@acc/git';
import { createTestApp, makeRepo, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

async function run(cwd: string, args: string[]) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** A bare remote holding `makeRepo`'s history, reachable as a file:// address. */
async function remoteWithHistory(): Promise<string> {
  const local = await makeRepo();
  const remote = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-clone-src-')), 'calc-app.git');
  await run(path.dirname(remote), ['init', '--bare', '-b', 'main', remote]);
  await run(local, ['push', remote, 'main']);
  return remote;
}

const parentDir = () => mkdtempSync(path.join(os.tmpdir(), 'acc-clone-dst-'));

describe('POST /api/repositories/clone', () => {
  it('downloads a repository into a new folder and registers it', async () => {
    const remote = await remoteWithHistory();
    const parent = parentDir();
    const res = await t.api('POST', '/api/repositories/clone', { url: pathToFileURL(remote).href, parentFolder: parent });
    expect(res.status).toBe(201);
    const destination = path.join(parent, 'calc-app');
    expect(res.body.name).toBe('calc-app');
    expect(res.body.path.toLowerCase()).toBe(destination.toLowerCase());
    expect(res.body.status.isGitRepo).toBe(true);
    expect(res.body.status.branch).toBe('main');
    expect(res.body.status.upstream).toBe('origin/main');
    expect(res.body.tooling).toContain('node');
    expect(existsSync(path.join(destination, 'README.md'))).toBe(true);
  });

  it('clones an empty repository, as GitHub creates one', async () => {
    const remote = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-clone-src-')), 'Simple-calc-01.git');
    await run(path.dirname(remote), ['init', '--bare', '-b', 'main', remote]);
    const parent = parentDir();
    const res = await t.api('POST', '/api/repositories/clone', { url: pathToFileURL(remote).href, parentFolder: parent, name: 'Simple calc' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Simple calc');
    expect(res.body.status.isGitRepo).toBe(true);
  });

  it('uses the chosen folder name, and the first discovery root when no folder is given', async () => {
    const remote = await remoteWithHistory();
    const root = parentDir();
    const current = t.services.settings.get().repositoryAutomation;
    t.services.settings.update({ repositoryAutomation: { ...current, roots: [root] } });
    expect((await t.api('GET', '/api/repositories/clone-defaults')).body).toEqual({ parentFolder: root });
    const res = await t.api('POST', '/api/repositories/clone', { url: pathToFileURL(remote).href, folderName: 'my-calc' });
    expect(res.status).toBe(201);
    expect(existsSync(path.join(root, 'my-calc', '.git'))).toBe(true);
  });

  it('never writes into a folder that already exists', async () => {
    const remote = await remoteWithHistory();
    const parent = parentDir();
    mkdirSync(path.join(parent, 'calc-app'));
    const res = await t.api('POST', '/api/repositories/clone', { url: pathToFileURL(remote).href, parentFolder: parent });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE');
    expect(t.services.store.listRepositories()).toHaveLength(0);
  });

  it('refuses unsafe or malformed addresses and folder names before running Git', async () => {
    const parent = parentDir();
    for (const url of ['ext::sh -c id', 'http://github.com/o/a.git', `https://${['user', 'pw'].join(':')}@github.com/o/a.git`, '--upload-pack=x']) {
      const res = await t.api('POST', '/api/repositories/clone', { url, parentFolder: parent });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_URL');
    }
    const bad = await t.api('POST', '/api/repositories/clone', { url: 'owner/app', parentFolder: parent, folderName: '../escape' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_PATH');
  });

  it('reports a failed download and leaves no folder behind', async () => {
    const parent = parentDir();
    const missing = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-clone-src-')), 'gone.git');
    const res = await t.api('POST', '/api/repositories/clone', { url: pathToFileURL(missing).href, parentFolder: parent });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CLONE_FAILED');
    expect(existsSync(path.join(parent, 'gone'))).toBe(false);
    expect(t.services.store.listRepositories()).toHaveLength(0);
  });
});
