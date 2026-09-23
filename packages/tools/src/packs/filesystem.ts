import { createReadStream, existsSync } from 'node:fs';
import { copyFile, cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { redact } from '@acc/security';
import { z } from 'zod';
import { OutsideRootError, relativeTo, resolveInside } from '../paths.js';
import { builtinDetection, failure, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';

/**
 * Structured filesystem capabilities (V2 plan §13). Paths are relative to
 * the task's working directory and confined to its roots; writes report the
 * paths they changed; the user's own uncommitted files are protected.
 */

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', '.venv', '__pycache__', '.gradle', 'test-results', 'playwright-report']);
const MAX_READ = 512 * 1024;

const pathField = z.string().min(1).max(1000).describe('Path relative to the repository root.');

function guard<T>(ctx: OperationContext, requested: string, fn: (absolute: string) => Promise<OperationResult<T>>): Promise<OperationResult<T>> {
  let absolute: string;
  try {
    absolute = resolveInside(ctx.roots, ctx.cwd, requested);
  } catch (error) {
    return Promise.resolve(failure(error instanceof OutsideRootError ? 'OUTSIDE_ROOT' : 'INVALID_INPUT', (error as Error).message) as OperationResult<T>);
  }
  return fn(absolute).catch((error: NodeJS.ErrnoException) =>
    failure(error.code === 'ENOENT' ? 'INVALID_INPUT' : 'FAILED', error.code === 'ENOENT' ? `${requested} does not exist` : redact(error.message)) as OperationResult<T>,
  );
}

function rel(ctx: OperationContext, absolute: string): string {
  return relativeTo(ctx.cwd, absolute);
}

/** The user's own uncommitted work (dirty at the task baseline) is never overwritten or deleted by a tool. */
function protectedCheck(ctx: OperationContext, absolute: string): OperationResult | null {
  const r = rel(ctx, absolute);
  const hit = ctx.protectedPaths.find((p) => p === r || r.startsWith(`${p.replace(/\/$/, '')}/`) || p.startsWith(`${r}/`));
  return hit ? failure('PROTECTED_PATH', `${hit} holds your own uncommitted work from before the task; tools do not change it`) : null;
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

/** Minimal glob → RegExp: `**`, `*`, `?`, `{a,b}`; forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += `(?:${glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
        i = end;
      } else re += '\\{';
    } else re += /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

async function* walk(root: string, dir: string, depth: number, maxDepth: number): AsyncGenerator<{ abs: string; rel: string; dir: boolean }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const isDir = entry.isDirectory();
    if (isDir && SKIP_DIRS.has(entry.name)) continue;
    yield { abs, rel: relativeTo(root, abs), dir: isDir };
    if (isDir && depth < maxDepth) yield* walk(root, abs, depth + 1, maxDepth);
  }
}

export function filesystemProvider(): ToolProvider {
  return {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, search, write and patch files inside the task working directory.',
    category: 'filesystem',
    builtin: true,
    async detect() {
      return builtinDetection();
    },
    operations: [
      operation({
        id: 'fs.read',
        title: 'Read a file',
        description: 'Read a text file (up to 512 KB; use offset/limit lines for big files). Binary files are reported, not dumped.',
        input: z.object({ path: pathField, startLine: z.number().int().min(1).optional(), maxLines: z.number().int().min(1).max(20_000).optional() }),
        level: 1,
        run: (input, ctx) =>
          guard(ctx, input.path, async (abs) => {
            const info = await stat(abs);
            if (info.isDirectory()) return failure('INVALID_INPUT', `${input.path} is a directory; use fs.list`);
            if (input.startLine || input.maxLines) {
              const start = input.startLine ?? 1;
              const max = input.maxLines ?? 2000;
              const out: string[] = [];
              let n = 0;
              for await (const line of createInterface({ input: createReadStream(abs, 'utf8'), crlfDelay: Infinity })) {
                n++;
                if (n >= start && out.length < max) out.push(line);
                if (out.length >= max) break;
              }
              return { ok: true, summary: `${input.path}: lines ${start}–${start + out.length - 1}`, output: { content: redact(out.join('\n')), startLine: start, lines: out.length } };
            }
            const handle = await open(abs, 'r');
            try {
              const size = Math.min(info.size, MAX_READ);
              const buffer = Buffer.alloc(size);
              await handle.read(buffer, 0, size, 0);
              if (isBinary(buffer)) return { ok: true, summary: `${input.path} is binary (${info.size} bytes)`, output: { binary: true, size: info.size } };
              return {
                ok: true,
                summary: `${input.path} (${info.size} bytes${info.size > MAX_READ ? ', truncated' : ''})`,
                output: { content: redact(buffer.toString('utf8')), size: info.size, truncated: info.size > MAX_READ },
              };
            } finally {
              await handle.close();
            }
          }),
      }),
      operation({
        id: 'fs.list',
        title: 'List a directory tree',
        description: 'List files and folders (skips .git, node_modules, build output). depth 0 lists one level.',
        input: z.object({ path: pathField.default('.'), depth: z.number().int().min(0).max(8).default(1), limit: z.number().int().min(1).max(5000).default(500) }),
        level: 1,
        run: (input, ctx) =>
          guard(ctx, input.path, async (abs) => {
            const entries: string[] = [];
            for await (const e of walk(ctx.cwd, abs, 0, input.depth)) {
              entries.push(e.dir ? `${e.rel}/` : e.rel);
              if (entries.length >= input.limit) break;
            }
            return { ok: true, summary: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} under ${input.path}`, output: { entries, truncated: entries.length >= input.limit } };
          }),
      }),
      operation({
        id: 'fs.stat',
        title: 'File information',
        description: 'Size, type and modification time of a path.',
        input: z.object({ path: pathField }),
        level: 1,
        run: (input, ctx) =>
          guard(ctx, input.path, async (abs) => {
            const s = await stat(abs);
            return { ok: true, summary: `${input.path}: ${s.isDirectory() ? 'directory' : `${s.size} bytes`}`, output: { type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', size: s.size, modifiedAt: s.mtime.toISOString() } };
          }),
      }),
      operation({
        id: 'fs.glob',
        title: 'Find files by pattern',
        description: 'Files matching a glob such as `src/**/*.test.ts` (relative to the repository).',
        input: z.object({ pattern: z.string().min(1).max(500), limit: z.number().int().min(1).max(5000).default(500) }),
        level: 1,
        async run(input, ctx) {
          const re = globToRegExp(input.pattern.replace(/\\/g, '/').replace(/^\.\//, ''));
          const matches: string[] = [];
          for await (const e of walk(ctx.cwd, ctx.cwd, 0, 30)) {
            if (!e.dir && re.test(e.rel)) matches.push(e.rel);
            if (matches.length >= input.limit) break;
          }
          return { ok: true, summary: `${matches.length} file(s) match ${input.pattern}`, output: { files: matches, truncated: matches.length >= input.limit } };
        },
      }),
      operation({
        id: 'fs.search',
        title: 'Search file contents',
        description: 'Search text or a regular expression across files (optionally limited by a glob). Returns path:line matches.',
        input: z.object({
          query: z.string().min(1).max(500),
          regex: z.boolean().default(false),
          glob: z.string().max(500).optional(),
          caseSensitive: z.boolean().default(false),
          limit: z.number().int().min(1).max(2000).default(200),
        }),
        level: 1,
        async run(input, ctx) {
          let re: RegExp;
          try {
            re = new RegExp(input.regex ? input.query : input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), input.caseSensitive ? '' : 'i');
          } catch (error) {
            return failure('INVALID_INPUT', `Invalid regular expression: ${(error as Error).message}`);
          }
          const filter = input.glob ? globToRegExp(input.glob.replace(/\\/g, '/')) : null;
          const matches: Array<{ path: string; line: number; text: string }> = [];
          outer: for await (const e of walk(ctx.cwd, ctx.cwd, 0, 30)) {
            if (e.dir || (filter && !filter.test(e.rel))) continue;
            let text: string;
            try {
              const s = await stat(e.abs);
              if (s.size > 2 * 1024 * 1024) continue;
              const buffer = await readFile(e.abs);
              if (isBinary(buffer)) continue;
              text = buffer.toString('utf8');
            } catch {
              continue;
            }
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i]!)) {
                matches.push({ path: e.rel, line: i + 1, text: redact(lines[i]!.trim().slice(0, 300)) });
                if (matches.length >= input.limit) break outer;
              }
            }
          }
          return { ok: true, summary: `${matches.length} match(es) for "${input.query}"`, output: { matches, truncated: matches.length >= input.limit } };
        },
      }),
      operation({
        id: 'fs.write',
        title: 'Write a file',
        description: 'Create or replace a file with the given content (creates folders as needed).',
        input: z.object({ path: pathField, content: z.string().max(5_000_000), createDirs: z.boolean().default(true) }),
        level: 2,
        run: (input, ctx) =>
          guard(ctx, input.path, async (abs) => {
            const blocked = protectedCheck(ctx, abs);
            if (blocked) return blocked;
            if (input.createDirs) await mkdir(path.dirname(abs), { recursive: true });
            const existed = existsSync(abs);
            await writeFile(abs, input.content, 'utf8');
            return { ok: true, summary: `${existed ? 'Updated' : 'Created'} ${rel(ctx, abs)}`, filesChanged: [rel(ctx, abs)] };
          }),
      }),
      operation({
        id: 'fs.patch',
        title: 'Replace text in a file',
        description: 'Replace an exact text fragment. Fails unless it occurs exactly `expectedCount` times (default 1), so an edit never lands in the wrong place.',
        input: z.object({ path: pathField, find: z.string().min(1).max(1_000_000), replace: z.string().max(1_000_000), expectedCount: z.number().int().min(1).max(1000).default(1) }),
        level: 2,
        run: (input, ctx) =>
          guard(ctx, input.path, async (abs) => {
            const blocked = protectedCheck(ctx, abs);
            if (blocked) return blocked;
            const text = await readFile(abs, 'utf8');
            const count = text.split(input.find).length - 1;
            if (count !== input.expectedCount) return failure('INVALID_INPUT', `Found ${count} occurrence(s) of the text in ${input.path}; expected ${input.expectedCount}`);
            await writeFile(abs, text.split(input.find).join(input.replace), 'utf8');
            return { ok: true, summary: `Patched ${count} occurrence(s) in ${rel(ctx, abs)}`, filesChanged: [rel(ctx, abs)] };
          }),
      }),
      operation({
        id: 'fs.mkdir',
        title: 'Create a folder',
        description: 'Create a directory (and parents).',
        input: z.object({ path: pathField }),
        level: 2,
        run: (input, ctx) =>
          guard(ctx, input.path, async (abs) => {
            await mkdir(abs, { recursive: true });
            return { ok: true, summary: `Created ${rel(ctx, abs)}/`, filesChanged: [] };
          }),
      }),
      operation({
        id: 'fs.copy',
        title: 'Copy a file or folder',
        description: 'Copy within the repository. Refuses to overwrite unless `overwrite` is true.',
        input: z.object({ from: pathField, to: pathField, overwrite: z.boolean().default(false) }),
        level: 2,
        run: (input, ctx) =>
          guard(ctx, input.from, (src) =>
            guard(ctx, input.to, async (dest) => {
              const blocked = protectedCheck(ctx, dest);
              if (blocked) return blocked;
              if (existsSync(dest) && !input.overwrite) return failure('INVALID_INPUT', `${input.to} exists; pass overwrite to replace it`);
              const s = await stat(src);
              await mkdir(path.dirname(dest), { recursive: true });
              if (s.isDirectory()) await cp(src, dest, { recursive: true, force: input.overwrite });
              else await copyFile(src, dest);
              return { ok: true, summary: `Copied ${rel(ctx, src)} → ${rel(ctx, dest)}`, filesChanged: [rel(ctx, dest)] };
            }),
          ),
      }),
      operation({
        id: 'fs.move',
        title: 'Move or rename',
        description: 'Move or rename a file or folder within the repository.',
        input: z.object({ from: pathField, to: pathField }),
        level: 2,
        run: (input, ctx) =>
          guard(ctx, input.from, (src) =>
            guard(ctx, input.to, async (dest) => {
              const blocked = protectedCheck(ctx, src) ?? protectedCheck(ctx, dest);
              if (blocked) return blocked;
              if (existsSync(dest)) return failure('INVALID_INPUT', `${input.to} already exists`);
              await mkdir(path.dirname(dest), { recursive: true });
              await rename(src, dest);
              return { ok: true, summary: `Moved ${rel(ctx, src)} → ${rel(ctx, dest)}`, filesChanged: [rel(ctx, src), rel(ctx, dest)] };
            }),
          ),
      }),
      operation({
        id: 'fs.delete',
        title: 'Delete a file or folder',
        description: 'Delete one file. Deleting a folder with its contents is destructive and needs your approval.',
        input: z.object({ path: pathField, recursive: z.boolean().default(false) }),
        level: 2,
        classify: (input) =>
          input.recursive ? { level: 5, risk: 'dangerous', reasons: ['Deletes a folder and everything in it'], effects: ['filesystem'] } : { level: 2, risk: 'normal', reasons: ['Deletes one file'], effects: ['filesystem'] },
        run: (input, ctx) =>
          guard(ctx, input.path, async (abs) => {
            if (ctx.roots.some((root) => path.resolve(root) === abs)) return failure('DENIED', 'Refusing to delete a root folder');
            const blocked = protectedCheck(ctx, abs);
            if (blocked) return blocked;
            const s = await stat(abs);
            if (s.isDirectory() && !input.recursive) return failure('INVALID_INPUT', `${input.path} is a folder; deleting it needs recursive (and approval)`);
            await rm(abs, { recursive: input.recursive, force: false });
            return { ok: true, summary: `Deleted ${rel(ctx, abs)}`, filesChanged: [rel(ctx, abs)] };
          }),
      }),
    ],
  };
}
