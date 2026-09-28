import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { detectSecrets, secretLabel, sensitiveFileReason } from '@acc/security';
import { EMPTY_TREE, failureText, git, GitError, headCommit } from './index.js';
import { outgoingFiles, outgoingPatch, patchHeaderPath, splitPatch, unstagePaths } from './source-control.js';

/**
 * Secret preflight before a commit or push (release requirement): known
 * sensitive files and high-confidence credential formats in added lines block
 * the action. Findings name the file and the kind of secret, never the value.
 * Source Control, a release, the `git.push` tool and every commit of task work
 * (VER-1: the Git checkpoint, a worktree's final commit and `git.commit`) run it.
 */
export interface PreflightFinding {
  path: string;
  reason: string;
}

/** Split a `-U0` patch into per-file added text. */
export function addedLinesByFile(patch: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // A header whose name cannot be read still has its lines checked (audit F-47).
      const file = patchHeaderPath(line) ?? line.slice('diff --git '.length);
      current = files.get(file) ?? [];
      files.set(file, current);
    } else if (current && line.startsWith('+') && !line.startsWith('+++')) current.push(line.slice(1));
  }
  return files;
}

export function preflightFindings(paths: string[], patch: string): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const reason = sensitiveFileReason(p);
    if (reason && !seen.has(p)) {
      seen.add(p);
      findings.push({ path: p, reason: `looks like ${reason}` });
    }
  }
  for (const [file, lines] of addedLinesByFile(patch)) {
    if (seen.has(file)) continue;
    const finding = contentFinding(file, lines.join('\n'));
    if (finding) findings.push(finding);
  }
  return findings;
}

/** A finding for text a file adds or holds, or null when it carries no known credential format. */
export function contentFinding(path: string, text: string): PreflightFinding | null {
  const rules = detectSecrets(text);
  return rules.length ? { path, reason: `contains what looks like ${rules.map(secretLabel).join(' and ')}` } : null;
}

/** Findings as one line: "src/a.ts contains what looks like a GitHub token; .env looks like an environment file". */
export function findingsText(findings: readonly PreflightFinding[]): string {
  return findings.map((f) => `${f.path} ${f.reason}`).join('; ');
}

/** Remove whole file sections for sensitive paths from a unified diff (for AI context). */
export function withoutSensitiveFiles(patch: string): { patch: string; omitted: string[] } {
  const omitted: string[] = [];
  const out: string[] = [];
  let skipping = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const file = patchHeaderPath(line);
      // An unreadable name is left out of AI context rather than guessed at.
      skipping = file === null || Boolean(sensitiveFileReason(file));
      if (skipping) omitted.push(file ?? line.slice('diff --git '.length));
    }
    if (!skipping) out.push(line);
  }
  return { patch: out.join('\n'), omitted };
}

/** The most outgoing patch text a push preflight reads; anything larger is refused, not partly checked. */
export const MAX_PREFLIGHT_BYTES = 20 * 1024 * 1024;

/**
 * Check what a push would send, `tip` minus `exclude` (a ref, or a revision
 * option such as `--remotes=<remote>`; every remote branch when null), for
 * secret material. Source Control runs it before every push,
 * a release before its push (docs/plans/RELEASE_STAGE_PLAN.md §3.4) and the
 * `git.push` tool before it pushes:
 * `truncated` means the range was too large to check, which callers refuse.
 */
export async function scanOutgoing(root: string, tip: string, exclude: string | null): Promise<{ truncated: boolean; findings: PreflightFinding[] }> {
  const { patch, truncated } = await outgoingPatch(root, { tip, exclude, maxBytes: MAX_PREFLIGHT_BYTES });
  if (truncated) return { truncated: true, findings: [] };
  // File names come from `--name-only -z`: a quoted or binary file is still checked by name (audit F-47).
  const files = [...new Set([...(await outgoingFiles(root, { tip, exclude })), ...splitPatch(patch).files])];
  return { truncated: false, findings: preflightFindings(files, patch) };
}

/** What a scan read: the files it covered and what it found; `truncated` means it could not read everything, which callers refuse. */
export interface SecretScan {
  truncated: boolean;
  findings: PreflightFinding[];
  files: string[];
}

const DIFF_SAFETY = ['--no-color', '--no-ext-diff', '--no-textconv'];

async function gitRead(cwd: string, args: string[], maxOutputBytes?: number, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; truncated: boolean }> {
  const result = await git(cwd, args, { timeoutMs: 120_000, ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}), ...(env ? { env } : {}) });
  if (result.code !== 0 && !result.truncated) throw new GitError(`git ${args.find((a) => !a.startsWith('-'))} failed: ${failureText(result.stderr) || failureText(result.stdout)}`, result);
  return { stdout: result.stdout, truncated: Boolean(result.truncated) };
}

/**
 * What is staged for `paths` (every staged path when omitted) — the index
 * against HEAD — checked as a Source Control commit is. Every commit of task
 * work runs it after staging and before `git commit` (VER-1). `literal` reads
 * the paths as `--literal-pathspecs` does, for a caller that stages them so.
 * A staged deletion is left out (`--diff-filter=d`, as the repository's own
 * pre-commit scan does): removing a committed `.env` takes a secret out, and
 * the text it removes counts toward no limit.
 * Attributes are read from the empty tree (`GIT_ATTR_SOURCE`), so a
 * `.gitattributes` line such as `config.ts -diff` or `*.json binary` — the
 * change's own or one already committed — cannot turn a text file into
 * "Binary files differ": only a NUL byte makes a file binary here. The
 * index-to-HEAD diff runs no filter, so nothing else changes. A Git older than
 * 2.42 ignores the variable, and a SHA-256 repository is left without it.
 */
