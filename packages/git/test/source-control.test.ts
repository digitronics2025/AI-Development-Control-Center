import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  absoluteGitDir,
  classifyGitOutput,
  commitFileDiff,
  commitFiles,
  commitMeta,
  commitStaged,
  commitsSince,
  fastForward,
  fetchRemote,
  git,
  headCommit,
  historyPage,
  indexLocked,
  lineStats,
  listRemotes,
  operationInProgress,
  outgoingPatch,
  parsePorcelainV2,
  pathDiff,
  pushRef,
  remoteMissing,
  remoteOwnerKey,
  repositoryStatus,
  outgoingFiles,
  patchHeaderPath,
  splitPatch,
  stagedPatch,
  stagePaths,
  unstagePaths,
} from '../src/index.js';

async function run(cwd: string, args: string[]) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

async function initRepo(dir = mkdtempSync(path.join(os.tmpdir(), 'acc-sc-')), commit = true): Promise<string> {
  await run(dir, ['init', '-b', 'main']);
  await run(dir, ['config', 'user.email', 'test@example.com']);
  await run(dir, ['config', 'user.name', 'Test']);
  await run(dir, ['config', 'commit.gpgsign', 'false']);
  await run(dir, ['config', 'core.autocrlf', 'false']);
  await run(dir, ['config', 'tag.gpgsign', 'false']);
  if (commit) {
    writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
    await run(dir, ['add', '.']);
    await run(dir, ['commit', '-m', 'init']);
  }
  return dir;
}

/** A bare remote with `main`, and a clone that tracks it. */
async function withRemote(): Promise<{ remote: string; local: string; other: string }> {
  const seed = await initRepo();
  const remote = mkdtempSync(path.join(os.tmpdir(), 'acc-sc-remote-'));
  await run(remote, ['init', '--bare', '-b', 'main']);
  await run(seed, ['remote', 'add', 'origin', remote]);
  await run(seed, ['push', '-u', 'origin', 'main']);
  const clone = async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-sc-clone-'));
    await run(dir, ['clone', remote, '.']);
    await run(dir, ['config', 'user.email', 'test@example.com']);
    await run(dir, ['config', 'user.name', 'Test']);
    await run(dir, ['config', 'commit.gpgsign', 'false']);
    return dir;
  };
  return { remote, local: await clone(), other: await clone() };
}

async function commitFile(dir: string, file: string, content: string, message: string) {
  writeFileSync(path.join(dir, file), content);
  await run(dir, ['add', '--', file]);
  await run(dir, ['commit', '-m', message]);
}

let repo: string;
beforeEach(async () => {
  repo = await initRepo();
});

const byPath = <T extends { path: string }>(entries: T[]): Record<string, T> => Object.fromEntries(entries.map((e) => [e.path, e]));

