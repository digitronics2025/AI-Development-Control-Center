import { describe, expect, it } from 'vitest';
import { builtinProviders, decide, type ToolOperation } from '../src/index.js';

/**
 * Regression tests for the 2026-09-24 pre-release audit
 * (docs/security/prerelease-audit-2026-09-24.md). Each test names its finding.
 */

function op(id: string): ToolOperation {
  const found = builtinProviders()
    .flatMap((p) => p.operations)
    .find((o) => o.id === id);
  if (!found) throw new Error(`no operation ${id}`);
  return found as ToolOperation;
}

function risk(id: string, input: unknown) {
  const o = op(id);
  const parsed = o.input.parse(input);
  return { level: o.level, risk: 'normal' as const, reasons: [], effects: [], production: false, ...o.classify?.(parsed, { cwd: process.cwd(), isTaskOwnedPid: () => false }) };
}

const agentAt = (r: ReturnType<typeof risk>, stageLevel: 1 | 2 | 3 | 4 = 2) =>
  decide({ risk: r, mode: 'full', autoApproveUpToLevel: 4, stageLevel, inProfile: true, origin: 'agent' }).decision;

describe('F-04: verify.web classifies its start command', () => {
  it('rates a harmless dev server at Level 2 and a destructive one like the command itself', () => {
    expect(risk('verify.web', { url: 'http://127.0.0.1:5173', startCommand: 'pnpm dev' }).level).toBe(2);
    const bad = risk('verify.web', { url: 'http://127.0.0.1:5173', startCommand: 'git push --force origin main' });
    expect(bad.level).toBe(5);
    expect(agentAt(bad)).toBe('deny');
    const deploy = risk('verify.web', { url: 'http://127.0.0.1:5173', startCommand: 'npx wrangler deploy --env production' });
    expect(deploy.production).toBe(true);
    expect(agentAt(deploy)).toBe('deny');
  });

  it('stays Level 1 with no start command', () => {
    expect(risk('verify.web', { url: 'http://127.0.0.1:5173' }).level).toBe(1);
  });
});

describe('F-05: git.stage / git.commit / git.restore never touch the user\'s pre-existing work', () => {
  it('refuses a folder, parent, absolute or whole-tree pathspec that covers a protected file, and treats globs literally', async () => {
    const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { git } = await import('@acc/git');
    const repo = mkdtempSync(path.join(os.tmpdir(), 'acc-f05-'));
    const sh = async (...args: string[]) => {
      const r = await git(repo, args);
      if (r.code !== 0) throw new Error(r.stderr);
    };
    await sh('init', '-b', 'main');
    await sh('config', 'user.email', 't@example.com');
    await sh('config', 'user.name', 'T');
    await sh('config', 'commit.gpgsign', 'false');
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'committed\n');
    writeFileSync(path.join(repo, 'src', 'task.ts'), 'committed\n');
    await sh('add', '.');
    await sh('commit', '-m', 'init');
    // The user's own edit before the task started, and a task edit next to it.
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'user work\n');
    writeFileSync(path.join(repo, 'src', 'task.ts'), 'task work\n');
    const ctx = {
      executionId: 't', taskId: null, cwd: repo, roots: [repo], env: process.env, signal: new AbortController().signal, timeoutMs: 60_000,
      tempDir: os.tmpdir(), stateDir: os.tmpdir(), shell: async () => null, detection: () => undefined, protectedPaths: ['src/app.ts'],
    } as never;
    const run = (id: string, input: unknown) => op(id).run(op(id).input.parse(input), ctx);
    for (const paths of [['src'], ['src/'], ['./src'], ['SRC/App.ts'].filter(() => process.platform === 'win32'), [path.join(repo, 'src')], ['.'], ['src/../src']].filter((p) => p.length)) {
      expect((await run('git.restore', { paths })).error?.code, JSON.stringify(paths)).toBe('PROTECTED_PATH');
      expect((await run('git.commit', { paths, message: 'nope' })).error?.code, JSON.stringify(paths)).toBe('PROTECTED_PATH');
      expect((await run('git.stage', { paths })).error?.code, JSON.stringify(paths)).toBe('PROTECTED_PATH');
    }
    // A glob is a literal name: it matches nothing and discards nothing.
    expect((await run('git.restore', { paths: ['src/*.ts'] })).ok).toBe(false);
    expect(readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe('user work\n');
    // The task's own file still works.
    expect((await run('git.commit', { paths: ['src/task.ts'], message: 'task change' })).ok).toBe(true);
    expect(readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe('user work\n');
  });
});

describe('F-16: the Postgres password never reaches psql argv', () => {
  it('turns a URL into libpq variables and keeps nothing secret for -d', async () => {
    const { postgresEnv } = await import('../src/packs/database.js');
    const pw = ['s3cr', 'et/+ x'].join('');
    const url = `postgresql://app%40user:${encodeURIComponent(pw)}@db.example.com:6543/shop%20db?sslmode=require`;
    expect(postgresEnv(url)).toEqual({ env: { PGHOST: 'db.example.com', PGPORT: '6543', PGUSER: 'app@user', PGPASSWORD: pw, PGDATABASE: 'shop db', PGSSLMODE: 'require' }, dbname: null });
  });

  it('takes the password out of the key=value form', async () => {
    const { postgresEnv } = await import('../src/packs/database.js');
    const r = postgresEnv(["host=h dbname=d user=u password='it", "s x' port=5"].join(''));
    expect(r.env).toEqual({ PGPASSWORD: 'its x' });
    expect(r.dbname).toBe('host=h dbname=d user=u port=5');
    expect(r.dbname).not.toContain('its');
  });
});

