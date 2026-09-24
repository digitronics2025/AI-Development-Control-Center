import { z } from 'zod';
import { readCapped } from '../net-guard.js';
import { builtinDetection, failure, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';
import { apiBase, pathSegment, restRequest, type RestResponse } from './rest.js';

/**
 * Read-only GitHub through the REST API (docs/systems/ask.md): files at any
 * branch, commits, code search, pull requests, issues and Actions runs of any
 * repository the token can see, with no clone. It never uses the `gh` login:
 * every call needs the brokered `github` token. `ACC_GITHUB_OWNERS` (set for
 * read-only sessions) limits which owners may be read; in a read-only
 * session a classic token that can write is refused.
 */

const CREDENTIALS = ['github'] as const;
const REAL_API = 'https://api.github.com';
const READ = { level: 1 as const, effects: ['network' as const], reasons: ['Reads GitHub'], writes: false };
const MAX_FILE_BYTES = 256 * 1024;
const LOG_LINES = 200;

const repo = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name')
  .refine((r) => !r.split('/').some((p) => p === '.' || p === '..'), 'owner/name');
const ref = z.string().min(1).max(200).regex(/^[\w./-]+$/).refine((r) => !r.includes('..'), 'Not a branch, tag or commit');
const filePath = z
  .string()
  .max(500)
  .refine((p) => ![...p].some((c) => c.charCodeAt(0) < 0x20), 'Control characters are not allowed')
  .refine((p) => !p.split('/').includes('..'), 'No ".." segments');
/** Issue and pull request numbers; Actions run ids are far larger (10+ digits). */
const num = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Scopes of a classic token that can change something. Fine-grained tokens send no scope header. */
const WRITE_SCOPES = /(?:^|,\s*)(?:repo|public_repo|workflow|write:\w+|admin:\w+|delete_repo|delete:\w+|gist|user)(?:\s*,|$)/;

interface Client {
  token: string;
  base: string;
  owners: string[] | null;
  readOnly: boolean;
}

function client(ctx: OperationContext): Client | OperationResult {
  const token = ctx.env.GH_TOKEN ?? ctx.env.GITHUB_TOKEN;
  if (!token) return failure('AUTH_REQUIRED', 'No GitHub key is available: add a read-only GitHub token in Settings → Ask (or Tools → Credentials).');
  const owners = ctx.env.ACC_GITHUB_OWNERS ? ctx.env.ACC_GITHUB_OWNERS.split(',').map((o) => o.trim().toLowerCase()).filter(Boolean) : null;
  return { token, base: apiBase(ctx, REAL_API, 'ACC_GITHUB_API_BASE'), owners, readOnly: ctx.env.ACC_READ_ONLY === '1' };
}

function isClient(c: Client | OperationResult): c is Client {
  return 'token' in c;
}

/** Refused before any request when the owner is not allowed. */
function ownerCheck(c: Client, repository: string): OperationResult | null {
  const owner = repository.split('/')[0]!.toLowerCase();
  if (c.owners && !c.owners.includes(owner)) return failure('DENIED', `Repositories of "${owner}" are not readable here. Allowed owners: ${c.owners.join(', ') || 'none'} (Settings → Ask).`);
  return null;
}

async function gh(ctx: OperationContext, c: Client, route: string, accept = 'application/vnd.github+json', maxBytes?: number): Promise<RestResponse | OperationResult> {
  const r = await restRequest(ctx, `${c.base}${route}`, { headers: { authorization: `Bearer ${c.token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'ai-development-control-center' }, maxBytes });
  const scopes = r.headers.get('x-oauth-scopes');
  if (c.readOnly && scopes && WRITE_SCOPES.test(scopes)) {
    return failure('DENIED', `This GitHub key can change repositories (scopes: ${scopes}). Ask only uses read-only keys: create a fine-grained token with read-only permissions and choose it in Settings → Ask.`);
  }
  return r;
}

function isResult(x: unknown): x is OperationResult {
  return typeof x === 'object' && x !== null && 'ok' in x && 'summary' in x && !('headers' in x);
}

function ghFailure(r: RestResponse, what: string): OperationResult {
  const message = (r.json?.message as string | undefined) ?? (r.text.slice(0, 200) || `HTTP ${r.status}`);
  if (r.status === 401) return failure('AUTH_REQUIRED', `GitHub refused the key for ${what}: ${message}.`);
  if (r.status === 403 && /rate limit/i.test(message)) return failure('UNAVAILABLE', `GitHub rate limit reached for ${what}. Try again later.`);
  if (r.status === 403 || r.status === 404) return failure('FAILED', `${what}: not found or not readable with this key (${message}).`);
  if (r.status === 429 || r.status >= 500) return failure('UNAVAILABLE', `GitHub is not answering ${what} right now (HTTP ${r.status}).`);
  return failure('FAILED', `${what} failed: ${message}`);
}

const net = { networkTargets: ['api.github.com'] };

/** Common start: client, owner check. */
function start(ctx: OperationContext, repository?: string): Client | OperationResult {
  const c = client(ctx);
  if (!isClient(c)) return c;
  if (repository) {
    const denied = ownerCheck(c, repository);
    if (denied) return denied;
  }
  return c;
}

const repoPath = (r: string) => r.split('/').map(pathSegment).join('/');

export function githubApiProvider(): ToolProvider {
  return {
    id: 'github-api',
    name: 'GitHub data (read-only)',
    description: 'Reads files, commits, code search, pull requests, issues and Actions runs through the GitHub API with a brokered token; nothing here can change anything.',
    category: 'github',
    builtin: true,
    async detect() {
      return builtinDetection();
    },
    operations: [
      operation({
        id: 'github.repos',
        title: 'List readable repositories',
        description: 'Repositories this key can read (limited to the allowed owners): name, visibility, default branch, last push. Start here to find repository names.',
        input: z.object({ limit: z.number().int().min(1).max(300).default(100) }),
        level: 1,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => READ,
        async run(input, ctx) {
          const c = start(ctx);
          if (!isClient(c)) return c;
          const repos: Array<{ repo: string; private: boolean; defaultBranch: string; pushedAt: string | null; description: string | null }> = [];
          for (let page = 1; page <= 3 && repos.length < input.limit; page++) {
            const r = await gh(ctx, c, `/user/repos?per_page=100&sort=pushed&page=${page}`);
            if (isResult(r)) return r;
            if (!r.ok) return ghFailure(r, 'the repository list');
            const batch = (r.json ?? []) as any[];
            for (const x of batch) {
              const full = String(x.full_name);
              if (c.owners && !c.owners.includes(full.split('/')[0]!.toLowerCase())) continue;
              repos.push({ repo: full, private: Boolean(x.private), defaultBranch: String(x.default_branch ?? 'main'), pushedAt: x.pushed_at ?? null, description: x.description ?? null });
            }
            if (batch.length < 100) break;
          }
          const list = repos.slice(0, input.limit);
          return { ok: true, summary: `${list.length} repositor${list.length === 1 ? 'y' : 'ies'}`, output: { repos: list }, ...net };
        },
      }),
      operation({
        id: 'github.file_read',
        title: 'Read a file or folder on GitHub',
        description: `A file's text (up to ${MAX_FILE_BYTES / 1024} KB) or a folder's listing, at a branch, tag or commit (default: the default branch). Use \`path: ""\` for the repository root.`,
        input: z.object({ repo, path: filePath.default(''), ref: ref.optional() }),
        level: 1,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => READ,
        async run(input, ctx) {
          const c = start(ctx, input.repo);
          if (!isClient(c)) return c;
          const p = input.path.replace(/^\/+|\/+$/g, '');
          const q = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : '';
          const r = await gh(ctx, c, `/repos/${repoPath(input.repo)}/contents/${p.split('/').filter(Boolean).map(pathSegment).join('/')}${q}`);
          if (isResult(r)) return r;
          if (!r.ok) return ghFailure(r, `${input.repo}/${p || '(root)'}`);
          if (Array.isArray(r.json)) {
            const entries = (r.json as any[]).map((e) => ({ name: String(e.name), type: String(e.type), size: typeof e.size === 'number' ? e.size : null }));
            return { ok: true, summary: `${input.repo}/${p || ''}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`, output: { repo: input.repo, path: p, ref: input.ref ?? null, entries }, ...net };
          }
          const f = r.json as { type?: string; size?: number; content?: string; encoding?: string; sha?: string };
          if (f.type !== 'file') return failure('FAILED', `${p} is a ${f.type ?? 'thing'} GitHub cannot show as a file.`);
          const size = f.size ?? 0;
          if (size > MAX_FILE_BYTES || !f.content) return { ok: true, summary: `${input.repo}/${p}: ${size} bytes (too large to show)`, output: { repo: input.repo, path: p, size, text: null }, ...net };
          const text = Buffer.from(f.content, (f.encoding as BufferEncoding) ?? 'base64').toString('utf8');
          if (text.includes('\u0000')) return { ok: true, summary: `${input.repo}/${p}: ${size} bytes of binary data (not shown)`, output: { repo: input.repo, path: p, size, text: null }, ...net };
          return { ok: true, summary: `${input.repo}/${p}: ${size} bytes`, output: { repo: input.repo, path: p, ref: input.ref ?? null, size, sha: f.sha ?? null, text }, ...net };
        },
      }),
      operation({
        id: 'github.commits',
        title: 'List commits on GitHub',
        description: 'Recent commits of a branch (default: the default branch), optionally touching a path or since a date: sha, message, author, date. `withFiles` adds the changed files for up to 5 commits.',
        input: z.object({ repo, ref: ref.optional(), path: filePath.optional(), since: z.string().datetime({ offset: true }).optional(), limit: z.number().int().min(1).max(100).default(20), withFiles: z.boolean().default(false) }),
        level: 1,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => READ,
        async run(input, ctx) {
          const c = start(ctx, input.repo);
          if (!isClient(c)) return c;
          const q = new URLSearchParams({ per_page: String(input.limit), ...(input.ref ? { sha: input.ref } : {}), ...(input.path ? { path: input.path } : {}), ...(input.since ? { since: input.since } : {}) });
          const r = await gh(ctx, c, `/repos/${repoPath(input.repo)}/commits?${q}`);
          if (isResult(r)) return r;
          if (!r.ok) return ghFailure(r, `commits of ${input.repo}`);
          const commits = ((r.json ?? []) as any[]).map((x) => ({
            sha: String(x.sha).slice(0, 12),
            message: String(x.commit?.message ?? '').slice(0, 1000),
            author: x.commit?.author?.name ?? x.author?.login ?? null,
            date: x.commit?.author?.date ?? null,
            files: undefined as undefined | Array<{ file: string; status: string; additions: number; deletions: number }>,
          }));
          if (input.withFiles) {
            for (const commit of commits.slice(0, 5)) {
              const d = await gh(ctx, c, `/repos/${repoPath(input.repo)}/commits/${commit.sha}`);
              if (isResult(d) || !d.ok) continue;
              commit.files = ((d.json?.files ?? []) as any[]).slice(0, 100).map((f) => ({ file: String(f.filename), status: String(f.status), additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0) }));
            }
          }
          return { ok: true, summary: `${input.repo}: ${commits.length} commit(s)`, output: { repo: input.repo, commits }, ...net };
        },
      }),
      operation({
        id: 'github.code_search',
        title: 'Search code on GitHub',
        description: 'Find where text appears in a repository\'s default branch: file paths with matching fragments. GitHub\'s code search syntax applies (e.g. `"exact phrase" language:ts`).',
        input: z.object({ repo, query: z.string().min(2).max(200), limit: z.number().int().min(1).max(50).default(20) }),
        level: 1,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => READ,
        async run(input, ctx) {
          const c = start(ctx, input.repo);
          if (!isClient(c)) return c;
          const q = new URLSearchParams({ q: `${input.query} repo:${input.repo}`, per_page: String(input.limit) });
          const r = await gh(ctx, c, `/search/code?${q}`, 'application/vnd.github.text-match+json');
          if (isResult(r)) return r;
          if (!r.ok) return ghFailure(r, `code search in ${input.repo}`);
          const matches = ((r.json?.items ?? []) as any[]).map((i) => ({ path: String(i.path), fragments: ((i.text_matches ?? []) as any[]).slice(0, 3).map((t) => String(t.fragment ?? '').slice(0, 400)) }));
          return { ok: true, summary: `${input.repo}: ${r.json?.total_count ?? matches.length} match(es) for "${input.query}"`, output: { repo: input.repo, total: r.json?.total_count ?? null, matches }, ...net };
        },
      }),
      operation({
        id: 'github.pulls',
        title: 'Pull requests on GitHub',
        description: 'List pull requests (state open, closed or all), or one pull request with its description, files and comments when `number` is given.',
        input: z.object({ repo, state: z.enum(['open', 'closed', 'all']).default('open'), number: num.optional(), limit: z.number().int().min(1).max(100).default(20) }),
        level: 1,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => READ,
        async run(input, ctx) {
          const c = start(ctx, input.repo);
          if (!isClient(c)) return c;
          const base = `/repos/${repoPath(input.repo)}`;
          if (input.number) {
            const r = await gh(ctx, c, `${base}/pulls/${input.number}`);
            if (isResult(r)) return r;
            if (!r.ok) return ghFailure(r, `pull request #${input.number}`);
            const [files, comments] = await Promise.all([gh(ctx, c, `${base}/pulls/${input.number}/files?per_page=100`), gh(ctx, c, `${base}/issues/${input.number}/comments?per_page=50`)]);
            const p = r.json;
            return {
              ok: true,
              summary: `${input.repo}#${input.number}: ${p.title} (${p.merged_at ? 'merged' : p.state})`,
              output: {
                number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, author: p.user?.login ?? null, createdAt: p.created_at, mergedAt: p.merged_at ?? null, base: p.base?.ref, head: p.head?.ref, body: String(p.body ?? '').slice(0, 4000),
                files: !isResult(files) && files.ok ? (files.json as any[]).map((f) => ({ file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })) : null,
                comments: !isResult(comments) && comments.ok ? (comments.json as any[]).map((x) => ({ author: x.user?.login ?? null, at: x.created_at, body: String(x.body ?? '').slice(0, 1500) })) : null,
              },
              ...net,
            };
          }
          const r = await gh(ctx, c, `${base}/pulls?state=${input.state}&per_page=${input.limit}&sort=updated&direction=desc`);
          if (isResult(r)) return r;
          if (!r.ok) return ghFailure(r, `pull requests of ${input.repo}`);
          const pulls = ((r.json ?? []) as any[]).map((p) => ({ number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, author: p.user?.login ?? null, updatedAt: p.updated_at, head: p.head?.ref }));
          return { ok: true, summary: `${input.repo}: ${pulls.length} pull request(s)`, output: { repo: input.repo, pulls }, ...net };
        },
      }),
      operation({
        id: 'github.issues',
        title: 'Issues on GitHub',
        description: 'List issues (state open, closed or all; pull requests left out), or one issue with its comments when `number` is given.',
        input: z.object({ repo, state: z.enum(['open', 'closed', 'all']).default('open'), number: num.optional(), label: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).default(20) }),
        level: 1,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => READ,
        async run(input, ctx) {
          const c = start(ctx, input.repo);
          if (!isClient(c)) return c;
          const base = `/repos/${repoPath(input.repo)}`;
          if (input.number) {
            const [r, comments] = await Promise.all([gh(ctx, c, `${base}/issues/${input.number}`), gh(ctx, c, `${base}/issues/${input.number}/comments?per_page=50`)]);
            if (isResult(r)) return r;
            if (!r.ok) return ghFailure(r, `issue #${input.number}`);
            const i = r.json;
            return {
              ok: true,
              summary: `${input.repo}#${input.number}: ${i.title} (${i.state})`,
              output: { number: i.number, title: i.title, state: i.state, author: i.user?.login ?? null, labels: (i.labels ?? []).map((l: any) => l.name), createdAt: i.created_at, closedAt: i.closed_at ?? null, body: String(i.body ?? '').slice(0, 4000), comments: !isResult(comments) && comments.ok ? (comments.json as any[]).map((x) => ({ author: x.user?.login ?? null, at: x.created_at, body: String(x.body ?? '').slice(0, 1500) })) : null },
              ...net,
            };
          }
          const q = new URLSearchParams({ state: input.state, per_page: String(input.limit), sort: 'updated', ...(input.label ? { labels: input.label } : {}) });
          const r = await gh(ctx, c, `${base}/issues?${q}`);
          if (isResult(r)) return r;
          if (!r.ok) return ghFailure(r, `issues of ${input.repo}`);
          const issues = ((r.json ?? []) as any[]).filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state, author: i.user?.login ?? null, labels: (i.labels ?? []).map((l: any) => l.name), updatedAt: i.updated_at }));
          return { ok: true, summary: `${input.repo}: ${issues.length} issue(s)`, output: { repo: input.repo, issues }, ...net };
        },
      }),
      operation({
        id: 'github.runs',
        title: 'GitHub Actions runs',
        description: `List workflow runs (optionally for a branch), or one run with its jobs when \`runId\` is given — including the last ${LOG_LINES} log lines of each failed job.`,
        input: z.object({ repo, branch: ref.optional(), runId: num.optional(), limit: z.number().int().min(1).max(50).default(10) }),
        level: 1,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => READ,
        async run(input, ctx) {
          const c = start(ctx, input.repo);
          if (!isClient(c)) return c;
          const base = `/repos/${repoPath(input.repo)}/actions`;
          if (!input.runId) {
            const q = new URLSearchParams({ per_page: String(input.limit), ...(input.branch ? { branch: input.branch } : {}) });
            const r = await gh(ctx, c, `${base}/runs?${q}`);
            if (isResult(r)) return r;
            if (!r.ok) return ghFailure(r, `Actions runs of ${input.repo}`);
            const runs = ((r.json?.workflow_runs ?? []) as any[]).map((x) => ({ id: x.id, workflow: x.name, branch: x.head_branch, commit: String(x.head_sha ?? '').slice(0, 12), event: x.event, status: x.status, conclusion: x.conclusion, createdAt: x.created_at }));
            return { ok: true, summary: `${input.repo}: ${runs.length} run(s)`, output: { repo: input.repo, runs }, ...net };
          }
          const [run, jobs] = await Promise.all([gh(ctx, c, `${base}/runs/${input.runId}`), gh(ctx, c, `${base}/runs/${input.runId}/jobs?per_page=50`)]);
          if (isResult(run)) return run;
          if (!run.ok) return ghFailure(run, `run ${input.runId}`);
          const jobList = !isResult(jobs) && jobs.ok ? ((jobs.json?.jobs ?? []) as any[]) : [];
          const detail = [];
          for (const j of jobList) {
            const failedSteps = ((j.steps ?? []) as any[]).filter((s) => s.conclusion === 'failure').map((s) => s.name);
            const entry: Record<string, unknown> = { id: j.id, name: j.name, conclusion: j.conclusion, failedSteps };
            if (j.conclusion === 'failure' && detail.filter((d) => d.logTail).length < 3) entry.logTail = await jobLogTail(ctx, c, `${base}/jobs/${j.id}/logs`);
            detail.push(entry as { logTail?: string });
          }
          const x = run.json;
          return {
            ok: true,
            summary: `${input.repo} run ${input.runId}: ${x.name} ${x.conclusion ?? x.status}`,
            output: { id: x.id, workflow: x.name, branch: x.head_branch, commit: String(x.head_sha ?? '').slice(0, 12), status: x.status, conclusion: x.conclusion, createdAt: x.created_at, jobs: detail },
            ...net,
          };
        },
      }),
    ],
  };
}

/**
 * A job's log is a redirect to short-lived blob storage: follow it once,
 * without the GitHub token, and keep only the tail.
 */
async function jobLogTail(ctx: OperationContext, c: Client, route: string): Promise<string | null> {
  try {
    const first = await fetch(`${c.base}${route}`, { headers: { authorization: `Bearer ${c.token}`, 'user-agent': 'ai-development-control-center' }, redirect: 'manual', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) });
    const location = first.headers.get('location');
    // Blob storage is HTTPS; a loopback stand-in API (tests) may redirect to itself.
    const allowed = location && (/^https:\/\//.test(location) || (c.base.startsWith('http://127.0.0.1:') && location.startsWith(new URL(c.base).origin)));
    const res = allowed ? await fetch(location, { redirect: 'error', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) }) : first;
    if (!res.ok) return null;
    const { buffer } = await readCapped(res, 8 * 1024 * 1024);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    return lines.slice(-LOG_LINES).map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s/, '')).join('\n');
  } catch {
    return null;
  }
}
