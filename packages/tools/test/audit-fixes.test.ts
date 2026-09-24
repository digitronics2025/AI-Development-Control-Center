import { describe, expect, it } from 'vitest';
import { builtinProviders, decide, type ToolOperation } from '../src/index.js';

/**
 * Regression tests for the 2026-09-24 pre-release audit
 * (docs/security/prerelease-audit-2026-09-24.md). Each test names its finding.
 */

function op(id: string): ToolOperation {
  const found = builtinProviders()
    .flatMap((p) => p.operations)
    .find((o) => o.id === id);
  if (!found) throw new Error(`no operation ${id}`);
  return found as ToolOperation;
}

function risk(id: string, input: unknown) {
  const o = op(id);
  const parsed = o.input.parse(input);
  return { level: o.level, risk: 'normal' as const, reasons: [], effects: [], production: false, ...o.classify?.(parsed, { cwd: process.cwd(), isTaskOwnedPid: () => false }) };
}

const agentAt = (r: ReturnType<typeof risk>, stageLevel: 1 | 2 | 3 | 4 = 2) =>
  decide({ risk: r, mode: 'full', autoApproveUpToLevel: 4, stageLevel, inProfile: true, origin: 'agent' }).decision;

describe('F-04: verify.web classifies its start command', () => {
  it('rates a harmless dev server at Level 2 and a destructive one like the command itself', () => {
    expect(risk('verify.web', { url: 'http://127.0.0.1:5173', startCommand: 'pnpm dev' }).level).toBe(2);
    const bad = risk('verify.web', { url: 'http://127.0.0.1:5173', startCommand: 'git push --force origin main' });
    expect(bad.level).toBe(5);
    expect(agentAt(bad)).toBe('deny');
    const deploy = risk('verify.web', { url: 'http://127.0.0.1:5173', startCommand: 'npx wrangler deploy --env production' });
    expect(deploy.production).toBe(true);
    expect(agentAt(deploy)).toBe('deny');
  });

  it('stays Level 1 with no start command', () => {
    expect(risk('verify.web', { url: 'http://127.0.0.1:5173' }).level).toBe(1);
  });
});

describe('F-05: git.stage / git.commit / git.restore never touch the user\'s pre-existing work', () => {
  it('refuses a folder, parent, absolute or whole-tree pathspec that covers a protected file, and treats globs literally', async () => {
    const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { git } = await import('@acc/git');
    const repo = mkdtempSync(path.join(os.tmpdir(), 'acc-f05-'));
    const sh = async (...args: string[]) => {
      const r = await git(repo, args);
      if (r.code !== 0) throw new Error(r.stderr);
    };
    await sh('init', '-b', 'main');
    await sh('config', 'user.email', 't@example.com');
    await sh('config', 'user.name', 'T');
    await sh('config', 'commit.gpgsign', 'false');
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'committed\n');
    writeFileSync(path.join(repo, 'src', 'task.ts'), 'committed\n');
    await sh('add', '.');
    await sh('commit', '-m', 'init');
    // The user's own edit before the task started, and a task edit next to it.
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'user work\n');
    writeFileSync(path.join(repo, 'src', 'task.ts'), 'task work\n');
    const ctx = {
      executionId: 't', taskId: null, cwd: repo, roots: [repo], env: process.env, signal: new AbortController().signal, timeoutMs: 60_000,
      tempDir: os.tmpdir(), stateDir: os.tmpdir(), shell: async () => null, detection: () => undefined, protectedPaths: ['src/app.ts'],
    } as never;
    const run = (id: string, input: unknown) => op(id).run(op(id).input.parse(input), ctx);
    for (const paths of [['src'], ['src/'], ['./src'], ['SRC/App.ts'].filter(() => process.platform === 'win32'), [path.join(repo, 'src')], ['.'], ['src/../src']].filter((p) => p.length)) {
      expect((await run('git.restore', { paths })).error?.code, JSON.stringify(paths)).toBe('PROTECTED_PATH');
      expect((await run('git.commit', { paths, message: 'nope' })).error?.code, JSON.stringify(paths)).toBe('PROTECTED_PATH');
      expect((await run('git.stage', { paths })).error?.code, JSON.stringify(paths)).toBe('PROTECTED_PATH');
    }
    // A glob is a literal name: it matches nothing and discards nothing.
    expect((await run('git.restore', { paths: ['src/*.ts'] })).ok).toBe(false);
    expect(readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe('user work\n');
    // The task's own file still works.
    expect((await run('git.commit', { paths: ['src/task.ts'], message: 'task change' })).ok).toBe(true);
    expect(readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe('user work\n');
  });
});
