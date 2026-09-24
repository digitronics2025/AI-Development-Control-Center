import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveShell } from '@acc/executor';
import { git } from '@acc/git';
import { builtinProviders, findBrowser, ToolHealthCache, ToolRegistry, ToolRouter, type OperationContext, type OperationResult } from '../src/index.js';

/**
 * Real tool calls against temporary folders, a real Git repository, a local
 * HTTP server and (when available) a real headless browser.
 */

const registry = new ToolRegistry();
for (const p of builtinProviders()) registry.register(p);
const router = new ToolRouter(registry);
const temp = mkdtempSync(path.join(os.tmpdir(), 'acc-tools-'));
const health = new ToolHealthCache(registry, () => ({ env: process.env, cwd: temp, shell: (k) => resolveShell(k), tempDir: temp }));

function ctx(cwd: string, extra: Partial<OperationContext> = {}): OperationContext {
  return {
    executionId: 'test',
    taskId: null,
    cwd,
    roots: [cwd],
    env: process.env,
    signal: new AbortController().signal,
    timeoutMs: 60_000,
    tempDir: path.join(temp, 'scratch'),
    stateDir: path.join(temp, 'state'),
    shell: (k) => resolveShell(k),
    detection: (id) => health.get(id),
    protectedPaths: [],
    ...extra,
  };
}

async function call(capability: string, input: unknown, context: OperationContext): Promise<OperationResult> {
  const decision = router.route({ capability, detection: (id) => health.get(id) });
  if (!decision.ok) throw new Error(decision.reason);
  const parsed = decision.route.operation.input.parse(input);
  return decision.route.operation.run(parsed, context);
}

let repo: string;
let server: http.Server;
let base: string;

