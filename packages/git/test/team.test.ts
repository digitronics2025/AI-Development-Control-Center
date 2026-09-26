import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addChildWorktree,
  addWorktree,
  applyIfUnchanged,
  changedPathsBetween,
  combineResults,
  createCheckpoint,
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

async function worker(name: string, base: string, work: (dir: string) => void): Promise<{ dir: string; result: string }> {
  const dir = path.join(root, 'children', name);
  await addChildWorktree(task, dir, base);
  work(dir);
  const { commit } = await createCheckpoint(dir, `refs/acc/team/TASK-0001/s1/${name}`, name);
  return { dir, result: commit };
}

describe('Stage Team write isolation', () => {
  it('gives each worker the task as it is, and integrates disjoint results — new, deleted, renamed, binary and CRLF files — into the task only', async () => {
    const operatorStatus = await status(repo);
    // Whatever line endings this machine's Git checked the task out with, a renamed file keeps its exact bytes.
    const oldBytes = readFileSync(path.join(task, 'api', 'old.ts'));
    const base = await createCheckpoint(task, 'refs/acc/team/TASK-0001/s1/w1-base', 'base');

    const api = await worker('api', base.commit, (dir) => {
      // The child starts from the task's uncommitted and untracked work.
      expect(readFileSync(path.join(dir, 'api', 'server.ts'), 'utf8')).toBe('export const port = 2;\n');
      expect(readFileSync(path.join(dir, 'notes.md'), 'utf8')).toBe('untracked task note\n');
      writeFileSync(path.join(dir, 'api', 'server.ts'), 'export const port = 3;\n');
      writeFileSync(path.join(dir, 'api', 'routes.ts'), 'export const routes = [];\n');
      renameSync(path.join(dir, 'api', 'old.ts'), path.join(dir, 'api', 'renamed.ts'));
      writeFileSync(path.join(dir, 'api', 'logo.bin'), BINARY);
    });
    const web = await worker('web', base.commit, (dir) => {
      // Bytes exactly as recorded: CRLF survives the checkout untouched.
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
    const paths = new Set([...apiChanges, ...webChanges].map((c) => c.path));
    const applied = await applyIfUnchanged(task, base.commit, combined.commit, paths);
    expect(applied).not.toBeNull();

    expect(readFileSync(path.join(task, 'api', 'server.ts'), 'utf8')).toBe('export const port = 3;\n');
    expect(readFileSync(path.join(task, 'api', 'routes.ts'), 'utf8')).toBe('export const routes = [];\n');
    expect(readFileSync(path.join(task, 'api', 'renamed.ts')).equals(oldBytes)).toBe(true);
    expect(existsSync(path.join(task, 'api', 'old.ts'))).toBe(false);
    expect(readFileSync(path.join(task, 'api', 'logo.bin')).equals(BINARY)).toBe(true);
    expect(readFileSync(path.join(task, 'web', 'page.ts'), 'utf8')).toBe('export const title = "b";\r\nexport const crlf = true;\r\n');
    expect(existsSync(path.join(task, 'web', 'gone.ts'))).toBe(false);
    // The task's own untracked note is still there, unchanged.
    expect(readFileSync(path.join(task, 'notes.md'), 'utf8')).toBe('untracked task note\n');

    // The operator's checkout: same branch, same status, same uncommitted work.
    expect(await currentBranch(repo)).toBe('main');
    expect(await status(repo)).toEqual(operatorStatus);
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# repo — operator draft\n');

    for (const dir of [api.dir, web.dir]) expect(await removeWorktree(task, dir, { force: true })).toBe(true);
  });

  it('integrates nothing when the task changed after the wave started', async () => {
    const base = await createCheckpoint(task, 'refs/acc/team/TASK-0001/s1/w1-base', 'base');
    const w = await worker('api', base.commit, (dir) => writeFileSync(path.join(dir, 'api', 'server.ts'), 'export const port = 9;\n'));
    const changes = await changedPathsBetween(task, base.commit, w.result);
    const combined = await combineResults(task, base.commit, [{ changes }], 'refs/acc/team/TASK-0001/s1/w1-combined', 'combined');
    // Something else wrote to the task in the meantime.
    writeFileSync(path.join(task, 'web', 'page.ts'), 'export const title = "someone else";\n');
    expect(await applyIfUnchanged(task, base.commit, combined.commit, new Set(changes.map((c) => c.path)))).toBeNull();
    expect(readFileSync(path.join(task, 'api', 'server.ts'), 'utf8')).toBe('export const port = 2;\n');
    expect(readFileSync(path.join(task, 'web', 'page.ts'), 'utf8')).toBe('export const title = "someone else";\n');
  });

  it('refuses to combine two workers that changed the same file', async () => {
    const base = await createCheckpoint(task, 'refs/acc/team/TASK-0001/s1/w1-base', 'base');
    const a = await worker('a', base.commit, (dir) => writeFileSync(path.join(dir, 'README.md'), 'a\n'));
    const b = await worker('b', base.commit, (dir) => writeFileSync(path.join(dir, 'README.md'), 'b\n'));
    const parts = [{ changes: await changedPathsBetween(task, base.commit, a.result) }, { changes: await changedPathsBetween(task, base.commit, b.result) }];
    await expect(combineResults(task, base.commit, parts, 'refs/acc/team/TASK-0001/s1/w1-combined', 'combined')).rejects.toThrow(/Two work units changed README.md/);
  });

  it('keeps worker results on hidden refs only, and rejects refs and objects it did not make', async () => {
    const base = await createCheckpoint(task, 'refs/acc/team/TASK-0001/s1/w1-base', 'base');
    expect(await treeOf(task, base.commit)).toBe(base.tree);
    const branches = await sh(repo, ['branch', '--list']);
    expect(branches).not.toContain('team');
    await expect(combineResults(task, base.commit, [], 'refs/heads/main', 'x')).rejects.toThrow(/Invalid team ref/);
    await expect(treeOf(task, 'HEAD; rm -rf /')).rejects.toThrow(/Not an object id/);
  });
});
