import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { killTree } from '@acc/executor';
import { credentialFreeEnv, sensitiveFileReason } from '@acc/security';
import { EMPTY_TREE, git, GitError, status, type GitSnapshot } from './index.js';

/**
 * The task's git-diff.patch (docs/systems/git.md#applicable-patches): a patch
 * `git apply` takes back, built so that nothing unredacted is written to disk
 * and no binary payload — nor a secret inside one — ever enters it.
 *
 * - Git's output is read as bytes straight from its stdout (never through the
 *   line reader, which drops each `\r`), so a CRLF-committed file applies.
 * - A file section that is not plain UTF-8 text — a binary file, or one a
 *   repository's `diff` attribute prints as text — keeps its header and full
 *   object ids and says only "Binary files … differ": `git apply` takes the
 *   blobs from the repository.
 * - A section holding secret-shaped content (its text, or a stubbed file's
 *   content read as UTF-8, Latin-1 or UTF-16), a private key, or a file whose
 *   name marks it as secret material is left out, with one note line naming it:
 *   the rest still applies and no object id of it remains.
 * - The user's diff settings are pinned (prefixes, context, submodules,
 *   external tools), and a cut never keeps part of a file.
 */

export interface PatchResult {
  patch: Buffer;
  /** Files not in the patch: past the size bound, not diffable, or with content the repository cannot supply. */
  dropped: string[];
  /** Files left out because they held secret-shaped content. */
  withheld: string[];
}

export interface PatchOptions {
  /** A repository's folder in a task across repositories: every path goes under it. */
  prefix?: string | null;
  maxBytes: number;
  /** Redacts text; when given, secret-bearing sections are withheld (the artifact mode). */
  redactText?: (text: string) => string;
}

/** A diff's own output is read up to this many times the bound. */
const READ_FACTOR = 4;
/** Content larger than this is neither stored nor read for a secret check. */
const MAX_CONTENT_BYTES = 100 * 1024 * 1024;

const PINNED_ENV: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_DIFF_OPTS: '', GIT_EXTERNAL_DIFF: '' };

function diffArgs(prefix: string | null | undefined): string[] {
  return [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--full-index',
    '-U3',
    '--submodule=short',
    '--ignore-submodules=dirty',
    // Git writes a folder-prefixed rename's "rename from/to" lines without the folder, so under one a rename is a deletion plus an addition.
    ...(prefix ? ['--no-renames', `--src-prefix=a/${prefix}/`, `--dst-prefix=b/${prefix}/`] : ['-M', '--src-prefix=a/', '--dst-prefix=b/']),
  ];
}

interface BytesResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  overflow: boolean;
  timedOut: boolean;
}

/**
 * Run git and keep its stdout as bytes, up to `limit`. Stopping it (the bound
 * or the timeout) kills the whole process tree: on Windows the `git` on PATH
 * is a launcher, and the real git behind it would otherwise keep writing.
 */
function gitBytes(cwd: string, args: string[], limit: number, timeoutMs = 300_000): Promise<BytesResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: { ...credentialFreeEnv(process.env), ...PINNED_ENV }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let timedOut = false;
    let stderr = '';
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code, stdout: Buffer.concat(chunks), stderr: stderr.trim(), overflow, timedOut });
    };
    const stop = () => {
      void killTree(child).finally(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        grace = setTimeout(() => settle(null), 2000);
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (overflow) return;
      if (size + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - size));
        overflow = true;
        stop();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitError(`git could not start: ${error.message}`, { code: null, stdout: '', stderr: error.message }));
    });
    child.on('close', (code) => settle(code));
  });
}

const FILE_START = Buffer.from('diff --git ');

/** A patch split at each file's `diff --git` header (a header only counts at the start of a line). */
function fileParts(patch: Buffer): Buffer[] {
  const starts: number[] = [];
  for (let i = patch.indexOf(FILE_START); i !== -1; i = patch.indexOf(FILE_START, i + 1)) if (i === 0 || patch[i - 1] === 0x0a) starts.push(i);
  return starts.map((s, i) => patch.subarray(s, starts[i + 1] ?? patch.length));
}

