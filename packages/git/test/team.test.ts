import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addChildWorktree,
  addWorktree,
  applyIfUnchanged,
  captureResult,
  changedPathsBetween,
  combineResults,
  committableTree,
  createWaveBase,
  currentBranch,
  git,
  removeWorktree,
  status,
  treeOf,
} from '../src/index.js';

/**
 * Stage Team isolation (docs/plans/STAGE_TEAMS_PLAN.md §3.7, §7.3), on real
 * repositories: an operator checkout, the task's worktree with uncommitted
 * work, and two workers in their own detached checkouts.
 */

let repo: string;
let task: string;
let root: string;

async function sh(cwd: string, args: string[]) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout;
}

/** Text as written, with CRLF read as LF: what a checkout with this machine's autocrlf may turn it into. */
const text = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const BINARY = Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 10]);

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'acc-team-'));
  repo = path.join(root, 'operator');
  mkdirSync(repo);
  await sh(repo, ['init', '-b', 'main']);
  await sh(repo, ['config', 'user.email', 'test@example.com']);
  await sh(repo, ['config', 'user.name', 'Test']);
  await sh(repo, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(repo, 'api'));
  mkdirSync(path.join(repo, 'web'));
  writeFileSync(path.join(repo, 'api', 'server.ts'), 'export const port = 1;\n');
  writeFileSync(path.join(repo, 'api', 'old.ts'), 'export const old = true;\n');
  writeFileSync(path.join(repo, 'web', 'page.ts'), 'export const title = "a";\r\nexport const crlf = true;\r\n');
  writeFileSync(path.join(repo, 'web', 'gone.ts'), 'export const gone = 1;\n');
  writeFileSync(path.join(repo, 'README.md'), '# repo\n');
  await sh(repo, ['add', '.']);
  await sh(repo, ['commit', '-m', 'init']);
  // The operator has their own uncommitted work in their checkout; a team must never touch it.
  writeFileSync(path.join(repo, 'README.md'), '# repo — operator draft\n');
  task = path.join(root, 'task');
  await addWorktree(repo, task, 'ai/TASK-0001');
  // The task's own uncommitted and untracked work, before the team stage.
  writeFileSync(path.join(task, 'api', 'server.ts'), 'export const port = 2;\n');
  writeFileSync(path.join(task, 'notes.md'), 'untracked task note\n');
});

async function worker(name: string, base: string, work: (dir: string) => void, cwd = task): Promise<{ dir: string; result: string }> {
  const dir = path.join(root, 'children', name);
  await addChildWorktree(cwd, dir, base);
  work(dir);
  const { commit } = await captureResult(dir, `refs/acc/team/TASK-0001/s1/${name}`, name);
  return { dir, result: commit };
}

