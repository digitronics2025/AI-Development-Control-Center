import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '@acc/executor';
import { redact } from '@acc/security';
import type { PermissionLevel } from '@acc/shared';
import { z } from 'zod';
import { clip, detectExecutable, localBin, run, pushBounded } from '../detect.js';
import { resolveInside } from '../paths.js';
import { failure, operation, type OperationContext, type OperationResult, type ToolProvider, type ToolRisk } from '../sdk.js';
import { classifySql } from '../sql.js';

/**
 * Cloudflare through Wrangler (V2 plan §23). Every operation names its
 * environment — local, preview, staging or production — and the level
 * follows it: local work is Level 2, staging and previews Level 4,
 * production Level 5 (always a typed approval). Reads that return no stored
 * data (deployment history, live logs, KV key names) stay Level 2 whatever the
 * environment. A remote D1/KV "preview" is the live database and is judged as
 * production; a Pages branch is production when Cloudflare says so, not the
 * caller. Credentials come from the
 * broker (`cloudflare` kind → CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID).
 */

const CREDENTIALS = ['cloudflare'] as const;
const environment = z.enum(['local', 'preview', 'staging', 'production']);
type Environment = z.infer<typeof environment>;
const remoteEnvironment = z.enum(['preview', 'staging', 'production']);
const dbName = z.string().min(1).max(100).regex(/^[\w-]+$/);

function levelFor(env: Environment, write: boolean): Partial<ToolRisk> {
  if (env === 'production') return write ? { level: 5, production: true, risk: 'elevated', reasons: ['Changes production on Cloudflare'], effects: ['infrastructure', 'production', 'network'] } : { level: 4, reasons: ['Reads production data on Cloudflare'], effects: ['network', 'production'] };
  if (env === 'local') return { level: write ? 2 : 1, reasons: [write ? 'Changes local Wrangler state' : 'Reads local Wrangler state'], effects: [] };
  return write ? { level: 4, risk: 'elevated', reasons: [`Changes the ${env} environment on Cloudflare`], effects: ['infrastructure', 'network'] } : { level: 2, reasons: [`Reads the ${env} environment on Cloudflare`], effects: ['network'] };
}

function envFlags(env: Environment): string[] {
  return env === 'staging' || env === 'production' ? ['--env', env] : [];
}

/** `stdin` carries a secret value when one is needed: never argv, never the environment, never a file. */
async function wrangler(ctx: OperationContext, args: string[], timeoutMs = 180_000, stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string; spawnError: string | null }> {
  const exe = localBin(ctx.cwd, 'wrangler') ?? ctx.detection('wrangler')?.path ?? 'wrangler';
  const lines: string[] = [];
  const errs: string[] = [];
  const handle = runProcess({
    command: exe,
    args,
    cwd: ctx.cwd,
    env: { ...ctx.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
    timeoutMs,
    ...(stdin !== undefined ? { stdin } : {}),
    onLine: (stream, line) => {
      const text = redact(line);
      pushBounded(stream === 'stdout' ? lines : errs, text);
      ctx.onLine?.(stream, text);
    },
  });
  const abort = () => void handle.cancel();
  ctx.signal.addEventListener('abort', abort, { once: true });
  const result = await handle.done;
  ctx.signal.removeEventListener('abort', abort);
  return { code: result.exitCode, stdout: lines.join('\n'), stderr: errs.join('\n'), spawnError: result.spawnError };
}

function resultOf(r: Awaited<ReturnType<typeof wrangler>>, summary: string, output?: unknown): OperationResult {
  if (r.spawnError) return failure('NOT_INSTALLED', 'Wrangler is not installed (add it to the project or install it globally)');
  const ok = r.code === 0;
  const message = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-5).join(' ').slice(0, 500);
  return {
    ok,
    summary: ok ? summary : `wrangler failed: ${message}`,
    stdout: clip(r.stdout),
    stderr: clip(r.stderr, 8000),
    exitCode: r.code,
    networkTargets: ['api.cloudflare.com'],
    ...(output !== undefined ? { output } : {}),
    ...(ok ? {} : { error: { code: /login|authenticat|CLOUDFLARE_API_TOKEN/i.test(message) ? ('AUTH_REQUIRED' as const) : ('FAILED' as const), message } }),
  };
}

function parseJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

const CF_API = 'https://api.cloudflare.com/client/v4';

/** A value from the repository's Wrangler config (`name`, `account_id`), for defaults only. */
/** Branch names that are production on nearly every Pages project: classified production without asking Cloudflare. */
const PRODUCTION_BRANCH = /^(?:main|master|production|prod|release|live)$/i;

/** The Pages project's production branch as Cloudflare has it, or null when it cannot be read. */
async function pagesProductionBranch(ctx: OperationContext, project: string): Promise<string | null> {
  const token = ctx.env.CLOUDFLARE_API_TOKEN;
  const account = ctx.env.CLOUDFLARE_ACCOUNT_ID ?? wranglerConfigValue(ctx.cwd, 'account_id');
  if (!token || !account) return null;
  const r = await cfApi(ctx, token, `/accounts/${account}/pages/projects/${project}`).catch(() => null);
  const branch = (r?.json?.result as { production_branch?: unknown } | undefined)?.production_branch;
  return r?.ok && typeof branch === 'string' ? branch : null;
}

/**
 * A remote D1 or KV store has no preview copy: `--remote` without `--env`
 * addresses the one database by name, which is the live one. A remote write
 * labelled preview is judged as production (audit F-14).
 */
function remoteData(env: Environment): Environment {
  return env === 'preview' ? 'production' : env;
}

export function wranglerConfigValue(cwd: string, key: 'name' | 'account_id'): string | null {
  for (const file of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    let text: string;
    try {
      text = readFileSync(path.join(cwd, file), 'utf8');
    } catch {
      continue;
    }
    const m = file.endsWith('.toml') ? new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(text) : new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text);
    if (m) return m[1]!;
  }
  return null;
}