describe('porcelain v2 status', () => {
  it('reports a clean repository with its branch and no upstream', async () => {
    const s = await repositoryStatus(repo);
    expect(s.entries).toEqual([]);
    expect(s.branch).toMatchObject({ head: 'main', detached: false, upstream: null, ahead: null, behind: null });
    expect(s.branch.oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('separates staged, unstaged, staged-and-modified, untracked, added, deleted and renamed', async () => {
    await commitFile(repo, 'gone.txt', 'z\n', 'add gone');
    writeFileSync(path.join(repo, 'a.txt'), 'one\nstaged\n');
    await run(repo, ['add', 'a.txt']);
    writeFileSync(path.join(repo, 'a.txt'), 'one\nstaged\nthen more\n');
    writeFileSync(path.join(repo, 'new file.txt'), 'x\n');
    writeFileSync(path.join(repo, 'added.txt'), 'y\n');
    await run(repo, ['add', 'added.txt']);
    await run(repo, ['mv', 'b.txt', 'renamed.txt']);
    rmSync(path.join(repo, 'gone.txt'));

    const e = byPath((await repositoryStatus(repo)).entries);
    expect(e['a.txt']).toMatchObject({ kind: '1', xy: 'MM' });
    expect(e['new file.txt']).toMatchObject({ kind: '?', xy: '??' });
    expect(e['added.txt']).toMatchObject({ xy: 'A.' });
    expect(e['renamed.txt']).toMatchObject({ kind: '2', xy: 'R.', origPath: 'b.txt' });
    expect(e['gone.txt']).toMatchObject({ xy: '.D' });
  });

  it('keeps file names with spaces, Unicode and special characters intact', async () => {
    const names = ['with space.txt', 'café – ñ.md', 'weird [x] #1 $HOME.txt', 'dir with space/inner file.ts'];
    mkdirSync(path.join(repo, 'dir with space'));
    for (const n of names) writeFileSync(path.join(repo, n), 'x\n');
    const s = await repositoryStatus(repo);
    expect(s.entries.map((e) => e.path).sort()).toEqual([...names].sort());
    await stagePaths(repo, names);
    const staged = (await repositoryStatus(repo)).entries;
    expect(staged.every((e) => e.xy === 'A.')).toBe(true);
  });

  it('parses branch headers including ahead/behind and a detached HEAD', () => {
    const parsed = parsePorcelainV2('# branch.oid abc\0# branch.head (detached)\0# branch.upstream origin/main\0# branch.ab +2 -3\0');
    expect(parsed.branch).toEqual({ oid: 'abc', head: null, detached: true, upstream: 'origin/main', ahead: 2, behind: 3 });
  });

  it('reports a detached HEAD from Git', async () => {
    const head = await headCommit(repo);
    await run(repo, ['checkout', '--detach', head!]);
    const s = await repositoryStatus(repo);
    expect(s.branch.detached).toBe(true);
    expect(s.branch.head).toBeNull();
  });

  it('reports conflicts and the merge in progress', async () => {
    await run(repo, ['switch', '-c', 'side']);
    await commitFile(repo, 'a.txt', 'side\n', 'side');
    await run(repo, ['switch', 'main']);
    await commitFile(repo, 'a.txt', 'main\n', 'main');
    const merge = await git(repo, ['merge', 'side']);
    expect(merge.code).not.toBe(0);
    const s = await repositoryStatus(repo);
    expect(s.entries.find((e) => e.path === 'a.txt')).toMatchObject({ kind: 'u', xy: 'UU' });
    expect(operationInProgress(await absoluteGitDir(repo))).toBe('merge');
  });

  it('handles an unborn repository: status, staging, unstaging, staged diff and first commit', async () => {
    const empty = await initRepo(undefined, false);
    writeFileSync(path.join(empty, 'first.txt'), 'hello\n');
    let s = await repositoryStatus(empty);
    expect(s.branch.oid).toBeNull();
    expect(s.entries).toEqual([expect.objectContaining({ path: 'first.txt', kind: '?' })]);
    expect((await stagePaths(empty, ['first.txt'])).code).toBe(0);
    const diff = await pathDiff(empty, { path: 'first.txt', mode: 'staged', untracked: false, hasHead: false, maxBytes: 100_000 });
    expect(diff.diff).toContain('+hello');
    expect((await lineStats(empty, 'staged', { hasHead: false })).get('first.txt')).toEqual({ additions: 1, deletions: 0 });
    expect((await unstagePaths(empty, ['first.txt'], { hasHead: false })).code).toBe(0);
    s = await repositoryStatus(empty);
    expect(s.entries[0]).toMatchObject({ kind: '?' });
    expect(readFileSync(path.join(empty, 'first.txt'), 'utf8')).toBe('hello\n');
    await stagePaths(empty, ['first.txt']);
    expect((await commitStaged(empty, 'first commit')).code).toBe(0);
    expect(await headCommit(empty)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('index mutations', () => {
  it('stages and unstages exactly the given paths, never touching the worktree', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'A\n');
    writeFileSync(path.join(repo, 'b.txt'), 'B\n');
    await stagePaths(repo, ['a.txt']);
    let e = byPath((await repositoryStatus(repo)).entries);
    expect(e['a.txt']!.xy).toBe('M.');
    expect(e['b.txt']!.xy).toBe('.M');
    await unstagePaths(repo, ['a.txt'], { hasHead: true });
    e = byPath((await repositoryStatus(repo)).entries);
    expect(e['a.txt']!.xy).toBe('.M');
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('A\n');
  });

  it('treats glob characters in names literally', async () => {
    // As a glob, "[ab].txt" would also match a.txt and b.txt.
    writeFileSync(path.join(repo, '[ab].txt'), 'brackets\n');
    writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    await stagePaths(repo, ['[ab].txt']);
    const e = byPath((await repositoryStatus(repo)).entries);
    expect(e['[ab].txt']!.xy).toBe('A.');
    expect(e['a.txt']!.xy).toBe('.M');
  });

  it('stages a deletion and a rename', async () => {
    rmSync(path.join(repo, 'a.txt'));
    renameSync(path.join(repo, 'b.txt'), path.join(repo, 'c.txt'));
    await stagePaths(repo, ['a.txt', 'b.txt', 'c.txt']);
    const e = byPath((await repositoryStatus(repo)).entries);
    expect(e['a.txt']!.xy).toBe('D.');
    expect(e['c.txt']).toMatchObject({ xy: 'R.', origPath: 'b.txt' });
  });

  it('commits only the index and leaves unstaged work', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'A\n');
    writeFileSync(path.join(repo, 'b.txt'), 'B\n');
    await stagePaths(repo, ['a.txt']);
    const before = await headCommit(repo);
    const result = await commitStaged(repo, 'Change a\n\nBody line');
    expect(result.code).toBe(0);
    const after = await headCommit(repo);
    expect(after).not.toBe(before);
    expect((await commitMeta(repo, after!))?.body).toBe('Change a\n\nBody line');
    const e = byPath((await repositoryStatus(repo)).entries);
    expect(Object.keys(e)).toEqual(['b.txt']);
  });

  it('runs hooks and reports their rejection without committing', async () => {
    const hooks = path.join(repo, '.git', 'hooks');
    writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint failed: fix it" >&2\nexit 1\n');
    chmodSync(path.join(hooks, 'pre-commit'), 0o755);
    writeFileSync(path.join(repo, 'a.txt'), 'A\n');
    await stagePaths(repo, ['a.txt']);
    const before = await headCommit(repo);
    const result = await commitStaged(repo, 'blocked');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('lint failed');
    expect(await headCommit(repo)).toBe(before);
    expect((await repositoryStatus(repo)).entries[0]).toMatchObject({ xy: 'M.' });
  });

  it('detects an index lock', async () => {
    const gitDir = await absoluteGitDir(repo);
    writeFileSync(path.join(gitDir, 'index.lock'), '');
    expect(indexLocked(gitDir)).toBe(true);
    writeFileSync(path.join(repo, 'a.txt'), 'A\n');
    const result = await stagePaths(repo, ['a.txt']);
    expect(result.code).not.toBe(0);
    expect(classifyGitOutput(result)).toBe('INDEX_LOCKED');
    rmSync(path.join(gitDir, 'index.lock'));
  });
});

describe('diffs', () => {
  it('returns staged and unstaged sides separately, and untracked files as new files', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'one\nstaged\n');
    await stagePaths(repo, ['a.txt']);
    writeFileSync(path.join(repo, 'a.txt'), 'one\nstaged\nworktree\n');
    writeFileSync(path.join(repo, 'n.txt'), 'new\n');
    const staged = await pathDiff(repo, { path: 'a.txt', mode: 'staged', untracked: false, hasHead: true, maxBytes: 100_000 });
    const unstaged = await pathDiff(repo, { path: 'a.txt', mode: 'unstaged', untracked: false, hasHead: true, maxBytes: 100_000 });
    expect(staged.diff).toContain('+staged');
    expect(staged.diff).not.toContain('+worktree');
    expect(unstaged.diff).toContain('+worktree');
    expect(unstaged.diff).not.toContain('+staged');
    const untracked = await pathDiff(repo, { path: 'n.txt', mode: 'unstaged', untracked: true, hasHead: true, maxBytes: 100_000 });
    expect(untracked.diff).toContain('+new');
    const stats = await lineStats(repo, 'unstaged', { hasHead: true });
    expect(stats.get('a.txt')).toEqual({ additions: 1, deletions: 0 });
  });

  it('flags binary files instead of decoding them', async () => {
    writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 0]));
    await stagePaths(repo, ['img.bin']);
    const d = await pathDiff(repo, { path: 'img.bin', mode: 'staged', untracked: false, hasHead: true, maxBytes: 100_000 });
    expect(d.binary).toBe(true);
    expect(d.diff).toBe('');
  });

  it('truncates a large diff at the byte bound', async () => {
    writeFileSync(path.join(repo, 'big.txt'), Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n'));
    const d = await pathDiff(repo, { path: 'big.txt', mode: 'unstaged', untracked: true, hasHead: true, maxBytes: 10_000 });
    expect(d.truncated).toBe(true);
    expect(d.diff.length).toBeLessThanOrEqual(10_001);
  });

  it('extracts staged file names and added lines for the preflight', async () => {
    writeFileSync(path.join(repo, '.env'), 'TOKEN=abc\n');
    await stagePaths(repo, ['.env']);
    const { patch } = await stagedPatch(repo, { hasHead: true, maxBytes: 100_000 });
    const split = splitPatch(patch);
    expect(split.files).toEqual(['.env']);
    expect(split.added).toBe('TOKEN=abc');
  });

  it('reads quoted and space-split file names in patch headers, and lists pushed files with -z (audit F-47)', async () => {
    mkdirSync(path.join(repo, 'x b'));
    writeFileSync(path.join(repo, 'x b', 'c.txt'), 'one\n');
    writeFileSync(path.join(repo, 'café.env'), 'two\n');
    await stagePaths(repo, ['x b/c.txt', 'café.env']);
    const { patch } = await stagedPatch(repo, { hasHead: true, maxBytes: 100_000 });
    expect(splitPatch(patch).files.sort()).toEqual(['café.env', 'x b/c.txt']);
    // Quotes, backslashes and control characters are C-quoted by git (not legal in Windows names, so synthetic here).
    expect(patchHeaderPath('diff --git "a/we\\"ird\\tname" "b/we\\"ird\\tname"')).toBe('we"ird\tname');
    expect(patchHeaderPath('diff --git a/plain.txt b/plain.txt')).toBe('plain.txt');
    await run(repo, ['commit', '-q', '-m', 'odd names']);
    expect((await outgoingFiles(repo, { tip: 'HEAD', exclude: 'HEAD~1' })).sort()).toEqual(['café.env', 'x b/c.txt']);
  });
});

