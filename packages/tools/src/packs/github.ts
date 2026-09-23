import { redact } from '@acc/security';
import { z } from 'zod';
import { clip, detectExecutable, run } from '../detect.js';
import { failure, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';

/** GitHub through the official `gh` CLI (V2 plan §2 scope). Reads are Level 1; anything that changes GitHub is Level 3. */

async function gh(ctx: OperationContext, args: string[], summary: (json: any) => string, timeoutMs = 60_000): Promise<OperationResult> {
  const detection = ctx.detection('gh');
  const exe = detection?.path ?? 'gh';
  const r = await run(exe, args, { cwd: ctx.cwd, env: { ...ctx.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, timeoutMs });
  if (r.spawnError) return failure('NOT_INSTALLED', 'GitHub CLI is not installed');
  if (r.code !== 0) {
    const message = redact(r.stderr.trim() || r.stdout.trim() || `gh exited with ${r.code}`).slice(0, 500);
    return failure(/auth login|not logged/i.test(message) ? 'AUTH_REQUIRED' : 'FAILED', message);
  }
  let json: any = null;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    /* not JSON: plain text output */
  }
  return { ok: true, summary: summary(json ?? r.stdout), output: json ?? undefined, stdout: json ? undefined : clip(redact(r.stdout)), networkTargets: ['github.com'] };
}

const num = z.number().int().min(1).max(10_000_000);
const limit = z.number().int().min(1).max(200).default(20);

export function githubProvider(): ToolProvider {
  return {
    id: 'gh',
    name: 'GitHub CLI',
    description: 'Pull requests, issues and Actions runs through `gh`.',
    category: 'github',
    detect: (ctx) => detectExecutable(ctx, ['gh']),
    async checkAuth(ctx, detection) {
      if (!detection.path) return { required: true, state: 'missing', message: 'GitHub CLI is not installed' };
      const r = await run(detection.path, ['auth', 'status'], { env: ctx.env, timeoutMs: 20_000 });
      const text = redact(`${r.stdout}\n${r.stderr}`);
      if (r.code === 0) return { required: true, state: 'ok', message: /Logged in to (\S+) (?:account|as) (\S+)/.exec(text)?.slice(1).join(' as ') ?? 'Signed in' };
      return { required: true, state: 'missing', message: 'Not signed in: run `gh auth login`' };
    },
    operations: [
      operation({
        id: 'github.pr_list',
        title: 'List pull requests',
        description: 'Open pull requests in this repository.',
        input: z.object({ state: z.enum(['open', 'closed', 'merged', 'all']).default('open'), limit }),
        level: 1,
        run: (i, ctx) => gh(ctx, ['pr', 'list', '--state', i.state, '--limit', String(i.limit), '--json', 'number,title,headRefName,author,state,isDraft,updatedAt,url'], (j) => `${Array.isArray(j) ? j.length : 0} pull request(s)`),
      }),
      operation({
        id: 'github.pr_view',
        title: 'View a pull request',
        description: 'Details, reviews and status of one pull request.',
        input: z.object({ number: num }),
        level: 1,
        run: (i, ctx) => gh(ctx, ['pr', 'view', String(i.number), '--json', 'number,title,body,state,headRefName,baseRefName,reviewDecision,mergeable,statusCheckRollup,url'], (j) => `PR #${i.number}: ${j?.title ?? ''}`),
      }),
      operation({
        id: 'github.pr_checks',
        title: 'Pull request checks',
        description: 'CI check results for a pull request.',
        input: z.object({ number: num }),
        level: 1,
        run: (i, ctx) => gh(ctx, ['pr', 'checks', String(i.number), '--json', 'name,state,bucket,link'], (j) => `${Array.isArray(j) ? j.filter((c: any) => c.bucket === 'fail').length : '?'} failing check(s)`),
      }),
      operation({
        id: 'github.issue_list',
        title: 'List issues',
        description: 'Issues in this repository.',
        input: z.object({ state: z.enum(['open', 'closed', 'all']).default('open'), limit, label: z.string().max(100).optional() }),
        level: 1,
        run: (i, ctx) => gh(ctx, ['issue', 'list', '--state', i.state, '--limit', String(i.limit), ...(i.label ? ['--label', i.label] : []), '--json', 'number,title,labels,author,updatedAt,url'], (j) => `${Array.isArray(j) ? j.length : 0} issue(s)`),
      }),
      operation({
        id: 'github.issue_view',
        title: 'View an issue',
        description: 'One issue with its comments.',
        input: z.object({ number: num }),
        level: 1,
        run: (i, ctx) => gh(ctx, ['issue', 'view', String(i.number), '--json', 'number,title,body,state,labels,comments,url'], (j) => `Issue #${i.number}: ${j?.title ?? ''}`),
      }),
      operation({
        id: 'github.run_list',
        title: 'List Actions runs',
        description: 'Recent GitHub Actions workflow runs.',
        input: z.object({ limit, branch: z.string().max(200).optional() }),
        level: 1,
        run: (i, ctx) => gh(ctx, ['run', 'list', '--limit', String(i.limit), ...(i.branch ? ['--branch', i.branch] : []), '--json', 'databaseId,name,status,conclusion,headBranch,createdAt,url'], (j) => `${Array.isArray(j) ? j.length : 0} run(s)`),
      }),
      operation({
        id: 'github.pr_create',
        title: 'Open a pull request',
        description: 'Create a pull request from a pushed branch.',
        input: z.object({ title: z.string().min(3).max(250), body: z.string().max(60_000).default(''), base: z.string().max(200).optional(), head: z.string().max(200).optional(), draft: z.boolean().default(false) }),
        level: 3,
        classify: () => ({ reasons: ['Changes GitHub state'], effects: ['network'] }),
        run: (i, ctx) =>
          gh(ctx, ['pr', 'create', '--title', i.title, '--body', i.body, ...(i.base ? ['--base', i.base] : []), ...(i.head ? ['--head', i.head] : []), ...(i.draft ? ['--draft'] : [])], (t) => `Opened ${String(t).trim().split('\n').pop()}`, 120_000),
      }),
      operation({
        id: 'github.issue_create',
        title: 'Open an issue',
        description: 'Create an issue.',
        input: z.object({ title: z.string().min(3).max(250), body: z.string().max(60_000).default(''), labels: z.array(z.string().max(50)).max(10).default([]) }),
        level: 3,
        classify: () => ({ reasons: ['Changes GitHub state'], effects: ['network'] }),
        run: (i, ctx) => gh(ctx, ['issue', 'create', '--title', i.title, '--body', i.body, ...i.labels.flatMap((l) => ['--label', l])], (t) => `Opened ${String(t).trim().split('\n').pop()}`),
      }),
      operation({
        id: 'github.issue_comment',
        title: 'Comment on an issue or PR',
        description: 'Add a comment to an issue or pull request.',
        input: z.object({ number: num, body: z.string().min(1).max(60_000) }),
        level: 3,
        classify: () => ({ reasons: ['Posts to GitHub'], effects: ['network'] }),
        run: (i, ctx) => gh(ctx, ['issue', 'comment', String(i.number), '--body', i.body], () => `Commented on #${i.number}`),
      }),
    ],
  };
}
