import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runShell } from '@acc/executor';
import { git, type GitResult } from '@acc/git';
import { classifyCommand, redact } from '@acc/security';
import { z } from 'zod';
import { clip, detectExecutable } from '../detect.js';
import { OutsideRootError, resolveInside } from '../paths.js';
import { failure, operation, type OperationContext, type OperationResult, type ToolOperation, type ToolProvider } from '../sdk.js';

/**
 * Structured Git capabilities (V2 plan §14). Native `git` with argv only;
 * history rewrites need approval; nothing discards the user's own work.
 */

const ref = z.string().min(1).max(250).regex(/^[^\s~^:?*[\\]+$|^HEAD(?:[~^]\d*)*$/, 'Not a valid Git ref');
const paths = z.array(z.string().min(1).max(1000)).max(500);
/** `git bisect`'s verdict: "<sha> is the first bad commit" (Git ≤ 2.52) or "…first 'bad' commit" (2.55). SHA-1 or SHA-256. */
const FIRST_BAD = /^([0-9a-f]{40}|[0-9a-f]{64}) is the first '?bad'? commit/m;

function out(result: GitResult, summary: string, output?: unknown): OperationResult {
  const ok = result.code === 0;
  return {
    ok,
    summary: ok ? summary : `git failed: ${redact(result.stderr.trim() || result.stdout.trim()).slice(0, 300)}`,
    stdout: clip(redact(result.stdout)),
    stderr: clip(redact(result.stderr), 8000),
    exitCode: result.code,
    ...(output !== undefined ? { output } : {}),
    ...(ok ? {} : { error: { code: 'FAILED' as const, message: redact(result.stderr.trim() || 'git failed').slice(0, 500) } }),
  };
}

function protectedHits(ctx: OperationContext, list: readonly string[]): string[] {
  return list.filter((p) => ctx.protectedPaths.includes(p.replace(/\\/g, '/')));
}

const folder = z
  .string()
  .min(1)
  .max(1000)
  .optional()
  .describe('Repository folder to run in, relative to the working directory. In a task working across several repositories, name the repository folder (e.g. "web").');

/**
 * Every Git capability takes an optional `cwd`: the repository folder to run
 * in, confined to the call's roots. Where the user's pre-existing work is
 * protected, paths are relative to the repository root, so a folder other
 * than that root is refused rather than letting a protected path slip past.
 */
function inFolder(op: ToolOperation): ToolOperation {
  return {
    ...op,
    input: (op.input as unknown as z.ZodObject).extend({ cwd: folder }),
    async run(input: { cwd?: string }, ctx: OperationContext) {
      let cwd = ctx.cwd;
      if (input.cwd) {
        try {
          cwd = resolveInside(ctx.roots, ctx.cwd, input.cwd);
        } catch (error) {
          return failure(error instanceof OutsideRootError ? 'OUTSIDE_ROOT' : 'INVALID_INPUT', (error as Error).message);
        }
        if (cwd !== ctx.cwd && ctx.protectedPaths.length) return failure('INVALID_INPUT', 'Git runs at the repository root in this task; leave cwd out');
      }
      return op.run(input, { ...ctx, cwd });
    },
  };
}

export function gitProvider(): ToolProvider {
  return {
    id: 'git',
    name: 'Git',
    description: 'Native Git: status, diffs, history, branches, commits and safe pushes.',
    category: 'git',
    preference: 10,
    detect: (ctx) => detectExecutable(ctx, ['git']),
    operations: [
      operation({
        id: 'git.status',
        title: 'Git status',
        description: 'Branch, upstream and changed files (porcelain v2).',
        input: z.object({}),
        level: 1,
        async run(_input, ctx) {
          const r = await git(ctx.cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all'], { maxOutputBytes: 512 * 1024 });
          const branch = /^# branch\.head (.+)$/m.exec(r.stdout)?.[1] ?? null;
          const files = r.stdout.split('\n').filter((l) => /^[12u?] /.test(l)).length;
          return out(r, `On ${branch ?? 'unknown branch'} · ${files} changed file(s)`, { branch, changedFiles: files });
        },
      }),
      operation({
        id: 'git.diff',
        title: 'Git diff',
        description: 'Diff of the working tree (or staged changes, or between two refs). Optionally limited to paths.',
        input: z.object({ staged: z.boolean().default(false), from: ref.optional(), to: ref.optional(), paths: paths.optional(), stat: z.boolean().default(false) }),
        level: 1,
        async run(input, ctx) {
          const args = ['diff', '--no-color', '--no-ext-diff'];
          if (input.stat) args.push('--stat');
          if (input.staged) args.push('--cached');
          if (input.from) args.push(input.from);
          if (input.to) args.push(input.to);
          if (input.paths?.length) args.push('--', ...input.paths);
          const r = await git(ctx.cwd, args, { maxOutputBytes: 400 * 1024 });
          return out(r, `${r.stdout.split('\n').filter((l) => l.startsWith('diff --git')).length} file(s) in the diff${r.truncated ? ' (truncated)' : ''}`);
        },
      }),
      operation({
        id: 'git.log',
        title: 'Git log',
        description: 'Recent commits (hash, author, date, subject).',
        input: z.object({ limit: z.number().int().min(1).max(500).default(20), ref: ref.optional(), path: z.string().max(1000).optional() }),
        level: 1,
        async run(input, ctx) {
          const args = ['log', `-n${input.limit}`, '--date=iso-strict', '--pretty=format:%H%x09%an%x09%ad%x09%s'];
          if (input.ref) args.push(input.ref);
          if (input.path) args.push('--', input.path);
          const r = await git(ctx.cwd, args);
          const commits = r.stdout.split('\n').filter(Boolean).map((l) => {
            const [sha, author, date, ...subject] = l.split('\t');
            return { sha, author, date, subject: subject.join('\t') };
          });
          return out(r, `${commits.length} commit(s)`, { commits });
        },
      }),
      operation({
        id: 'git.show',
        title: 'Show a commit',
        description: 'Commit message and patch (bounded).',
        input: z.object({ ref, stat: z.boolean().default(false) }),
        level: 1,
        async run(input, ctx) {
          const r = await git(ctx.cwd, ['show', '--no-color', ...(input.stat ? ['--stat'] : []), input.ref], { maxOutputBytes: 300 * 1024 });
          return out(r, `Commit ${input.ref}`);
        },
      }),
      operation({
        id: 'git.branch_list',
        title: 'List branches',
        description: 'Local and remote branches with their last commit.',
        input: z.object({ remote: z.boolean().default(false) }),
        level: 1,
        async run(input, ctx) {
          const r = await git(ctx.cwd, ['branch', '--format=%(refname:short)%09%(objectname:short)%09%(upstream:short)%09%(HEAD)', ...(input.remote ? ['-a'] : [])]);
          const branches = r.stdout.split('\n').filter(Boolean).map((l) => {
            const [name, sha, upstream, head] = l.split('\t');
            return { name, sha, upstream: upstream || null, current: head === '*' };
          });
          return out(r, `${branches.length} branch(es)`, { branches });
        },
      }),
      operation({
        id: 'git.remote_list',
        title: 'List remotes',
        description: 'Configured remotes (URLs with credentials redacted).',
        input: z.object({}),
        level: 1,
        async run(_input, ctx) {
          const r = await git(ctx.cwd, ['remote', '-v']);
          return out(r, `${new Set(r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')[0])).size} remote(s)`);
        },
      }),
      operation({
        id: 'git.worktree_list',
        title: 'List worktrees',
        description: 'Worktrees of this repository.',
        input: z.object({}),
        level: 1,
        async run(_input, ctx) {
          const r = await git(ctx.cwd, ['worktree', 'list', '--porcelain']);
          return out(r, `${r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).length} worktree(s)`);
        },
      }),
      operation({
        id: 'git.stash_list',
        title: 'List stashes',
        description: 'Saved stashes.',
        input: z.object({}),
        level: 1,
        async run(_input, ctx) {
          const r = await git(ctx.cwd, ['stash', 'list']);
          return out(r, `${r.stdout.split('\n').filter(Boolean).length} stash(es)`);
        },
      }),
      operation({
        id: 'git.fetch',
        title: 'Fetch from a remote',
        description: 'Download remote refs (never changes your files).',
        input: z.object({ remote: z.string().min(1).max(100).regex(/^[\w.-]+$/).default('origin') }),
        level: 2,
        classify: () => ({ effects: ['git', 'network'] }),
        async run(input, ctx) {
          return out(await git(ctx.cwd, ['fetch', '--prune', input.remote], { timeoutMs: 120_000 }), `Fetched ${input.remote}`);
        },
      }),
      operation({
        id: 'git.branch_create',
        title: 'Create a branch',
        description: 'Create a local branch at a ref without switching to it.',
        input: z.object({ name: z.string().min(1).max(200).regex(/^[\w./-]+$/), from: ref.default('HEAD') }),
        level: 2,
        async run(input, ctx) {
          return out(await git(ctx.cwd, ['branch', input.name, input.from]), `Created branch ${input.name}`);
        },
      }),
      operation({
        id: 'git.switch',
        title: 'Switch branch',
        description: 'Switch the working tree to another branch. Git refuses if it would overwrite changes.',
        input: z.object({ branch: z.string().min(1).max(200).regex(/^[\w./-]+$/), create: z.boolean().default(false) }),
        level: 3,
        classify: () => ({ reasons: ['Changes which branch the working tree is on'], effects: ['git'] }),
        async run(input, ctx) {
          return out(await git(ctx.cwd, ['switch', ...(input.create ? ['-c'] : []), input.branch]), `Switched to ${input.branch}`);
        },
      }),
      operation({
        id: 'git.stage',
        title: 'Stage paths',
        description: 'Add specific paths to the index.',
        input: z.object({ paths: paths.min(1) }),
        level: 2,
        async run(input, ctx) {
          return out(await git(ctx.cwd, ['add', '--', ...input.paths]), `Staged ${input.paths.length} path(s)`, undefined);
        },
      }),
      operation({
        id: 'git.commit',
        title: 'Commit paths',
        description: 'Commit exactly the listed paths with a message (hooks run). Never commits your own pre-existing changes.',
        input: z.object({ paths: paths.min(1), message: z.string().min(3).max(5000) }),
        level: 3,
        async run(input, ctx) {
          const hits = protectedHits(ctx, input.paths);
          if (hits.length) return failure('PROTECTED_PATH', `Refusing to commit your own uncommitted work: ${hits.join(', ')}`);
          const add = await git(ctx.cwd, ['add', '--', ...input.paths]);
          if (add.code !== 0) return out(add, 'git add failed');
          const r = await git(ctx.cwd, ['commit', '-m', input.message, '--', ...input.paths], { timeoutMs: 300_000 });
          if (r.code !== 0) return out(r, '');
          const sha = (await git(ctx.cwd, ['rev-parse', 'HEAD'])).stdout.trim();
          return { ...out(r, `Committed ${input.paths.length} path(s) as ${sha.slice(0, 10)}`, { sha }), filesChanged: input.paths };
        },
      }),
      operation({
        id: 'git.restore',
        title: 'Discard changes to paths',
        description: 'Restore listed files to their committed state. Refuses files that held your own work before the task.',
        input: z.object({ paths: paths.min(1), staged: z.boolean().default(false) }),
        level: 3,
        classify: () => ({ reasons: ['Discards uncommitted changes to the listed files'], effects: ['git', 'filesystem'] }),
        async run(input, ctx) {
          const hits = protectedHits(ctx, input.paths);
          if (hits.length) return failure('PROTECTED_PATH', `Refusing to discard your own uncommitted work: ${hits.join(', ')}`);
          if (input.paths.some((p) => p === '.' || p === '*' || p === ':/')) return failure('INVALID_INPUT', 'List files explicitly; restoring everything is not a tool operation');
          return { ...out(await git(ctx.cwd, ['restore', ...(input.staged ? ['--staged'] : []), '--', ...input.paths]), `Restored ${input.paths.length} path(s)`), filesChanged: input.paths };
        },
      }),
      operation({
        id: 'git.stash',
        title: 'Stash changes',
        description: 'Save working-tree changes to a named stash (they can be re-applied later).',
        input: z.object({ message: z.string().min(1).max(200), includeUntracked: z.boolean().default(false) }),
        level: 3,
        async run(input, ctx) {
          if (ctx.protectedPaths.length) return failure('PROTECTED_PATH', 'The working tree holds your own uncommitted work; stashing would move it. Not done.');
          return out(await git(ctx.cwd, ['stash', 'push', ...(input.includeUntracked ? ['-u'] : []), '-m', input.message]), 'Stashed changes');
        },
      }),
      operation({
        id: 'git.merge',
        title: 'Merge a branch',
        description: 'Merge a ref into the current branch; fast-forward only unless `ffOnly` is false. Stops on conflicts and aborts cleanly.',
        input: z.object({ ref, ffOnly: z.boolean().default(true) }),
        level: 3,
        async run(input, ctx) {
          const r = await git(ctx.cwd, ['merge', input.ffOnly ? '--ff-only' : '--no-edit', input.ref], { timeoutMs: 120_000 });
          if (r.code !== 0 && !input.ffOnly) await git(ctx.cwd, ['merge', '--abort']);
          return out(r, `Merged ${input.ref}`);
        },
      }),
      operation({
        id: 'git.push',
        title: 'Push a branch',
        description: 'Push a branch to a remote. Never force-pushes.',
        input: z.object({ remote: z.string().regex(/^[\w.-]+$/).default('origin'), branch: z.string().min(1).max(200).regex(/^[\w./-]+$/), setUpstream: z.boolean().default(false) }),
        level: 3,
        classify: (input) => {
          const c = classifyCommand(`git push ${input.remote} ${input.branch}`);
          return { level: c.level, risk: c.risk, reasons: c.reasons, effects: c.effects, production: c.production };
        },
        async run(input, ctx) {
          return out(await git(ctx.cwd, ['push', ...(input.setUpstream ? ['-u'] : []), input.remote, `${input.branch}:${input.branch}`], { timeoutMs: 180_000 }), `Pushed ${input.branch} to ${input.remote}`);
        },
      }),
      operation({
        id: 'git.rebase',
        title: 'Rebase (needs approval)',
        description: 'Rebase the current branch onto a ref. Rewrites history, so it always needs your approval; aborts on conflict.',
        input: z.object({ onto: ref }),
        level: 5,
        classify: () => ({ level: 5, risk: 'dangerous', reasons: ['Rewrites Git history'], effects: ['git'] }),
        async run(input, ctx) {
          const r = await git(ctx.cwd, ['rebase', input.onto], { timeoutMs: 300_000 });
          if (r.code !== 0) await git(ctx.cwd, ['rebase', '--abort']);
          return out(r, `Rebased onto ${input.onto}`);
        },
      }),
      operation({
        id: 'git.bisect',
        title: 'Find the commit that broke something',
        description: 'Run `git bisect` between a good and a bad ref with a test command, in a temporary worktree so your working tree is untouched. Returns the first bad commit.',
        input: z.object({ good: ref, bad: ref.default('HEAD'), command: z.string().min(1).max(2000).describe('Exits 0 when the commit is good.'), timeoutSec: z.number().int().min(30).max(3600).default(900) }),
        level: 2,
        classify: (input) => {
          const c = classifyCommand(input.command);
          return { level: Math.max(2, c.level) as 2 | 3 | 4 | 5, risk: c.risk, reasons: ['Runs a test command on older commits', ...c.reasons], effects: [...c.effects, 'git'], production: c.production };
        },
        async run(input, ctx) {
          const dir = path.join(os.tmpdir(), `acc-bisect-${randomBytes(6).toString('hex')}`);
          const add = await git(ctx.cwd, ['worktree', 'add', '--detach', dir, input.bad]);
          if (add.code !== 0) return out(add, '');
          try {
            let step = await git(dir, ['bisect', 'start', input.bad, input.good]);
            const deadline = Date.now() + input.timeoutSec * 1000;
            const log: string[] = [];
            let first: string | null = null;
            let previous: string | null = null;
            // Drive the loop ourselves: `git bisect run` re-parses the command through sh, which breaks Windows command lines.
            for (let i = 0; i < 64 && step.code === 0 && Date.now() < deadline; i++) {
              first = FIRST_BAD.exec(step.stdout)?.[1] ?? null;
              if (first) break;
              const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
              // Bisect no longer moving means it finished in words this parser does not know: never re-test one commit.
              if (head === previous) break;
              previous = head;
              const test = await runShell({ commandLine: input.command, cwd: dir, env: ctx.env, timeoutMs: Math.max(5000, deadline - Date.now()) }).done;
              const verdict = test.timedOut ? 'skip' : test.exitCode === 0 ? 'good' : test.exitCode === 125 ? 'skip' : 'bad';
              log.push(`${head.slice(0, 10)} ${verdict}`);
              step = await git(dir, ['bisect', verdict]);
            }
            await git(dir, ['bisect', 'reset']);
            const result = out(step, first ? `First bad commit: ${first.slice(0, 10)}` : 'Bisect did not isolate a commit', { firstBadCommit: first, steps: log });
            return { ...result, ok: step.code === 0 && Boolean(first), stdout: clip(redact(step.stdout)) };
          } finally {
            await git(ctx.cwd, ['worktree', 'remove', '--force', dir]);
            await rm(dir, { recursive: true, force: true });
          }
        },
      }),
    ].map(inFolder),
  };
}
