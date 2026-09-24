import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveShell } from '@acc/executor';
import { builtinProviders, classifySql, decide, limitReadSql, resetCloudflareCatalog, strictReadSql, ToolRegistry, type OperationContext, type OperationResult, type ToolRisk } from '../src/index.js';

/**
 * Read-only data (docs/plans/ASK_READ_ONLY_DATA_PLAN.md): the strict SQL
 * check, the read-only policy branch, and the Cloudflare and GitHub read
 * packs against a local stand-in for both APIs.
 */

const registry = new ToolRegistry();
for (const p of builtinProviders()) registry.register(p);

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const D1 = { uuid: 'db-uuid-1', name: 'orders-prod' };

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: any;
}
let seen: Seen[] = [];
let server: http.Server;
let base: string;
let failNext: { status: number; times: number } | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      if (failNext && failNext.times > 0) {
        failNext.times -= 1;
        res.writeHead(failNext.status, { 'content-type': 'application/json', 'retry-after': '0' });
        return res.end(JSON.stringify({ success: false, errors: [{ message: 'nope' }] }));
      }
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(value));
      };
      const u = new URL(req.url!, 'http://x');
      const cf = `/cf/accounts/${ACCOUNT}`;
      if (u.pathname === `${cf}/d1/database`) return json(200, { success: true, result: [{ uuid: D1.uuid, name: D1.name, file_size: 4096, num_tables: 2 }], result_info: { total_pages: 1 } });
      if (u.pathname === `${cf}/storage/kv/namespaces`) return json(200, { success: true, result: [{ id: 'kv1', title: 'SESSIONS' }], result_info: { total_pages: 1 } });
      if (u.pathname === `${cf}/r2/buckets`) return json(200, { success: true, result: { buckets: [{ name: 'backups', creation_date: '2026-01-01' }] } });
      if (u.pathname === `${cf}/workers/scripts`) return json(200, { success: true, result: [{ id: 'shop-api', modified_on: '2026-09-01' }], result_info: { total_pages: 1 } });
      if (u.pathname === `${cf}/d1/database/${D1.uuid}/query`) {
        return json(200, { success: true, result: [{ success: true, results: [{ id: 1, email: 'amina@example.com', total: 12.5 }, { id: 2, email: 'omar@example.com', total: 7 }], meta: { rows_read: 2, duration: 0.4 } }] });
      }
      if (u.pathname === `${cf}/storage/kv/namespaces/kv1/values/config`) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('{"mode":"live"}');
      }
      if (u.pathname === `${cf}/r2/buckets/backups/objects`) return json(200, { success: true, result: [{ key: '2026-09-24/acc.db', size: 2580480, last_modified: '2026-09-24T20:48:00Z' }], result_info: { cursor: 'next' } });
      if (u.pathname === `${cf}/r2/buckets/backups/objects/2026-09-24/acc.db`) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '11' });
        return res.end(Buffer.from('SQLite\u0000abcd'));
      }
      // GitHub
      const scopes: Record<string, string> = req.headers.authorization === 'Bearer classic-write' ? { 'x-oauth-scopes': 'repo, read:org' } : {};
      if (u.pathname === '/gh/user/repos') return json(200, [{ full_name: 'digitronics2025/shop', private: true, default_branch: 'main', pushed_at: '2026-09-24' }, { full_name: 'someone-else/tool', private: false, default_branch: 'main' }], scopes);
      if (u.pathname === '/gh/repos/digitronics2025/shop/contents/README.md') return json(200, { type: 'file', size: 13, encoding: 'base64', content: Buffer.from('# Shop\nHello\n').toString('base64'), sha: 'abc' }, scopes);
      if (u.pathname === '/gh/repos/digitronics2025/shop/actions/runs/7') return json(200, { id: 7, name: 'CI', head_branch: 'main', head_sha: 'deadbeef', status: 'completed', conclusion: 'failure' });
      if (u.pathname === '/gh/repos/digitronics2025/shop/actions/runs/7/jobs') return json(200, { jobs: [{ id: 70, name: 'test', conclusion: 'failure', steps: [{ name: 'pnpm test', conclusion: 'failure' }] }] });
      if (u.pathname === '/gh/repos/digitronics2025/shop/actions/jobs/70/logs') {
        res.writeHead(302, { location: `${base}/blob/log70` });
        return res.end();
      }
      if (u.pathname === '/blob/log70') {
        // The token must not follow the redirect to blob storage.
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`${req.headers.authorization ? 'LEAKED TOKEN\n' : ''}2026-09-24T10:00:00.0000000Z line one\n2026-09-24T10:00:01.0000000Z Error: expected 41 to be 42\n`);
      }
      json(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  seen = [];
  failNext = null;
  resetCloudflareCatalog();
});

