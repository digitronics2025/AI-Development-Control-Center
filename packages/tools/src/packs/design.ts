import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { redact } from '@acc/security';
import { z } from 'zod';
import { OutsideRootError, relativeTo, resolveInside } from '../paths.js';
import { builtinDetection, failure, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';

/**
 * Design checks (docs/systems/design-agent.md): the contrast of a design
 * standard's colour roles in both themes, by the WCAG 2 formula, and the
 * design values code hard-codes instead of using the standard. Read-only,
 * offline, confined to the repository.
 */

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const NAMED: Record<string, Rgba> = { white: { r: 255, g: 255, b: 255, a: 1 }, black: { r: 0, g: 0, b: 0, a: 1 }, transparent: { r: 0, g: 0, b: 0, a: 0 } };

function channel(raw: string, max: number): number {
  const v = raw.trim();
  return v.endsWith('%') ? (Number(v.slice(0, -1)) / 100) * max : Number(v);
}

function alpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const v = raw.trim();
  return clamp01(v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : Number(v));
}

/** `rgb(1 2 3 / 50%)`, `rgb(1, 2, 3)`, `hsl(…)`: the arguments and the alpha after `/` (or a fourth comma value). */
function args(inner: string): { parts: string[]; a: string | undefined } {
  const [main, slash] = inner.split('/');
  const parts = main!.includes(',') ? main!.split(',').map((p) => p.trim()) : main!.trim().split(/\s+/);
  return { parts: parts.slice(0, 3), a: slash ?? parts[3] };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** OKLCH → sRGB (Björn Ottosson's matrices), clipped to the gamut. */
function oklchToRgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];
  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  return lin.map((x) => clamp01(gamma(x)) * 255) as [number, number, number];
}

