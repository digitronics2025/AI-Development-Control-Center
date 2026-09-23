import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '@acc/executor';
import { redact } from '@acc/security';
import type { PermissionLevel } from '@acc/shared';
import { z } from 'zod';
import { clip, detectExecutable, localBin, run } from '../detect.js';
import { resolveInside } from '../paths.js';
import { failure, operation, type OperationContext, type OperationResult, type ToolProvider, type ToolRisk } from '../sdk.js';
import { classifySql } from '../sql.js';

/**
 * Cloudflare through Wrangler (V2 plan §23). Every operation names its
 * environment — local, preview, staging or production — and the level
 * follows it: local work is Level 2, staging and previews Level 4,
 * production Level 5 (always a typed approval). Credentials come from the
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

async function wrangler(ctx: OperationContext, args: string[], timeoutMs = 180_000): Promise<{ code: number | null; stdout: string; stderr: string; spawnError: string | null }> {
  const exe = localBin(ctx.cwd, 'wrangler') ?? ctx.detection('wrangler')?.path ?? 'wrangler';
  const lines: string[] = [];
  const errs: string[] = [];
  const handle = runProcess({
    command: exe,
    args,
    cwd: ctx.cwd,
    env: { ...ctx.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
    timeoutMs,
    onLine: (stream, line) => {
      const text = redact(line);
      (stream === 'stdout' ? lines : errs).push(text);
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
        input: z.object({ directory: z.string().min(1).max(500), project: z.string().min(1).max(100).regex(/^[\w-]+$/), branch: z.string().min(1).max(100).regex(/^[\w./-]+$/), productionBranch: z.string().max(100).default('main') }),
        level: 4,
        classify: (i) => levelFor(i.branch === i.productionBranch ? 'production' : 'preview', true),
        credentials: CREDENTIALS,
        async run(input, ctx) {
          let dir: string;
          try {
            dir = resolveInside(ctx.roots, ctx.cwd, input.directory);
          } catch (error) {
            return failure('OUTSIDE_ROOT', (error as Error).message);
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
        id: 'cloudflare.d1_query',
        title: 'Query a D1 database',
        description: 'Run SQL against D1 locally or remotely. Reads are low risk; writes to staging need Level 4, to production your typed approval; destructive SQL always asks.',
        input: z.object({ database: dbName, sql: z.string().min(1).max(100_000), environment }),
        level: 1,
        classify: (i) => {
          const sql = classifySql(i.sql);
          const base = levelFor(i.environment, !sql.readOnly);
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
        classify: (i) => ({ ...levelFor(i.environment, i.action === 'apply'), effects: ['database'] }),
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
        classify: (i) => (i.environment === 'production' ? levelFor('production', false) : { level: 2, reasons: ['Backs up a database'], effects: ['database'] }),
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