function ctx(env: Record<string, string>): OperationContext {
  const tmp = os.tmpdir();
  return {
    executionId: 'test',
    taskId: null,
    cwd: tmp,
    roots: [tmp],
    env: { ACC_CF_API_BASE: `${base}/cf`, ACC_GITHUB_API_BASE: `${base}/gh`, ...env },
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    tempDir: tmp,
    stateDir: tmp,
    shell: (k) => resolveShell(k),
    detection: () => undefined,
    protectedPaths: [],
  };
}

const cfEnv = { CLOUDFLARE_API_TOKEN: 'cf-read', CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
const ghEnv = { GH_TOKEN: 'gh-read', ACC_GITHUB_OWNERS: 'digitronics2025', ACC_READ_ONLY: '1' };

async function call(capability: string, input: unknown, env: Record<string, string>): Promise<OperationResult> {
  const op = registry.offering(capability)[0]!.operation;
  return op.run(op.input.parse(input), ctx(env));
}

describe('strict read-only SQL', () => {
  it.each([
    ['SELECT COUNT(*) FROM orders', true],
    ['select * from orders where total > 10;', true],
    ['WITH t AS (SELECT 1 AS n) SELECT n FROM t', true],
    ['EXPLAIN QUERY PLAN SELECT * FROM orders', true],
    ['PRAGMA table_info(orders)', true],
    ["SELECT replace(name, 'a', 'b') FROM t", true],
    ['SELECT 1; DELETE FROM orders', false],
    ['SELECT 1; SELECT 2', false],
    ['DELETE FROM orders WHERE id = 1', false],
    ['INSERT INTO t VALUES (1)', false],
    ['WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', false],
    ['UPDATE t SET a = 1 WHERE id = 2', false],
    ['REPLACE INTO t VALUES (1)', false],
    ['PRAGMA writable_schema(1)', false],
    ['PRAGMA journal_mode = WAL', false],
    ["ATTACH DATABASE 'x.db' AS x", false],
    ['VACUUM', false],
    ['CREATE TABLE x (a)', false],
    ['SELECT * FROM t /* ; DROP TABLE t */', true],
    ['-- a comment\nSELECT 1', true],
    ['', false],
  ])('%s → %s', (sql, ok) => {
    expect(strictReadSql(sql).ok).toBe(ok);
  });

  it('wraps a read in a row limit, and leaves EXPLAIN and PRAGMA alone', () => {
    expect(limitReadSql('SELECT * FROM t', 100)).toBe('SELECT * FROM (SELECT * FROM t) LIMIT 101');
    expect(limitReadSql('PRAGMA table_info(t)', 100)).toBe('PRAGMA table_info(t)');
  });

  it('classifySql no longer calls a settings PRAGMA a read, and catches DROP TRIGGER', () => {
    expect(classifySql('PRAGMA writable_schema(1)').readOnly).toBe(false);
    expect(classifySql('PRAGMA table_info(t)').readOnly).toBe(true);
    expect(classifySql('PRAGMA integrity_check').readOnly).toBe(true);
    expect(classifySql('DROP TRIGGER audit').destructive).toBe(true);
  });
});

describe('read-only policy', () => {
  const risk = (over: Partial<ToolRisk> = {}): ToolRisk => ({ level: 4, risk: 'normal', reasons: ['Reads production'], effects: ['production'], production: false, ...over });
  const input = { mode: 'safe' as const, autoApproveUpToLevel: 1 as const, stageLevel: 1 as const, inProfile: false, origin: 'agent' as const };

  it('allows an allow-listed read at any level, production included', () => {
    expect(decide({ ...input, risk: risk({ writes: false }), readOnly: { allowed: true } }).decision).toBe('allow');
    expect(decide({ ...input, risk: risk({ writes: false, level: 2 }), readOnly: { allowed: true } }).decision).toBe('allow');
  });

  it('denies — never escalates — anything off the list, not declared a read, or dangerous', () => {
    expect(decide({ ...input, risk: risk({ writes: false, level: 1 }), readOnly: { allowed: false } }).decision).toBe('deny');
    expect(decide({ ...input, risk: risk({ level: 1 }), readOnly: { allowed: true } }).decision).toBe('deny');
    expect(decide({ ...input, risk: risk({ writes: true, level: 1 }), readOnly: { allowed: true } }).decision).toBe('deny');
    expect(decide({ ...input, risk: risk({ writes: false, risk: 'dangerous' }), readOnly: { allowed: true } }).decision).toBe('deny');
  });

  it('leaves normal scopes as they were', () => {
    expect(decide({ ...input, risk: risk({ level: 1, effects: [] }) }).decision).toBe('escalate');
    expect(decide({ ...input, risk: risk({ level: 2, effects: [] }) }).decision).toBe('deny');
  });

  it('every new read capability declares itself read-only', () => {
    const ids = ['cloudflare.catalog', 'cloudflare.d1_schema', 'cloudflare.d1_read', 'cloudflare.kv_keys', 'cloudflare.kv_get', 'cloudflare.r2_list', 'cloudflare.r2_get', 'cloudflare.logs_query', 'github.repos', 'github.file_read', 'github.commits', 'github.code_search', 'github.pulls', 'github.issues', 'github.runs'];
    for (const id of ids) {
      const offering = registry.offering(id);
      expect(offering.length, id).toBeGreaterThan(0);
      for (const o of offering) expect(o.operation.readOnly, id).toBe(true);
    }
    // Writers stay writers.
    for (const id of ['cloudflare.d1_query', 'cloudflare.deploy', 'github.pr_create', 'github.secret_put']) expect(registry.offering(id)[0]!.operation.readOnly, id).toBeFalsy();
  });
});

describe('Cloudflare read pack', () => {
  it('needs a token and an account id; never falls back to a login', async () => {
    expect((await call('cloudflare.catalog', {}, {})).error?.code).toBe('AUTH_REQUIRED');
    expect((await call('cloudflare.catalog', {}, { CLOUDFLARE_API_TOKEN: 't' })).error?.code).toBe('AUTH_REQUIRED');
    expect(seen).toHaveLength(0);
  });

  it('lists the account’s data stores with the token', async () => {
    const r = await call('cloudflare.catalog', {}, cfEnv);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('1 D1 database(s), 1 KV namespace(s), 1 R2 bucket(s), 1 Worker(s)');
    expect(seen.every((s) => s.auth === 'Bearer cf-read' && s.method === 'GET')).toBe(true);
  });

  it('reads D1 by name with the query wrapped in a limit', async () => {
    const r = await call('cloudflare.d1_read', { database: 'orders-prod', sql: 'SELECT * FROM orders', limit: 1 }, cfEnv);
    expect(r.ok).toBe(true);
    const q = seen.find((s) => s.url.endsWith('/query'))!;
    expect(q.method).toBe('POST');
    expect(q.body).toEqual({ sql: 'SELECT * FROM (SELECT * FROM orders) LIMIT 2' });
    expect(r.output).toMatchObject({ database: 'orders-prod', truncated: true, rowsRead: 2 });
    expect((r.output as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('refuses a write before any request', async () => {
    const r = await call('cloudflare.d1_read', { database: 'orders-prod', sql: 'DELETE FROM orders' }, cfEnv);
    expect(r.error?.code).toBe('INVALID_INPUT');
    expect(seen).toHaveLength(0);
  });

  it('names the known databases when one is not found', async () => {
    const r = await call('cloudflare.d1_read', { database: 'nope', sql: 'SELECT 1' }, cfEnv);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Known: orders-prod');
  });

  it('retries once on a rate limit, then reports it', async () => {
    failNext = { status: 429, times: 1 };
    expect((await call('cloudflare.kv_get', { namespace: 'SESSIONS', key: 'config' }, cfEnv)).ok).toBe(true);
    resetCloudflareCatalog();
    failNext = { status: 503, times: 10 };
    const r = await call('cloudflare.catalog', {}, cfEnv);
    expect(r.ok).toBe(false);
  });

  it('reads KV text and R2 listings; binary objects report size only', async () => {
    const kv = await call('cloudflare.kv_get', { namespace: 'SESSIONS', key: 'config' }, cfEnv);
    expect((kv.output as { text: string }).text).toBe('{"mode":"live"}');
    const list = await call('cloudflare.r2_list', { bucket: 'backups' }, cfEnv);
    expect(list.summary).toBe('R2 backups: 1+ object(s)');
    const obj = await call('cloudflare.r2_get', { bucket: 'backups', key: '2026-09-24/acc.db' }, cfEnv);
    expect(obj.ok).toBe(true);
    expect((obj.output as { text: string | null }).text).toBeNull();
    expect(seen.some((s) => s.url.includes('/objects/2026-09-24/acc.db'))).toBe(true);
  });

  it('turns a refusal into a plain auth message', async () => {
    failNext = { status: 403, times: 10 };
    const r = await call('cloudflare.catalog', {}, cfEnv);
    expect(r.error?.code).toBe('AUTH_REQUIRED');
  });
});

describe('GitHub read pack', () => {
  it('refuses an owner outside the allow-list without a request', async () => {
    const r = await call('github.file_read', { repo: 'someone-else/tool', path: 'README.md' }, ghEnv);
    expect(r.error?.code).toBe('DENIED');
    expect(seen).toHaveLength(0);
  });

  it('lists only allowed owners’ repositories and reads a file at the default branch', async () => {
    const repos = await call('github.repos', {}, ghEnv);
    expect((repos.output as { repos: Array<{ repo: string }> }).repos.map((r) => r.repo)).toEqual(['digitronics2025/shop']);
    const file = await call('github.file_read', { repo: 'digitronics2025/shop', path: 'README.md' }, ghEnv);
    expect((file.output as { text: string }).text).toBe('# Shop\nHello\n');
    expect(seen.every((s) => s.auth === 'Bearer gh-read')).toBe(true);
  });

  it('refuses a classic token that can write, in a read-only session', async () => {
    const r = await call('github.repos', {}, { ...ghEnv, GH_TOKEN: 'classic-write' });
    expect(r.error?.code).toBe('DENIED');
    expect(r.summary).toContain('can change repositories');
    // Outside a read-only session the same key is only reading, and allowed.
    expect((await call('github.repos', {}, { ...ghEnv, GH_TOKEN: 'classic-write', ACC_READ_ONLY: '' })).ok).toBe(true);
  });

  it('gives a failed run’s job log tail without sending the token to blob storage', async () => {
    const r = await call('github.runs', { repo: 'digitronics2025/shop', runId: 7 }, ghEnv);
    expect(r.ok).toBe(true);
    const job = (r.output as { jobs: Array<{ logTail: string; failedSteps: string[] }> }).jobs[0]!;
    expect(job.failedSteps).toEqual(['pnpm test']);
    expect(job.logTail).toContain('Error: expected 41 to be 42');
    expect(job.logTail).not.toContain('LEAKED TOKEN');
  });

  it('needs its own token', async () => {
    expect((await call('github.repos', {}, { ACC_GITHUB_OWNERS: 'x' })).error?.code).toBe('AUTH_REQUIRED');
  });

  it('only a loopback address can stand in for the API', async () => {
    const { apiBase } = await import('../src/packs/rest.js');
    expect(apiBase({ env: { X: 'http://127.0.0.1:9/api' } }, 'https://real', 'X')).toBe('http://127.0.0.1:9/api');
    expect(apiBase({ env: { X: 'https://evil.example.com' } }, 'https://real', 'X')).toBe('https://real');
  });
});

describe('cloudflare.d1_query (Wrangler) large results', () => {
  it('returns every row of a large pretty-printed result instead of reporting 0 rows', async () => {
    // A stand-in wrangler that prints 3000 rows as pretty JSON: about 15,000 lines.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-d1-'));
    mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    const script = path.join(dir, 'fake-wrangler.js');
    writeFileSync(script, "const rows = Array.from({ length: 3000 }, (_, i) => ({ id: i, name: 'row ' + i, total: i * 2 }));\nprocess.stdout.write(JSON.stringify([{ results: rows, meta: { rows_read: 3000 } }], null, 2));\n");
    const bin = path.join(dir, 'node_modules', '.bin', 'wrangler');
    if (process.platform === 'win32') writeFileSync(`${bin}.cmd`, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    else writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    const op = registry.offering('cloudflare.d1_query')[0]!.operation;
    const c = { ...ctx({}), cwd: dir, roots: [dir] };
    const r = await op.run(op.input.parse({ database: 'orders', sql: 'SELECT * FROM orders', environment: 'local' }), c);
    expect(r.summary).toBe('3000 row(s) from orders (local)');
    expect(r.ok).toBe(true);
    expect((r.output as { results: unknown[] }).results).toHaveLength(500);
  }, 60_000);
});
