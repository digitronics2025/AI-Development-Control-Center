import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redact } from '@acc/security';
import { addDetachedWorktree, commitPaths, createTaskBranch, git, headCommit, patchBetween, patchSince, snapshot, type GitSnapshot } from '../src/index.js';

/**
 * git-diff.patch must be a patch Git takes back, carrying no binary payload
 * and no secret (docs/systems/git.md#applicable-patches). core.autocrlf is
 * off in every repository here, so the bytes committed are the bytes on disk.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

async function sh(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A committed repository holding CRLF text and binary files; the task branch is checked out. */
async function taskRepo(dir = tempDir('acc-patch-repo-')): Promise<{ repo: string; baseline: GitSnapshot }> {
  mkdirSync(dir, { recursive: true });
  await sh(dir, ['init', '-b', 'main']);
  for (const [key, value] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) await sh(dir, ['config', key!, value!]);
  writeFileSync(path.join(dir, 'run.bat'), 'echo one\r\necho two\r\n');
  writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 13, 10]));
  writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
  writeFileSync(path.join(dir, 'old.txt'), Array.from({ length: 8 }, (_, i) => `line ${i + 1}\n`).join(''));
  await sh(dir, ['add', '.']);
  await sh(dir, ['commit', '-m', 'init']);
  const baseline = await snapshot(dir);
  await createTaskBranch(dir, 'ai/TASK-0001-patch');
  return { repo: dir, baseline };
}

function writePatch(patch: Buffer): string {
  const file = path.join(tempDir('acc-patch-file-'), 'git-diff.patch');
  writeFileSync(file, patch);
  return file;
}

/** Every file under `dir` but Git's own, with its bytes. */
function tree(dir: string, rel = ''): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [k, v] of tree(dir, name)) files.set(k, v);
    else files.set(name, readFileSync(path.join(dir, name)));
  }
  return files;
}

/**
 * The patch reverses out of the task's checkout, and applied to a baseline
 * checkout reproduces it byte for byte — binary sections through the object
 * ids patchSince stored, with nothing committed. `skip` names files a note
 * replaced (withheld), which the baseline side then keeps as they were.
 */
async function expectApplies(repo: string, baseline: GitSnapshot, patch: Buffer, skip: string[] = []): Promise<void> {
  const file = writePatch(patch);
  const reverse = await git(repo, ['apply', '--check', '-R', file]);
  expect(reverse.code, reverse.stderr).toBe(0);
  const base = path.join(tempDir('acc-patch-base-'), 'base');
  await addDetachedWorktree(repo, base, baseline.head!);
  const forward = await git(base, ['apply', file]);
  expect(forward.code, forward.stderr).toBe(0);
  const want = tree(repo);
  const got = tree(base);
  for (const name of skip) {
    want.delete(name);
    got.delete(name);
  }
  expect(got).toEqual(want);
}

const cases: Array<[string, (repo: string) => Promise<void> | void]> = [
  ['a file committed with CRLF endings changed', (repo) => writeFileSync(path.join(repo, 'run.bat'), 'echo one\r\necho three\r\n')],
  ['a binary file changed', (repo) => writeFileSync(path.join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 4, 0, 255, 13, 10, 7]))],
  ['a binary file added', (repo) => writeFileSync(path.join(repo, 'added.bin'), Buffer.from([0, 0, 9, 200, 13, 10]))],
  ['an untracked text file added', (repo) => writeFileSync(path.join(repo, 'notes.txt'), 'hello\n')],
  ['an untracked CRLF file and an empty file added', (repo) => {
    writeFileSync(path.join(repo, 'new.bat'), 'a\r\nb\r\n');
    writeFileSync(path.join(repo, 'empty.txt'), '');
  }],
  ['a file deleted', (repo) => rmSync(path.join(repo, 'gone.txt'))],
  ['a file renamed on the task branch', async (repo) => {
    await sh(repo, ['mv', 'old.txt', 'new.txt']);
    await sh(repo, ['commit', '-m', 'rename']);
  }],
  ['a path with spaces and non-ASCII letters added', (repo) => {
    mkdirSync(path.join(repo, 'dir with space'));
    writeFileSync(path.join(repo, 'dir with space', 'café.txt'), 'olé\n');
  }],
];