beforeAll(async () => {
  await health.refresh({ ids: ['git', 'powershell', 'cmd', 'bash', 'windows', 'playwright', 'node', 'curl'] });
  repo = path.join(temp, 'repo');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const answer = 41;\n');
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', 'init']]) {
    const r = await git(repo, args);
    if (r.code !== 0) throw new Error(r.stderr);
  }
  server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', version: 2 }));
    } else if (req.url === '/broken') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Broken</title><script>console.error("boom from page"); fetch("/missing.json")</script><h1>Broken</h1>');
    } else if (req.url === '/missing.json') {
      res.statusCode = 404;
      res.end('nope');
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Fixture</title></head><body><h1>Hello</h1><button id="b" onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>clicked</p>\')">Go</button></body></html>');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('filesystem pack', () => {
  it('reads, writes, patches, searches and globs inside the root', async () => {
    const c = ctx(repo);
    expect((await call('fs.write', { path: 'src/new.ts', content: 'export const x = 1;\n' }, c)).filesChanged).toEqual(['src/new.ts']);
    expect(await call('fs.patch', { path: 'src/app.ts', find: '41', replace: '42' }, c)).toMatchObject({ ok: true });
    expect(readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toContain('42');
    expect((await call('fs.read', { path: 'src/app.ts' }, c)).output).toMatchObject({ content: 'export const answer = 42;\n' });
    expect(((await call('fs.search', { query: 'answer' }, c)).output as any).matches[0]).toMatchObject({ path: 'src/app.ts', line: 1 });
    expect(((await call('fs.glob', { pattern: 'src/**/*.ts' }, c)).output as any).files).toEqual(['src/app.ts', 'src/new.ts']);
    expect(await call('fs.patch', { path: 'src/app.ts', find: 'nothing-here', replace: 'x' }, c)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('refuses paths outside the root, including through a link', async () => {
    const c = ctx(repo);
    expect(await call('fs.read', { path: '../../etc/hosts' }, c)).toMatchObject({ ok: false, error: { code: 'OUTSIDE_ROOT' } });
    const outside = path.join(temp, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'x');
    try {
      symlinkSync(outside, path.join(repo, 'link'), 'junction');
      expect(await call('fs.read', { path: 'link/secret.txt' }, c)).toMatchObject({ ok: false, error: { code: 'OUTSIDE_ROOT' } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  it('protects the user’s own uncommitted files', async () => {
    const c = ctx(repo, { protectedPaths: ['README.md'] });
    expect(await call('fs.write', { path: 'README.md', content: 'x' }, c)).toMatchObject({ ok: false, error: { code: 'PROTECTED_PATH' } });
    expect(await call('fs.delete', { path: 'README.md' }, c)).toMatchObject({ ok: false, error: { code: 'PROTECTED_PATH' } });
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# fixture\n');
  });
});

describe('git pack', () => {
  it('reports status, diff and log; commits only listed paths; refuses protected ones', async () => {
    const c = ctx(repo);
    const status = await call('git.status', {}, c);
    expect(status.ok).toBe(true);
    expect(status.summary).toMatch(/On main/);
    expect((await call('git.diff', { paths: ['src/app.ts'] }, c)).stdout).toContain('+export const answer = 42;');
    const commit = await call('git.commit', { paths: ['src/app.ts'], message: 'bump answer' }, c);
    expect(commit.ok).toBe(true);
    expect(((await call('git.log', { limit: 5 }, c)).output as any).commits[0].subject).toBe('bump answer');
    expect(await call('git.commit', { paths: ['README.md'], message: 'nope' }, ctx(repo, { protectedPaths: ['README.md'] }))).toMatchObject({ error: { code: 'PROTECTED_PATH' } });
    expect(await call('git.restore', { paths: ['.'] }, c)).toMatchObject({ ok: false });
  });

  it('bisects in a temporary worktree without touching the working tree', async () => {
    const c = ctx(repo);
    const good = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    writeFileSync(path.join(repo, 'flag.txt'), 'bad\n');
    await git(repo, ['add', 'flag.txt']);
    await git(repo, ['commit', '-m', 'introduce bad flag']);
    const bad = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    writeFileSync(path.join(repo, 'wip.txt'), 'uncommitted');
    const command = process.platform === 'win32' ? 'if exist flag.txt (exit 1) else (exit 0)' : 'test ! -f flag.txt';
    const r = await call('git.bisect', { good, bad, command }, c);
    expect(r.ok, JSON.stringify(r).slice(0, 3000)).toBe(true);
    expect((r.output as any).firstBadCommit).toBe(bad);
    expect(readFileSync(path.join(repo, 'wip.txt'), 'utf8')).toBe('uncommitted');
    expect((await git(repo, ['worktree', 'list'])).stdout.trim().split('\n')).toHaveLength(1);
  }, 60_000);

  it('searches several commits and tests each one at most once', async () => {
    const c = ctx(repo);
    const commit = async (file: string, message: string) => {
      writeFileSync(path.join(repo, file), message);
      await git(repo, ['add', file]);
      await git(repo, ['commit', '-m', message]);
      return (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    };
    const good = await commit('a.txt', 'one');
    await commit('b.txt', 'two');
    const culprit = await commit('broken.txt', 'three breaks it');
    await commit('c.txt', 'four');
    const bad = await commit('d.txt', 'five');
    const command = process.platform === 'win32' ? 'if exist broken.txt (exit 1) else (exit 0)' : 'test ! -f broken.txt';
    const r = await call('git.bisect', { good, bad, command }, c);
    expect(r.ok, JSON.stringify(r).slice(0, 2000)).toBe(true);
    expect((r.output as any).firstBadCommit).toBe(culprit);
    const tested = ((r.output as any).steps as string[]).map((s) => s.split(' ')[0]);
    expect(new Set(tested).size).toBe(tested.length);
    expect(tested.length).toBeLessThanOrEqual(3);
  }, 60_000);
});

describe('shell pack', () => {
  it('routes shell.run to PowerShell on Windows and honours an explicit shell', async () => {
    const c = ctx(repo);
    const r = await call('shell.run', { script: 'Write-Output ("sum=" + (2 + 3))' }, c);
    if (process.platform === 'win32') expect(r.stdout).toBe('sum=5');
    const decision = router.route({ capability: 'shell.run', detection: (id) => health.get(id), prefer: 'bash' });
    expect(decision.ok && decision.route.provider.id).toBe(health.get('bash')?.installed ? 'bash' : decision.ok && decision.route.provider.id);
  });

  it('classifies scripts before they run', () => {
    const op = registry.offering('shell.powershell')[0]!.operation;
    expect(op.classify!({ script: 'Remove-Item -Recurse -Force C:\\x' }, { cwd: repo })).toMatchObject({ risk: 'dangerous', level: 5 });
    expect(op.classify!({ script: 'Get-ChildItem' }, { cwd: repo })).toMatchObject({ level: 1 });
  });
});

describe('http and network packs', () => {
  it('sends requests with assertions and reports latency', async () => {
    const c = ctx(repo);
    const ok = await call('http.request', { url: `${base}/api/health`, expectStatus: 200, expectJson: { status: 'ok' } }, c);
    expect(ok.ok).toBe(true);
    expect((ok.output as any).latencyMs).toBeGreaterThanOrEqual(0);
    const bad = await call('http.request', { url: `${base}/api/health`, expectJson: { status: 'down' } }, c);
    expect(bad.ok).toBe(false);
    expect(bad.summary).toMatch(/status: expected "down"/);
    expect(await call('http.health', { url: `${base}/api/health`, timeoutSec: 5 }, c)).toMatchObject({ ok: true });
  });

  it('checks TCP reachability and finds who owns a port', async () => {
    const c = ctx(repo);
    const port = (server.address() as { port: number }).port;
    expect(await call('network.tcp_check', { port }, c)).toMatchObject({ ok: true });
    const owner = await call('network.port_owner', { port }, c);
    expect(owner.ok).toBe(true);
    expect(JSON.stringify(owner.output)).toContain(String(process.pid));
  }, 60_000);
});

describe('sqlite pack', () => {
  it('queries read-only, backs up before changes, and checks integrity', async () => {
    const Database = (await import('better-sqlite3')).default;
    const file = path.join(repo, 'data.db');
    const db = new Database(file);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES (\'a\'), (\'b\');');
    db.close();
    const c = ctx(repo);
    expect(((await call('database.sqlite_query', { file: 'data.db', sql: 'SELECT name FROM t ORDER BY id' }, c)).output as any).rows).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(await call('database.sqlite_query', { file: 'data.db', sql: 'DELETE FROM t' }, c)).toMatchObject({ ok: false });
    const change = await call('database.sqlite_execute', { file: 'data.db', sql: "UPDATE t SET name = 'c' WHERE id = 1" }, c);
    expect(change.ok).toBe(true);
    expect(existsSync((change.output as any).backup)).toBe(true);
    expect(await call('database.sqlite_integrity', { file: 'data.db' }, c)).toMatchObject({ ok: true });
    const op = registry.offering('database.sqlite_execute')[0]!.operation;
    expect(op.classify!({ file: 'data.db', sql: 'DROP TABLE t' }, { cwd: repo })).toMatchObject({ risk: 'dangerous' });
  });
});

const browser = await findBrowser();

describe.skipIf(!browser)('browser pack (real Chromium)', () => {
  it('passes a clean page and reports console errors and failed requests on a broken one', async () => {
    const c = ctx(repo);
    const clean = await call('browser.check_page', { url: `${base}/`, screenshot: false }, c);
    expect(clean.ok).toBe(true);
    expect(clean.evidence).toHaveLength(2);
    const broken = await call('browser.check_page', { url: `${base}/broken`, viewports: ['desktop'], screenshot: false }, c);
    expect(broken.ok).toBe(false);
    const problems = (broken.output as any).problems.join('\n');
    expect(problems).toMatch(/console error: boom from page/);
    expect(problems).toMatch(/missing\.json 404/);
  }, 90_000);

  it('runs a flow and captures a screenshot to the scratch folder', async () => {
    const c = ctx(repo);
    const r = await call('browser.run_flow', { url: `${base}/`, steps: [{ action: 'click', selector: '#b' }, { action: 'expect_text', text: 'clicked' }, { action: 'screenshot', name: 'after-click' }] }, c);
    expect(r.ok).toBe(true);
    expect(existsSync(r.artifacts![0]!.id)).toBe(true);
    const failing = await call('browser.run_flow', { url: `${base}/`, steps: [{ action: 'expect_text', text: 'never there' }] }, c);
    expect(failing).toMatchObject({ ok: false });
    expect(failing.summary).toMatch(/step 1/);
  }, 90_000);
});

describe('credential and secret packs without a broker', () => {
  it('refuse cleanly when the session has no credential host', async () => {
    const generate = await call('credential.generate', { name: 'NO_HOST' }, ctx(repo));
    expect(generate.error?.code).toBe('UNAVAILABLE');
    // Called on the provider directly: routing would first require Wrangler on this machine.
    const secretPut = registry.provider('wrangler')!.operations.find((o) => o.id === 'cloudflare.secret_put')!;
    const input = secretPut.input.parse({ credential: 'X', secretName: 'Y', environment: 'staging' });
    const put = await secretPut.run(input, ctx(repo));
    expect(put.error?.code).toBe('UNAVAILABLE');
    // A gate from the broker stops the call before Wrangler runs; the value is never asked for.
    let asked = false;
    const gated = await secretPut.run(input, ctx(repo, { credentials: { value: async () => { asked = true; return 'v'; }, envFor: async () => ({}), deployGate: async () => 'held for MyVault' } }));
    expect(gated).toMatchObject({ ok: false, summary: 'held for MyVault' });
    expect(asked).toBe(false);
  });
});

describe('cloudflare past logs', () => {
  it('reads defaults from the Wrangler config and prints one line per event', async () => {
    const { wranglerConfigValue, logLine } = await import('../src/packs/cloudflare.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-wrangler-'));
    writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "shop-api"\naccount_id = "0123456789abcdef0123456789abcdef"\n');
    expect(wranglerConfigValue(dir, 'name')).toBe('shop-api');
    expect(wranglerConfigValue(dir, 'account_id')).toBe('0123456789abcdef0123456789abcdef');
    const json = mkdtempSync(path.join(os.tmpdir(), 'acc-wrangler-'));
    writeFileSync(path.join(json, 'wrangler.jsonc'), '{\n  // comment\n  "name": "shop-web"\n}\n');
    expect(wranglerConfigValue(json, 'name')).toBe('shop-web');
    expect(wranglerConfigValue(temp, 'name')).toBeNull();
    expect(logLine({ timestamp: Date.UTC(2026, 8, 24, 13, 8), $metadata: { service: 'shop-api', level: 'error', trigger: 'GET /orders', error: 'boom\n  at x' }, $workers: { event: { response: { status: 500 } } } })).toBe('2026-09-24T13:08:00Z [error] shop-api GET /orders → 500 :: boom at x');
    expect(logLine({ source: { message: 'hello' } })).toBe('? [info] ? :: hello');
  });

  it('asks for a token instead of failing obscurely', async () => {
    const op = registry.provider('wrangler')!.operations.find((o) => o.id === 'cloudflare.logs_query')!;
    const r = await op.run(op.input.parse({}), ctx(repo, { env: {} }));
    expect(r.error?.code).toBe('AUTH_REQUIRED');
  });
});
