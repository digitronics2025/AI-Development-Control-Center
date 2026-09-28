import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { which } from '@acc/executor';
import { findingsText, git, scanFiles, scanSince, scanStaged, type SecretScan } from '@acc/git';
import { redact } from '@acc/security';
import { z } from 'zod';
import { detectExecutable, run } from '../detect.js';
import { OutsideRootError, relativeTo, resolveInside } from '../paths.js';
import { failure, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';

/**
 * Security scans (VER-1): read-only checks whose findings are shown to
 * reviewers and count as verification evidence. `security.secret_scan` runs
 * the same secret check as every commit and push (the `@acc/git` preflight);
 * `security.dependency_audit` lists known advisories in the lockfiles — with
 * osv-scanner when it is installed, else `pnpm audit` / `npm audit` — and,
 * inside a task, which of them the task's change brought in: advisory ids are
 * compared with an audit of the baseline commit's lockfile, read with `git show`.
 * SAST is not here yet.
 */

/** Lockfiles the audit looks for at the repository root (osv-scanner reads each of them; pnpm and npm audit only their own). */
export const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'Cargo.lock',
  'go.mod',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'requirements.txt',
  'Gemfile.lock',
  'composer.lock',
  'gradle.lockfile',
] as const;

/** Whether a repository path is a lockfile the audit reads. */
export function isLockfile(file: string): boolean {
  return (LOCKFILE_NAMES as readonly string[]).includes(path.posix.basename(file.replace(/\\/g, '/')));
}

/** One known advisory affecting a package a lockfile pins. */
export interface Advisory {
  /** GHSA id where there is one, else the database's own id. */
  id: string;
  package: string;
  version: string | null;
  /** CRITICAL, HIGH, MODERATE, MEDIUM, LOW or UNKNOWN. */
  severity: string;
  /** The first version that fixes it, when the database names one. */
  fixedIn: string | null;
  summary: string;
  lockfile: string;
}

/** "GHSA-… · lodash 4.17.20 · severity HIGH · fixed in 4.17.21 — Command injection (pnpm-lock.yaml)". */
export function advisoryLine(a: Advisory): string {
  return `${a.id} · ${a.package}${a.version ? ` ${a.version}` : ''} · severity ${a.severity} · ${a.fixedIn ? `fixed in ${a.fixedIn}` : 'no fixed version yet'}${a.summary ? ` — ${a.summary}` : ''} (${a.lockfile})`;
}

type Scanner = 'osv-scanner' | 'pnpm audit' | 'npm audit';

/** The audit command a lockfile has without osv-scanner. */
const FALLBACK: Record<string, Scanner> = { 'pnpm-lock.yaml': 'pnpm audit', 'package-lock.json': 'npm audit', 'npm-shrinkwrap.json': 'npm audit' };

const MAX_SCANNER_OUTPUT = 32 * 1024 * 1024;
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;

/**
 * The scanner's environment, with cmd.exe told never to look for a program in
 * the current folder (NoDefaultCurrentDirectoryInExePath). npm's `pnpm.cmd` and
 * `npm.cmd` call a bare `node` and the audit runs in the repository: a
 * `node.bat` or `node.cmd` there would otherwise run from this Level 1,
 * read-only tool. Other systems ignore the variable.
 */
function scannerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([name]) => name.toUpperCase() !== 'NODEFAULTCURRENTDIRECTORYINEXEPATH');
  return { ...Object.fromEntries(kept), NoDefaultCurrentDirectoryInExePath: '1' };
}

function upper(severity: unknown): string {
  return typeof severity === 'string' && severity.trim() ? severity.trim().toUpperCase() : 'UNKNOWN';
}

/** A CVSS base score as the usual band. */
function band(score: unknown): string {
  const n = typeof score === 'string' ? Number.parseFloat(score) : typeof score === 'number' ? score : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return 'UNKNOWN';
  return n >= 9 ? 'CRITICAL' : n >= 7 ? 'HIGH' : n >= 4 ? 'MEDIUM' : 'LOW';
}