describe('history', () => {
  it('pages history with parents, refs and a stable order', async () => {
    for (let i = 0; i < 5; i++) await commitFile(repo, 'a.txt', `v${i}\n`, `commit ${i}`);
    await run(repo, ['tag', 'v1']);
    const page1 = await historyPage(repo, { tips: ['HEAD'], skip: 0, limit: 3 });
    const page2 = await historyPage(repo, { tips: ['HEAD'], skip: 3, limit: 3 });
    expect(page1.map((c) => c.subject)).toEqual(['commit 4', 'commit 3', 'commit 2']);
    expect(page2.map((c) => c.subject)).toEqual(['commit 1', 'commit 0', 'init']);
    expect(page1[0]!.refs).toEqual(expect.arrayContaining([{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'branch' }, { name: 'v1', kind: 'tag' }]));
    expect(page1[0]!.parents).toEqual([page1[1]!.sha]);
    expect(page2.at(-1)!.parents).toEqual([]);
  });

  it('lists the files of a commit, including the root commit, and their diffs', async () => {
    await run(repo, ['mv', 'b.txt', 'c.txt']);
    writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    await run(repo, ['add', '-A']);
    await run(repo, ['commit', '-m', 'rename and edit']);
    const head = (await headCommit(repo))!;
    const { files } = await commitFiles(repo, head, 100);
    expect(files).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', originalPath: null, status: 'modified', additions: 1, deletions: 1 },
        expect.objectContaining({ path: 'c.txt', originalPath: 'b.txt', status: 'renamed' }),
      ]),
    );
    const root = (await historyPage(repo, { tips: ['HEAD'], skip: 1, limit: 1 }))[0]!.sha;
    expect((await commitFiles(repo, root, 100)).files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    const diff = await commitFileDiff(repo, { sha: head, path: 'a.txt', originalPath: null, maxBytes: 100_000 });
    expect(diff.diff).toContain('+two');
    const since = await commitsSince(repo, root, head, 10);
    expect(since.map((c) => c.message)).toEqual(['rename and edit']);
  });
});