describe('F-31: redirects are judged hop by hop, bodies are capped', () => {
  it('follows a same-origin redirect, reports a cross-origin one, refuses one into the Control Center', async () => {
    const http = await import('node:http');
    const { guardedFetch, readCapped, RedirectRefused } = await import('../src/net-guard.js');
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === '/same') return res.writeHead(307, { location: '/landed' }).end();
      if (req.url === '/see-other') return res.writeHead(303, { location: '/landed' }).end();
      if (req.url === '/away') return res.writeHead(302, { location: 'http://localhost:9/elsewhere' }).end();
      if (req.url === '/self') return res.writeHead(302, { location: 'http://127.0.0.1:4317/' }).end();
      if (req.url === '/big') return res.end(Buffer.alloc(3000, 97));
      res.end(`ok ${req.method}`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const same = await guardedFetch(`${base}/same`, { method: 'POST', body: 'x' }, { crossOrigin: 'stop' });
      expect(await same.res.text()).toBe('ok POST');
      const seeOther = await guardedFetch(`${base}/see-other`, { method: 'POST', body: 'x' }, { crossOrigin: 'stop' });
      expect(await seeOther.res.text()).toBe('ok GET');
      const away = await guardedFetch(`${base}/away`, { method: 'POST', body: 'x' }, { crossOrigin: 'stop' });
      expect(away).toMatchObject({ redirectedTo: 'http://localhost:9/elsewhere' });
      expect(away.res.status).toBe(302);
      await expect(guardedFetch(`${base}/self`, {}, { crossOrigin: 'follow' })).rejects.toBeInstanceOf(RedirectRefused);
      const big = await readCapped((await guardedFetch(`${base}/big`, {}, { crossOrigin: 'follow' })).res, 1000);
      expect(big).toMatchObject({ truncated: true });
      expect(big.buffer.length).toBe(1000);
      expect(hits).not.toContain('GET /elsewhere');
    } finally {
      server.close();
    }
  });
});

describe('F-02: pages the tools drive never load the Control Center', async () => {
  const { findBrowser, guardBrowserContext } = await import('../src/index.js');
  const { launch } = await import('../src/packs/browser.js');
  const browser = await findBrowser();
  it.skipIf(!browser)('blocks a navigation or a fetch to 127.0.0.1:4317 from a guarded context', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => res.end('<html><body>app</body></html>'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const b = await launch();
    try {
      const context = await b.newContext();
      await guardBrowserContext(context);
      const page = await context.newPage();
      await page.goto(base);
      await expect(page.goto('http://127.0.0.1:4317/')).rejects.toThrow();
      const second = await context.newPage();
      await second.goto(base);
      const fetched = await second.evaluate(() => fetch('http://127.0.0.1:4317/').then(() => 'reached', () => 'blocked'));
      expect(fetched).toBe('blocked');
    } finally {
      await b.close();
      server.close();
    }
  }, 60_000);
});

describe('F-14: production is decided by the resource, not by a label the caller picks', () => {
  it('classifies a Pages deploy of a production-named branch as production, whatever else is passed', () => {
    const main = risk('cloudflare.pages_deploy', { directory: 'dist', project: 'site', branch: 'main', productionBranch: 'release' });
    expect(main).toMatchObject({ level: 5, production: true });
    expect(risk('cloudflare.pages_deploy', { directory: 'dist', project: 'site', branch: 'feature-x' }).level).toBe(4);
  });

  it('refuses a non-production-named branch it cannot check against Cloudflare', async () => {
    const os = await import('node:os');
    const o = op('cloudflare.pages_deploy');
    const ctx = { executionId: 't', taskId: null, cwd: os.tmpdir(), roots: [os.tmpdir()], env: {}, signal: new AbortController().signal, timeoutMs: 1000, tempDir: os.tmpdir(), stateDir: os.tmpdir(), shell: async () => null, detection: () => undefined, protectedPaths: [] } as never;
    const r = await o.run(o.input.parse({ directory: '.', project: 'site', branch: 'staging-preview' }), ctx);
    expect(r.error?.code).toBe('DENIED');
  });

  it('judges a remote D1 write or migration labelled preview as production', () => {
    expect(risk('cloudflare.d1_query', { database: 'app-db', sql: 'UPDATE users SET plan = 1 WHERE id = 2', environment: 'preview' })).toMatchObject({ level: 5, production: true });
    expect(risk('cloudflare.d1_migrations', { database: 'app-db', action: 'apply', environment: 'preview' })).toMatchObject({ level: 5, production: true });
    expect(risk('cloudflare.d1_query', { database: 'app-db', sql: 'SELECT 1', environment: 'local' }).level).toBeLessThan(3);
  });
});
