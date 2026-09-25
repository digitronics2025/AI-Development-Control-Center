import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changesSince, classifyDiffPath, diffSince, git, packDiff, snapshot, splitDiff, withoutPartialTail, type PackFile } from '../src/index.js';

/** A minimal unified-diff chunk of `lines` added lines for `file`. */
function chunk(file: string, lines: number, width = 20): string {
  const body = Array.from({ length: lines }, (_, i) => `+${String(i).padStart(width, 'x')}`).join('\n');
  return `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines} @@\n${body}\n`;
}

const stat = (file: string, additions: number | null = 1, deletions: number | null = 0): PackFile => ({ path: file, additions, deletions });

describe('classifyDiffPath', () => {
  it('orders source, tests, config, docs, then generated files', () => {
    expect(classifyDiffPath('src/app.ts')).toBe('source');
    expect(classifyDiffPath('src/app.test.ts')).toBe('test');
    expect(classifyDiffPath('tests/e2e/login.spec.ts')).toBe('test');
    expect(classifyDiffPath('package.json')).toBe('config');
    expect(classifyDiffPath('vite.config.ts')).toBe('config');
    expect(classifyDiffPath('.github/workflows/ci.yml')).toBe('config');
    expect(classifyDiffPath('docs/systems/git.md')).toBe('docs');
    expect(classifyDiffPath('README.md')).toBe('docs');
    expect(classifyDiffPath('pnpm-lock.yaml')).toBe('generated');
    expect(classifyDiffPath('dist/index.js')).toBe('generated');
    expect(classifyDiffPath('app.min.js')).toBe('generated');
    expect(classifyDiffPath('schema.generated.ts')).toBe('generated');
    expect(classifyDiffPath('logo.png', true)).toBe('generated');
  });
});

describe('packDiff', () => {
  it('shows source before tests, config and docs, and lockfiles and binaries last', () => {
    const raw = [chunk('README.md', 2), chunk('pnpm-lock.yaml', 2), chunk('src/a.test.ts', 2), chunk('package.json', 2), chunk('src/a.ts', 2)].join('');
    const packed = packDiff(raw, ['README.md', 'pnpm-lock.yaml', 'src/a.test.ts', 'package.json', 'src/a.ts'].map((f) => stat(f)), 100_000);
    expect(packed.shown).toEqual(['src/a.ts', 'src/a.test.ts', 'package.json', 'README.md', 'pnpm-lock.yaml']);
    expect(packed.omitted).toEqual([]);
    expect(packed.text.indexOf('b/src/a.ts')).toBeLessThan(packed.text.indexOf('b/README.md'));
  });

  it('packs whole files up to the budget and names every one it leaves out', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'docs/d.md'];
    const raw = [chunk('src/a.ts', 100), chunk('src/b.ts', 100), chunk('src/c.ts', 100), chunk('docs/d.md', 5)].join('');
    const size = chunk('src/a.ts', 100).length;
    const packed = packDiff(raw, files.map((f) => stat(f, 100)), size * 2 + 400);
    expect(packed.shown).toEqual(['src/a.ts', 'src/b.ts', 'docs/d.md']);
    expect(packed.omitted).toEqual([{ path: 'src/c.ts', additions: 100, deletions: 0, reason: 'too large for the budget' }]);
    expect(packed.text.length).toBeLessThanOrEqual(size * 2 + 400);
    expect(packed.text).not.toContain('b/src/c.ts');
  });

  it('shows a giant first file in part, cut at a hunk boundary, instead of hiding everything', () => {
    const hunk = (start: number) => `@@ -${start},1 +${start},1 @@\n-old${start}\n+${'y'.repeat(200)}\n`;
    const giant = `diff --git a/src/giant.ts b/src/giant.ts\nindex 1..2 100644\n--- a/src/giant.ts\n+++ b/src/giant.ts\n${Array.from({ length: 50 }, (_, i) => hunk(i * 10 + 1)).join('')}`;
    const packed = packDiff(giant + chunk('docs/x.md', 1), [stat('src/giant.ts', 50, 50), stat('docs/x.md')], 1_000);
    expect(packed.omitted[0]).toMatchObject({ path: 'src/giant.ts', reason: 'partial' });
    const part = packed.text.split('[src/giant.ts: only the first')[0]!;
    expect(part.endsWith('\n')).toBe(true);
    // Every hunk kept is whole: the last kept hunk ends with its added line.
    expect(part.trimEnd().endsWith('y'.repeat(200))).toBe(true);
    expect(packed.shown).toContain('docs/x.md');
  });

  it('lists a changed file that never reached the collected diff (the omitted list is always complete)', () => {
    const packed = packDiff(chunk('src/a.ts', 1), [stat('src/a.ts'), stat('src/late.ts', 7, 3)], 100_000);
    expect(packed.omitted).toEqual([{ path: 'src/late.ts', additions: 7, deletions: 3, reason: 'not in the collected diff' }]);
  });

  it('treats a binary chunk as lowest priority and never shows it in part', () => {
    const bin = 'diff --git a/logo.png b/logo.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/logo.png differ\n';
    const packed = packDiff(bin + chunk('src/a.ts', 1), [stat('logo.png', null, null), stat('src/a.ts')], 100_000);
    expect(packed.shown).toEqual(['src/a.ts', 'logo.png']);
    expect(splitDiff(bin)[0]).toMatchObject({ path: 'logo.png', binary: true });
  });

  it('drops the partial last chunk of a diff that was cut short', () => {
    const raw = chunk('src/a.ts', 3) + chunk('src/b.ts', 3).slice(0, 60);
    expect(withoutPartialTail(raw, true)).toBe(chunk('src/a.ts', 3));
    const packed = packDiff(raw, [stat('src/a.ts'), stat('src/b.ts')], 100_000, { truncated: true });
    expect(packed.shown).toEqual(['src/a.ts']);
    expect(packed.omitted.map((o) => o.path)).toEqual(['src/b.ts']);
  });

  it('packs a real repository with untracked files, renames and deletions', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-pack-'));
    const sh = async (args: string[]) => {
      const r = await git(dir, args);
      if (r.code !== 0) throw new Error(r.stderr);
    };
    await sh(['init', '-b', 'main']);
    await sh(['config', 'user.email', 't@example.com']);
    await sh(['config', 'user.name', 'T']);
    writeFileSync(path.join(dir, 'keep.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(dir, 'gone.md'), '# gone\n');
    writeFileSync(path.join(dir, 'old name.ts'), 'export const moved = true;\n'.repeat(20));
    await sh(['add', '.']);
    await sh(['commit', '-m', 'init']);
    const base = await snapshot(dir);
    writeFileSync(path.join(dir, 'keep.ts'), 'export const a = 2;\n');
    await sh(['rm', '-q', 'gone.md']);
    await sh(['mv', 'old name.ts', 'new name.ts']);
    writeFileSync(path.join(dir, 'fresh.test.ts'), 'it("x", () => {});\n');
    const files = await changesSince(dir, base);
    const { diff, truncated } = await diffSince(dir, base);
    const packed = packDiff(diff, files, 100_000, { truncated });
    expect(new Set(packed.shown)).toEqual(new Set(files.map((f) => f.path)));
    expect(packed.omitted).toEqual([]);
    expect(packed.shown).toContain('new name.ts');
    expect(packed.shown.indexOf('keep.ts')).toBeLessThan(packed.shown.indexOf('fresh.test.ts'));
  });
});
