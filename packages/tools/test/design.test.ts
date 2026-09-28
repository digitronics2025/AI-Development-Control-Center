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

  it('reads modern hsl(): a bare saturation and lightness are percentages, a negative hue turns the wheel, out of range is refused', () => {
    // hsl(0 0 20) is #333 in CSS Color 4, not white; the legacy comma syntax needs the `%`.
    expect(parseColor('hsl(0 0 20)')).toMatchObject({ r: 51, g: 51, b: 51 });
    expect(parseColor('hsl(0 0 20)')).toEqual(parseColor('hsl(0 0% 20%)'));
    expect(parseColor('hsl(120 100 50 / 50%)')).toMatchObject({ r: 0, g: 255, b: 0, a: 0.5 });
    expect(parseColor('hsl(0, 0, 20)')).toBeNull();
    expect(parseColor('hsl(-75 100% 50%)')).toEqual(parseColor('hsl(285 100% 50%)'));
    expect(parseColor('hsl(-75deg 100% 50%)')).toMatchObject({ r: 191.25, g: 0, b: 255 });
    expect(parseColor('hsl(400 100% 50%)')).toEqual(parseColor('hsl(40 100% 50%)'));
    expect(parseColor('hsl(0 150% 50%)')).toBeNull();
    expect(parseColor('hsl(0 50% -10%)')).toBeNull();
    expect(parseColor('hsl(0 0 120)')).toBeNull();
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

  it('pairs X-foreground with X, and never uses a foreground role as a background (shadcn)', async () => {
    const dir = repo({
      'app/globals.css': `@import "tailwindcss";
        @theme inline { --color-background: var(--background); --color-card-foreground: var(--card-foreground); }
        :root {
          --background: oklch(1 0 0); --foreground: oklch(0.145 0 0);
          --card: oklch(1 0 0); --card-foreground: oklch(0.145 0 0);
          --popover: oklch(1 0 0); --popover-foreground: oklch(0.145 0 0);
          --primary: oklch(0.205 0 0); --primary-foreground: oklch(0.985 0 0);
          --muted: oklch(0.97 0 0); --muted-foreground: oklch(0.556 0 0);
          --border: oklch(0.922 0 0); --ring: oklch(0.708 0 0);
          --chart-1: oklch(0.646 0.222 41.116);
        }
        .dark {
          --background: oklch(0.145 0 0); --foreground: oklch(0.985 0 0);
          --card: oklch(0.205 0 0); --card-foreground: oklch(0.985 0 0);
          --popover: oklch(0.205 0 0); --popover-foreground: oklch(0.985 0 0);
          --primary: oklch(0.922 0 0); --primary-foreground: oklch(0.205 0 0);
          --muted: oklch(0.269 0 0); --muted-foreground: oklch(0.708 0 0);
          --border: oklch(1 0 0 / 10%); --ring: oklch(0.556 0 0);
        }`,
    });
    const r = await call('design.contrast_matrix', { path: 'app/globals.css' }, dir);
    const out = r.output as { themes: Array<{ theme: string; rows: Array<{ fg: string; bg: string; kind: string; pass: boolean }> }>; failures: string[] };
    const rows = out.themes.flatMap((t) => t.rows.map((row) => ({ ...row, theme: t.theme })));
    expect(rows.filter((row) => /foreground$/.test(row.bg))).toEqual([]);
    const byTheme = (theme: string) => Object.fromEntries(rows.filter((row) => row.theme === theme).map((row) => [`${row.fg}/${row.bg}`, row]));
    for (const theme of ['light', 'dark']) {
      expect(byTheme(theme)['card-foreground/card']).toMatchObject({ kind: 'text', pass: true });
      expect(byTheme(theme)['popover-foreground/popover']).toMatchObject({ kind: 'text', pass: true });
      expect(byTheme(theme)['primary-foreground/primary']).toMatchObject({ kind: 'text', pass: true });
      expect(byTheme(theme)['foreground/background']).toMatchObject({ kind: 'text', pass: true });
    }
    // A role named for its background is checked on that background: near-white primary-foreground is never put on the white page.
    expect([...new Set(rows.filter((row) => row.fg.endsWith('-foreground')).map((row) => `${row.fg}/${row.bg}`))].sort()).toEqual([
      'card-foreground/card',
      'muted-foreground/muted',
      'popover-foreground/popover',
      'primary-foreground/primary',
    ]);
    // shadcn's muted text on the muted surface is a real miss (about 4.35:1); every other text pair passes.
    expect(out.failures.filter((f) => !/^(?:border|ring) /.test(f))).toEqual([expect.stringMatching(/^muted-foreground on muted \(light\): 4\.3\d:1/)]);
  });

  it('pairs on-X with X (Material), whatever the prefix', async () => {
    const dir = repo({
      'src/tokens.css': `:root { --md-sys-color-surface: #fef7ff; --md-sys-color-on-surface: #1d1b20; --md-sys-color-primary: #6750a4; --md-sys-color-on-primary: #ffffff; }
        @media (prefers-color-scheme: dark) { :root { --md-sys-color-surface: #141218; --md-sys-color-on-surface: #e6e0e9; --md-sys-color-primary: #d0bcff; --md-sys-color-on-primary: #381e72; } }`,
    });
    const r = await call('design.contrast_matrix', { path: 'src/tokens.css' }, dir);
    const out = r.output as { themes: Array<{ theme: string; rows: Array<{ fg: string; bg: string; pass: boolean }> }> };
    expect(out.themes.map((t) => t.rows.map((row) => `${row.fg}/${row.bg}`).sort())).toEqual([
      ['md-sys-color-on-primary/md-sys-color-primary', 'md-sys-color-on-surface/md-sys-color-surface'],
      ['md-sys-color-on-primary/md-sys-color-primary', 'md-sys-color-on-surface/md-sys-color-surface'],
    ]);
    expect(r.summary).toMatch(/^All 4 colour pairs .* meet WCAG AA/);

    // Plain Material names: on-surface-variant has no surface-variant here, so it is checked on every background.
    const plain = await call('design.contrast_matrix', { colors: { surface: '#fef7ff', 'on-surface': '#1d1b20', 'on-surface-variant': '#49454f', background: '#fef7ff', 'on-background': '#1d1b20' } }, repo({}));
    const pairs = (plain.output as { themes: Array<{ rows: Array<{ fg: string; bg: string }> }> }).themes[0]!.rows.map((row) => `${row.fg}/${row.bg}`).sort();
    expect(pairs).toEqual(['on-background/background', 'on-surface-variant/background', 'on-surface-variant/surface', 'on-surface/surface']);
    expect(plain.summary).toMatch(/^All 4 colour pairs/);
  });

  it('decides AA and AAA on the exact ratio, so 4.4957:1 is not rounded up to a pass', async () => {
    const r = await call('design.contrast_matrix', { colors: { text: '#007cc3', bg: '#ffffff' } }, repo({}));
    const row = (r.output as { themes: Array<{ rows: Array<{ ratio: number; pass: boolean; aaa: boolean }> }> }).themes[0]!.rows[0]!;
    expect(row).toMatchObject({ pass: false, aaa: false });
    // The shown ratio never reads as meeting a threshold the pair misses.
    expect(row.ratio).toBeLessThan(4.5);
    expect(r.summary).toMatch(/^1 of 1 colour pairs .* fall short of WCAG AA: text on bg \(light\): 4\.49:1, needs 4\.5:1/);
  });

  it('reads a unitless modern hsl() as a percentage, so dark grey on black fails', async () => {
    const r = await call('design.contrast_matrix', { colors: { text: 'hsl(0 0 20)', bg: '#000' } }, repo({}));
    expect(r.summary).toMatch(/fall short of WCAG AA: text on bg \(light\): 1\.6\d:1/);
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

  it('reads the files a change touched when they are named, under the same rules as a folder walk', async () => {
    // A critic names a change's files, not folders (seen live on TASK-0025, 2026-09-28).
    const dir = repo({
      'styles/app.css': '.sold-out { color: #999999; }\n',
      'styles/tokens.css': ':root { --muted: #5c574c; }\n',
      'src/components/card.js': "el.style.color = 'var(--muted)';\n",
      'src/components/card.test.js': "const x = '#123456';\n",
      'src/other.js': "const y = '#abcdef';\n",
    });
    const r = await call('design.lint_tokens', { paths: ['styles/app.css', 'src/components/card.js', 'styles/tokens.css', 'src/components/card.test.js'] }, dir);
    expect(r.ok).toBe(true);
    const out = r.output as { files: number; findings: Array<{ path: string; value: string }>; skipped: Array<{ path: string; reason: string }> };
    // Only the named files are read: the unnamed src/other.js is not.
    expect(out.files).toBe(2);
    expect(out.findings.map((f) => `${f.path} ${f.value}`)).toEqual(['styles/app.css #999999']);
    expect(out.skipped.map((s) => s.path).sort()).toEqual(['src/components/card.test.js', 'styles/tokens.css']);
    // Files and folders mix; a path that is neither is still refused.
    expect((await call('design.lint_tokens', { paths: ['src', 'styles/app.css'] }, dir)).output).toMatchObject({ files: 3 });
    // A file named with its folder, or a folder with its parent, is read once: its values count once.
    const twice = await call('design.lint_tokens', { paths: ['styles', 'styles/app.css', 'src', 'src/components'] }, dir);
    expect(twice.output).toMatchObject({ files: 3, counts: { 'hex-color': 2 } });
    expect((twice.output as { findings: Array<{ path: string }> }).findings.map((f) => f.path).sort()).toEqual(['src/other.js', 'styles/app.css']);
    const missing = await call('design.lint_tokens', { paths: ['nope.css'] }, dir);
    expect(missing).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
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

  it('finds colours on the continuation lines of a multi-line value (Prettier), and still skips id selectors and custom properties', async () => {
    // What Prettier 3 writes for a long box-shadow, background-image and custom property.
    const dir = repo({
      'src/card.css': [
        '.card {',
        '  box-shadow:',
        '    0 0 0 1px #ffffff,',
        '    0 1px 2px #000000;',
        '  background-image:',
        '    linear-gradient(to right, #ff0000 0%, #0000ff 100%),',
        '    linear-gradient(to bottom, #123456, #654321);',
        '  --ring-shadow:',
        '    0 0 0 1px #ababab, 0 0 0 2px rgb(1 2 3);',
        '}',
        'a:hover,',
        '#decade {',
        '  color: red;',
        '}',
      ].join('\n'),
    });
    const r = await call('design.lint_tokens', { paths: ['src'] }, dir);
    const out = r.output as { findings: Array<{ line: number; kind: string; value: string }> };
    expect(out.findings.map((f) => `${f.line} ${f.value}`)).toEqual(['3 #ffffff', '4 #000000', '6 #ff0000', '6 #0000ff', '7 #123456', '7 #654321']);
    // lintLine alone cannot know a line continues a value; the caller says so.
    expect(lintLine('    0 0 0 1px #fff,', true)).toEqual([]);
    expect(lintLine('    0 0 0 1px #fff,', true, true).map((f) => f.value)).toEqual(['#fff']);
    // An id selector that looks like hex (#decade, #bad) is still not a colour outside a value.
    expect(lintLine('#decade {', true)).toEqual([]);
    expect(lintLine('#bad {', true, true).map((f) => f.value)).toEqual(['#bad']);
    expect(lintLine('  x; } #bad {', true, true)).toEqual([]);
  });

  it('keeps a long single-line stylesheet from stalling the event loop, and reports what it did not scan', async () => {
    const hexes = Array.from({ length: 30_000 }, (_, i) => `#${(i * 97).toString(16).padStart(6, '0').slice(-6)}`);
    const huge = `.a{color:${hexes.join(';color:')}}`;
    // The per-match lookbehind is bounded: a 500 KB line of colours takes milliseconds, not seconds.
    const started = performance.now();
    expect(lintLine(huge, true)).toHaveLength(hexes.length);
    expect(performance.now() - started).toBeLessThan(750);

    const key = ['sk', 'proj', 'q'.repeat(40)].join('-');
    const dir = repo({
      'src/vendor.css': huge,
      'src/lib/bootstrap.min.css': '.x{color:#ff0000}',
      'src/long.tsx': `const style = { apiKey: "${key}", pad: "${'x'.repeat(400)}", color: '#3355ff' };\n`,
    });
    const t0 = performance.now();
    const r = await call('design.lint_tokens', { paths: ['src'], maxFindings: 1000 }, dir);
    expect(performance.now() - t0).toBeLessThan(2000);
    const out = r.output as { files: number; findings: Array<{ path: string; value: string; text: string }>; skipped: Array<{ path: string; reason: string; lines?: number[] }> };
    expect([...out.skipped].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'src/lib/bootstrap.min.css', reason: 'minified' },
      { path: 'src/vendor.css', reason: 'line(s) over 4096 characters', lines: [1] },
    ]);
    expect(r.summary).toMatch(/2 not read: see skipped/);
    // A finding on a long line shows the text around it, from the line redacted whole: the key never appears.
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ path: 'src/long.tsx', value: '#3355ff' });
    expect(out.findings[0]!.text).toContain("color: '#3355ff'");
    expect(out.findings[0]!.text.length).toBeLessThanOrEqual(160);
    const short = await call('design.lint_tokens', { paths: ['src'] }, repo({ 'src/a.tsx': `const s = { apiKey: "${key}", color: '#3355ff' };\n` }));
    const text = (short.output as { findings: Array<{ text: string }> }).findings[0]!.text;
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(key.slice(8));
  });

  it('reports a folder nested too deep to read instead of passing it by in silence', async () => {
    const deep = `src/${Array.from({ length: 13 }, (_, i) => `d${i + 1}`).join('/')}`;
    const r = await call('design.lint_tokens', { paths: ['src'] }, repo({ [`${deep}/button.css`]: '.b { color: #ff0000; }\n', 'src/ok.css': '.a { color: var(--accent); }\n' }));
    const out = r.output as { skipped: Array<{ path: string; reason: string }>; stoppedAtFiles: boolean };
    expect(out.skipped).toEqual([{ path: deep, reason: 'nested deeper than 12 folders' }]);
    expect(out.stoppedAtFiles).toBe(false);
    expect(r.summary).toMatch(/^No hard-coded colours.+\(1 not read: see skipped\)$/);
  });
});