describe('Stage Team write isolation', () => {
  it('gives each worker the task as it is, and integrates disjoint results — new, deleted, renamed, binary and CRLF files — into the task only', async () => {
    const operatorStatus = await status(repo);
    // Whatever line endings this machine's Git checked the task out with, a renamed file keeps its bytes.
    const oldBytes = readFileSync(path.join(task, 'api', 'old.ts'));
    const base = await createWaveBase(task, 'refs/acc/team/TASK-0001/s1/w1-base', 'base');

    const api = await worker('api', base.commit, (dir) => {
      // The child starts from the task's uncommitted and untracked work, in this machine's line-ending convention.
      expect(text(path.join(dir, 'api', 'server.ts'))).toBe('export const port = 2;\n');
      expect(text(path.join(dir, 'notes.md'))).toBe('untracked task note\n');
      writeFileSync(path.join(dir, 'api', 'server.ts'), 'export const port = 3;\n');
      writeFileSync(path.join(dir, 'api', 'routes.ts'), 'export const routes = [];\n');
      renameSync(path.join(dir, 'api', 'old.ts'), path.join(dir, 'api', 'renamed.ts'));
      writeFileSync(path.join(dir, 'api', 'logo.bin'), BINARY);
    });
    const web = await worker('web', base.commit, (dir) => {
      // A file written with CRLF has CRLF in the checkout too, whatever autocrlf says.
      expect(readFileSync(path.join(dir, 'web', 'page.ts'), 'utf8')).toContain('\r\n');
      writeFileSync(path.join(dir, 'web', 'page.ts'), 'export const title = "b";\r\nexport const crlf = true;\r\n');
      rmSync(path.join(dir, 'web', 'gone.ts'));
    });

    const apiChanges = await changedPathsBetween(task, base.commit, api.result);
    const webChanges = await changedPathsBetween(task, base.commit, web.result);
    expect(apiChanges.map((c) => `${c.status} ${c.path}`).sort()).toEqual(['A api/logo.bin', 'A api/renamed.ts', 'A api/routes.ts', 'D api/old.ts', 'M api/server.ts']);
    expect(webChanges.map((c) => `${c.status} ${c.path}`).sort()).toEqual(['D web/gone.ts', 'M web/page.ts']);

    // Nothing reached the task yet.
    expect(readFileSync(path.join(task, 'api', 'server.ts'), 'utf8')).toBe('export const port = 2;\n');

    const combined = await combineResults(task, base.commit, [{ changes: apiChanges }, { changes: webChanges }], 'refs/acc/team/TASK-0001/s1/w1-combined', 'combined');
    const applied = await applyIfUnchanged(task, base.exactTree, combined.commit, [...apiChanges, ...webChanges]);
    expect(applied).not.toBeNull();
    expect([...applied!.restored].sort()).toEqual(['api/logo.bin', 'api/renamed.ts', 'api/routes.ts', 'api/server.ts', 'web/page.ts']);
    expect([...applied!.removed].sort()).toEqual(['api/old.ts', 'web/gone.ts']);

    expect(text(path.join(task, 'api', 'server.ts'))).toBe('export const port = 3;\n');
    expect(text(path.join(task, 'api', 'routes.ts'))).toBe('export const routes = [];\n');
    expect(readFileSync(path.join(task, 'api', 'renamed.ts')).equals(oldBytes)).toBe(true);
    expect(existsSync(path.join(task, 'api', 'old.ts'))).toBe(false);
    expect(readFileSync(path.join(task, 'api', 'logo.bin')).equals(BINARY)).toBe(true);
    expect(readFileSync(path.join(task, 'web', 'page.ts'), 'utf8')).toBe('export const title = "b";\r\nexport const crlf = true;\r\n');
    expect(existsSync(path.join(task, 'web', 'gone.ts'))).toBe(false);
    // The task's own untracked note is still there, byte for byte.
    expect(readFileSync(path.join(task, 'notes.md'), 'utf8')).toBe('untracked task note\n');

    // The operator's checkout: same branch, same status, same uncommitted work.
    expect(await currentBranch(repo)).toBe('main');
    expect(await status(repo)).toEqual(operatorStatus);
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# repo — operator draft\n');

    for (const dir of [api.dir, web.dir]) expect(await removeWorktree(task, dir, { force: true })).toBe(true);
  });

  it('integrates nothing when the task changed after the wave started', async () => {
    const base = await createWaveBase(task, 'refs/acc/team/TASK-0001/s1/w1-base', 'base');
    const w = await worker('api', base.commit, (dir) => writeFileSync(path.join(dir, 'api', 'server.ts'), 'export const port = 9;\n'));
    const changes = await changedPathsBetween(task, base.commit, w.result);
    const combined = await combineResults(task, base.commit, [{ changes }], 'refs/acc/team/TASK-0001/s1/w1-combined', 'combined');
    // Something else wrote to the task in the meantime.
    writeFileSync(path.join(task, 'web', 'page.ts'), 'export const title = "someone else";\n');
    expect(await applyIfUnchanged(task, base.exactTree, combined.commit, changes)).toBeNull();
    expect(readFileSync(path.join(task, 'api', 'server.ts'), 'utf8')).toBe('export const port = 2;\n');
    expect(readFileSync(path.join(task, 'web', 'page.ts'), 'utf8')).toBe('export const title = "someone else";\n');
  });

  it('refuses to combine two workers that changed the same file', async () => {
    const base = await createWaveBase(task, 'refs/acc/team/TASK-0001/s1/w1-base', 'base');
    const a = await worker('a', base.commit, (dir) => writeFileSync(path.join(dir, 'README.md'), 'a\n'));
    const b = await worker('b', base.commit, (dir) => writeFileSync(path.join(dir, 'README.md'), 'b\n'));
    const parts = [{ changes: await changedPathsBetween(task, base.commit, a.result) }, { changes: await changedPathsBetween(task, base.commit, b.result) }];
    await expect(combineResults(task, base.commit, parts, 'refs/acc/team/TASK-0001/s1/w1-combined', 'combined')).rejects.toThrow(/Two work units changed README.md/);
  });

  it('keeps worker results on hidden refs only, and rejects refs and objects it did not make', async () => {
    const base = await createWaveBase(task, 'refs/acc/team/TASK-0001/s1/w1-base', 'base');
    expect(await treeOf(task, base.commit)).toBe(base.tree);
    // The base sits on the task's own commit, so `git diff <base>` in a child shows only the task's and the worker's work.
    expect(base.head).toBe((await sh(task, ['rev-parse', 'HEAD'])).trim());
    expect((await sh(task, ['rev-parse', `${base.commit}^`])).trim()).toBe(base.head);
    const branches = await sh(repo, ['branch', '--list']);
    expect(branches).not.toContain('team');
    await expect(combineResults(task, base.commit, [], 'refs/heads/main', 'x')).rejects.toThrow(/Invalid team ref/);
    await expect(createWaveBase(task, 'refs/heads/main', 'x')).rejects.toThrow(/Invalid team ref/);
    await expect(treeOf(task, 'HEAD; rm -rf /')).rejects.toThrow(/Not an object id/);
  });
});

