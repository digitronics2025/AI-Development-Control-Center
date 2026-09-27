import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveShell } from '@acc/executor';
import { builtinProviders, contrastRatio, lintLine, parseColor, readThemeTokens, ToolRegistry, type OperationContext, type OperationResult } from '../src/index.js';

/** The design pack (docs/systems/design-agent.md): WCAG contrast math and the token lint, on fixtures. */

const registry = new ToolRegistry();
for (const p of builtinProviders()) registry.register(p);

function ctx(cwd: string): OperationContext {
  return {
    executionId: 'test',
    taskId: null,
    cwd,
    roots: [cwd],
    env: process.env,
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    tempDir: path.join(cwd, '.scratch'),
    stateDir: path.join(cwd, '.state'),
    shell: (k) => resolveShell(k),
    detection: () => undefined,
    protectedPaths: [],
  };
}

async function call(id: string, input: unknown, cwd: string): Promise<OperationResult> {
  const op = registry.provider('design')!.operations.find((o) => o.id === id)!;
  return op.run(op.input.parse(input), ctx(cwd));
}

const repo = (files: Record<string, string>) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-design-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
};

describe('contrast math (WCAG 2)', () => {
  it('computes the known ratios', () => {
    const c = (a: string, b: string) => Math.round(contrastRatio(parseColor(a)!, parseColor(b)!) * 100) / 100;
    expect(c('#000', '#fff')).toBe(21);
    expect(c('#fff', '#fff')).toBe(1);
    // #777 on white is the classic "just misses AA" grey; #767676 is the lightest grey that passes.
    expect(c('#777777', '#ffffff')).toBe(4.48);
    expect(c('#767676', '#ffffff')).toBe(4.54);
    expect(c('rgb(0 0 0)', 'hsl(0 0% 100%)')).toBe(21);
    // Translucent text is painted on its background first: 50% black on white is a mid grey.
    expect(c('rgba(0, 0, 0, 0.5)', '#ffffff')).toBeCloseTo(c('#808080', '#ffffff'), 0);
  });

  it('reads hex, rgb, hsl and oklch, and refuses what it cannot read', () => {
    expect(parseColor('#0a7a5a')).toEqual({ r: 10, g: 122, b: 90, a: 1 });
    expect(parseColor('#0a7a5a80')!.a).toBeCloseTo(0.5, 2);
    expect(parseColor('rgb(10, 122, 90)')).toEqual({ r: 10, g: 122, b: 90, a: 1 });
    expect(parseColor('hsl(120 100% 50%)')).toMatchObject({ r: 0, g: 255, b: 0 });
    // oklch(1 0 0) is white, oklch(0 0 0) black; a mid lightness with no chroma is a neutral grey.
    expect(parseColor('oklch(1 0 0)')).toMatchObject({ r: 255, g: 255, b: 255 });
    expect(parseColor('oklch(0 0 0)')).toMatchObject({ r: 0, g: 0, b: 0 });
    const grey = parseColor('oklch(0.6 0 0)')!;
    expect(Math.abs(grey.r - grey.g)).toBeLessThan(1);
    expect(parseColor('color-mix(in srgb, red, blue)')).toBeNull();
    expect(parseColor('var(--x)')).toBeNull();
  });

  it('reads light and dark custom properties from a stylesheet', () => {
    const css = `/* tokens */
      :root { --color-fg: #111111; --color-bg: #ffffff; --color-accent: var(--brand); --brand: #0a7a5a; }
      @media (prefers-color-scheme: dark) { :root { --color-fg: #f5f5f5; --color-bg: #111111; } }
      [data-theme="dark"] { --color-muted: #9a9a9a; }
      .card { color: var(--color-fg); }`;
    const t = readThemeTokens(css);
    expect(t.light).toMatchObject({ 'color-fg': '#111111', 'color-bg': '#ffffff', brand: '#0a7a5a' });
    expect(t.dark).toMatchObject({ 'color-fg': '#f5f5f5', 'color-bg': '#111111', 'color-muted': '#9a9a9a', brand: '#0a7a5a' });
  });
});

