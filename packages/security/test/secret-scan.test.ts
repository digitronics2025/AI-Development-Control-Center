import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The repository's own pre-commit secret scan (audit F-19): scripts/secret-scan.ts
 * run against a scratch repository, as `.githooks/pre-commit` runs it.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const SCRIPT = path.join(ROOT, 'scripts', 'secret-scan.ts');

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-secret-scan-'));
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'u@example.com'], ['config', 'user.name', 'U']]) spawnSync('git', args, { cwd: dir });
  return dir;
}
const stage = (dir: string, file: string, content: string) => {
  writeFileSync(path.join(dir, file), content);
  spawnSync('git', ['add', '--', file], { cwd: dir });
};
const scan = (dir: string) => spawnSync(process.execPath, ['--import', TSX, SCRIPT], { cwd: dir, encoding: 'utf8' });

describe('pre-commit secret scan', () => {
  it('passes clean changes and stops a staged credential without printing it', () => {
    const dir = repo();
    stage(dir, 'ok.ts', 'export const answer = 42;\n');
    expect(scan(dir).status).toBe(0);

    const token = ['gh', 'p_', 'D'.repeat(36)].join('');
    stage(dir, 'config.ts', `export const token = "${token}";\n`);
    const blocked = scan(dir);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('config.ts: contains what looks like github');
    expect(blocked.stderr).not.toContain('ok.ts');
    expect(blocked.stderr + blocked.stdout).not.toContain(token);
  }, 30_000);

  it('stops sensitive file names, honours the allow marker, and fails closed outside a repository', () => {
    const dir = repo();
    stage(dir, '.env', 'API_URL=http://localhost\n');
    const named = scan(dir);
    expect(named.status).toBe(1);
    expect(named.stderr).toContain('.env: looks like an environment file');

    const other = repo();
    const token = ['gh', 'p_', 'E'.repeat(36)].join('');
    stage(other, 'fixture.ts', `const sample = "${token}"; // secret-scan: allow\n`);
    expect(scan(other).status).toBe(0);

    const outside = mkdtempSync(path.join(os.tmpdir(), 'acc-secret-scan-none-'));
    expect(scan(outside).status).toBe(2);
  }, 30_000);
});
