import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertNoStagedSecrets, commitPaths, git, headCommit, scanFiles, scanSince, scanStaged, SecretCommitError } from '../src/index.js';

/**
 * VER-1: the secret check at every commit of task work. `commitPaths` (the
 * Git checkpoint and a worktree's final commit) checks what it staged before
 * `git commit`; the scans behind `security.secret_scan` read the change since
 * a baseline, the index, or whole files. Tokens are assembled at run time.
 */

const token = () => ['gh', 'p_', 'C0mm1tT0'.repeat(4), 'Kk7Q'].join('');

let repo: string;

async function sh(args: string[]) {
  const r = await git(repo, args);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout;
}

beforeEach(async () => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'acc-git-secrets-'));
  await sh(['init', '-b', 'main']);
  await sh(['config', 'user.email', 'test@example.com']);
  await sh(['config', 'user.name', 'Test']);
  await sh(['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  await sh(['add', '.']);
  await sh(['commit', '-m', 'init']);
});

describe('commitPaths', () => {
  it('refuses to commit a file holding a token, unstages it and names the file and the kind, never the value', async () => {
    const head = await headCommit(repo);
    writeFileSync(path.join(repo, 'config.ts'), `export const githubToken = '${token()}';\n`);
    writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    const error = await commitPaths(repo, ['config.ts', 'a.txt'], 'task work').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretCommitError);
    expect((error as SecretCommitError).message).toContain('config.ts contains what looks like a GitHub token');
    expect((error as SecretCommitError).message).not.toContain(token());
    expect((error as SecretCommitError).findings).toEqual([{ path: 'config.ts', reason: 'contains what looks like a GitHub token' }]);
    // Nothing was committed, nothing stays staged, and the working tree keeps the files.
    expect(await headCommit(repo)).toBe(head);
    expect(await sh(['diff', '--cached', '--name-only'])).toBe('');
    expect(await sh(['status', '--porcelain'])).toContain('?? config.ts');
  });

  it('refuses a sensitive file by its name, and commits clean work as before', async () => {
    writeFileSync(path.join(repo, '.env'), 'PLAIN=1\n');
    const error = await commitPaths(repo, ['.env'], 'env').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretCommitError);
    expect((error as SecretCommitError).findings[0]).toMatchObject({ path: '.env' });
    writeFileSync(path.join(repo, 'clean.ts'), "export const githubToken = process.env.GITHUB_TOKEN ?? '';\n");
    const commit = await commitPaths(repo, ['clean.ts'], 'clean');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await sh(['show', '--name-only', '--format=', 'HEAD'])).toBe('clean.ts');
  });

  it('commits the deletion of a committed .env or key file: a deletion takes a secret out and is not judged by its name', async () => {
    writeFileSync(path.join(repo, '.env'), 'PLAIN=1\n');
    writeFileSync(path.join(repo, 'id_rsa'), 'not really a key\n');
    await sh(['add', '.env', 'id_rsa']);
    await sh(['commit', '-m', 'secrets that should not be here']);
    const withSecrets = (await headCommit(repo))!;
    rmSync(path.join(repo, '.env'));
    rmSync(path.join(repo, 'id_rsa'));
    writeFileSync(path.join(repo, 'a.txt'), 'reads process.env now\n');
    // The task scope's scan does not report the removed files as secret material either.
    expect((await scanSince(repo, withSecrets)).findings).toEqual([]);
    const commit = await commitPaths(repo, ['.env', 'id_rsa', 'a.txt'], 'take the secrets out');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await sh(['show', '--name-status', '--format=', 'HEAD'])).trim().split('\n').sort()).toEqual(['D\t.env', 'D\tid_rsa', 'M\ta.txt']);
    // The git.commit tool's form (literal pathspecs) reads a staged deletion the same way.
    writeFileSync(path.join(repo, '.npmrc'), 'shamefully-hoist=true\n');
    await sh(['add', '.npmrc']);
    await sh(['commit', '-m', 'npmrc']);
    await sh(['rm', '-q', '.npmrc']);
    expect(await scanStaged(repo, ['.npmrc'], { literal: true })).toEqual({ truncated: false, findings: [], files: [] });
    await expect(assertNoStagedSecrets(repo, ['.npmrc'], { literal: true })).resolves.toBeUndefined();
  });

  it('is not blinded by a .gitattributes line that marks a text file -diff or binary, the change\'s own or one already committed', async () => {
    const head = await headCommit(repo);
    // The change marks its own file -diff: Git alone would print only "Binary files differ" for it.
    writeFileSync(path.join(repo, '.gitattributes'), 'sim-config.ts -diff\n');
    writeFileSync(path.join(repo, 'sim-config.ts'), `export const githubToken = '${token()}';\n`);
    const own = await commitPaths(repo, ['.gitattributes', 'sim-config.ts'], 'config').catch((e: unknown) => e);
    expect(own).toBeInstanceOf(SecretCommitError);
    expect((own as SecretCommitError).findings).toEqual([{ path: 'sim-config.ts', reason: 'contains what looks like a GitHub token' }]);
    expect(await headCommit(repo)).toBe(head);
    // Attributes the repository already has: a new file and a tracked file changed under them.
    rmSync(path.join(repo, 'sim-config.ts'));
    writeFileSync(path.join(repo, '.gitattributes'), '*.json binary\n*.ts -diff\n*.png binary\n');
    writeFileSync(path.join(repo, 'tracked.ts'), 'export const a = 1;\n');
    await sh(['add', '.gitattributes', 'tracked.ts']);
    await sh(['commit', '-m', 'attributes']);
    writeFileSync(path.join(repo, 'config.json'), `{ "token": "${token()}" }\n`);
    writeFileSync(path.join(repo, 'tracked.ts'), `export const a = '${token()}';\n`);
    for (const file of ['config.json', 'tracked.ts']) {
      const error = await commitPaths(repo, [file], 'config').catch((e: unknown) => e);
      expect(error, file).toBeInstanceOf(SecretCommitError);
      expect((error as SecretCommitError).findings, file).toEqual([{ path: file, reason: 'contains what looks like a GitHub token' }]);
      // The git.commit tool's form (literal pathspecs) reads it the same way.
      await sh(['add', file]);
      await expect(assertNoStagedSecrets(repo, [file], { literal: true })).rejects.toBeInstanceOf(SecretCommitError);
    }
    // A real binary file (a NUL byte) is still left to Git's binary test, and commits.
    writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]));
    expect(await commitPaths(repo, ['logo.png'], 'logo')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('checks the first commit of a repository with no commits yet', async () => {
    const fresh = mkdtempSync(path.join(os.tmpdir(), 'acc-git-unborn-'));
    await git(fresh, ['init', '-b', 'main']);
    writeFileSync(path.join(fresh, 'k.ts'), `const k = '${token()}';\n`);
    await expect(commitPaths(fresh, ['k.ts'], 'first')).rejects.toBeInstanceOf(SecretCommitError);
    expect(await headCommit(fresh)).toBeNull();
    expect((await git(fresh, ['diff', '--cached', '--name-only'])).stdout).toBe('');
  });
});