/** The path a section is about (the new side), as the patch writes it — under the folder prefix, if any. */
function sectionPath(text: string): string {
  const renamed = /^rename to (.*)$/m.exec(text)?.[1];
  if (renamed) return renamed;
  const plus = /^\+\+\+ b\/(.*?)\t?$/m.exec(text)?.[1];
  if (plus) return plus;
  const minus = /^--- a\/(.*?)\t?$/m.exec(text)?.[1];
  if (minus) return minus;
  // "diff --git a/P b/P": both halves are the same path, so its length says where it splits.
  const body = /^diff --git (.*)$/m.exec(text)?.[1] ?? '';
  const half = (body.length - 5) / 2;
  if (Number.isInteger(half) && body.startsWith('a/') && body.slice(half + 3, half + 5) === 'b/' && body.slice(2, half + 2) === body.slice(half + 5)) return body.slice(2, half + 2);
  return body || 'a file';
}

function isPlainText(part: Buffer): boolean {
  return !part.includes(0) && Buffer.from(part.toString('utf8'), 'utf8').equals(part);
}

/** The section's header and "Binary files … differ": the full `index` ids let `git apply` take the content from the repository. */
function binaryStub(part: Buffer): Buffer {
  const text = part.toString('latin1');
  const header: string[] = [];
  let oldName: string | null = null;
  let newName: string | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('--- ')) oldName = line.slice(4).replace(/\t$/, '');
    else if (line.startsWith('+++ ')) newName = line.slice(4).replace(/\t$/, '');
    else if (line.startsWith('@@') || line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) break;
    else header.push(line);
    if (newName !== null) break;
  }
  const already = /^Binary files .* differ$/m.exec(text)?.[0];
  const names = oldName !== null && newName !== null ? `Binary files ${oldName} and ${newName} differ` : already;
  return Buffer.from(`${header.filter((l) => l !== '').join('\n')}\n${names ? `${names}\n` : ''}`, 'latin1');
}

/** The new side's object id, or null for a deletion. */
function postId(text: string): string | null {
  const id = /^index [0-9a-f]+\.\.([0-9a-f]+)/m.exec(text)?.[1];
  return id && !/^0+$/.test(id) ? id : null;
}

/** Whether content holds something the redactor would change, read every way a text editor might have written it. */
function holdsSecret(content: Buffer, redactText: (text: string) => string): boolean {
  // UTF-8, Latin-1, UTF-16 little- and big-endian, and the bytes with every NUL removed (UTF-16 of ASCII text either way round).
  const bigEndian = content.length % 2 === 0 ? Buffer.from(content).swap16().toString('utf16le') : '';
  const readings = [content.toString('utf8'), content.toString('latin1'), content.toString('utf16le'), bigEndian, Buffer.from(content.filter((b) => b !== 0)).toString('latin1')];
  // Odd-aligned UTF-16 (a BOM-less file that starts mid-character) reads correctly one byte in.
  if (content.length > 1) readings.push(content.subarray(1, content.length - ((content.length - 1) % 2)).toString('utf16le'));
  return readings.some((text) => text && redactText(text) !== text);
}

interface Built {
  section: Buffer;
  path: string;
  /** Set for a stubbed section: the content id `git apply` must find in the repository. */
  needs: string | null;
  note: boolean;
}

/**
 * The sections of a raw patch, each kept byte-exact, stubbed or replaced by a
 * note. `content` reads a stubbed file's new content for the secret check.
 */