/** A CSS colour: hex, rgb()/rgba(), hsl()/hsla(), oklch(), white/black/transparent. Anything else is null. */
export function parseColor(input: string): Rgba | null {
  const v = input.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16), a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?|oklch)\(\s*([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const { parts, a } = args(fn[2]!);
  if (parts.length < 3) return null;
  let rgb: [number, number, number];
  if (fn[1]!.startsWith('rgb')) rgb = [channel(parts[0]!, 255), channel(parts[1]!, 255), channel(parts[2]!, 255)];
  else if (fn[1]!.startsWith('hsl')) rgb = hslToRgb(Number(parts[0]!.replace(/deg$/, '')), channel(parts[1]!, 1), channel(parts[2]!, 1));
  else rgb = oklchToRgb(channel(parts[0]!, 1), parts[1]!.endsWith('%') ? (Number(parts[1]!.slice(0, -1)) / 100) * 0.4 : Number(parts[1]!), Number(parts[2]!.replace(/deg$/, '')));
  if (rgb.some((n) => !Number.isFinite(n))) return null;
  const byte = (n: number) => Math.round(Math.min(255, Math.max(0, n)) * 1000) / 1000;
  return { r: byte(rgb[0]), g: byte(rgb[1]), b: byte(rgb[2]), a: alpha(a) };
}

/** A translucent colour over an opaque one, as a browser paints it. */
export function over(top: Rgba, below: Rgba): Rgba {
  return { r: top.r * top.a + below.r * (1 - top.a), g: top.g * top.a + below.g * (1 - top.a), b: top.b * top.a + below.b * (1 - top.a), a: 1 };
}

/** WCAG 2 relative luminance. */
export function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2 contrast ratio (1–21) of a foreground on a background; translucent layers are painted first. */
export function contrastRatio(fg: Rgba, bg: Rgba, canvas: Rgba = NAMED.white!): number {
  const base = bg.a < 1 ? over(bg, canvas) : bg;
  const top = fg.a < 1 ? over(fg, base) : fg;
  const [a, b] = [luminance(top), luminance(base)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---------------------------------------------------------------------------
// Design values in CSS
// ---------------------------------------------------------------------------

export interface ThemeTokens {
  light: Record<string, string>;
  dark: Record<string, string>;
}

const DARK_SELECTOR = /(?:\.dark\b|\[data-theme=["']?dark["']?\]|\[data-mode=["']?dark["']?\]|\.theme-dark\b)/i;
const LIGHT_SELECTOR = /^(?::root|html|body|\[data-theme=["']?light["']?\]|\.light\b)$/i;

/**
 * Custom properties of a stylesheet by theme: `:root` (and `html`, light
 * selectors) is light; `@media (prefers-color-scheme: dark)`, `.dark`,
 * `[data-theme=dark]` are dark. Dark starts from light and overrides it.
 */
export function readThemeTokens(css: string): ThemeTokens {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  const declarations = (body: string, into: Record<string, string>) => {
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);?/g)) into[m[1]!.slice(2)] = m[2]!.trim();
  };
  // Walk the blocks, remembering whether we are inside a dark media query.
  const walk = (src: string, darkContext: boolean) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open === -1) break;
      const prelude = src.slice(i, open).trim().split(/[;}]/).pop()!.trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (/^@media\b/i.test(prelude)) walk(body, darkContext || /prefers-color-scheme\s*:\s*dark/i.test(prelude));
      else if (/^@(?:supports|layer)\b/i.test(prelude)) walk(body, darkContext);
      else {
        const selectors = prelude.split(',').map((s) => s.trim());
        const isDark = darkContext || selectors.some((s) => DARK_SELECTOR.test(s));
        const isRoot = selectors.some((s) => LIGHT_SELECTOR.test(s) || /^:root|^html/i.test(s) || DARK_SELECTOR.test(s));
        if (isRoot) declarations(body, isDark ? dark : light);
      }
      i = j;
    }
  };
  walk(text, false);
  return { light, dark: { ...light, ...dark } };
}

/** A token's value with `var(--x)` references followed (five deep at most). */
function resolveToken(tokens: Record<string, string>, name: string, depth = 0): string | null {
  const raw = tokens[name];
  if (raw === undefined || depth > 5) return null;
  const ref = /^var\(\s*--([\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(raw.trim());
  if (ref) return resolveToken(tokens, ref[1]!, depth + 1) ?? ref[2]?.trim() ?? null;
  return raw;
}

const FG = /(?:^|[-_])(?:fg|text|foreground|on|ink|content|link|heading|label|icon)(?:[-_]|$)/i;
const BG = /(?:^|[-_])(?:bg|background|surface|canvas|card|panel|base|backdrop|page)(?:[-_]|$)/i;
const UI = /(?:^|[-_])(?:border|outline|ring|focus|divider|stroke)(?:[-_]|$)/i;

export interface ContrastRow {
  fg: string;
  bg: string;
  fgValue: string;
  bgValue: string;
  ratio: number;
  kind: 'text' | 'ui';
  /** 4.5:1 for text (3:1 for UI boundaries). */
  pass: boolean;
  aaa: boolean;
}

// ---------------------------------------------------------------------------
// Hard-coded design values in code
// ---------------------------------------------------------------------------

export interface LintFinding {
  path: string;
  line: number;
  kind: 'hex-color' | 'color-function' | 'tailwind-palette' | 'font-size-literal';
  value: string;
  text: string;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.nuxt', '.git', 'coverage', 'out', 'vendor', '.turbo', '.svelte-kit', 'storybook-static']);
/** Where a design standard defines its values: its tokens and theme files are the one place literals belong. */
const TOKEN_FILE = /(?:^|[\\/])(?:(?:design-)?tokens?|theme|themes|variables|vars|colou?rs?|palette)\.(?:css|scss|sass|less|ts|js|mjs|cjs|json)$|(?:^|[\\/])tailwind\.config\.[cm]?[jt]s$/i;
const PALETTE = /\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|divide|placeholder|decoration|accent|caret|shadow|ring-offset)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/g;
const HEX = /(?<![\w/&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOR_FN = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(\s*[\d.]/g;
const FONT_SIZE = /\bfont-size\s*:\s*\d+(?:\.\d+)?(?:px|pt)\b/g;

export function lintLine(line: string, css: boolean): Array<{ kind: LintFinding['kind']; value: string }> {
  // A custom property definition is a design value's home, not a bypass; so is a comment line.
  if (/^\s*--[\w-]+\s*:/.test(line) || /^\s*(?:\/\/|\/\*|\*|<!--)/.test(line)) return [];
  const out: Array<{ kind: LintFinding['kind']; value: string }> = [];
  for (const m of line.matchAll(HEX)) {
    // An anchor (href="#top") or an id selector (#main) is not a colour: only 3/4/6/8 hex digits after a value position.
    const before = line.slice(0, m.index);
    if (/href\s*=\s*["']?$|id\s*=\s*["']?$/.test(before)) continue;
    if (css && /(?:^|[{},\s])$/.test(before) && !/:\s*[^;{}]*$/.test(before)) continue;
    out.push({ kind: 'hex-color', value: m[0] });
  }
  for (const m of line.matchAll(COLOR_FN)) out.push({ kind: 'color-function', value: m[0].replace(/\(\s*[\d.]$/, '(…)') });
  for (const m of line.matchAll(PALETTE)) out.push({ kind: 'tailwind-palette', value: m[0] });
  if (css) for (const m of line.matchAll(FONT_SIZE)) out.push({ kind: 'font-size-literal', value: m[0].replace(/\s+/g, ' ') });
  return out;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const repoPath = z.string().min(1).max(1000).describe('Path relative to the repository root.');

function confined(ctx: OperationContext, requested: string): string | OperationResult {
  try {
    return resolveInside(ctx.roots, ctx.cwd, requested);
  } catch (error) {
    return failure(error instanceof OutsideRootError ? 'OUTSIDE_ROOT' : 'INVALID_INPUT', (error as Error).message);
  }
}
const isFailure = (v: unknown): v is OperationResult => typeof v === 'object' && v !== null && 'ok' in v;

async function contrastMatrix(
  ctx: OperationContext,
  input: { path?: string; colors?: Record<string, string>; dark?: Record<string, string>; pairs?: Array<[string, string]>; foregrounds?: string[]; backgrounds?: string[] },
): Promise<OperationResult> {
  let themes: ThemeTokens = { light: { ...(input.colors ?? {}) }, dark: { ...(input.colors ?? {}), ...(input.dark ?? {}) } };
  let source = 'the colours given';
  if (input.path) {
    const abs = confined(ctx, input.path);
    if (isFailure(abs)) return abs;
    const s = await stat(abs).catch(() => null);
    if (!s?.isFile() || s.size > 2 * 1024 * 1024) return failure('INVALID_INPUT', `${input.path} is not a stylesheet this tool reads (a file up to 2 MB)`);
    const read = readThemeTokens(await readFile(abs, 'utf8'));
    themes = { light: { ...read.light, ...themes.light }, dark: { ...read.dark, ...themes.dark } };
    source = relativeTo(ctx.cwd, abs);
  }
  const names = [...new Set([...Object.keys(themes.light), ...Object.keys(themes.dark)])];
  const colourNames = names.filter((n) => [themes.light, themes.dark].some((t) => {
    const v = resolveToken(t, n);
    return v !== null && parseColor(v) !== null;
  }));
  let pairs: Array<{ fg: string; bg: string; kind: 'text' | 'ui' }>;
  if (input.pairs?.length) pairs = input.pairs.map(([fg, bg]) => ({ fg, bg, kind: UI.test(fg) ? 'ui' : 'text' }));
  else {
    const fgs = input.foregrounds?.length ? input.foregrounds : colourNames.filter((n) => FG.test(n) && !BG.test(n));
    const uis = input.foregrounds?.length ? [] : colourNames.filter((n) => UI.test(n) && !BG.test(n));
    const bgs = input.backgrounds?.length ? input.backgrounds : colourNames.filter((n) => BG.test(n));
    pairs = [...fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, kind: 'text' as const }))), ...uis.flatMap((fg) => bgs.map((bg) => ({ fg, bg, kind: 'ui' as const })))];
  }
  if (!pairs.length) {
    return { ok: true, summary: `No colour pairs to check in ${source}: name them in pairs, or use names with fg/text and bg/surface`, output: { tokens: colourNames, themes: [] }, evidence: [`contrast matrix of ${source}: no pairs`] };
  }
  pairs = pairs.slice(0, 400);
  const unresolved = new Set<string>();
  const failures: string[] = [];
  const result = (['light', 'dark'] as const)
    .filter((theme) => theme === 'light' || JSON.stringify(themes.dark) !== JSON.stringify(themes.light))
    .map((theme) => {
      const tokens = themes[theme];
      const canvas = theme === 'dark' ? NAMED.black! : NAMED.white!;
      const rows: ContrastRow[] = [];
      for (const p of pairs) {
        const fgValue = resolveToken(tokens, p.fg) ?? (parseColor(p.fg) ? p.fg : null);
        const bgValue = resolveToken(tokens, p.bg) ?? (parseColor(p.bg) ? p.bg : null);
        const fg = fgValue ? parseColor(fgValue) : null;
        const bg = bgValue ? parseColor(bgValue) : null;
        if (!fg || !bg) {
          if (!fg) unresolved.add(p.fg);
          if (!bg) unresolved.add(p.bg);
          continue;
        }
        const ratio = Math.round(contrastRatio(fg, bg, canvas) * 100) / 100;
        const needed = p.kind === 'ui' ? 3 : 4.5;
        const row: ContrastRow = { fg: p.fg, bg: p.bg, fgValue: fgValue!, bgValue: bgValue!, ratio, kind: p.kind, pass: ratio >= needed, aaa: ratio >= (p.kind === 'ui' ? 4.5 : 7) };
        rows.push(row);
        if (!row.pass) failures.push(`${p.fg} on ${p.bg} (${theme}): ${ratio}:1, needs ${needed}:1`);
      }
      return { theme, rows };
    });
  const checked = result.reduce((n, t) => n + t.rows.length, 0);
  return {
    ok: true,
    summary: failures.length
      ? `${failures.length} of ${checked} colour pairs in ${source} fall short of WCAG AA: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '; …' : ''}`
      : `All ${checked} colour pairs in ${source} meet WCAG AA (4.5:1 text, 3:1 UI) in ${result.map((t) => t.theme).join(' and ')}`,
    output: { source, themes: result, failures, unresolved: [...unresolved] },
    evidence: [`contrast matrix of ${source}: ${checked} pairs, ${failures.length} below AA`],
  };
}

async function lintTokens(ctx: OperationContext, input: { paths: string[]; allow: string[]; maxFindings: number }): Promise<OperationResult> {
  const allow = new Set(input.allow.map((a) => a.toLowerCase()));
  const findings: LintFinding[] = [];
  const counts: Record<LintFinding['kind'], number> = { 'hex-color': 0, 'color-function': 0, 'tailwind-palette': 0, 'font-size-literal': 0 };
  let files = 0;
  let truncated = false;
  const exts = /\.(?:css|scss|sass|less|tsx|jsx|ts|js|mjs|vue|svelte|html|astro)$/i;
  const visit = async (abs: string, depth: number): Promise<void> => {
    if (depth > 12 || files >= 5000) return;
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      // Never follows a link: a link could leave the repository.
      if (e.isSymbolicLink()) continue;
      const child = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(child, depth + 1);
        continue;
      }
      if (!e.isFile() || !exts.test(e.name) || /\.(?:min|d)\.[jt]s$|\.test\.|\.spec\.|\.stories\./.test(e.name)) continue;
      const rel = relativeTo(ctx.cwd, child);
      if (TOKEN_FILE.test(rel)) continue;
      const s = await stat(child).catch(() => null);
      if (!s || s.size > 512 * 1024) continue;
      files++;
      const css = /\.(?:css|scss|sass|less)$/i.test(e.name);
      const lines = (await readFile(child, 'utf8').catch(() => '')).split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const f of lintLine(line, css)) {
          if (allow.has(f.value.toLowerCase())) continue;
          counts[f.kind]++;
          if (findings.length < input.maxFindings) findings.push({ path: rel, line: i + 1, kind: f.kind, value: f.value, text: redact(line.trim()).slice(0, 160) });
          else truncated = true;
        }
      });
    }
  };
  const scanned: string[] = [];
  for (const p of input.paths) {
    const abs = confined(ctx, p);
    if (isFailure(abs)) continue;
    const s = await stat(abs).catch(() => null);
    if (!s?.isDirectory()) continue;
    scanned.push(relativeTo(ctx.cwd, abs) || '.');
    await visit(abs, 0);
  }
  if (!scanned.length) return failure('INVALID_INPUT', `None of ${input.paths.join(', ')} is a folder in the repository`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const parts = (Object.entries(counts) as Array<[LintFinding['kind'], number]>).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`);
  return {
    ok: true,
    summary: total
      ? `${total} hard-coded design value${total === 1 ? '' : 's'} in ${new Set(findings.map((f) => f.path)).size}${truncated ? '+' : ''} file(s) under ${scanned.join(', ')} (${parts.join(', ')}): use the design standard's semantic values instead`
      : `No hard-coded colours, palette classes or font sizes in ${files} file(s) under ${scanned.join(', ')}`,
    output: { scanned, files, counts, findings, truncated },
    evidence: [`token lint of ${scanned.join(', ')}: ${files} files, ${total} finding(s)`],
  };
}

export function designProvider(): ToolProvider {
  return {
    id: 'design',
    name: 'Design checks',
    description: 'Colour contrast of a design standard in both themes, and design values code hard-codes (docs/systems/design-agent.md).',
    category: 'verification',
    builtin: true,
    detect: async () => builtinDetection(),
    operations: [
      operation({
        id: 'design.contrast_matrix',
        title: 'Check the contrast of colour roles in both themes',
        description:
          'Read a stylesheet\'s custom properties (light from :root, dark from prefers-color-scheme: dark, .dark or [data-theme=dark]) or colours you give, pair foreground roles (fg, text, on-…) and UI boundaries (border, ring, focus) with background roles (bg, surface, canvas…) or the pairs you name, and report each WCAG 2 contrast ratio per theme with AA (4.5:1 text, 3:1 UI) and AAA. Reads hex, rgb(), hsl(), oklch() and var() references.',
        input: z
          .object({
            path: repoPath.optional().describe('A stylesheet (or tokens file with CSS custom properties).'),
            colors: z.record(z.string().max(80), z.string().max(120)).optional().describe('Light (and shared) colours by name, e.g. {"fg":"#111","bg":"#fff"}.'),
            dark: z.record(z.string().max(80), z.string().max(120)).optional().describe('Dark overrides by name.'),
            pairs: z.array(z.tuple([z.string().max(80), z.string().max(80)])).max(400).optional().describe('[foreground, background] names or colours to check.'),
            foregrounds: z.array(z.string().max(80)).max(100).optional(),
            backgrounds: z.array(z.string().max(80)).max(100).optional(),
          })
          .refine((v) => v.path || v.colors, 'Give a stylesheet path or colours'),
        level: 1,
        readOnly: true,
        classify: () => ({ reasons: ['Reads a stylesheet and computes contrast'], effects: [], writes: false }),
        run: (input, ctx) => contrastMatrix(ctx, input),
      }),
      operation({
        id: 'design.lint_tokens',
        title: 'Find design values code hard-codes',
        description:
          'Scan source folders for colours written as literals (hex, rgb()/hsl()/oklch()), Tailwind default-palette classes (bg-blue-500) and pixel font sizes in stylesheets, outside the files where a design standard defines its values (tokens, theme, variables, tailwind.config) and outside custom-property definitions. Use it to keep a change on the repository\'s semantic tokens.',
        input: z.object({
          paths: z.array(repoPath).min(1).max(20).default(['src']),
          allow: z.array(z.string().max(60)).max(100).default([]).describe('Values to ignore, e.g. "#fff" for an email template.'),
          maxFindings: z.number().int().min(1).max(1000).default(200),
        }),
        level: 1,
        readOnly: true,
        classify: () => ({ reasons: ['Reads source files'], effects: [], writes: false }),
        run: (input, ctx) => lintTokens(ctx, input),
      }),
    ],
  };
}