describe('secret scans', () => {
  it('scanStaged reads only the index, and only the paths asked for', async () => {
    writeFileSync(path.join(repo, 'staged.ts'), `const t = '${token()}';\n`);
    writeFileSync(path.join(repo, 'loose.ts'), `const t = '${token()}';\n`);
    await sh(['add', 'staged.ts']);
    expect((await scanStaged(repo)).findings.map((f) => f.path)).toEqual(['staged.ts']);
    expect((await scanStaged(repo, ['a.txt'])).findings).toEqual([]);
    await expect(assertNoStagedSecrets(repo, ['staged.ts'], { literal: true })).rejects.toBeInstanceOf(SecretCommitError);
    expect(await sh(['diff', '--cached', '--name-only'])).toBe('');
  });

  it('scanSince reads tracked changes and untracked files since a commit, not what the commit already had', async () => {
    const base = (await headCommit(repo))!;
    writeFileSync(path.join(repo, 'a.txt'), `one\ntoken ${token()}\n`);
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src', 'new.ts'), `const t = '${token()}';\n`);
    writeFileSync(path.join(repo, 'src', 'fine.ts'), 'export {};\n');
    const scan = await scanSince(repo, base);
    expect(scan.truncated).toBe(false);
    expect(scan.findings.map((f) => f.path).sort()).toEqual(['a.txt', 'src/new.ts']);
    expect(scan.files.sort()).toEqual(['a.txt', 'src/fine.ts', 'src/new.ts']);
    // Committed since the base, the token is still part of the change.
    await sh(['add', '.']);
    await sh(['commit', '-m', 'leak']);
    expect((await scanSince(repo, base)).findings).toHaveLength(2);
    expect((await scanSince(repo, (await headCommit(repo))!)).findings).toEqual([]);
  });

  it('scanFiles reads whole files, judges a binary file by its name and stops at its byte budget', async () => {
    writeFileSync(path.join(repo, 'old.ts'), `const t = '${token()}';\n`);
    writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    expect((await scanFiles(repo, ['old.ts', 'blob.bin', 'a.txt'])).findings).toEqual([{ path: 'old.ts', reason: 'contains what looks like a GitHub token' }]);
    expect((await scanFiles(repo, ['old.ts'], { maxBytes: 10 })).truncated).toBe(true);
  });
});