/**
 * TASK-0018: with core.autocrlf=true (Git for Windows' default) the task's
 * files are CRLF on disk. A byte-exact base put CRLF blobs into every child,
 * so `git diff` there listed every file and workers "fixed" line endings.
 */
describe('Stage Team line endings (core.autocrlf=true)', () => {
  let crlfRepo: string;
  let crlfTask: string;
  const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 10, 10]);
  const PNG2 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 13, 10]);
  const eolOf = (listing: string, file: string) => listing.split('\n').find((l) => l.endsWith(`\t${file}`)) ?? '';
  const blobOf = async (cwd: string, content: string) => (await git(cwd, ['hash-object', '--stdin'], { stdin: content })).stdout.trim();

  beforeEach(async () => {
    crlfRepo = path.join(root, 'crlf-operator');
    mkdirSync(crlfRepo);
    await sh(crlfRepo, ['init', '-b', 'main']);
    for (const [key, value] of [
      ['user.email', 'test@example.com'],
      ['user.name', 'Test'],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'true'],
    ]) {
      await sh(crlfRepo, ['config', key!, value!]);
    }
    mkdirSync(path.join(crlfRepo, 'api'));
    mkdirSync(path.join(crlfRepo, 'web'));
    mkdirSync(path.join(crlfRepo, 'assets'));
    writeFileSync(path.join(crlfRepo, 'api', 'server.ts'), 'export const port = 1;\nexport const host = "x";\n');
    writeFileSync(path.join(crlfRepo, 'api', 'client.ts'), 'export const client = 1;\n');
    writeFileSync(path.join(crlfRepo, 'web', 'page.ts'), 'export const title = "a";\n');
    writeFileSync(path.join(crlfRepo, 'web', 'gone.ts'), 'export const gone = 1;\n');
    writeFileSync(path.join(crlfRepo, 'assets', 'logo.png'), PNG);
    await sh(crlfRepo, ['add', '.']);
    await sh(crlfRepo, ['commit', '-m', 'init']);
    crlfTask = path.join(root, 'crlf-task');
    await addWorktree(crlfRepo, crlfTask, 'ai/TASK-0002');
    // The task's own work before the team stage: an edited file in the checkout's CRLF, a new note in LF.
    writeFileSync(path.join(crlfTask, 'api', 'client.ts'), 'export const client = 2;\r\n');
    writeFileSync(path.join(crlfTask, 'notes.md'), 'task note\n');
  });

  it('gives a worker a clean checkout that looks like the task, and writes its result back in the task convention', async () => {
    expect(readFileSync(path.join(crlfTask, 'api', 'server.ts'), 'utf8')).toBe('export const port = 1;\r\nexport const host = "x";\r\n');
    const base = await createWaveBase(crlfTask, 'refs/acc/team/TASK-0002/s1/w1-base', 'base');
    // The base holds what a commit would: LF text, exactly as `git add -A` records it.
    expect((await sh(crlfTask, ['rev-parse', `${base.commit}:api/client.ts`])).trim()).toBe(await blobOf(crlfTask, 'export const client = 2;\n'));
    expect(base.tree).toBe(await committableTree(crlfTask));

    const dir = path.join(root, 'children', 'crlf-api');
    await addChildWorktree(crlfTask, dir, base.commit);
    // At the start: nothing to commit, normalised text in Git's eyes, and the task's own convention on disk.
    expect((await sh(dir, ['status', '--porcelain'])).trim()).toBe('');
    const eol = await sh(dir, ['ls-files', '--eol']);
    for (const file of ['api/server.ts', 'api/client.ts', 'web/page.ts', 'notes.md']) expect(eolOf(eol, file), file).toMatch(/^i\/lf\s+w\/crlf/);
    expect(eolOf(eol, 'assets/logo.png')).toMatch(/^i\/-text/);
    for (const file of ['api/server.ts', 'api/client.ts', 'web/page.ts']) expect(readFileSync(path.join(dir, file), 'utf8'), file).toBe(readFileSync(path.join(crlfTask, file), 'utf8'));

    // The worker edits as an agent's editor does (LF), deletes, adds, replaces a binary — and rewrites one file's line endings only.
    writeFileSync(path.join(dir, 'api', 'server.ts'), 'export const port = 3;\nexport const host = "x";\n');
    writeFileSync(path.join(dir, 'api', 'routes.ts'), 'export const routes = [];\n');
    rmSync(path.join(dir, 'web', 'gone.ts'));
    writeFileSync(path.join(dir, 'assets', 'logo.png'), PNG2);
    writeFileSync(path.join(dir, 'web', 'page.ts'), 'export const title = "a";\n');
    const stat = await sh(dir, ['diff', '--stat', base.commit]);
    const listed = stat.split('\n').filter((l) => l.includes('|')).map((l) => l.split('|')[0]!.trim()).sort();
    expect(listed).toEqual(['api/server.ts', 'assets/logo.png', 'web/gone.ts']);

    const result = await captureResult(dir, 'refs/acc/team/TASK-0002/s1/api', 'api');
    const changes = await changedPathsBetween(crlfTask, base.commit, result.commit);
    // A file that differs only in its line endings is no change.
    expect(changes.map((c) => `${c.status} ${c.path}`).sort()).toEqual(['A api/routes.ts', 'D web/gone.ts', 'M api/server.ts', 'M assets/logo.png']);
    const combined = await combineResults(crlfTask, base.commit, [{ changes }], 'refs/acc/team/TASK-0002/s1/w1-combined', 'combined');
    const applied = await applyIfUnchanged(crlfTask, base.exactTree, combined.commit, changes);
    expect(applied).not.toBeNull();

    // The task gets its usual convention back: CRLF text like its neighbours, the binary byte for byte, the deletion deleted.
    expect(readFileSync(path.join(crlfTask, 'api', 'server.ts'), 'utf8')).toBe('export const port = 3;\r\nexport const host = "x";\r\n');
    expect(readFileSync(path.join(crlfTask, 'api', 'routes.ts'), 'utf8')).toBe('export const routes = [];\r\n');
    expect(readFileSync(path.join(crlfTask, 'web', 'page.ts'), 'utf8')).toBe('export const title = "a";\r\n');
    expect(readFileSync(path.join(crlfTask, 'assets', 'logo.png')).equals(PNG2)).toBe(true);
    expect(existsSync(path.join(crlfTask, 'web', 'gone.ts'))).toBe(false);
    // Paths the worker did not change are untouched, byte for byte.
    expect(readFileSync(path.join(crlfTask, 'api', 'client.ts'), 'utf8')).toBe('export const client = 2;\r\n');
    expect(readFileSync(path.join(crlfTask, 'notes.md'), 'utf8')).toBe('task note\n');
    // What the task would commit has LF text.
    const committed = await committableTree(crlfTask);
    expect((await sh(crlfTask, ['rev-parse', `${committed}:api/server.ts`])).trim()).toBe(await blobOf(crlfTask, 'export const port = 3;\nexport const host = "x";\n'));
    expect((await sh(crlfTask, ['rev-parse', `${committed}:api/routes.ts`])).trim()).toBe(await blobOf(crlfTask, 'export const routes = [];\n'));

    expect(await removeWorktree(crlfTask, dir, { force: true })).toBe(true);
  });

  it('writes nothing when the task changed after the wave started', async () => {
    const before = readFileSync(path.join(crlfTask, 'api', 'server.ts'), 'utf8');
    const base = await createWaveBase(crlfTask, 'refs/acc/team/TASK-0002/s1/w1-base', 'base');
    const w = await worker('crlf-api', base.commit, (dir) => writeFileSync(path.join(dir, 'api', 'server.ts'), 'export const port = 9;\n'), crlfTask);
    const changes = await changedPathsBetween(crlfTask, base.commit, w.result);
    expect(changes.map((c) => c.path)).toEqual(['api/server.ts']);
    const combined = await combineResults(crlfTask, base.commit, [{ changes }], 'refs/acc/team/TASK-0002/s1/w1-combined', 'combined');
    writeFileSync(path.join(crlfTask, 'web', 'page.ts'), 'export const title = "someone else";\r\n');
    expect(await applyIfUnchanged(crlfTask, base.exactTree, combined.commit, changes)).toBeNull();
    expect(readFileSync(path.join(crlfTask, 'api', 'server.ts'), 'utf8')).toBe(before);
  });
});