describe('patchSince', () => {
  it.each(cases)('applies when %s', async (_name, change) => {
    const { repo, baseline } = await taskRepo();
    await change(repo);
    const { patch, dropped, withheld } = await patchSince(repo, baseline, { maxBytes: 5_000_000, redactText: redact });
    expect([dropped, withheld]).toEqual([[], []]);
    expect(patch.length).toBeGreaterThan(0);
    await expectApplies(repo, baseline, patch);
  });

  it('keeps CRLF bytes and carries binary files by object id only', async () => {
    const { repo, baseline } = await taskRepo();
    for (const [, change] of cases) await change(repo);
    const { patch } = await patchSince(repo, baseline, { maxBytes: 5_000_000 });
    const text = patch.toString('latin1');
    expect(text).toContain('+echo three\r\n');
    expect(text).toContain('rename from old.txt');
    expect(text).toMatch(/^index [0-9a-f]{40}\.\.[0-9a-f]{40}/m);
    expect(text).toContain('Binary files a/logo.bin and b/logo.bin differ');
    expect(text).not.toContain('GIT binary patch');
    await expectApplies(repo, baseline, patch);
  });

  it('carries no bytes of a binary file a diff attribute prints as text, nor of a non-UTF-8 file', async () => {
    const { repo, baseline } = await taskRepo();
    writeFileSync(path.join(repo, '.gitattributes'), '*.key diff\n');
    const key = Buffer.from([0x9f, 0x01, 0xff, 0xfe, 0x42, 0x13, 0x77, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1]);
    writeFileSync(path.join(repo, 'data.raw'), key);
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]);
    writeFileSync(path.join(repo, 'latin.txt'), latin);
    const { patch } = await patchSince(repo, baseline, { maxBytes: 5_000_000, redactText: redact });
    expect(patch.includes(key.subarray(2, 8))).toBe(false);
    expect(patch.includes(latin)).toBe(false);
    expect(patch.toString('latin1')).toContain('Binary files /dev/null and b/data.raw differ');
    await expectApplies(repo, baseline, patch);
  });

  it('withholds a file holding a secret with a note, and the rest still applies', async () => {
    const { repo, baseline } = await taskRepo();
    // Assembled at runtime: no credential-shaped literal in the repository (AGENTS.md).
    const secret = ['ghp', '_', 'A1b2C3d4'.repeat(5)].join('');
    const pem = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    writeFileSync(path.join(repo, 'config.env'), `TOKEN=${secret}\r\n`);
    writeFileSync(path.join(repo, 'deploy.pem'), `${pem}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${pem.replace('BEGIN', 'END')}\n`);
    writeFileSync(path.join(repo, 'run.bat'), 'echo one\r\necho three\r\n');
    const { patch, withheld } = await patchSince(repo, baseline, { maxBytes: 5_000_000, redactText: redact });
    const text = patch.toString('latin1');
    expect(withheld.sort()).toEqual(['config.env', 'deploy.pem']);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(text).toContain('[withheld from git-diff.patch: config.env held secret-shaped content]');
    // No object id of a withheld file remains (no way to confirm a guessed secret offline).
    expect(text).not.toMatch(/b\/config\.env\nindex/);
    await expectApplies(repo, baseline, patch, ['config.env', 'deploy.pem']);
  });

  it("is not changed by the user's own diff settings", async () => {
    const { repo, baseline } = await taskRepo();
    for (const [key, value] of [['diff.noprefix', 'true'], ['diff.context', '0'], ['diff.srcPrefix', 'x/'], ['diff.dstPrefix', 'y/z/'], ['diff.submodule', 'log'], ['diff.mnemonicPrefix', 'true']]) await sh(repo, ['config', key!, value!]);
    writeFileSync(path.join(repo, 'old.txt'), Array.from({ length: 8 }, (_, i) => `line ${i === 4 ? 'five' : i + 1}\n`).join(''));
    const { patch } = await patchSince(repo, baseline, { maxBytes: 5_000_000 });
    expect(patch.toString('latin1')).toContain('diff --git a/old.txt b/old.txt');
    await expectApplies(repo, baseline, patch);
  });

  it('never keeps part of a file: files past the bound are named, not cut', async () => {
    const { repo, baseline } = await taskRepo();
    for (const [, change] of cases) await change(repo);
    const whole = (await patchSince(repo, baseline, { maxBytes: 5_000_000 })).patch;
    const lastFile = whole.lastIndexOf(Buffer.from('\ndiff --git ')) + 1;
    const { patch, dropped } = await patchSince(repo, baseline, { maxBytes: lastFile + 20 });
    expect(patch.equals(whole.subarray(0, lastFile))).toBe(true);
    expect(dropped.length).toBe(1);
    // A first file alone over the bound is left out whole.
    const small = await patchSince(repo, baseline, { maxBytes: 40 });
    expect(small.patch.length).toBe(0);
    expect(small.dropped.length).toBeGreaterThan(0);
  });

  it('puts every path under a folder, so the text of several repositories applies from their parent', async () => {
    const parent = tempDir('acc-patch-multi-');
    const units: Array<{ folder: string; repo: string; baseline: GitSnapshot }> = [];
    for (const folder of ['web', 'api']) {
      const { repo, baseline } = await taskRepo(path.join(parent, folder));
      writeFileSync(path.join(repo, 'run.bat'), 'echo one\r\necho three\r\n');
      writeFileSync(path.join(repo, 'notes.txt'), `${folder}\n`);
      rmSync(path.join(repo, 'gone.txt'));
      await sh(repo, ['mv', 'old.txt', 'new.txt']);
      units.push({ folder, repo, baseline });
    }
    const parts: Buffer[] = [];
    for (const unit of units) parts.push((await patchSince(unit.repo, unit.baseline, { maxBytes: 5_000_000, prefix: unit.folder })).patch);
    const file = writePatch(Buffer.concat(parts));
    const text = readFileSync(file, 'latin1');
    expect(text).toContain('diff --git a/web/run.bat b/web/run.bat');
    expect(text).not.toContain('rename from');
    const baseParent = tempDir('acc-patch-multi-base-');
    for (const unit of units) await addDetachedWorktree(unit.repo, path.join(baseParent, unit.folder), unit.baseline.head!);
    // Outside a repository Git applies the machine's own core.autocrlf; pin it so bytes compare exactly.
    const forward = await git(baseParent, ['-c', 'core.autocrlf=false', 'apply', file]);
    expect(forward.code, forward.stderr).toBe(0);
    for (const unit of units) expect(tree(path.join(baseParent, unit.folder))).toEqual(tree(unit.repo));
  });
});