async function cfApi(ctx: OperationContext, token: string, route: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`${CF_API}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean };
  return { ok: res.ok && json.success !== false, status: res.status, json };
}

interface LogEvent {
  timestamp?: number;
  source?: { level?: string; message?: unknown } | string;
  $metadata?: { service?: string; level?: string; message?: string; error?: string; trigger?: string };
  $workers?: { scriptName?: string; event?: { response?: { status?: number } } };
}

/** One readable line per stored log event: time, level, Worker, trigger, message. */
export function logLine(e: LogEvent): string {
  const m = e.$metadata ?? {};
  const when = e.timestamp ? new Date(e.timestamp).toISOString().replace('.000Z', 'Z') : '?';
  const source = typeof e.source === 'object' && e.source ? e.source.message : e.source;
  const text = String(m.error ?? m.message ?? (typeof source === 'string' ? source : JSON.stringify(source ?? ''))).replace(/\s+/g, ' ').slice(0, 400);
  const status = e.$workers?.event?.response?.status;
  return `${when} [${m.level ?? 'info'}] ${m.service ?? e.$workers?.scriptName ?? '?'}${m.trigger ? ` ${m.trigger}` : ''}${status ? ` → ${status}` : ''} :: ${text}`;
}

export function cloudflareProvider(): ToolProvider {
  return {
    id: 'wrangler',
    name: 'Cloudflare Wrangler',
    description: 'Workers, Pages, D1, R2 and KV through Wrangler, with local, preview, staging and production kept apart.',
    category: 'cloudflare',
    async detect(ctx) {
      const local = localBin(ctx.cwd, 'wrangler');
      if (local) {
        const out = await run(local, ['--version'], { cwd: ctx.cwd ?? undefined, env: ctx.env, timeoutMs: 30_000 });
        return { installed: true, version: /(\d+\.\d+\.\d+)/.exec(out.stdout + out.stderr)?.[1] ?? null, path: local, auth: { required: true, state: 'unknown', message: null }, message: 'project-local wrangler' };
      }
      const global = await detectExecutable(ctx, ['wrangler']);
      return { ...global, auth: { required: true, state: 'unknown', message: null } };
    },
    async checkAuth(ctx, detection) {
      if (!detection.path) return { required: true, state: 'missing', message: 'Wrangler is not installed' };
      const r = await run(detection.path, ['whoami'], { env: { ...ctx.env, WRANGLER_SEND_METRICS: 'false' }, timeoutMs: 45_000 });
      const text = redact(`${r.stdout}\n${r.stderr}`);
      if (r.code === 0 && !/not authenticated|You are not logged in/i.test(text)) {
        return { required: true, state: 'ok', message: /associated with the email (\S+)/i.exec(text)?.[1] ?? /logged in with an? ([\w ]+token)/i.exec(text)?.[1] ?? 'Signed in' };
      }
      return { required: true, state: 'missing', message: 'Not signed in: store a Cloudflare API token under Tools → Credentials, or run `wrangler login`' };
    },
    operations: [
      operation({
        id: 'cloudflare.whoami',
        title: 'Cloudflare account',
        description: 'Which Cloudflare account Wrangler would act as.',
        input: z.object({}),
        level: 1,
        credentials: CREDENTIALS,
        async run(_input, ctx) {
          const r = await wrangler(ctx, ['whoami'], 60_000);
          return resultOf(r, 'Wrangler is signed in');
        },
      }),
      operation({
        id: 'cloudflare.resources',
        title: 'List Cloudflare resources',
        description: 'D1 databases, R2 buckets and KV namespaces on the account.',
        input: z.object({}),
        level: 2,
        classify: () => levelFor('staging', false),
        credentials: CREDENTIALS,
        async run(_input, ctx) {
          const d1 = await wrangler(ctx, ['d1', 'list', '--json'], 90_000);
          const r2 = await wrangler(ctx, ['r2', 'bucket', 'list'], 90_000);
          const kv = await wrangler(ctx, ['kv', 'namespace', 'list'], 90_000);
          const ok = [d1, r2, kv].every((r) => r.code === 0);
          return { ...resultOf(ok ? d1 : [d1, r2, kv].find((r) => r.code !== 0)!, 'Listed Cloudflare resources'), output: { d1: parseJson(d1.stdout), r2: r2.stdout.trim(), kv: parseJson(kv.stdout) } };
        },
      }),
      operation({
        id: 'cloudflare.deployments',
        title: 'Deployment history',
        description: 'Recent deployments of the Worker in an environment.',
        input: z.object({ environment: remoteEnvironment.default('production') }),
        level: 2,
        classify: (i) => ({ ...levelFor(i.environment === 'production' ? 'staging' : i.environment, false) }),
        credentials: CREDENTIALS,
        async run(input, ctx) {
          const r = await wrangler(ctx, ['deployments', 'list', ...envFlags(input.environment)], 90_000);
          return resultOf(r, `Deployments for ${input.environment}`);
        },
      }),
      operation({
        id: 'cloudflare.dev',
        title: 'Start the Worker locally',
        description: 'Run `wrangler dev` on 127.0.0.1 as a task-owned background process and wait until it answers.',
        input: z.object({ port: z.number().int().min(1024).max(65535).default(8787), environment: z.enum(['local', 'staging']).default('local') }),
        level: 2,
        longRunning: true,
        async run(input, ctx) {
          if (!ctx.processes) return failure('UNAVAILABLE', 'Background processes are not available in this session');
          const exe = localBin(ctx.cwd, 'wrangler') ?? 'wrangler';
          const url = `http://127.0.0.1:${input.port}`;
          const proc = await ctx.processes.start({
            name: 'wrangler dev',
            command: `"${exe}" dev --ip 127.0.0.1 --port ${input.port}${input.environment === 'staging' ? ' --env staging' : ''}`,
            cwd: ctx.cwd,
            port: input.port,
            readyUrl: url,
            readyTimeoutSec: 90,
            env: { WRANGLER_SEND_METRICS: 'false' },
          });
          return { ok: proc.status === 'healthy', summary: proc.status === 'healthy' ? `Worker running at ${url}` : `wrangler dev did not become healthy (${proc.status})`, output: proc, evidence: [`wrangler dev ${url} → ${proc.status}`] };
        },
      }),
      operation({
        id: 'cloudflare.deploy',
        title: 'Deploy the Worker',
        description: '`dryRun` bundles without uploading (Level 2). preview uploads a version without routing traffic, staging deploys `--env staging` (Level 4), production needs your typed approval (Level 5).',
        input: z.object({ environment: remoteEnvironment, dryRun: z.boolean().default(false), message: z.string().max(200).optional() }),
        level: 4,
        classify: (i) => (i.dryRun ? { level: 2, reasons: ['Builds the Worker without uploading'], effects: [] } : levelFor(i.environment, true)),
        credentials: CREDENTIALS,
        async run(input, ctx) {
          if (input.dryRun) {
            const out = path.join(ctx.tempDir, `wrangler-dry-run-${Date.now()}`);
            mkdirSync(out, { recursive: true });
            return resultOf(await wrangler(ctx, ['deploy', '--dry-run', '--outdir', out, ...envFlags(input.environment)]), 'Dry run: the Worker bundles');
          }
          const args = input.environment === 'preview' ? ['versions', 'upload', ...(input.message ? ['--message', input.message] : [])] : ['deploy', ...envFlags(input.environment), ...(input.message ? ['--message', input.message] : [])];
          const r = await wrangler(ctx, args, 600_000);
          const url = /(https:\/\/\S+\.workers\.dev\S*)/.exec(r.stdout)?.[1] ?? null;
          const version = /Version ID:\s*([0-9a-f-]{36})/i.exec(r.stdout)?.[1] ?? null;
          return { ...resultOf(r, `Deployed to ${input.environment}${url ? ` at ${url}` : ''}`, { url, versionId: version }), evidence: r.code === 0 ? [`deploy ${input.environment}${version ? ` version ${version}` : ''}${url ? ` ${url}` : ''}`] : [] };
        },
      }),
      operation({
        id: 'cloudflare.pages_deploy',
        title: 'Deploy a Pages site',
        description: 'Upload a built folder to a Pages project. A preview branch is Level 4; the production branch needs your typed approval.',
        // Which branch is production is the project's setting on Cloudflare, never the caller's word
        // (audit F-14): common production names are classified production up front, and any other
        // branch is checked against the project before anything is uploaded.
        input: z.object({ directory: z.string().min(1).max(500), project: z.string().min(1).max(100).regex(/^[\w-]+$/), branch: z.string().min(1).max(100).regex(/^[\w./-]+$/) }),
        level: 4,
        classify: (i) => levelFor(PRODUCTION_BRANCH.test(i.branch) ? 'production' : 'preview', true),
        credentials: CREDENTIALS,
        async run(input, ctx) {
          let dir: string;
          try {
            dir = resolveInside(ctx.roots, ctx.cwd, input.directory);
          } catch (error) {
            return failure('OUTSIDE_ROOT', (error as Error).message);
          }
          if (!PRODUCTION_BRANCH.test(input.branch)) {
            const production = await pagesProductionBranch(ctx, input.project);
            if (production === null) return failure('DENIED', `Could not confirm ${input.project}'s production branch on Cloudflare, so a deploy to "${input.branch}" cannot be judged a preview. Store a Cloudflare token with Pages read access, or deploy as the production branch (typed approval).`);
            if (production === input.branch) return failure('DENIED', `"${input.branch}" is ${input.project}'s production branch: this is a production deploy and needs your typed approval. Deploy it under that name as production.`);
          }
          const r = await wrangler(ctx, ['pages', 'deploy', dir, '--project-name', input.project, '--branch', input.branch], 600_000);
          const url = /(https:\/\/\S+\.pages\.dev)/.exec(r.stdout)?.[1] ?? null;
          return { ...resultOf(r, `Pages deployed${url ? ` at ${url}` : ''}`, { url }), evidence: r.code === 0 && url ? [`pages ${input.branch} → ${url}`] : [] };
        },
      }),
      operation({
        id: 'cloudflare.tail',
        title: 'Tail Worker logs',
        description: 'Collect live logs from a deployed Worker for a few seconds.',
        input: z.object({ environment: remoteEnvironment.default('staging'), durationSec: z.number().int().min(3).max(120).default(15) }),
        level: 2,
        classify: (i) => levelFor(i.environment === 'production' ? 'staging' : i.environment, false),
        credentials: CREDENTIALS,
        async run(input, ctx) {
          const r = await wrangler(ctx, ['tail', '--format', 'json', ...envFlags(input.environment)], input.durationSec * 1000);
          const events = r.stdout.split('\n').map((l) => parseJson(l)).filter(Boolean);
          return { ok: true, summary: `${events.length} log event(s) in ${input.durationSec}s`, output: { events: events.slice(-200) }, stderr: clip(r.stderr, 4000) };
        },
      }),
      operation({
        id: 'cloudflare.logs_query',
        title: 'Search past Worker logs',
        description:
          'Search a Worker’s stored logs (Workers Observability) over the last minutes, hours or days: errors, console output, requests. `sinceMinutes` sets how far back (default 60; 1440 = a day, 10080 = a week); `worker` defaults to the repository’s Wrangler name; `search` finds text anywhere in an event; `onlyErrors` keeps errors. The summary states the window searched. Use it to find why production failed earlier; cloudflare.tail only shows what happens now.',
        input: z.object({
          worker: z.string().min(1).max(100).regex(/^[\w-]+$/).optional(),
          allWorkers: z.boolean().default(false),
          sinceMinutes: z.number().int().min(1).max(7 * 24 * 60).default(60),
          search: z.string().min(1).max(200).optional(),
          onlyErrors: z.boolean().default(false),
          limit: z.number().int().min(1).max(200).default(50),
          accountId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
        }),
        level: 2,
        classify: () => ({ reasons: ['Reads Worker logs stored by Cloudflare'], effects: ['network'] }),
        credentials: CREDENTIALS,
        async run(input, ctx) {
          const token = ctx.env.CLOUDFLARE_API_TOKEN;
          if (!token) return failure('AUTH_REQUIRED', 'No Cloudflare API token: store one with Workers Observability read access in Tools → Credentials (kind cloudflare)');
          let account = input.accountId ?? ctx.env.CLOUDFLARE_ACCOUNT_ID ?? wranglerConfigValue(ctx.cwd, 'account_id');
          if (!account) {
            const r = await cfApi(ctx, token, '/accounts?per_page=50');
            if (!r.ok) return failure(r.status === 401 || r.status === 403 ? 'AUTH_REQUIRED' : 'FAILED', `Cloudflare refused the account list (HTTP ${r.status})`);
            const accounts = (r.json?.result ?? []) as Array<{ id: string; name: string }>;
            if (accounts.length !== 1) return failure('INVALID_INPUT', `Which account? Pass accountId: ${accounts.map((a) => `${a.id} (${redact(a.name)})`).join(', ') || 'none visible to this token'}`);
            account = accounts[0]!.id;
          }
          const worker = input.allWorkers ? null : (input.worker ?? wranglerConfigValue(ctx.cwd, 'name'));
          const to = Date.now();
          const filters = [
            ...(worker ? [{ key: '$metadata.service', operation: 'eq', type: 'string', value: worker }] : []),
            ...(input.onlyErrors ? [{ key: '$metadata.level', operation: 'eq', type: 'string', value: 'error' }] : []),
          ];
          const r = await cfApi(ctx, token, `/accounts/${account}/workers/observability/telemetry/query`, {
            queryId: `acc-${ctx.executionId}`.slice(0, 60),
            timeframe: { from: to - input.sinceMinutes * 60_000, to },
            view: 'events',
            limit: input.limit,
            parameters: { filters, filterCombination: 'and', ...(input.search ? { needle: { value: input.search, isRegex: false, matchCase: false } } : {}) },
          });
          if (!r.ok) {
            const why = redact(((r.json?.errors ?? []) as Array<{ message: string }>).map((e) => e.message).join('; ') || `HTTP ${r.status}`);
            return failure(r.status === 401 || r.status === 403 ? 'AUTH_REQUIRED' : 'FAILED', `Cloudflare refused the log search: ${why}${r.status === 403 ? ' (the token needs Workers Observability read)' : ''}`);
          }
          const events = ((r.json?.result?.events?.events ?? []) as LogEvent[]).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
          const errors = events.filter((e) => e.$metadata?.level === 'error').length;
          const span = input.sinceMinutes >= 120 ? `${Math.round(input.sinceMinutes / 60)} h` : `${input.sinceMinutes} min`;
          const scope = `${worker ?? 'all Workers'}, last ${span}${input.search ? `, matching "${redact(input.search)}"` : ''}${input.onlyErrors ? ', errors only' : ''}`;
          return {
            ok: true,
            summary: `${events.length} log event(s), ${errors} error(s) — ${scope}`,
            stdout: events.map((e) => redact(logLine(e))).join('\n') || '(no matching events)',
            output: { worker, account, count: events.length, errors },
            evidence: [`logs ${scope}: ${events.length} event(s), ${errors} error(s)`],
            networkTargets: ['api.cloudflare.com'],
          };
        },
      }),
      operation({
        id: 'cloudflare.d1_query',
        title: 'Query a D1 database',
        description: 'Run SQL against D1 locally or remotely. Reads are low risk; writes to staging need Level 4, to production your typed approval; destructive SQL always asks.',
        input: z.object({ database: dbName, sql: z.string().min(1).max(100_000), environment }),
        level: 1,
        classify: (i) => {
          const sql = classifySql(i.sql);
          const base = levelFor(remoteData(i.environment), !sql.readOnly);
          return sql.destructive ? { ...base, level: 5 as PermissionLevel, risk: 'dangerous', reasons: sql.reasons, effects: ['database', ...(base.effects ?? [])] } : { ...base, reasons: [...(base.reasons ?? []), ...sql.reasons], effects: ['database', ...(base.effects ?? [])] };
        },
        credentials: CREDENTIALS,
        async run(input, ctx) {
          const where = input.environment === 'local' ? ['--local'] : ['--remote', ...envFlags(input.environment)];
          const r = await wrangler(ctx, ['d1', 'execute', input.database, '--command', input.sql, '--json', ...where], 180_000);
          const json = parseJson(r.stdout) as Array<{ results?: unknown[]; meta?: Record<string, unknown> }> | null;
          const rows = Array.isArray(json) ? json.flatMap((s) => s.results ?? []) : [];
          return resultOf(r, `${rows.length} row(s) from ${input.database} (${input.environment})`, { results: rows.slice(0, 500), meta: Array.isArray(json) ? json.map((s) => s.meta) : null });
        },
      }),
      operation({
        id: 'cloudflare.d1_migrations',
        title: 'D1 migrations',
        description: 'List or apply D1 migrations. Applying locally is Level 2, to staging Level 4, to production your typed approval.',
        input: z.object({ database: dbName, action: z.enum(['list', 'apply']), environment }),
        level: 1,
        classify: (i) => ({ ...levelFor(remoteData(i.environment), i.action === 'apply'), effects: ['database'] }),
        credentials: CREDENTIALS,
        async run(input, ctx) {
          const where = input.environment === 'local' ? ['--local'] : ['--remote', ...envFlags(input.environment)];
          const r = await wrangler(ctx, ['d1', 'migrations', input.action, input.database, ...where], 300_000);
          return resultOf(r, input.action === 'apply' ? `Migrations applied to ${input.database} (${input.environment})` : `Migrations of ${input.database} (${input.environment})`);
        },
      }),
      operation({
        id: 'cloudflare.d1_export',
        title: 'Back up a D1 database',
        description: 'Export a D1 database to a SQL file kept with the Control Center (not in the repository).',
        input: z.object({ database: dbName, environment }),
        level: 2,
        classify: (i) => (remoteData(i.environment) === 'production' ? levelFor('production', false) : { level: 2, reasons: ['Backs up a database'], effects: ['database'] }),
        credentials: CREDENTIALS,
        async run(input, ctx) {
          const dir = path.join(ctx.stateDir, 'backups', 'd1');
          mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${input.database}-${input.environment}-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);
          const where = input.environment === 'local' ? ['--local'] : ['--remote', ...envFlags(input.environment)];
          const r = await wrangler(ctx, ['d1', 'export', input.database, '--output', file, ...where], 600_000);
          return { ...resultOf(r, `Backed up ${input.database} (${input.environment})`, { file }), evidence: r.code === 0 ? [`d1 backup ${file}`] : [] };
        },
      }),
      operation({
        id: 'cloudflare.secret_put',
        title: 'Set a Worker secret',
        description:
          'Store a credential from the broker as a Worker secret, by name: the value goes to Wrangler on stdin and never appears to you, in arguments or in logs. staging is Level 4; production needs your typed approval. A secret made with credential.generate must be saved to MyVault before its first deployment. Success is verified by listing secret names — Cloudflare never returns values. Retrying deploys the same value.',
        input: z.object({
          credential: z.string().min(1).max(100).regex(/^[\w.-]+$/),
          secretName: z.string().min(1).max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Letters, digits and underscore, not starting with a digit'),
          environment: z.enum(['staging', 'production']),
        }),
        level: 4,
        classify: (i) => levelFor(i.environment, true),
        credentials: CREDENTIALS,
        async run(input, ctx) {
          if (!ctx.credentials) return failure('UNAVAILABLE', 'Credentials are not available in this session');
          const target = `Worker secret ${input.secretName} (${input.environment})`;
          const blocked = await ctx.credentials.deployGate?.(input.credential, target);
          if (blocked) return failure('UNAVAILABLE', blocked);
          const value = await ctx.credentials.value(input.credential);
          if (value === null) return failure('INVALID_INPUT', `No credential named "${input.credential}" is available to this repository`);
          const put = resultOf(await wrangler(ctx, ['secret', 'put', input.secretName, ...envFlags(input.environment)], 180_000, value), `Set ${target}`);
          if (!put.ok) return put;
          // Presence is all Cloudflare can prove: secret values are never readable back.
          const listed = await wrangler(ctx, ['secret', 'list', '--format', 'json', ...envFlags(input.environment)], 90_000);
          const names = parseJson(listed.stdout);
          const present = listed.code === 0 && Array.isArray(names) && names.some((n) => (n as { name?: unknown } | null)?.name === input.secretName);
          const output = { credential: input.credential, secretName: input.secretName, environment: input.environment, verified: present };
          if (!present) {
            const message = `Deployment unverified: Wrangler reported the secret was set, but ${input.secretName} is not in the ${input.environment} secret list. The same value will be used on retry.`;
            return { ...put, ok: false, summary: message, output, error: { code: 'FAILED', message } };
          }
          return { ...put, output, evidence: [`secret ${input.secretName} present in ${input.environment} (value not readable back by design)`] };
        },
      }),
      operation({
        id: 'cloudflare.kv_list',
        title: 'List KV keys',
        description: 'Keys in a KV namespace (by binding), optionally by prefix. Values are not read.',
        input: z.object({ binding: z.string().min(1).max(100).regex(/^\w+$/), prefix: z.string().max(200).optional(), environment }),
        level: 1,
        classify: (i) => levelFor(i.environment === 'production' ? 'staging' : i.environment, false),
        credentials: CREDENTIALS,
        async run(input, ctx) {
          const where = input.environment === 'local' ? ['--local'] : ['--remote', ...envFlags(input.environment)];
          const r = await wrangler(ctx, ['kv', 'key', 'list', '--binding', input.binding, ...(input.prefix ? ['--prefix', input.prefix] : []), ...where], 90_000);
          const keys = parseJson(r.stdout);
          return resultOf(r, `${Array.isArray(keys) ? keys.length : 0} key(s)`, { keys });
        },
      }),
    ],
  };
}