async function sections(raw: Buffer, overflow: boolean, options: PatchOptions, content: (path: string, id: string) => Promise<Buffer | null>): Promise<{ built: Built[]; withheld: string[]; partial: string | null }> {
  const parts = fileParts(raw);
  // A read cut short ends inside its last file: that file is not kept.
  const partial = overflow && parts.length ? sectionPath(parts.pop()!.toString('latin1')) : null;
  const redact = options.redactText;
  const name = (p: string) => (redact ? redact(p) : p);
  const built: Built[] = [];
  const withheld: string[] = [];
  const withhold = (path: string) => {
    withheld.push(name(path));
    built.push({ section: Buffer.from(`[withheld from git-diff.patch: ${name(path)} held secret-shaped content]\n`, 'utf8'), path, needs: null, note: true });
  };
  for (const part of parts) {
    const text = part.toString('latin1');
    const path = sectionPath(text);
    const plain = isPlainText(part);
    const section = plain ? part : binaryStub(part);
    // Git's own "Binary files … differ" sections and our stubs carry no content: `git apply` needs the object, and its content is what to check.
    const id = !plain || /^Binary files .* differ$/m.test(text) ? postId(text) : null;
    if (redact) {
      if (sensitiveFileReason(inRepo(path, options.prefix)) || /PRIVATE KEY-----/.test(text) || redact(section.toString('utf8')) !== section.toString('utf8')) {
        withhold(path);
        continue;
      }
      const body = id ? await content(path, id) : null;
      if (body && holdsSecret(body, redact)) {
        withhold(path);
        continue;
      }
    }
    built.push({ section, path, needs: id, note: false });
  }
  return { built, withheld, partial };
}

/** Whole sections up to the bound (notes always kept); everything past it, and the files never read, are named. */
function bounded(built: Built[], options: PatchOptions, dropped: string[]): Buffer {
  const out: Buffer[] = [];
  let size = 0;
  let full = false;
  for (const b of built) {
    if (b.note) {
      out.push(b.section);
      continue;
    }
    if (full || size + b.section.length > options.maxBytes) {
      full = true;
      dropped.push(options.redactText ? options.redactText(b.path) : b.path);
      continue;
    }
    out.push(b.section);
    size += b.section.length;
  }
  return Buffer.concat(out);
}

/** A path under the folder prefix, relative to its repository again. */
function inRepo(path: string, prefix: string | null | undefined): string {
  return prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
}

/** Changed and new paths since `base`, as the patch would name them, for naming what an overflow never read. */
async function changedNames(cwd: string, base: string, to: string | null, prefix: string | null | undefined): Promise<string[]> {
  const listed = await git(cwd, ['diff', '--name-only', '-z', '--no-renames', base, ...(to ? [to] : [])]).catch(() => null);
  const names = listed?.code === 0 ? listed.stdout.split('\0').filter(Boolean) : [];
  if (!to) names.push(...(await status(cwd).catch(() => [])).filter((e) => e.code === '??').map((e) => e.path));
  return names.map((n) => (prefix ? `${prefix}/${n}` : n));
}

/** A working-tree file's bytes, only for a regular file (never through a link) within the size bound. */
async function regularFile(file: string): Promise<Buffer | null> {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > MAX_CONTENT_BYTES) return null;
  return readFile(file).catch(() => null);
}

/**
 * Everything that differs from `baseline` in the working tree at `cwd` (an
 * in-place task, or a worktree still there). The content of each stubbed file
 * is written to the object store (`git hash-object -w`: no ref, index or file
 * change) so its id resolves in this repository even before anything is
 * committed; a file whose content cannot be stored is named instead.
 */