describe('design.contrast_matrix', () => {
  it('pairs foreground and UI roles with backgrounds in both themes and names what falls short', async () => {
    const dir = repo({
      'src/styles/theme.css': `:root { --fg: #111111; --fg-muted: #9a9a9a; --border: #d9d9d9; --bg: #ffffff; --surface: #f4f4f4; }
        @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f5; --fg-muted: #8a8a8a; --border: #444444; --bg: #111111; --surface: #1b1b1b; } }`,
    });
    const r = await call('design.contrast_matrix', { path: 'src/styles/theme.css' }, dir);
    expect(r.ok).toBe(true);
    const out = r.output as { themes: Array<{ theme: string; rows: Array<{ fg: string; bg: string; ratio: number; kind: string; pass: boolean }> }>; failures: string[] };
    expect(out.themes.map((t) => t.theme)).toEqual(['light', 'dark']);
    const light = Object.fromEntries(out.themes[0]!.rows.map((row) => [`${row.fg}/${row.bg}`, row]));
    expect(light['fg/bg']).toMatchObject({ kind: 'text', pass: true });
    expect(light['fg-muted/bg']).toMatchObject({ kind: 'text', pass: false });
    // A border is a UI boundary: 3:1, not 4.5:1 — and this one misses even that.
    expect(light['border/bg']).toMatchObject({ kind: 'ui', pass: false });
    expect(out.failures.some((f) => f.startsWith('fg-muted on bg (light)'))).toBe(true);
    expect(r.summary).toMatch(/fall short of WCAG AA/);
  });

  it('checks the colours and pairs you give, and stays inside the repository', async () => {
    const dir = repo({});
    const r = await call('design.contrast_matrix', { colors: { ink: '#1a1a1a', paper: '#fafafa' }, dark: { ink: '#eeeeee', paper: '#121212' }, pairs: [['ink', 'paper']] }, dir);
    expect(r.summary).toMatch(/All 2 colour pairs .* meet WCAG AA .* in light and dark/);
    expect((await call('design.contrast_matrix', { path: '../../etc/passwd' }, dir)).error?.code).toBe('OUTSIDE_ROOT');
  });
});

describe('design.lint_tokens', () => {
  it('finds hard-coded colours, palette classes and pixel font sizes outside the token files', async () => {
    const dir = repo({
      'src/theme.css': ':root { --accent: #0a7a5a; }\n',
      'src/tokens.ts': "export const accent = '#0a7a5a';\n",
      'src/Button.tsx': [
        "export function Button() {",
        "  return <a href=\"#top\" className=\"bg-blue-500 text-[var(--fg)]\" style={{ color: '#3355ff', background: 'rgb(10 20 30)' }}>Go</a>;",
        '}',
      ].join('\n'),
      'src/page.css': '#main { padding: 1rem; }\n.title { color: #fade00; font-size: 18px; }\n.ok { color: var(--accent); }\n',
      'src/Button.test.tsx': "const x = '#123456';\n",
      'node_modules/lib/index.css': '.x { color: #000; }\n',
    });
    const r = await call('design.lint_tokens', { paths: ['src'] }, dir);
    expect(r.ok).toBe(true);
    const out = r.output as { counts: Record<string, number>; findings: Array<{ path: string; line: number; kind: string; value: string }> };
    expect(out.findings.map((f) => `${f.path}:${f.line} ${f.kind} ${f.value}`).sort()).toEqual([
      'src/Button.tsx:2 color-function rgb(…)',
      'src/Button.tsx:2 hex-color #3355ff',
      'src/Button.tsx:2 tailwind-palette bg-blue-500',
      'src/page.css:2 font-size-literal font-size: 18px',
      'src/page.css:2 hex-color #fade00',
    ]);
    // Token files, custom properties, anchors, id selectors, tests and dependencies are not findings.
    expect(r.summary).toMatch(/^5 hard-coded design values in 2 file\(s\) under src/);
    const allowed = await call('design.lint_tokens', { paths: ['src'], allow: ['#3355ff', '#fade00'] }, dir);
    expect((allowed.output as { counts: Record<string, number> }).counts['hex-color']).toBe(0);
  });

  it('never follows a link out of the repository, and refuses paths outside it', async () => {
    const outside = repo({ 'evil.css': '.x { color: #ff0000; }\n' });
    const dir = repo({ 'src/ok.css': '.ok { color: var(--fg); }\n' });
    symlinkSync(outside, path.join(dir, 'src', 'linked'), 'dir');
    const r = await call('design.lint_tokens', { paths: ['src'] }, dir);
    expect((r.output as { findings: unknown[] }).findings).toEqual([]);
    expect(r.summary).toMatch(/^No hard-coded colours/);
    expect((await call('design.lint_tokens', { paths: ['../'] }, dir)).ok).toBe(false);
    expect(lintLine('  --brand: #0a7a5a;', true)).toEqual([]);
    expect(lintLine('// was #123456', false)).toEqual([]);
  });
});