describe('remote operations', () => {
  it('fetches, reports behind, fast-forwards, pushes and detects divergence', async () => {
    const { local, other } = await withRemote();
    expect(await listRemotes(local)).toEqual(['origin']);
    let s = await repositoryStatus(local);
    expect(s.branch).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 });

    // Remote advances → fetch → behind → fast-forward.
    await commitFile(other, 'remote.txt', 'r\n', 'remote change');
    await run(other, ['push']);
    expect((await fetchRemote(local, 'origin')).code).toBe(0);
    s = await repositoryStatus(local);
    expect(s.branch).toMatchObject({ ahead: 0, behind: 1 });
    expect((await fastForward(local, 'origin/main')).code).toBe(0);
    s = await repositoryStatus(local);
    expect(s.branch).toMatchObject({ ahead: 0, behind: 0 });

    // Local commit → ahead → push → synced.
    await commitFile(local, 'local.txt', 'l\n', 'local change');
    s = await repositoryStatus(local);
    expect(s.branch.ahead).toBe(1);
    const outgoing = await outgoingPatch(local, { tip: 'HEAD', exclude: 'origin/main', maxBytes: 100_000 });
    expect(outgoing.commits).toBe(1);
    expect(splitPatch(outgoing.patch).files).toEqual(['local.txt']);
    const push = await pushRef(local, { remote: 'origin', localBranch: 'main', remoteRef: 'refs/heads/main', setUpstream: false });
    expect(push.code).toBe(0);
    expect(push.lines[0]).toMatchObject({ flag: ' ', to: 'refs/heads/main' });
    s = await repositoryStatus(local);
    expect(s.branch).toMatchObject({ ahead: 0, behind: 0 });

    // Both advance → diverged → fast-forward refuses, push is rejected.
    await run(other, ['pull', '--ff-only']);
    await commitFile(other, 'other.txt', 'o\n', 'other');
    await run(other, ['push']);
    await commitFile(local, 'mine.txt', 'm\n', 'mine');
    await fetchRemote(local, 'origin');
    s = await repositoryStatus(local);
    expect(s.branch).toMatchObject({ ahead: 1, behind: 1 });
    const ff = await fastForward(local, 'origin/main');
    expect(ff.code).not.toBe(0);
    expect(classifyGitOutput(ff)).toBe('DIVERGED');
    const rejected = await pushRef(local, { remote: 'origin', localBranch: 'main', remoteRef: 'refs/heads/main', setUpstream: false });
    expect(rejected.code).not.toBe(0);
    expect(rejected.lines[0]?.flag).toBe('!');
    expect(classifyGitOutput(rejected)).toBe('REMOTE_REJECTED');
  });

  it('publishes a branch with no upstream and records the upstream', async () => {
    const { local } = await withRemote();
    await run(local, ['switch', '-c', 'feature/x']);
    await commitFile(local, 'f.txt', 'f\n', 'feature');
    expect((await repositoryStatus(local)).branch.upstream).toBeNull();
    const outgoing = await outgoingPatch(local, { tip: 'HEAD', exclude: null, maxBytes: 100_000 });
    expect(outgoing.commits).toBe(1);
    const push = await pushRef(local, { remote: 'origin', localBranch: 'feature/x', remoteRef: 'refs/heads/feature/x', setUpstream: true });
    expect(push.code).toBe(0);
    expect((await repositoryStatus(local)).branch).toMatchObject({ upstream: 'origin/feature/x', ahead: 0, behind: 0 });
  });

  it('classifies an unreachable remote as a network failure', async () => {
    await run(repo, ['remote', 'add', 'origin', path.join(os.tmpdir(), 'acc-does-not-exist', 'nope.git')]);
    const result = await fetchRemote(repo, 'origin');
    expect(result.code).not.toBe(0);
    // Git answers "Could not read from remote repository" for a path that is not a repository.
    expect(classifyGitOutput(result)).toBe('NETWORK');
  });
});