/** Dotted versions compared part by part, numbers as numbers ("4.17.9" < "4.17.21"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    const c = nx !== null && ny !== null ? nx - ny : x.localeCompare(y);
    if (c !== 0) return c;
  }
  return 0;
}

/** "<4.17.21", ">=4.17.21" or "4.17.21": the version named, else null ("<0.0.0" means no fix). */
function versionIn(range: unknown): string | null {
  if (typeof range !== 'string') return null;
  const m = /(\d+(?:\.\d+)*(?:[-+][\w.]+)?)/.exec(range);
  return m && m[1] !== '0.0.0' ? m[1]! : null;
}

/**
 * JSON a scanner printed that is not an audit report: npm and pnpm print their
 * error (an unreachable registry, a missing lockfile) as a JSON object with
 * `error` / `message`, exit 1 as they do for findings. Read as a report it would
 * be "no advisories", so it is a failure, with the tool's own reason.
 */
class NotAnAuditReport extends Error {
  constructor(data: unknown) {
    const d = (data && typeof data === 'object' ? data : {}) as { error?: unknown; message?: unknown };
    const e = d.error && typeof d.error === 'object' ? (d.error as { summary?: unknown; message?: unknown; code?: unknown }) : {};
    const said = [e.summary, e.message, d.message, d.error, e.code].find((x): x is string => typeof x === 'string' && x.trim().length > 0);
    super(said ? said.trim().split('\n')[0]! : 'the output is not an audit report');
    this.name = 'NotAnAuditReport';
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

interface OsvVulnerability {
  id?: string;
  summary?: string;
  details?: string;
  database_specific?: { severity?: string };
  affected?: Array<{ package?: { name?: string }; ranges?: Array<{ events?: Array<Record<string, string>> }> }>;
}

/**
 * osv-scanner v2's `--format json`: results → packages → vulnerabilities,
 * with aliases of one issue gathered in `groups` (one advisory per group).
 * Anything without `results` throws `NotAnAuditReport`.
 */
export function parseOsvJson(text: string, lockfile: string): Advisory[] {
  const data = JSON.parse(text) as { error?: unknown; results?: Array<{ packages?: Array<{ package?: { name?: string; version?: string }; vulnerabilities?: OsvVulnerability[]; groups?: Array<{ ids?: string[]; max_severity?: string }> }> }> | null };
  if (!isObject(data) || data.error !== undefined || !(Array.isArray(data.results) || data.results === null)) throw new NotAnAuditReport(data);
  const out: Advisory[] = [];
  for (const result of data.results ?? []) {
    for (const entry of result.packages ?? []) {
      const name = entry.package?.name;
      if (!name) continue;
      const version = entry.package?.version ?? null;
      const vulns = (entry.vulnerabilities ?? []).filter((v) => typeof v.id === 'string');
      const groups = entry.groups?.length ? entry.groups : vulns.map((v) => ({ ids: [v.id!], max_severity: undefined }));
      for (const group of groups) {
        const members = vulns.filter((v) => group.ids?.includes(v.id!));
        const rep = members.find((v) => v.id!.startsWith('GHSA-')) ?? members[0];
        if (!rep) continue;
        const named = members.map((v) => v.database_specific?.severity).find((s) => typeof s === 'string' && s);
        const fixes = members
          .flatMap((v) => v.affected ?? [])
          .filter((a) => !a.package?.name || a.package.name === name)
          .flatMap((a) => a.ranges ?? [])
          .flatMap((r) => r.events ?? [])
          .map((e) => e.fixed)
          .filter((f): f is string => typeof f === 'string' && f.length > 0)
          .sort(compareVersions);
        const fixedIn = (version ? fixes.find((f) => compareVersions(f, version) > 0) : undefined) ?? fixes[0] ?? null;
        out.push({
          id: rep.id!,
          package: name,
          version,
          severity: named ? upper(named) : band(group.max_severity),
          fixedIn,
          summary: (rep.summary ?? rep.details?.split('\n')[0] ?? '').slice(0, 160),
          lockfile,
        });
      }
    }
  }
  return out;
}

const GHSA = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;

/**
 * `pnpm audit --json` and npm 6 (`advisories`, keyed by id), or npm 7+
 * (`vulnerabilities`, keyed by package, each `via` object an advisory).
 * An object with neither, or with `error` (npm's and pnpm's JSON error
 * output), throws `NotAnAuditReport`: it is never read as zero advisories.
 */
export function parseAuditJson(text: string, lockfile: string): Advisory[] {
  const data = JSON.parse(text) as {
    error?: unknown;
    advisories?: Record<string, { id?: number | string; github_advisory_id?: string; url?: string; module_name?: string; severity?: string; title?: string; patched_versions?: string; findings?: Array<{ version?: string }> }>;
    vulnerabilities?: Record<string, { name?: string; fixAvailable?: boolean | { name?: string; version?: string }; via?: Array<string | { source?: number; name?: string; title?: string; url?: string; severity?: string; range?: string }> }>;
  };
  if (!isObject(data) || data.error !== undefined || !(isObject(data.advisories) || isObject(data.vulnerabilities))) throw new NotAnAuditReport(data);
  const out: Advisory[] = [];
  for (const a of Object.values(data.advisories ?? {})) {
    if (!a.module_name) continue;
    out.push({
      id: a.github_advisory_id ?? GHSA.exec(a.url ?? '')?.[0] ?? String(a.id ?? 'unknown'),
      package: a.module_name,
      version: a.findings?.[0]?.version ?? null,
      severity: upper(a.severity),
      fixedIn: versionIn(a.patched_versions),
      summary: (a.title ?? '').slice(0, 160),
      lockfile,
    });
  }
  for (const [key, v] of Object.entries(data.vulnerabilities ?? {})) {
    const name = v.name ?? key;
    for (const via of v.via ?? []) {
      // A string names the package it inherits the problem from: that package has its own entry.
      if (typeof via === 'string' || (via.name && via.name !== name)) continue;
      const fix = typeof v.fixAvailable === 'object' && v.fixAvailable.name === name ? (v.fixAvailable.version ?? null) : null;
      out.push({
        id: GHSA.exec(via.url ?? '')?.[0] ?? String(via.source ?? 'unknown'),
        package: name,
        version: null,
        severity: upper(via.severity),
        fixedIn: versionIn(via.range?.startsWith('<') ? via.range : undefined) ?? fix,
        summary: (via.title ?? '').slice(0, 160),
        lockfile,
      });
    }
  }
  return out;
}

const key = (a: Advisory) => `${a.package}\0${a.id}`;

/** Audit one lockfile, `rel` inside `dir`, with one scanner. Throws with the reason when it cannot. */
async function auditWith(ctx: OperationContext, scanner: Scanner, exe: string, dir: string, rel: string, label: string): Promise<Advisory[]> {
  const args = scanner === 'osv-scanner' ? ['scan', 'source', '-L', rel, '--format', 'json'] : scanner === 'pnpm audit' ? ['audit', '--json'] : ['audit', '--json', '--package-lock-only'];
  const cwd = scanner === 'osv-scanner' ? dir : path.join(dir, path.dirname(rel));
  const r = await run(exe, args, { cwd, env: scannerEnv(ctx.env), timeoutMs: Math.min(ctx.timeoutMs, 180_000), maxBytes: MAX_SCANNER_OUTPUT });
  if (r.spawnError) throw new Error(`${scanner} could not start: ${r.spawnError}`);
  if (r.timedOut) throw new Error(`${scanner} timed out`);
  // Both exit non-zero when they find something; only output that is not an audit report is a failure.
  const start = r.stdout.indexOf('{');
  try {
    if (start < 0) throw new Error('no JSON');
    return scanner === 'osv-scanner' ? parseOsvJson(r.stdout.slice(start), label) : parseAuditJson(r.stdout.slice(start), label);
  } catch (error) {
    const why = error instanceof NotAnAuditReport ? error.message : ((r.stderr || r.stdout).split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? `exit ${r.code}`);
    throw new Error(`${scanner} failed (exit ${r.code}): ${redact(why).slice(0, 200)}`, { cause: error });
  }
}

/** A lockfile as the baseline commit had it: its text, or null when it did not exist there. */
async function atBaseline(ctx: OperationContext, base: string, rel: string): Promise<string | null> {
  const r = await git(ctx.cwd, ['show', `${base}:./${rel}`], { maxOutputBytes: MAX_LOCKFILE_BYTES, timeoutMs: 60_000 });
  if (r.truncated) throw new Error(`${rel} at the baseline is too large to read`);
  return r.code === 0 ? r.stdout : null;
}

const same = (a: string, b: string) => a.replace(/\r/g, '').trimEnd() === b.replace(/\r/g, '').trimEnd();

interface LockfileAudit {
  path: string;
  scanner: Scanner;
  advisories: Advisory[];
  /** How the baseline was known: compared, unchanged, absent from the baseline, not in a task, or not audited. */
  baseline: 'compared' | 'unchanged' | 'new-lockfile' | 'none' | 'unknown';
  newAdvisories: Advisory[];
  note?: string;
}

async function auditLockfile(ctx: OperationContext, rel: string, reasons: string[]): Promise<LockfileAudit | null> {
  const name = path.posix.basename(rel);
  const candidates: Scanner[] = ['osv-scanner', ...(FALLBACK[name] ? [FALLBACK[name]!] : [])];
  for (const scanner of candidates) {
    const exe = await which(scanner.split(' ')[0]!, ctx.env);
    if (!exe) {
      reasons.push(`${rel}: ${scanner.split(' ')[0]} is not installed`);
      continue;
    }
    let advisories: Advisory[];
    try {
      advisories = await auditWith(ctx, scanner, exe, ctx.cwd, rel, rel);
    } catch (error) {
      reasons.push(`${rel}: ${(error as Error).message}`);
      continue;
    }
    if (!ctx.baseline) return { path: rel, scanner, advisories, baseline: 'none', newAdvisories: advisories };
    let before: string | null;
    try {
      before = await atBaseline(ctx, ctx.baseline, rel);
    } catch (error) {
      return { path: rel, scanner, advisories, baseline: 'unknown', newAdvisories: advisories, note: (error as Error).message };
    }
    if (before === null) return { path: rel, scanner, advisories, baseline: 'new-lockfile', newAdvisories: advisories };
    const now = await readFile(path.join(ctx.cwd, rel), 'utf8').catch(() => null);
    if (now !== null && same(before, now)) return { path: rel, scanner, advisories, baseline: 'unchanged', newAdvisories: [] };
    // The baseline's lockfile (and manifest, which pnpm and npm read beside it) in a folder of its own.
    const dir = path.join(ctx.tempDir, `acc-audit-${randomBytes(6).toString('hex')}`);
    try {
      await mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(dir, rel), before);
      if (scanner !== 'osv-scanner') {
        const manifest = path.posix.join(path.posix.dirname(rel), 'package.json');
        const shown = await atBaseline(ctx, ctx.baseline, manifest).catch(() => null);
        if (shown !== null) await writeFile(path.join(dir, manifest), shown);
      }
      const old = new Set((await auditWith(ctx, scanner, exe, dir, rel, rel)).map(key));
      return { path: rel, scanner, advisories, baseline: 'compared', newAdvisories: advisories.filter((a) => !old.has(key(a))) };
    } catch (error) {
      return { path: rel, scanner, advisories, baseline: 'unknown', newAdvisories: advisories, note: `the baseline lockfile could not be audited (${(error as Error).message})` };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return null;
}

function scanResult(scope: string, scan: SecretScan): OperationResult {
  const output = { scope, files: scan.files.length, findings: scan.findings, truncated: scan.truncated };
  if (scan.truncated) return failure('FAILED', `Too much to check for secrets (over 20 MB) in ${scan.files.length} file(s); narrow it with scope "paths".`, { output });
  const n = scan.findings.length;
  return {
    ok: true,
    summary: n ? `Secret material in ${n} file(s): ${findingsText(scan.findings)}` : `No secret material in ${scan.files.length} file(s) (${scope})`,
    output,
    evidence: [`secret scan (${scope}): ${scan.files.length} file(s), ${n} finding(s)`],
  };
}

const lockfilesInput = z
  .array(z.string().min(1).max(500))
  .max(20)
  .optional()
  .describe('Lockfiles to audit, relative to the repository (default: every known lockfile at its root).');

export function securityProvider(): ToolProvider {
  return {
    id: 'security',
    name: 'Security scans',
    description: 'Secret scan of changes or files, and a dependency audit of lockfiles (osv-scanner, else pnpm or npm audit).',
    category: 'verification',
    builtin: true,
    detect: (ctx) => detectExecutable(ctx, ['git']),
    operations: [
      operation({
        id: 'security.secret_scan',
        title: 'Scan for secrets',
        description:
          'Check for credentials the way every commit and push is checked: known token and key formats, private keys, and sensitive files such as .env. Scope "task" reads everything changed since the task started, "staged" what is staged, "paths" whole files or folders. Findings name the file and the kind of secret, never the value.',
        input: z.object({
          scope: z.enum(['task', 'staged', 'paths']).default('task'),
          paths: z.array(z.string().min(1).max(1000)).max(500).optional().describe('Files or folders to read, with scope "paths".'),
        }),
        level: 1,
        readOnly: true,
        async run(input, ctx) {
          try {
            if (input.scope === 'staged') return scanResult('staged', await scanStaged(ctx.cwd));
            if (input.scope === 'task') {
              if (!ctx.baseline) return failure('UNAVAILABLE', 'There is no task baseline to compare with here (not a task, or no Git baseline). Use scope "staged" or "paths".');
              return scanResult('task', await scanSince(ctx.cwd, ctx.baseline));
            }
            if (!input.paths?.length) return failure('INVALID_INPUT', 'Scope "paths" needs the files or folders to read in `paths`.');
            const rels = input.paths.map((p) => relativeTo(ctx.cwd, resolveInside(ctx.roots, ctx.cwd, p)) || '.');
            // Folders are read as Git lists them: tracked and untracked files it does not ignore.
            const listed = await git(ctx.cwd, ['--literal-pathspecs', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...rels]);
            const files = listed.code === 0 ? [...new Set(listed.stdout.split('\0').filter(Boolean))] : rels.filter((r) => existsSync(path.join(ctx.cwd, r)));
            return scanResult('paths', await scanFiles(ctx.cwd, files, { roots: ctx.roots }));
          } catch (error) {
            if (error instanceof OutsideRootError) return failure('OUTSIDE_ROOT', error.message);
            return failure('FAILED', `The secret scan could not run: ${redact((error as Error).message).slice(0, 300)}`);
          }
        },
      }),
      operation({
        id: 'security.dependency_audit',
        title: 'Audit dependencies',
        description:
          'Known advisories (package, severity, fixed-in version) in the lockfiles, with osv-scanner when it is installed, else pnpm or npm audit. In a task it also says which advisories the change brought in, by comparing with the lockfile the task started from. Sends package names and versions to the advisory database.',
        input: z.object({ lockfiles: lockfilesInput }),
        level: 1,
        readOnly: true,
        classify: () => ({ effects: ['network'], reasons: ['Sends the lockfile’s package names and versions to an advisory database (osv.dev or the npm registry)'] }),
        async run(input, ctx) {
          let rels: string[];
          const reasons: string[] = [];
          try {
            rels = input.lockfiles?.length ? input.lockfiles.map((p) => relativeTo(ctx.cwd, resolveInside(ctx.roots, ctx.cwd, p))) : [];
          } catch (error) {
            return failure(error instanceof OutsideRootError ? 'OUTSIDE_ROOT' : 'INVALID_INPUT', (error as Error).message);
          }
          // The root's lockfiles, confined as named ones are: a lockfile-named link out of the roots is not read.
          const outside: string[] = [];
          if (!input.lockfiles?.length) {
            for (const name of LOCKFILE_NAMES.filter((f) => existsSync(path.join(ctx.cwd, f)))) {
              try {
                rels.push(relativeTo(ctx.cwd, resolveInside(ctx.roots, ctx.cwd, name)));
              } catch (error) {
                if (!(error instanceof OutsideRootError)) throw error;
                outside.push(name);
                reasons.push(`${name}: it leads outside the folders this task may touch`);
              }
            }
          }
          rels = rels.filter((r) => existsSync(path.join(ctx.cwd, r)));
          if (!rels.length) return outside.length ? failure('OUTSIDE_ROOT', `No lockfile to audit here: ${reasons.join('; ')}`) : failure('INVALID_INPUT', 'No lockfile to audit here.');
          const audits: LockfileAudit[] = [];
          for (const rel of rels) {
            const audit = await auditLockfile(ctx, rel, reasons);
            if (audit) audits.push(audit);
          }
          // Neither osv-scanner nor the package manager's own audit worked: unverified, never a pass.
          if (!audits.length) return failure('UNAVAILABLE', `Dependency audit unverified: ${reasons.join('; ')}`, { output: { status: 'unverified', reasons } });
          const fresh = audits.flatMap((a) => a.newAdvisories);
          const total = audits.reduce((n, a) => n + a.advisories.length, 0);
          const compared = audits.some((a) => a.baseline !== 'none');
          // A lockfile no scanner read is named, with why: the advisories above say nothing about it.
          const notAudited = [...rels.filter((r) => !audits.some((a) => a.path === r)), ...outside].map((r) => ({
            path: r,
            reason:
              reasons
                .filter((x) => x.startsWith(`${r}: `))
                .map((x) => x.slice(r.length + 2))
                .join('; ') || 'no scanner could read it',
          }));
          const head = compared
            ? `${fresh.length} new advisor${fresh.length === 1 ? 'y' : 'ies'} since the baseline, ${total - fresh.length} already there`
            : `${total} advisor${total === 1 ? 'y' : 'ies'}`;
          return {
            ok: true,
            summary: `${head} (${audits.map((a) => `${a.path} by ${a.scanner}`).join(', ')})${fresh.length ? `: ${fresh.slice(0, 3).map(advisoryLine).join('; ')}${fresh.length > 3 ? '; …' : ''}` : ''}${notAudited.length ? `. Not audited: ${notAudited.map((n) => `${n.path} (${n.reason})`).join(', ')}` : ''}`,
            output: {
              status: notAudited.length ? 'partial' : 'audited',
              lockfiles: audits.map((a) => ({ path: a.path, scanner: a.scanner, advisories: a.advisories.length, new: a.newAdvisories.length, baseline: a.baseline, ...(a.note ? { note: a.note } : {}) })),
              newAdvisories: fresh,
              advisories: audits.flatMap((a) => a.advisories),
              ...(notAudited.length ? { notAudited } : {}),
              ...(reasons.length ? { unverified: reasons } : {}),
            },
            evidence: audits.map((a) => `dependency audit of ${a.path} (${a.scanner}): ${a.advisories.length} advisories, ${a.newAdvisories.length} new since the baseline (${a.baseline})`),
          };
        },
      }),
    ],
  };
}