export async function scanStaged(cwd: string, paths?: readonly string[], options: { literal?: boolean } = {}): Promise<SecretScan> {
  const head = await headCommit(cwd);
  const base = head ? [] : [EMPTY_TREE];
  const noAttributes = !head || head.length === EMPTY_TREE.length ? { GIT_ATTR_SOURCE: EMPTY_TREE } : undefined;
  const pre = options.literal ? ['--literal-pathspecs'] : [];
  const spec = paths ? ['--', ...paths] : [];
  const names = await gitRead(cwd, [...pre, 'diff', '--cached', ...base, '--name-only', '-z', '--no-renames', '--diff-filter=d', ...spec]);
  const files = names.stdout.split('\0').filter(Boolean);
  if (!files.length) return { truncated: false, findings: [], files };
  const patch = await gitRead(cwd, [...pre, 'diff', '--cached', ...base, ...DIFF_SAFETY, '-U0', '--no-renames', '--diff-filter=d', ...spec], MAX_PREFLIGHT_BYTES, noAttributes);
  if (patch.truncated) return { truncated: true, findings: [], files };
  return { truncated: false, findings: preflightFindings(files, patch.stdout), files };
}

/**
 * Everything in the working tree that differs from the commit `base` —
 * tracked changes and untracked files Git does not ignore — checked for
 * secret material (the `security.secret_scan` tool's task scope). A deletion
 * is left out, as `scanStaged` leaves it out of a commit's check.
 */
export async function scanSince(cwd: string, base: string): Promise<SecretScan> {
  const tracked = (await gitRead(cwd, ['diff', base, '--name-only', '-z', '--no-renames', '--diff-filter=d'])).stdout.split('\0').filter(Boolean);
  const untracked = (await gitRead(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  const patch = tracked.length ? await gitRead(cwd, ['diff', base, ...DIFF_SAFETY, '-U0', '--no-renames', '--diff-filter=d'], MAX_PREFLIGHT_BYTES) : { stdout: '', truncated: false };
  const files = [...new Set([...tracked, ...untracked])];
  if (patch.truncated) return { truncated: true, findings: [], files };
  const findings = preflightFindings(tracked, patch.stdout);
  const whole = await scanFiles(cwd, untracked, { maxBytes: MAX_PREFLIGHT_BYTES - patch.stdout.length });
  return { truncated: whole.truncated, findings: [...findings, ...whole.findings], files };
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function inside(root: string, candidate: string): boolean {
  const [r, c] = caseInsensitive ? [root.toLowerCase(), candidate.toLowerCase()] : [root, candidate];
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * Whole files, by path relative to `cwd`: a sensitive name, or a known
 * credential format anywhere in the text (a binary file is judged by its name).
 * Only regular files whose real location is inside `roots` (default `cwd`) are
 * read: a link is committed as a link, never as what it points at, so it is
 * judged by its name, and neither it nor a linked folder above a file leads
 * the scan out of the roots. Reading stops, `truncated`, once `maxBytes` would
 * be passed.
 */
export async function scanFiles(cwd: string, paths: readonly string[], options: { maxBytes?: number; roots?: readonly string[] } = {}): Promise<SecretScan> {
  const maxBytes = options.maxBytes ?? MAX_PREFLIGHT_BYTES;
  const roots = await Promise.all((options.roots ?? [cwd]).map((root) => realpath(root).catch(() => path.resolve(root))));
  const findings = preflightFindings([...paths], '');
  const named = new Set(findings.map((f) => f.path));
  let read = 0;
  for (const rel of paths) {
    if (named.has(rel)) continue;
    const file = path.join(cwd, rel);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) continue;
    const real = await realpath(file).catch(() => null);
    if (!real || !roots.some((root) => inside(root, real))) continue;
    if (read + info.size > maxBytes) return { truncated: true, findings, files: [...paths] };
    read += info.size;
    const bytes = await readFile(file).catch(() => null);
    if (!bytes || bytes.includes(0)) continue;
    const finding = contentFinding(rel, bytes.toString('utf8'));
    if (finding) findings.push(finding);
  }
  return { truncated: false, findings, files: [...paths] };
}

/**
 * A commit of task work the secret check refused (VER-1): the Git checkpoint,
 * a worktree's final commit or the `git.commit` tool would have recorded
 * secret material. Nothing was committed; the message names each file and the
 * kind of secret, never the value.
 */
export class SecretCommitError extends Error {
  constructor(
    readonly findings: PreflightFinding[],
    readonly truncated: boolean,
  ) {
    super(
      truncated
        ? 'Secret check refused the commit: the changes are too large to check for secrets (over 20 MB). Nothing was committed.'
        : `Secret check refused the commit: ${findingsText(findings)}. Remove the secret from the file and read it at run time instead (an environment variable or the project's secret store). Nothing was committed.`,
    );
    this.name = 'SecretCommitError';
  }
}

/**
 * Refuse a commit whose staged `paths` hold secret material: they are
 * unstaged again and a `SecretCommitError` is thrown. Called after staging
 * and before `git commit`, with the pathspec semantics the commit uses.
 */
export async function assertNoStagedSecrets(cwd: string, paths: readonly string[], options: { literal?: boolean } = {}): Promise<void> {
  const scan = await scanStaged(cwd, paths, options);
  if (!scan.truncated && !scan.findings.length) return;
  // Unstaged so the index does not keep holding what was refused; the working tree is untouched.
  await unstagePaths(cwd, [...paths], { hasHead: (await headCommit(cwd)) !== null }).catch(() => undefined);
  throw new SecretCommitError(scan.findings, scan.truncated);
}