export async function patchSince(cwd: string, baseline: GitSnapshot, options: PatchOptions): Promise<PatchResult> {
  const base = baseline.head ?? EMPTY_TREE;
  const limit = options.maxBytes * READ_FACTOR;
  const dropped: string[] = [];
  const tracked = await gitBytes(cwd, [...diffArgs(options.prefix), base], limit);
  if (tracked.code !== 0 && !tracked.overflow) throw new GitError(`git diff failed${tracked.timedOut ? ' (timed out)' : ''}: ${tracked.stderr || 'no reason given'}`, { code: tracked.code, stdout: '', stderr: tracked.stderr });
  const chunks = [tracked.stdout];
  let overflow = tracked.overflow;
  const name = (p: string) => (options.redactText ? options.redactText(p) : p);
  for (const entry of overflow ? [] : (await status(cwd)).filter((e) => e.code === '??')) {
    const room = limit - chunks.reduce((n, c) => n + c.length, 0);
    if (room <= 0) {
      overflow = true;
      break;
    }
    // --no-index exits 1 when the files differ, which is the expected case.
    const r = await gitBytes(cwd, [...diffArgs(options.prefix), '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', entry.path], room);
    if (r.overflow) {
      chunks.push(r.stdout);
      overflow = true;
      break;
    }
    if ((r.code === 0 || r.code === 1) && r.stdout.length) chunks.push(r.stdout);
    // A nested repository or an unreadable path: named, not silently left out.
    else if (r.code !== 0) dropped.push(name(options.prefix ? `${options.prefix}/${entry.path}` : entry.path));
  }
  const { built, withheld, partial } = await sections(Buffer.concat(chunks), overflow, options, (path) => regularFile(join(cwd, inRepo(path, options.prefix))));
  // Store what the stubs point at, then keep only the stubs whose content the repository now holds.
  const stubs = built.filter((b) => b.needs);
  const storable: string[] = [];
  for (const b of stubs) if (await lstat(join(cwd, inRepo(b.path, options.prefix))).then((i) => i.isFile() && i.size <= MAX_CONTENT_BYTES).catch(() => false)) storable.push(inRepo(b.path, options.prefix));
  if (storable.length) await git(cwd, ['hash-object', '-w', '--stdin-paths'], { stdin: `${storable.join('\n')}\n`, timeoutMs: 300_000 }).catch(() => null);
  const resolved = await presentObjects(cwd, stubs.map((b) => b.needs!));
  const kept = built.filter((b) => {
    if (!b.needs || resolved.has(b.needs)) return true;
    dropped.push(name(b.path));
    return false;
  });
  const patch = bounded(kept, options, dropped);
  if (overflow) addUnread(dropped, [...kept.map((b) => b.path), ...built.filter((b) => b.note).map((b) => b.path)], partial, await changedNames(cwd, base, null, options.prefix), name);
  return { patch, dropped, withheld };
}

/** Everything between two commits (an isolated task's baseline and its branch tip, once its work is committed). */
export async function patchBetween(cwd: string, from: string | null, to: string, options: PatchOptions): Promise<PatchResult> {
  if (from !== null && !/^[0-9a-f]{40,64}$/.test(from)) throw new Error(`Not a commit id: ${from}`);
  if (!/^[0-9a-f]{40,64}$/.test(to)) throw new Error(`Not a commit id: ${to}`);
  const r = await gitBytes(cwd, [...diffArgs(options.prefix), from ?? EMPTY_TREE, to], options.maxBytes * READ_FACTOR);
  if (r.code !== 0 && !r.overflow) throw new GitError(`git diff failed${r.timedOut ? ' (timed out)' : ''}: ${r.stderr || 'no reason given'}`, { code: r.code, stdout: '', stderr: r.stderr });
  const name = (p: string) => (options.redactText ? options.redactText(p) : p);
  const { built, withheld, partial } = await sections(r.stdout, r.overflow, options, async (_path, id) => {
    const blob = await gitBytes(cwd, ['cat-file', 'blob', id], MAX_CONTENT_BYTES);
    return blob.code === 0 && !blob.overflow ? blob.stdout : null;
  });
  const dropped: string[] = [];
  const patch = bounded(built, options, dropped);
  if (r.overflow) addUnread(dropped, built.map((b) => b.path), partial, await changedNames(cwd, from ?? EMPTY_TREE, to, options.prefix), name);
  return { patch, dropped, withheld };
}

/** After an overflow, every changed path not already in the patch, withheld or dropped is named as dropped. */
function addUnread(dropped: string[], seen: string[], partial: string | null, all: string[], name: (p: string) => string): void {
  const known = new Set(seen);
  const listed = new Set(dropped);
  for (const p of [...(partial ? [partial] : []), ...all]) {
    const n = name(p);
    if (known.has(p) || listed.has(n)) continue;
    listed.add(n);
    dropped.push(n);
  }
}

/** Which of these object ids the repository holds. */
async function presentObjects(cwd: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const r = await git(cwd, ['cat-file', '--batch-check=%(objectname)'], { stdin: `${ids.join('\n')}\n` }).catch(() => null);
  return new Set((r?.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l)));
}