describe('patchSince secrets and names (second review round)', () => {
  const secret = ['ghp', '_', 'A1b2C3d4'.repeat(5)].join('');

  it('withholds a UTF-16 file holding a secret, and keeps no object id of it', async () => {
    const { repo, baseline } = await taskRepo();
    writeFileSync(path.join(repo, 'bom.txt'), Buffer.from(`\ufeffTOKEN=${secret}\r\n`, 'utf16le'));
    writeFileSync(path.join(repo, 'nobom.txt'), Buffer.from(`TOKEN=${secret}\r\n`, 'utf16le'));
    writeFileSync(path.join(repo, 'big-endian.txt'), Buffer.from(`TOKEN=${secret}\r\n`, 'utf16le').swap16());
    writeFileSync(path.join(repo, 'late-nul.txt'), Buffer.concat([Buffer.from(`${'x'.repeat(9000)}\nTOKEN=${secret}\n`), Buffer.from([0])]));
    writeFileSync(path.join(repo, 'run.bat'), 'echo one\r\necho three\r\n');
    const { patch, withheld } = await patchSince(repo, baseline, { maxBytes: 5_000_000, redactText: redact });
    expect(withheld.sort()).toEqual(['big-endian.txt', 'bom.txt', 'late-nul.txt', 'nobom.txt']);
    expect(patch.toString('latin1')).not.toMatch(/b\/(bom|nobom|big-endian|late-nul)\.txt\n(new file mode.*\n)?index/);
    await expectApplies(repo, baseline, patch, ['big-endian.txt', 'bom.txt', 'late-nul.txt', 'nobom.txt']);
  });

  it('withholds secret material by name and private-key context lines, whatever the redactor sees', async () => {
    const { repo, baseline } = await taskRepo();
    const pem = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    writeFileSync(path.join(repo, 'bundle.crt'), `${pem}\nAAAA\nBBBB\n${pem.replace('BEGIN', 'END')}\ncert one\n`);
    await sh(repo, ['add', 'bundle.crt']);
    await sh(repo, ['commit', '-m', 'bundle']);
    const base2 = await snapshot(repo);
    writeFileSync(path.join(repo, 'bundle.crt'), `${pem}\nAAAA\nBBBB\n${pem.replace('BEGIN', 'END')}\ncert two\n`);
    writeFileSync(path.join(repo, '.env'), 'DB_PASS=correct-horse-battery-staple\n');
    const { patch, withheld } = await patchSince(repo, base2, { maxBytes: 5_000_000, redactText: redact });
    expect(withheld.sort()).toEqual(['.env', 'bundle.crt']);
    expect(patch.toString('latin1')).not.toContain('BBBB');
    expect(patch.toString('latin1')).not.toContain('correct-horse');
    void baseline;
  });

  it('redacts names on the not-included list, and names every file an overflow never read', async () => {
    const { repo, baseline } = await taskRepo();
    writeFileSync(path.join(repo, `dump-${secret}.sql`), `${'y'.repeat(60_000)}\n`);
    for (let i = 0; i < 4; i++) writeFileSync(path.join(repo, `later-${i}.txt`), `${i}\n`);
    const { patch, dropped } = await patchSince(repo, baseline, { maxBytes: 10_000, redactText: redact });
    expect(dropped.join(' ')).not.toContain(secret);
    expect(dropped.some((d) => d.includes('[REDACTED]'))).toBe(true);
    for (let i = 0; i < 4; i++) expect(patch.toString('latin1').includes(`later-${i}.txt`) || dropped.includes(`later-${i}.txt`)).toBe(true);
  });

  it('names an untracked nested repository instead of leaving it out silently', async () => {
    const { repo, baseline } = await taskRepo();
    const nested = path.join(repo, 'nested');
    mkdirSync(nested);
    await sh(nested, ['init', '-b', 'main']);
    writeFileSync(path.join(nested, 'x.txt'), 'x\n');
    writeFileSync(path.join(repo, 'notes.txt'), 'hello\n');
    const { patch, dropped } = await patchSince(repo, baseline, { maxBytes: 5_000_000, redactText: redact });
    expect(dropped.some((d) => d.startsWith('nested'))).toBe(true);
    expect(patch.toString('latin1')).toContain('b/notes.txt');
  });

  it('never stores what a symbolic link points at', async () => {
    const { repo, baseline } = await taskRepo();
    const outside = path.join(tempDir('acc-patch-outside-'), 'secret.json');
    writeFileSync(outside, '{"refresh":"opaque-operator-value-kept-outside"}');
    const { symlinkSync } = await import('node:fs');
    try {
      symlinkSync(outside, path.join(repo, 'link.bin'));
    } catch {
      return; // No symlink permission on this machine: nothing to prove here.
    }
    const outsideId = (await sh(repo, ['hash-object', outside])).trim();
    await patchSince(repo, baseline, { maxBytes: 5_000_000, redactText: redact });
    expect((await git(repo, ['cat-file', '-e', outsideId])).code).not.toBe(0);
  });
});

describe('patchBetween', () => {
  it('describes exactly what was committed, even when a pre-commit hook rewrote a file', async () => {
    const { repo, baseline } = await taskRepo();
    // A formatting hook: rewrites app.js as it is committed.
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nprintf "const a = 1;\\nconst b = 2;\\n" > app.js\ngit add app.js\n');
    chmodSync(hook, 0o755);
    writeFileSync(path.join(repo, 'app.js'), 'const a=1\n');
    writeFileSync(path.join(repo, 'logo.bin'), Buffer.from([9, 9, 0, 9]));
    await commitPaths(repo, ['app.js', 'logo.bin'], 'task work');
    const tip = (await headCommit(repo))!;
    const { patch } = await patchBetween(repo, baseline.head, tip, { maxBytes: 5_000_000, redactText: redact });
    expect(patch.toString('latin1')).toContain('+const b = 2;');
    await expectApplies(repo, baseline, patch);
  });

  it('refuses anything but commit ids', async () => {
    const { repo } = await taskRepo();
    await expect(patchBetween(repo, 'HEAD~1', 'HEAD', { maxBytes: 1000 })).rejects.toThrow(/Not a commit id/);
  });
});