describe('failure classification', () => {
  it('maps representative Git messages', () => {
    const c = (stderr: string) => classifyGitOutput({ stdout: '', stderr });
    expect(c("fatal: Authentication failed for 'https://x'")).toBe('REMOTE_AUTH_FAILED');
    expect(c('fatal: could not read Username for https://github.com: terminal prompts disabled')).toBe('REMOTE_AUTH_FAILED');
    expect(c('ssh: Could not resolve host: github.com')).toBe('NETWORK');
    expect(c(' ! [rejected]        main -> main (fetch first)')).toBe('REMOTE_REJECTED');
    expect(c('*** Please tell me who you are.')).toBe('IDENTITY_MISSING');
    expect(c('error: gpg failed to sign the data')).toBe('SIGNING_FAILED');
    expect(c('fatal: Not possible to fast-forward, aborting.')).toBe('DIVERGED');
    expect(c('something odd')).toBe('GIT_FAILED');
  });
});

describe('remote identity', () => {
  it('recognises a remote that says the repository does not exist', () => {
    expect(remoteMissing({ stdout: '', stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found" })).toBe(true);
    expect(remoteMissing({ stdout: '', stderr: "fatal: 'C:/gone' does not appear to be a git repository" })).toBe(true);
    expect(remoteMissing({ stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.com' })).toBe(false);
    expect(remoteMissing({ stdout: '', stderr: 'fatal: Authentication failed' })).toBe(false);
  });

  it('keys a remote by host and owner, never keeping credentials', () => {
    expect(remoteOwnerKey('https://github.com/Digitronics2025/wholesale-app.git')).toBe('github.com/digitronics2025');
    expect(remoteOwnerKey('https://user:tok3n@github.com/TenTen-maroc/rihla.git')).toBe('github.com/tenten-maroc');
    expect(remoteOwnerKey('git@github.com:TenTen-maroc/rihla.git')).toBe('github.com/tenten-maroc');
    expect(remoteOwnerKey('ssh://git@gitlab.example.com:2222/team/app.git')).toBe('gitlab.example.com/team');
    expect(remoteOwnerKey('C:\\Users\\me\\remotes\\app.git')).toBe('local:c:/users/me/remotes');
    expect(remoteOwnerKey('/srv/git/app.git')).toBe('local:/srv/git');
    expect(remoteOwnerKey('')).toBeNull();
  });
});
