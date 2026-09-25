import { LOCKFILES } from './worktrees.js';

/**
 * Diff packing (docs/plans/AUTOPILOT_GATES_PLAN.md §3.A). A review prompt
 * has room for only so much diff. Instead of cutting one long string in
 * git's order — which silently hides whatever comes last — the diff is split
 * into one chunk per file, ordered by how much a reviewer needs it, and packed
 * whole up to the budget. Every changed file that is not shown is named, so
 * the list of what a reviewer did not see is always complete.
 */

export type DiffFileClass = 'source' | 'test' | 'config' | 'docs' | 'generated';

export interface PackFile {
  path: string;
  additions: number | null;
  deletions: number | null;
  /** Untracked files have no `git diff <baseline>`; they are read from disk. */
  status?: string;
}

export interface OmittedFile {
  path: string;
  additions: number | null;
  deletions: number | null;
  /** Why it is not (fully) in the packed diff. */
  reason: 'partial' | 'too large for the budget' | 'not in the collected diff' | 'binary';
}

export interface PackedDiff {
  text: string;
  shown: string[];
  omitted: OmittedFile[];
}

const CLASS_ORDER: Record<DiffFileClass, number> = { source: 0, test: 1, config: 2, docs: 3, generated: 4 };
const LOCKFILE_NAMES = new Set(LOCKFILES);

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Which of the five priority classes a path falls in. Binary files count as generated. */
export function classifyDiffPath(filePath: string, binary = false): DiffFileClass {
  const p = filePath.replace(/\\/g, '/');
  const name = baseName(p);
  if (binary || LOCKFILE_NAMES.has(name) || /\.generated\./i.test(name) || /\.min\.[a-z0-9]+$/i.test(name) || /(^|\/)(dist|build)\//.test(p)) return 'generated';
  if (/(^|\/)(__tests__|__mocks__|tests?|specs?|e2e)\//i.test(p) || /\.(test|spec)\.[a-z0-9]+$/i.test(name)) return 'test';
  if (/\.(md|mdx|markdown|rst|txt|adoc)$/i.test(name) || /(^|\/)docs?\//i.test(p)) return 'docs';
  if (
    /\.(json|jsonc|ya?ml|toml|ini|cfg|conf|properties|env\.example|lock)$/i.test(name) ||
    /^\.[\w.-]+rc(\.\w+)?$/.test(name) ||
    /\.config\.[a-z0-9]+$/i.test(name) ||
    /^(Dockerfile|Makefile|Procfile|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.nvmrc)$/.test(name) ||
    /(^|\/)\.github\//.test(p)
  )
    return 'config';
  return 'source';
}

interface Chunk {
  path: string;
  text: string;
  binary: boolean;
}

/** The path a `diff --git` chunk is about: its new name, or its old one when deleted. */
function chunkPath(text: string): string | null {
  const lines = text.split('\n', 12);
  const plus = lines.find((l) => l.startsWith('+++ '));
  if (plus && plus !== '+++ /dev/null') return plus.slice(4).replace(/^b\//, '').replace(/\t.*$/, '');
  const minus = lines.find((l) => l.startsWith('--- '));
  if (minus && minus !== '--- /dev/null') return minus.slice(4).replace(/^a\//, '').replace(/\t.*$/, '');
  const renamed = lines.find((l) => l.startsWith('rename to '));
  if (renamed) return renamed.slice('rename to '.length);
  // `diff --git a/P b/P` with the same path twice (binary or mode-only changes).
  const header = lines[0]!.slice('diff --git '.length);
  if (header.startsWith('a/')) {
    const half = (header.length - 1) / 2;
    if (Number.isInteger(half) && header.slice(half, half + 3) === ' b/') return header.slice(2, half);
    const m = / b\/(.+)$/.exec(header);
    if (m) return m[1]!;
  }
  return null;
}

/** Split a unified diff into one chunk per file. Text before the first header is dropped. */
export function splitDiff(raw: string): Chunk[] {
  const chunks: Chunk[] = [];
  const starts: number[] = [];
  const re = /^diff --git /gm;
  for (let m = re.exec(raw); m; m = re.exec(raw)) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const text = raw.slice(starts[i], starts[i + 1] ?? raw.length);
    const path = chunkPath(text);
    if (!path) continue;
    chunks.push({ path, text: text.endsWith('\n') ? text : `${text}\n`, binary: /^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text) });
  }
  return chunks;
}

/** Cut a chunk at the last hunk boundary that fits, keeping its header. */
function cutAtHunk(text: string, budget: number): string {
  const hunks: number[] = [];
  const re = /^@@ /gm;
  for (let m = re.exec(text); m; m = re.exec(text)) hunks.push(m.index);
  // A hunk ends where the next one starts: keep the header and every whole hunk that fits.
  const ends = hunks.slice(1).filter((i) => i <= budget);
  if (ends.length) return text.slice(0, ends.at(-1));
  // Even the first hunk is larger than the budget: cut at the last whole line.
  const nl = text.lastIndexOf('\n', budget - 1);
  return text.slice(0, nl > 0 ? nl + 1 : budget);
}

/**
 * Pack `raw` (a unified diff) into at most `budget` characters. `changedFiles`
 * is the complete list of what changed (from `changesSince`): any of them not
 * shown in full is in `omitted`, whether it was too large or never reached the
 * collected diff at all.
 */
export function packDiff(raw: string, changedFiles: PackFile[], budget: number, opts: { truncated?: boolean } = {}): PackedDiff {
  const stats = new Map(changedFiles.map((f) => [f.path, f]));
  const chunks = splitDiff(withoutPartialTail(raw, Boolean(opts.truncated))).sort((a, b) => {
    const binA = a.binary || stats.get(a.path)?.additions === null;
    const binB = b.binary || stats.get(b.path)?.additions === null;
    return CLASS_ORDER[classifyDiffPath(a.path, binA)] - CLASS_ORDER[classifyDiffPath(b.path, binB)];
  });
  const parts: string[] = [];
  const shown: string[] = [];
  const omitted: OmittedFile[] = [];
  const statOf = (p: string) => ({ additions: stats.get(p)?.additions ?? null, deletions: stats.get(p)?.deletions ?? null });
  let used = 0;
  for (const [i, chunk] of chunks.entries()) {
    if (used + chunk.text.length <= budget) {
      parts.push(chunk.text);
      used += chunk.text.length;
      shown.push(chunk.path);
      continue;
    }
    // The first file is shown in part even when it alone is over budget, so one giant file never hides everything.
    if (i === 0 && !chunk.binary) {
      const part = cutAtHunk(chunk.text, budget);
      parts.push(`${part}${part.endsWith('\n') ? '' : '\n'}[${chunk.path}: only the first ${part.length} of ${chunk.text.length} characters are shown]\n`);
      used += part.length;
      omitted.push({ path: chunk.path, ...statOf(chunk.path), reason: 'partial' });
      continue;
    }
    omitted.push({ path: chunk.path, ...statOf(chunk.path), reason: chunk.binary ? 'binary' : 'too large for the budget' });
  }
  const seen = new Set(chunks.map((c) => c.path));
  for (const f of changedFiles) if (!seen.has(f.path)) omitted.push({ path: f.path, additions: f.additions, deletions: f.deletions, reason: 'not in the collected diff' });
  return { text: parts.join(''), shown, omitted };
}

/**
 * A collected diff that was cut short ends in a partial chunk: drop it, so that
 * file counts as not collected instead of being shown as if complete.
 */
export function withoutPartialTail(raw: string, truncated: boolean): string {
  if (!truncated) return raw;
  const last = raw.lastIndexOf('\ndiff --git ');
  return last >= 0 ? raw.slice(0, last + 1) : '';
}

const signed = (n: number | null, sign: string) => (n === null ? `${sign}?` : `${sign}${n}`);

/** "+12 −3", or "binary" when git reports no line counts. */
export function diffLineStats(f: { additions: number | null; deletions: number | null }): string {
  return f.additions === null && f.deletions === null ? 'binary' : `${signed(f.additions, '+')} ${signed(f.deletions, '−')}`;
}
