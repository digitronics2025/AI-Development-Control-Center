import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { redact } from '@acc/security';
import { z } from 'zod';
import { detectExecutable, run } from '../detect.js';
import { resolveInside } from '../paths.js';
import { builtinDetection, failure, operation, type OperationContext, type OperationResult, type ToolProvider, type ToolRisk } from '../sdk.js';

/**
 * Structured HTTP (V2 plan §22): requests with assertions, latency and
 * brokered authentication. Built-in `fetch` is preferred; curl is the
 * fallback provider. Reads are Level 1; writes to this machine Level 2; writes
 * to anything else Level 3.
 */

const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key)$/i;

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

const requestInput = z.object({
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).default('GET'),
  url: z.string().url().max(4000).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs'),
  headers: z.record(z.string().max(200), z.string().max(8000)).default({}),
  json: z.unknown().optional().describe('JSON body (sets content-type).'),
  body: z.string().max(5_000_000).optional().describe('Raw text body.'),
  multipart: z
    .array(z.object({ name: z.string().min(1).max(200), value: z.string().max(1_000_000).optional(), file: z.string().max(1000).optional() }))
    .max(50)
    .optional()
    .describe('Form fields; `file` is a path inside the repository.'),
  auth: z.object({ credential: z.string().min(1).max(100), scheme: z.enum(['Bearer', 'Basic', 'Token', 'header']).default('Bearer'), header: z.string().max(100).optional() }).optional().describe('Use a stored credential (the value is never shown).'),
  timeoutSec: z.number().int().min(1).max(300).default(30),
  expectStatus: z.union([z.number().int(), z.array(z.number().int())]).optional(),
  expectJson: z.record(z.string(), z.unknown()).optional().describe('Top-level fields the JSON response must contain with these values.'),
  expectText: z.string().max(2000).optional(),
  maxLatencyMs: z.number().int().min(1).max(600_000).optional(),
});
type RequestInput = z.infer<typeof requestInput>;

export function classifyRequest(input: Pick<RequestInput, 'method' | 'url'>): Partial<ToolRisk> {
  const read = ['GET', 'HEAD', 'OPTIONS'].includes(input.method);
  const local = isLoopbackUrl(input.url);
  const production = /(?:^|[./-])(?:prod|production)(?:[./-]|$)/i.test(new URL(input.url).hostname);
  if (read) return { level: 1, reasons: [local ? 'Reads from a local server' : 'Reads from a remote service'], effects: local ? [] : ['network'] };
  if (local) return { level: 2, reasons: ['Sends a change to a local server'], effects: ['network'] };
  return { level: production ? 5 : 3, risk: production ? 'elevated' : 'normal', production, reasons: [production ? 'Changes a production service' : 'Changes a remote service'], effects: ['network', ...(production ? (['production'] as const) : [])] };
}

function matches(expected: Record<string, unknown>, actual: unknown): string[] {
  if (!actual || typeof actual !== 'object') return ['Response is not a JSON object'];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    const got = (actual as Record<string, unknown>)[key];
    if (JSON.stringify(got) !== JSON.stringify(value)) problems.push(`${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(got)?.slice(0, 200)}`);
  }
  return problems;
}

function assertions(input: RequestInput, status: number, text: string, json: unknown, latencyMs: number): string[] {
  const problems: string[] = [];
  const expected = input.expectStatus === undefined ? null : Array.isArray(input.expectStatus) ? input.expectStatus : [input.expectStatus];
  if (expected ? !expected.includes(status) : status >= 400) problems.push(`status ${status}${expected ? `, expected ${expected.join(' or ')}` : ''}`);
  if (input.expectJson) problems.push(...matches(input.expectJson, json));
  if (input.expectText && !text.includes(input.expectText)) problems.push(`body does not contain "${input.expectText}"`);
  if (input.maxLatencyMs && latencyMs > input.maxLatencyMs) problems.push(`took ${latencyMs}ms, limit ${input.maxLatencyMs}ms`);
  return problems;
}

async function authHeaders(input: RequestInput, ctx: OperationContext): Promise<Record<string, string> | OperationResult> {
  if (!input.auth) return {};
  const value = await ctx.credentials?.value(input.auth.credential);
  if (!value) return failure('AUTH_REQUIRED', `No stored credential named "${input.auth.credential}" is available to this task`);
  if (input.auth.scheme === 'header') return { [input.auth.header ?? 'x-api-key']: value };
  return { authorization: `${input.auth.scheme} ${input.auth.scheme === 'Basic' ? Buffer.from(value).toString('base64') : value}` };
}

function safeHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  for (const [k, v] of entries) out[k] = SENSITIVE_HEADER.test(k) ? '[REDACTED]' : redact(v);
  return out;
}

async function viaFetch(input: RequestInput, ctx: OperationContext): Promise<OperationResult> {
  const auth = await authHeaders(input, ctx);
  if ('ok' in auth && typeof auth.ok === 'boolean') return auth as OperationResult;
  const headers: Record<string, string> = { ...input.headers, ...(auth as Record<string, string>) };
  let body: BodyInit | undefined;
  if (input.json !== undefined) {
    body = JSON.stringify(input.json);
    headers['content-type'] ??= 'application/json';
  } else if (input.multipart) {
    const form = new FormData();
    for (const part of input.multipart) {
      if (part.file) {
        const file = resolveInside(ctx.roots, ctx.cwd, part.file);
        form.append(part.name, new Blob([await readFile(file)]), path.basename(file));
      } else form.append(part.name, part.value ?? '');
    }
    body = form;
  } else if (input.body !== undefined) body = input.body;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutSec * 1000);
  const onAbort = () => controller.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const started = performance.now();
  try {
    const res = await fetch(input.url, { method: input.method, headers, body, signal: controller.signal, redirect: 'follow' });
    const buffer = Buffer.from(await res.arrayBuffer());
    const latencyMs = Math.round(performance.now() - started);
    const text = buffer.toString('utf8');
    let json: unknown;
    if (/json/i.test(res.headers.get('content-type') ?? '')) {
      try {
        json = JSON.parse(text);
      } catch {
        /* declared JSON but is not */
      }
    }
    const problems = assertions(input, res.status, text, json, latencyMs);
    const shownBody = redact(text.length > 64 * 1024 ? `${text.slice(0, 64 * 1024)}\n[… ${text.length - 64 * 1024} more bytes]` : text);
    return {
      ok: problems.length === 0,
      summary: `${input.method} ${redact(input.url)} → ${res.status} in ${latencyMs}ms${problems.length ? ` · ${problems[0]}` : ''}`,
      output: { status: res.status, headers: safeHeaders(res.headers), body: shownBody, json: json === undefined ? undefined : JSON.parse(redact(JSON.stringify(json))), latencyMs, bytes: buffer.length, problems },
      evidence: [`${input.method} ${redact(input.url)} → ${res.status} (${latencyMs}ms)${problems.length ? ` · ${problems.join('; ')}` : ''}`],
      networkTargets: [new URL(input.url).host],
      ...(problems.length ? { error: { code: 'FAILED' as const, message: problems.join('; ') } } : {}),
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return failure(aborted ? (ctx.signal.aborted ? 'CANCELLED' : 'TIMEOUT') : 'FAILED', `${input.method} ${redact(input.url)} failed: ${aborted ? `no answer within ${input.timeoutSec}s` : redact((error as Error & { cause?: Error }).cause?.message ?? (error as Error).message)}`, {
      networkTargets: [new URL(input.url).host],
    });
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

async function viaCurl(input: RequestInput, ctx: OperationContext): Promise<OperationResult> {
  if (input.multipart) return failure('INVALID_INPUT', 'Multipart through curl is not supported; use the built-in HTTP provider');
  const exe = ctx.detection('curl')?.path ?? (process.platform === 'win32' ? 'curl.exe' : 'curl');
  const auth = await authHeaders(input, ctx);
  if ('ok' in auth && typeof auth.ok === 'boolean') return auth as OperationResult;
  // Headers (including brokered auth) go through stdin as a config file, never argv.
  const config = Object.entries({ ...input.headers, ...(auth as Record<string, string>), ...(input.json !== undefined ? { 'content-type': 'application/json' } : {}) })
    .map(([k, v]) => `header = "${k}: ${v.replace(/"/g, '\\"')}"`)
    .join('\n');
  const args = ['-sS', '-L', '-X', input.method, '--max-time', String(input.timeoutSec), '-K', '-', '-w', '\n%{http_code} %{time_total}', input.url];
  const data = input.json !== undefined ? JSON.stringify(input.json) : input.body;
  const r = await run(exe, data !== undefined ? [...args.slice(0, -1), '--data-binary', data, input.url] : args, { cwd: ctx.cwd, env: ctx.env, stdin: config, timeoutMs: (input.timeoutSec + 5) * 1000 });
  if (r.spawnError) return failure('NOT_INSTALLED', 'curl is not installed');
  const lines = r.stdout.split('\n');
  const [statusText, time] = (lines.pop() ?? '').split(' ');
  const status = Number(statusText);
  const text = lines.join('\n');
  if (r.code !== 0 || !status) return failure('FAILED', `curl failed: ${redact(r.stderr.trim()).slice(0, 300)}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const latencyMs = Math.round(Number(time) * 1000);
  const problems = assertions(input, status, text, json, latencyMs);
  return {
    ok: problems.length === 0,
    summary: `${input.method} ${redact(input.url)} → ${status} in ${latencyMs}ms (curl)`,
    output: { status, body: redact(text.slice(0, 64 * 1024)), latencyMs, problems },
    evidence: [`${input.method} ${redact(input.url)} → ${status} (${latencyMs}ms, curl)`],
    networkTargets: [new URL(input.url).host],
    ...(problems.length ? { error: { code: 'FAILED' as const, message: problems.join('; ') } } : {}),
  };
}

const healthInput = z.object({
  url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs'),
  expectStatus: z.number().int().optional(),
  timeoutSec: z.number().int().min(1).max(600).default(60),
  intervalMs: z.number().int().min(100).max(10_000).default(500),
});

/** Poll until a URL answers (any status below 500, or the expected one). */
export async function waitForHttp(url: string, opts: { timeoutMs: number; intervalMs?: number; expectStatus?: number; signal?: AbortSignal }): Promise<{ ok: boolean; status: number | null; attempts: number; elapsedMs: number; lastError: string | null }> {
  const started = Date.now();
  let attempts = 0;
  let lastError: string | null = null;
  let status: number | null = null;
  while (Date.now() - started < opts.timeoutMs && !opts.signal?.aborted) {
    attempts++;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(5000, opts.timeoutMs)), redirect: 'manual' });
      status = res.status;
      await res.arrayBuffer().catch(() => undefined);
      if (opts.expectStatus ? res.status === opts.expectStatus : res.status < 500) return { ok: true, status, attempts, elapsedMs: Date.now() - started, lastError: null };
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = (error as Error & { cause?: Error }).cause?.message ?? (error as Error).message;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 500));
  }
  return { ok: false, status, attempts, elapsedMs: Date.now() - started, lastError };
}

export function httpProviders(): ToolProvider[] {
  const request = (via: typeof viaFetch) =>
    operation({
      id: 'http.request',
      title: 'HTTP request',
      description: 'Send an HTTP request and check the answer (status, JSON fields, text, latency). Use `auth.credential` for stored secrets instead of pasting them.',
      input: requestInput,
      level: 1,
      classify: (input) => classifyRequest(input),
      credentials: [],
      run: (input, ctx) => via(input, ctx),
    });
  return [
    {
      id: 'http',
      name: 'HTTP (built-in)',
      description: "Node's fetch: requests, assertions, health checks.",
      category: 'http',
      builtin: true,
      preference: 10,
      async detect() {
        return builtinDetection(`Node ${process.versions.node}`);
      },
      operations: [
        request(viaFetch),
        operation({
          id: 'http.health',
          title: 'Wait until a URL is healthy',
          description: 'Poll a URL until it answers (status below 500, or the expected status) or the timeout passes.',
          input: healthInput,
          level: 1,
          classify: (input) => ({ effects: isLoopbackUrl(input.url) ? [] : ['network'] }),
          async run(input, ctx) {
            const r = await waitForHttp(input.url, { timeoutMs: input.timeoutSec * 1000, intervalMs: input.intervalMs, expectStatus: input.expectStatus, signal: ctx.signal });
            return {
              ok: r.ok,
              summary: r.ok ? `${redact(input.url)} healthy (HTTP ${r.status}) after ${r.elapsedMs}ms` : `${redact(input.url)} not healthy after ${Math.round(r.elapsedMs / 1000)}s: ${r.lastError}`,
              output: r,
              evidence: [`health ${redact(input.url)} → ${r.ok ? `HTTP ${r.status}` : `unhealthy (${r.lastError})`}`],
              ...(r.ok ? {} : { error: { code: 'FAILED' as const, message: r.lastError ?? 'unhealthy' } }),
            };
          },
        }),
      ],
    },
    {
      id: 'curl',
      name: 'curl',
      description: 'curl as the fallback HTTP client.',
      category: 'http',
      preference: 60,
      detect: (ctx) => detectExecutable(ctx, process.platform === 'win32' ? ['curl.exe', 'curl'] : ['curl']),
      operations: [request(viaCurl)],
    },
  ];
}
