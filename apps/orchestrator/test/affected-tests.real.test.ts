import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runShell } from '@acc/executor';
import { git } from '@acc/git';
import { narrowCommand } from '../src/engine/targeted-tests.js';

/**
 * Affected tests only, proven with real Vitest (docs/plans/AFFECTED_TESTS_PLAN.md
 * §4 step 5): the exact command line the engine builds, run through npm in a
 * real Git repository, runs the tests whose imports reach a changed file — an
 * untracked new test included — and the whole suite when package.json changes.
 * Uses this workspace's own Vitest; nothing is installed.
 */

const vitestDir = path.dirname(realpathSync(createRequire(import.meta.url).resolve('vitest/package.json')));
const vitestBin = path.join(vitestDir, 'vitest.mjs');
const SCRIPTS = { test: 'vitest run --reporter=verbose' };

async function run(cwd: string, args: string[]) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A Git repository with two modules and a test for each, committed as the baseline. */
async function project(): Promise<{ dir: string; baseline: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-affected-real-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'affected', private: true, type: 'module', scripts: SCRIPTS }, null, 2),
    '.gitignore': 'node_modules\n',
    'a.ts': 'export const a = () => 1;\n',
    'b.ts': 'export const b = () => 2;\n',
    'lonely.ts': 'export const lonely = 3;\n',
    'a.test.ts': "import { expect, it } from 'vitest';\nimport { a } from './a';\nit('a', () => expect(a()).toBe(1));\n",
    'b.test.ts': "import { expect, it } from 'vitest';\nimport { b } from './b';\nit('b', () => expect(b()).toBe(2));\n",
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  // The workspace's Vitest, reachable as a dependency and as the `vitest` command npm puts on PATH.
  const modules = path.join(dir, 'node_modules');
  mkdirSync(path.join(modules, '.bin'), { recursive: true });
  symlinkSync(vitestDir, path.join(modules, 'vitest'), 'junction');
  writeFileSync(path.join(modules, '.bin', 'vitest'), `#!/bin/sh\nexec node "${vitestBin}" "$@"\n`);
  chmodSync(path.join(modules, '.bin', 'vitest'), 0o755);
  writeFileSync(path.join(modules, '.bin', 'vitest.cmd'), `@node "${vitestBin}" %*\r\n`);
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', 'baseline']]) await run(dir, args);
  return { dir, baseline: await run(dir, ['rev-parse', 'HEAD']) };
}

/** Runs the command the engine would run and says which test files ran. */
async function affected(dir: string, baseline: string): Promise<{ exitCode: number | null; ran: string[]; output: string }> {
  const commandLine = narrowCommand('npm test', SCRIPTS, baseline);
  expect(commandLine).toBe(`npm test -- --changed ${baseline} --passWithNoTests`);
  const lines: string[] = [];
  const { CI: _ci, ...env } = process.env;
  const result = await runShell({ commandLine: commandLine!, cwd: dir, env: { ...env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, timeoutMs: 120_000, onLine: (_s, line) => lines.push(line) }).done;
  const output = lines.join('\n');
  const ran = [...new Set([...output.matchAll(/✓\s+([\w.]+\.test\.ts)/g)].map((m) => m[1]!))].sort();
  return { exitCode: result.exitCode, ran, output };
}

describe('real Vitest, narrowed to the change', () => {
  it('runs only the test that imports the changed module', async () => {
    const { dir, baseline } = await project();
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = () => 1; // changed\n');
    const r = await affected(dir, baseline);
    expect(r.exitCode, r.output).toBe(0);
    expect(r.ran, r.output).toEqual(['a.test.ts']);
  }, 120_000);

  it('runs a new untracked test that imports the changed module', async () => {
    const { dir, baseline } = await project();
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = () => 1; // changed\n');
    writeFileSync(path.join(dir, 'c.test.ts'), "import { expect, it } from 'vitest';\nimport { a } from './a';\nit('c', () => expect(a()).toBe(1));\n");
    const r = await affected(dir, baseline);
    expect(r.exitCode, r.output).toBe(0);
    expect(r.ran, r.output).toEqual(['a.test.ts', 'c.test.ts']);
  }, 120_000);

  it('runs the whole suite when package.json changes', async () => {
    const { dir, baseline } = await project();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'affected', private: true, type: 'module', description: 'changed', scripts: SCRIPTS }, null, 2));
    const r = await affected(dir, baseline);
    expect(r.exitCode, r.output).toBe(0);
    expect(r.ran, r.output).toEqual(['a.test.ts', 'b.test.ts']);
  }, 120_000);

  it('passes, running nothing, when no test imports the changed module', async () => {
    const { dir, baseline } = await project();
    writeFileSync(path.join(dir, 'lonely.ts'), 'export const lonely = 4;\n');
    const r = await affected(dir, baseline);
    expect(r.exitCode, r.output).toBe(0);
    expect(r.ran, r.output).toEqual([]);
  }, 120_000);
});
