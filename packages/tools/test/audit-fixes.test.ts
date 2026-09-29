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

/**
 * A Chromium to drive: the one the tools find, or else any revision installed
 * under PLAYWRIGHT_BROWSERS_PATH (a container's pre-installed browser may not
 * be the revision this playwright-core expects).
 */
async function anyChromium(): Promise<string | null> {
  const { findBrowser } = await import('../src/index.js');
  const found = await findBrowser();
  if (found?.executablePath) return found.executablePath;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root) return null;
  const { existsSync, readdirSync } = await import('node:fs');
  const path = await import('node:path');
  if (!existsSync(root)) return null;
  const revisions = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const revision of revisions) {
    for (const exe of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const candidate = path.join(root, revision, exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

describe('F-02: pages the tools drive never load the Control Center', async () => {
  const { guardBrowserContext } = await import('../src/index.js');
  const executablePath = await anyChromium();
  it.skipIf(!executablePath)('blocks a navigation or a fetch to the listen address, in every spelling of this machine, from a guarded context', async () => {
    const http = await import('node:http');
    const { chromium } = await import('playwright-core');
    const { setSelfReferences } = await import('@acc/security');
    const listen = async (hits: string[]) => {
      const server = http.createServer((req, res) => {
        hits.push(req.url ?? '');
        res.end('<html><body>app</body></html>');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return { server, port: (server.address() as { port: number }).port };
    };
    const selfHits: string[] = [];
    const appHits: string[] = [];
    // A live stand-in for the Control Center, so a request that got through would be seen.
    const self = await listen(selfHits);
    const app = await listen(appHits);
    setSelfReferences({ port: self.port });
    const base = `http://127.0.0.1:${app.port}`;
    const b = await chromium.launch({ headless: true, executablePath: executablePath! });
    try {
      const context = await b.newContext();
      await guardBrowserContext(context);
      const page = await context.newPage();
      await page.goto(base);
      // SEC-1: the loopback aliases Chromium normalises to this machine are refused like 127.0.0.1.
      for (const host of ['127.0.0.1', '127.1', '2130706433', '[::ffff:127.0.0.1]', '0x7f000001', 'localhost.']) {
        const target = `http://${host}:${self.port}/`;
        await expect(page.goto(target), target).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      }
      const second = await context.newPage();
      await second.goto(base);
      for (const host of ['127.0.0.1', '127.1', '2130706433']) {
        const target = `http://${host}:${self.port}/api`;
        const fetched = await second.evaluate((url) => fetch(url).then(() => 'reached', () => 'blocked'), target);
        expect(fetched, target).toBe('blocked');
      }
      expect(selfHits).toEqual([]);
      // Another port of this machine still loads.
      expect(await second.evaluate((url) => fetch(url).then((r) => r.status), `${base}/ok`)).toBe(200);
      expect(appHits).toContain('/ok');
    } finally {
      setSelfReferences({});
      await b.close();
      self.server.close();
      app.server.close();
    }
  }, 60_000);

  it('refuses the listen address over the network, and the data folder over other schemes, not a page that only names a word (SEC-1)', async () => {
    const { browserRequestReachesSelf: browserRequestRefused } = await import('../src/index.js');
    const { setSelfReferences } = await import('@acc/security');
    const os = await import('node:os');
    const path = await import('node:path');
    const dataDir = path.join(os.tmpdir(), 'acc-browser-guard-data');
    setSelfReferences({ dataDir, port: 4399 });
    try {
      const fileUrl = (p: string) => new URL(`file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`);
      for (const refused of ['http://127.0.0.1:4399/', 'http://127.1:4399/api', 'http://2130706433:4399/', 'ws://localhost:4399/ws']) {
        expect(browserRequestRefused(new URL(refused)), refused).toBe(true);
      }
      expect(browserRequestRefused(fileUrl(path.join(dataDir, 'auth-token')))).toBe(true);
      expect(browserRequestRefused(fileUrl(path.join(os.tmpdir(), 'x', 'auth-token')))).toBe(true);
      for (const allowed of ['http://127.0.0.1:9/octokit/auth-token.js', 'https://example.com/docs/auth-token', 'http://127.0.0.1:4400/']) {
        expect(browserRequestRefused(new URL(allowed)), allowed).toBe(false);
      }
    } finally {
      setSelfReferences({});
    }
  });
});

describe('F-14: production is decided by the resource, not by a label the caller picks', () => {
  it('classifies a Pages deploy of a production-named branch as production, whatever else is passed', () => {
    const main = risk('cloudflare.pages_deploy', { directory: 'dist', project: 'site', branch: 'main', productionBranch: 'release' });
    expect(main).toMatchObject({ level: 5, production: true });
    expect(risk('cloudflare.pages_deploy', { directory: 'dist', project: 'site', branch: 'feature-x' }).level).toBe(4);
  });

  it('creates a Pages project at Level 4 and accepts only a Cloudflare-valid name', () => {
    expect(risk('cloudflare.pages_project_create', { project: 'simple-calc' })).toMatchObject({ level: 4 });
    const input = op('cloudflare.pages_project_create').input;
    expect(input.parse({ project: 'simple-calc' })).toEqual({ project: 'simple-calc', productionBranch: 'main' });
    for (const bad of ['Simple-Calc', '-calc', 'calc;rm', 'a'.repeat(59)]) expect(() => input.parse({ project: bad }), bad).toThrow();
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

describe('F-33 / F-34 / F-35 / F-32: small pack guards', () => {
  it('F-35 keeps only the tail of a stream', async () => {
    const { pushBounded } = await import('../src/detect.js');
    const list: string[] = [];
    for (let i = 0; i < 10; i++) pushBounded(list, String(i), 3);
    expect(list).toEqual(['7', '8', '9']);
  });

  it('F-33 refuses an option passed as a package name', async () => {
    const os = await import('node:os');
    const o = op('node.add_dependency');
    const ctx = { executionId: 't', taskId: null, cwd: os.tmpdir(), roots: [os.tmpdir()], env: process.env, signal: new AbortController().signal, timeoutMs: 1000, tempDir: os.tmpdir(), stateDir: os.tmpdir(), shell: async () => null, detection: () => undefined, protectedPaths: [] } as never;
    expect((await o.run(o.input.parse({ packages: ['-g', 'some-cli'] }), ctx)).error?.code).toBe('INVALID_INPUT');
  });

  it('F-34 confines the Dockerfile like the build context', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const root = path.join(os.tmpdir(), 'acc-docker-root');
    const o = op('docker.build');
    const ctx = { executionId: 't', taskId: null, cwd: root, roots: [root], env: process.env, signal: new AbortController().signal, timeoutMs: 1000, tempDir: os.tmpdir(), stateDir: os.tmpdir(), shell: async () => null, detection: () => undefined, protectedPaths: [] } as never;
    expect((await o.run(o.input.parse({ context: '.', file: '../../outside/Dockerfile', tag: 'x:1' }), ctx)).error?.code).toBe('OUTSIDE_ROOT');
  });
});

describe('SEC-1: the fetch tools never request the Control Center, however its address is written', () => {
  it.each(['http://127.1:4317/', 'http://2130706433:4317/', 'http://[::ffff:127.0.0.1]:4317/', 'http://0x7f000001:4317/api/tasks'])('refuses %s on the first hop', async (url) => {
    const { guardedFetch, RedirectRefused } = await import('../src/net-guard.js');
    await expect(guardedFetch(url, {}, { crossOrigin: 'follow' })).rejects.toBeInstanceOf(RedirectRefused);
    await expect(guardedFetch(url, {}, { crossOrigin: 'stop' })).rejects.toThrow(/Control Center's own address/);
  });

  it('fetches a page whose URL only mentions a self-reference word (the address is what it refuses)', async () => {
    const http = await import('node:http');
    const { guardedFetch } = await import('../src/net-guard.js');
    const server = http.createServer((_req, res) => res.end('readme'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/octokit/auth-token.js?dir=AIDevControlCenter`;
      expect(await (await guardedFetch(url, {}, { crossOrigin: 'follow' })).res.text()).toBe('readme');
    } finally {
      server.close();
    }
  });

  it('refuses a redirect to an IPv4-mapped spelling, and still fetches an ordinary loopback app', async () => {
    const http = await import('node:http');
    const { guardedFetch, RedirectRefused } = await import('../src/net-guard.js');
    const server = http.createServer((req, res) => {
      if (req.url === '/mapped') return res.writeHead(302, { location: 'http://[::ffff:127.0.0.1]:4317/' }).end();
      res.end('app');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await expect(guardedFetch(`${base}/mapped`, {}, { crossOrigin: 'follow' })).rejects.toBeInstanceOf(RedirectRefused);
      expect(await (await guardedFetch(`${base}/`, {}, { crossOrigin: 'follow' })).res.text()).toBe('app');
    } finally {
      server.close();
    }
  });
});

describe('SEC-1: git.push to the release branch is a production deploy', () => {
  const push = (input: Record<string, unknown>, releaseBranch: string | null = null) => {
    const o = op('git.push');
    return { level: o.level, risk: 'normal' as const, reasons: [], effects: [], production: false, ...o.classify?.(o.input.parse(input), { cwd: process.cwd(), releaseBranches: releaseBranch ? [releaseBranch] : [] }) };
  };
  const decision = (r: ReturnType<typeof push>, origin: 'agent' | 'operator') => decide({ risk: r, mode: 'full', autoApproveUpToLevel: 4, stageLevel: 4, inProfile: true, origin });

  it.each([
    [{ branch: 'main' }, 'main'],
    [{ branch: 'site' }, 'site'],
    [{ branch: 'Site', remote: 'upstream' }, 'site'],
    [{ branch: 'refs/heads/site' }, 'site'],
    [{ branch: 'main' }, null],
    [{ branch: 'production' }, null],
  ] as const)('%j with release branch %s needs a typed approval', (input, release) => {
    const r = push(input, release);
    expect(r).toMatchObject({ level: 5, production: true });
    expect(r.effects).toContain('production');
    expect(decision(r, 'operator')).toMatchObject({ decision: 'approval', typedConfirmation: true });
    expect(decision(r, 'agent').decision).toBe('deny');
  });

  it.each([
    [{ branch: 'feature/login' }, 'main'],
    [{ branch: 'site' }, null],
    [{ branch: 'site' }, 'main'],
    [{ branch: 'main-fixes' }, 'main'],
  ] as const)('%j with release branch %s stays Level 3', (input, release) => {
    const r = push(input, release);
    expect(r).toMatchObject({ level: 3, production: false });
    expect(decision(r, 'operator').decision).toBe('allow');
    expect(decision(r, 'agent').decision).toBe('allow');
  });
});

describe('SEC-1: git.push checks the commits it would send for secrets', () => {
  it('refuses a commit carrying a token and names the rule, and pushes a clean one', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { git } = await import('@acc/git');
    const run = async (cwd: string, args: string[]) => {
      const r = await git(cwd, args);
      if (r.code !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    const base = mkdtempSync(path.join(os.tmpdir(), 'acc-push-'));
    const remote = path.join(base, 'origin.git');
    const repo = path.join(base, 'repo');
    await run(base, ['init', '--bare', '-b', 'main', remote]);
    await run(base, ['init', '-b', 'main', repo]);
    for (const args of [['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false'], ['remote', 'add', 'origin', remote]]) await run(repo, args);
    writeFileSync(path.join(repo, 'README.md'), '# x\n');
    await run(repo, ['add', '.']);
    await run(repo, ['commit', '-m', 'init']);
    await run(repo, ['push', '-u', 'origin', 'main']);

    const o = op('git.push');
    const ctx = { executionId: 't', taskId: null, cwd: repo, roots: [repo], env: process.env, signal: new AbortController().signal, timeoutMs: 60_000, tempDir: os.tmpdir(), stateDir: os.tmpdir(), shell: async () => null, detection: () => undefined, protectedPaths: [] } as never;

    await run(repo, ['switch', '-c', 'feature/clean']);
    writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\n');
    await run(repo, ['add', '.']);
    await run(repo, ['commit', '-m', 'clean']);
    const clean = await o.run(o.input.parse({ branch: 'feature/clean' }), ctx);
    expect(clean.ok, clean.summary).toBe(true);
    expect(await run(remote, ['rev-parse', 'refs/heads/feature/clean'])).toBe(await run(repo, ['rev-parse', 'HEAD']));

    await run(repo, ['switch', '-c', 'feature/leak']);
    const token = ['gh', 'p_', 'A1b2C3d4'.repeat(4), 'Zz9Y'].join('');
    writeFileSync(path.join(repo, 'config.ts'), `export const token = '${token}';\n`);
    await run(repo, ['add', '.']);
    await run(repo, ['commit', '-m', 'leak']);
    await run(repo, ['switch', '-c', 'feature/after-leak']);
    writeFileSync(path.join(repo, 'config.ts'), 'export const token = process.env.TOKEN;\n');
    await run(repo, ['commit', '-am', 'remove it again']);
    // The tip no longer holds the token, but a commit the push would send does.
    for (const branch of ['feature/leak', 'feature/after-leak']) {
      const r = await o.run(o.input.parse({ branch }), ctx);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('DENIED');
      expect(r.summary).toMatch(/config\.ts contains what looks like a GitHub token/);
      expect(r.summary).not.toContain(token);
      expect((await git(remote, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code).not.toBe(0);
    }
    expect((await o.run(o.input.parse({ branch: 'no-such-branch' }), ctx)).error?.code).toBe('INVALID_INPUT');
  }, 60_000);
});

describe('SEC-1: a push to the release branch through any command line is a deploy', () => {
  const ctx = (releaseBranches: string[] = ['site'], cwd = process.cwd()) => ({ cwd, releaseBranches });
  const classify = (id: string, input: Record<string, unknown>, c = ctx()) => {
    const o = op(id);
    return { level: o.level, risk: 'normal' as const, reasons: [], effects: [], production: false, ...o.classify?.(o.input.parse(input), c) };
  };
  const decision = (r: ReturnType<typeof classify>, origin: 'agent' | 'operator') => decide({ risk: r, mode: 'full', autoApproveUpToLevel: 4, stageLevel: 4, inProfile: true, origin });

  it.each([
    ['shell.run', { script: 'git push origin site' }],
    ['shell.run', { script: 'git push -u origin HEAD:site' }],
    ['shell.run', { script: 'git push --set-upstream origin refs/heads/site' }],
    ['shell.run', { script: 'git push origin topic:Site' }],
    ['shell.run', { script: 'npm test && git push origin main' }],
    ['shell.run', { script: 'git -C app push origin master' }],
    ['shell.run', { script: 'bash -c "git push origin site"' }],
    ['shell.run', { script: 'git push --all origin' }],
    ['shell.bash', { script: 'git push origin production' }],
    ['process.exec', { command: 'git', args: ['push', 'origin', 'site'] }],
    ['process.start', { name: 'deploy', command: 'git push origin site' }],
    ['terminal.send', { id: 't1', input: 'git push origin HEAD:main\n' }],
    ['git.bisect', { good: 'v1', command: 'git push origin site' }],
    ['verify.web', { url: 'http://127.0.0.1:5173', startCommand: 'git push origin site && pnpm dev' }],
    // Spellings a first-word check misses (review of SEC-1).
    ['shell.run', { script: 'git checkout main && git push' }],
    ['shell.run', { script: 'git switch site && git push origin' }],
    ['shell.run', { script: 'git -c remote.origin.push=HEAD:main push origin' }],
    ['shell.run', { script: 'if true; then git push origin main; fi' }],
    ['shell.run', { script: 'for i in 1; do git push origin main; done' }],
    ['shell.run', { script: 'true && ! git push origin main' }],
    ['shell.run', { script: 'if ($true) { git push origin main }' }],
    ['shell.run', { script: 'echo $(git push origin main)' }],
    ['shell.run', { script: 'bash -lc "git push origin main"' }],
    ['shell.run', { script: 'b=main; git push origin $b' }],
    ['shell.run', { script: 'echo main | xargs git push origin' }],
    ['process.exec', { command: String.raw`C:\Program Files\Git\cmd\git.exe`, args: ['push', 'origin', 'main'] }],
    // Branches may be named with quotes: joined with spaces, `x'`, `main`, `'y` would read as one word.
    ['process.exec', { command: 'git', args: ['push', 'origin', "x'", 'main', "'y"] }],
    // A pull-request merge: its base is usually the release branch.
    ['shell.run', { script: 'gh pr merge 12 --squash' }],
    ['shell.run', { script: 'gh api -X PUT repos/o/r/pulls/1/merge' }],
    ['process.exec', { command: 'gh', args: ['pr', 'merge', '12'] }],
    ['terminal.send', { id: 't1', input: 'gh pr merge 12\n' }],
    // `pnpm exec` and `npx` run a program on PATH as well as a package binary.
    ['node.exec', { bin: 'git', args: ['push', 'origin', 'site'] }],
    // PowerShell (the default terminal shell on Windows), escapes and Git's own programs (review of SEC-1, round 3).
    ['shell.run', { script: "Start-Process git -ArgumentList 'push','origin','main' -Wait" }],
    ['shell.run', { script: "saps git 'push origin site' -Wait" }],
    ['shell.run', { script: 'Write-Output (git push origin main)' }],
    ['shell.run', { script: '[void](git push origin site)' }],
    ['shell.run', { script: 'sv b origin,main; git push @b' }],
    ['shell.run', { script: 'git push origin @b' }],
    ['shell.run', { script: 'git branch -M site && git push -u origin HEAD' }],
    ['shell.run', { script: 'git stash branch main && git push' }],
    ['shell.bash', { script: String.raw`g\it push origin main` }],
    ['shell.run', { script: '/usr/lib/git-core/git-push origin main' }],
    ['shell.run', { script: 'gh repo sync owner/fork' }],
  ] as const)('%s %j needs a typed approval', (id, input) => {
    const r = classify(id, input);
    expect(r, JSON.stringify(r.reasons)).toMatchObject({ level: 5, production: true });
    expect(r.reasons.some((reason) => reason.startsWith('Deploys: '))).toBe(true);
    expect(decision(r, 'operator')).toMatchObject({ decision: 'approval', typedConfirmation: true });
    expect(decision(r, 'agent').decision).toBe('deny');
  });

  it.each([
    ['shell.run', { script: 'git push origin feature/login' }],
    ['shell.run', { script: 'git push -u origin HEAD:acc/task-12' }],
    ['shell.run', { script: 'git push -n origin site' }],
    ['shell.run', { script: 'git push --tags origin' }],
    ['shell.run', { script: 'git push origin v1.2:refs/tags/v1.2' }],
    ['shell.run', { script: 'echo "git push origin site" > notes.md' }],
    ['process.exec', { command: 'git', args: ['push', 'origin', 'sites'] }],
    ['terminal.send', { id: 't1', input: 'git push origin main-fixes\n' }],
    ['verify.web', { url: 'http://127.0.0.1:5173', startCommand: 'pnpm dev' }],
    ['shell.run', { script: 'if true; then git push origin feature/login; fi' }],
    ['shell.run', { script: 'if ($ok) { git push origin feature/login }' }],
    ['shell.run', { script: 'git checkout -b feature/x && git push -u origin feature/x' }],
    ['shell.run', { script: 'git switch main && git push origin feature/x' }],
    ['shell.run', { script: 'bash -lc "git push origin feature/login"' }],
    ['shell.run', { script: 'gh pr view 12' }],
    ['shell.run', { script: 'gh pr create --fill' }],
    ['process.exec', { command: String.raw`C:\Program Files\Git\cmd\git.exe`, args: ['push', 'origin', 'feature/login'] }],
    ['process.exec', { command: 'git', args: ['push', 'origin', "x'", "'y"] }],
    ['node.exec', { bin: 'git', args: ['push', 'origin', 'feature/login'] }],
    ["shell.run", { script: "Start-Process git -ArgumentList 'push','origin','feature/login'" }],
    ['shell.run', { script: 'Write-Output (git push origin feature/login)' }],
    ['shell.run', { script: 'gh repo sync' }],
    // A line that only mentions `push` in another word runs no push.
    ['shell.run', { script: 'cd services/push && node index.js --port $PORT' }],
    ['shell.run', { script: 'pushd web && python -m http.server $PORT' }],
    ['shell.run', { script: 'Push-Location web; node build.js $env:MODE; Pop-Location' }],
    ['shell.run', { script: 'python tools/pusher.py --token $TOKEN' }],
  ] as const)('%s %j stays below Level 5', (id, input) => {
    const r = classify(id, input);
    expect(r.level, JSON.stringify(r.reasons)).toBeLessThan(5);
    expect(r.production).toBe(false);
  });

  it('reads the branch checked out for a push without a refspec, in a worktree too', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const { mkdtempSync } = await import('node:fs');
    const { git } = await import('@acc/git');
    const { checkedOutBranch } = await import('../src/release-gate.js');
    const run = async (cwd: string, args: string[]) => {
      const r = await git(cwd, args);
      if (r.code !== 0) throw new Error(r.stderr);
    };
    const base = mkdtempSync(path.join(os.tmpdir(), 'acc-head-'));
    const repo = path.join(base, 'repo');
    await run(base, ['init', '-b', 'site', repo]);
    await run(repo, ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init']);
    const tree = path.join(base, 'tree');
    await run(repo, ['worktree', 'add', '-b', 'acc/task-1', tree]);
    expect(checkedOutBranch(path.join(repo))).toBe('site');
    expect(checkedOutBranch(tree)).toBe('acc/task-1');
    for (const script of ['git push', 'git push origin', 'git push -u origin HEAD']) {
      expect(classify('shell.run', { script }, ctx(['site'], repo)).level, script).toBe(5);
      expect(classify('shell.run', { script }, ctx(['site'], tree)).level, script).toBe(3);
    }
    // Detached, or in no repository at all: no branch.
    await run(tree, ['switch', '--detach']);
    expect(checkedOutBranch(tree)).toBeNull();
    expect(checkedOutBranch(path.parse(base).root)).toBeNull();
  }, 30_000);
});

describe('SEC-1: a push without a refspec follows the repository and the line', () => {
  const classify = (id: string, input: Record<string, unknown>, cwd: string, releaseBranches = ['site']) => {
    const o = op(id);
    return { level: o.level, risk: 'normal' as const, reasons: [], effects: [], production: false, ...o.classify?.(o.input.parse(input), { cwd, releaseBranches }) };
  };

  async function featureRepo() {
    const os = await import('node:os');
    const path = await import('node:path');
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { git } = await import('@acc/git');
    const run = async (cwd: string, args: string[]) => {
      const r = await git(cwd, args);
      if (r.code !== 0) throw new Error(r.stderr);
    };
    const repo = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-gate-')), 'repo');
    await run(path.dirname(repo), ['init', '-b', 'feature', repo]);
    await run(repo, ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init']);
    await run(repo, ['remote', 'add', 'origin', 'https://example.com/r.git']);
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { ship: 'git push origin main', 'ship-feature': 'git push origin feature', release: 'npm run ship', check: 'git push', to: 'git push origin', relay: 'npm run check' } }));
    return { repo, config: (args: string[]) => run(repo, ['config', ...args]) };
  }

  it('stays Level 3 for the feature branch checked out, however it is named', async () => {
    const { repo } = await featureRepo();
    for (const script of ['git push', 'git push origin', 'git push -u origin "$(git branch --show-current)"', 'cd src && git push', 'git push origin HEAD']) {
      const r = classify('shell.run', { script }, repo);
      expect(r.level, `${script}: ${r.reasons.join('; ')}`).toBe(3);
    }
  }, 30_000);

  it('is a deploy when the line moves to the release branch, leaves the folder or cannot be read first', async () => {
    const { repo } = await featureRepo();
    for (const script of ['git switch site && git push', 'git checkout - && git push', 'cd .. && git push', 'git config push.default matching && git push', 'git -c remote.origin.push=HEAD:site push']) {
      const r = classify('shell.run', { script }, repo);
      expect(r, script).toMatchObject({ level: 5, production: true });
    }
    // A tool's own `cwd` is where HEAD is read.
    expect(classify('shell.run', { script: 'git push', cwd: 'src' }, repo).level).toBe(3);
  }, 30_000);

  it("reads the repository's push settings: a refspec, matching, or an upstream elsewhere", async () => {
    const { repo, config } = await featureRepo();
    const bare = () => classify('shell.run', { script: 'git push' }, repo);
    await config(['remote.origin.push', 'HEAD:refs/heads/site']);
    expect(bare()).toMatchObject({ level: 5, production: true });
    await config(['--unset', 'remote.origin.push']);
    await config(['push.default', 'matching']);
    expect(bare()).toMatchObject({ level: 5, production: true });
    await config(['push.default', 'upstream']);
    await config(['branch.feature.merge', 'refs/heads/site']);
    expect(bare()).toMatchObject({ level: 5, production: true });
    // `simple` refuses a push to an upstream of another name, so the branch goes where it is named.
    await config(['push.default', 'simple']);
    expect(bare().level).toBe(3);
    await config(['branch.feature.merge', 'refs/heads/feature']);
    await config(['push.default', 'upstream']);
    expect(bare().level).toBe(3);
  }, 30_000);

  it('judges what a package script runs (node.run_script)', async () => {
    const { repo } = await featureRepo();
    for (const script of ['ship', 'release']) expect(classify('node.run_script', { script }, repo), script).toMatchObject({ level: 5, production: true });
    expect(classify('node.run_script', { script: 'ship', args: [] }, repo, []).level).toBe(5);
    for (const script of ['ship-feature', 'check']) expect(classify('node.run_script', { script }, repo).level, script).toBeLessThan(5);
  }, 30_000);

  it("appends the call's args to the script body, as the package manager runs it", async () => {
    const { repo } = await featureRepo();
    for (const [script, args] of [
      ['to', ['main']],
      ['to', ['site']],
      ['check', ['origin', 'site']],
      ['check', ['origin', 'HEAD:site']],
      // Through a script that runs another, too.
      ['relay', ['origin', 'site']],
    ] as const) {
      expect(classify('node.run_script', { script, args }, repo), `${script} ${args.join(' ')}`).toMatchObject({ level: 5, production: true });
    }
    for (const [script, args] of [
      ['to', []],
      ['to', ['feature/x']],
      ['check', ['origin', 'feature/x']],
      ['check', ['--dry-run', 'origin', 'site']],
    ] as const) {
      expect(classify('node.run_script', { script, args }, repo).level, `${script} ${args.join(' ')}`).toBe(3);
    }
  }, 30_000);

  it('reads HEAD in the repository a push runs in, from the root of a multi-repository workspace', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const { mkdtempSync } = await import('node:fs');
    const { git } = await import('@acc/git');
    const run = async (cwd: string, args: string[]) => {
      const r = await git(cwd, args);
      if (r.code !== 0) throw new Error(r.stderr);
    };
    const root = mkdtempSync(path.join(os.tmpdir(), 'acc-multi-'));
    for (const [name, branch] of [['a', 'feature'], ['b', 'site']] as const) {
      await run(root, ['init', '-b', branch, name]);
      await run(path.join(root, name), ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init']);
    }
    for (const script of ['cd b && git push', 'git -C b push', 'git -C b push origin HEAD', 'pushd b; git push', 'Set-Location b; git push origin', 'cd a; cd ../b; git push', '(cd a && git push); cd b && git push']) {
      expect(classify('shell.run', { script }, root), script).toMatchObject({ level: 5, production: true });
    }
    for (const script of ['cd a && git push', 'git -C a push', 'git -C a push origin HEAD', 'pushd a; git push', 'git -C b push origin feature/x']) {
      expect(classify('shell.run', { script }, root).level, script).toBe(3);
    }
  }, 30_000);

  it('fails closed on a HEAD it cannot read, such as a reftable repository an older Git cannot open', async () => {
    const { repo } = await featureRepo();
    const path = await import('node:path');
    const { writeFileSync } = await import('node:fs');
    const { checkedOutBranch } = await import('../src/release-gate.js');
    expect(checkedOutBranch(repo)).toBe('feature');
    expect(classify('shell.run', { script: 'git push' }, repo).level).toBe(3);
    // A reftable repository's HEAD file is a stub; the real HEAD is in the reftable.
    writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
    expect(checkedOutBranch(repo)).toBeUndefined();
    expect(classify('shell.run', { script: 'git push' }, repo)).toMatchObject({ level: 5, production: true });
    // A branch named on the line is still read without HEAD.
    expect(classify('shell.run', { script: 'git push origin feature/x' }, repo).level).toBe(3);
  }, 30_000);

  it("looks up a subcommand that is not Git's own in the repository's aliases", async () => {
    const { repo, config } = await featureRepo();
    const levelOf = (script: string) => classify('shell.run', { script }, repo);
    await config(['alias.p', 'push']);
    await config(['alias.pp', 'p origin']);
    await config(['alias.sp', '!git push origin site']);
    await config(['alias.st', 'status -sb']);
    await config(['alias.lg', '!git log --oneline']);
    for (const script of ['git p origin site', 'git p', 'git pp feature/x', 'git sp', 'cd src && git p origin site']) expect(levelOf(script), script).toMatchObject({ level: 5, production: true });
    for (const script of ['git st', 'git lg', 'git nosuchalias origin site']) expect(levelOf(script).level, script).toBeLessThan(5);
    // A long line of subcommands that are not Git's own reads the repository's aliases once, not once per name.
    const many = Array.from({ length: 500 }, (_, i) => `git a${i}`).join('; ');
    for (const [script, deploys] of [
      ['git x; '.repeat(2000), false],
      [many, false],
      [`${many}; git p origin site`, true],
    ] as const) {
      const started = performance.now();
      expect(levelOf(script).level === 5).toBe(deploys);
      expect(performance.now() - started).toBeLessThan(3_000);
    }
  }, 30_000);
});

describe('SEC-1: git.push pushes a local branch, and scans merge commits for secrets', () => {
  async function pushRepo() {
    const os = await import('node:os');
    const path = await import('node:path');
    const { mkdtempSync, writeFileSync, appendFileSync } = await import('node:fs');
    const { git } = await import('@acc/git');
    const run = async (cwd: string, args: string[]) => {
      const r = await git(cwd, args);
      if (r.code !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    const base = mkdtempSync(path.join(os.tmpdir(), 'acc-push2-'));
    const remote = path.join(base, 'origin.git');
    const repo = path.join(base, 'repo');
    await run(base, ['init', '--bare', '-b', 'main', remote]);
    await run(base, ['init', '-b', 'main', repo]);
    for (const args of [['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false'], ['config', 'tag.gpgsign', 'false'], ['remote', 'add', 'origin', remote]]) await run(repo, args);
    writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\n');
    await run(repo, ['add', '.']);
    await run(repo, ['commit', '-m', 'init']);
    await run(repo, ['push', '-u', 'origin', 'main']);
    const commit = async (file: string, content: string) => {
      writeFileSync(path.join(repo, file), content);
      await run(repo, ['add', file]);
      await run(repo, ['commit', '-m', `change ${file}`]);
    };
    const o = op('git.push');
    const ctx = { executionId: 't', taskId: null, cwd: repo, roots: [repo], env: process.env, signal: new AbortController().signal, timeoutMs: 60_000, tempDir: os.tmpdir(), stateDir: os.tmpdir(), shell: async () => null, detection: () => undefined, protectedPaths: [] } as never;
    const push = (branch: string, more: Record<string, unknown> = {}) => o.run(o.input.parse({ branch, ...more }), ctx);
    const remoteHas = async (ref: string, at = remote) => (await git(at, ['rev-parse', '--verify', '--quiet', ref])).stdout.trim();
    const bare = async (name: string) => {
      const at = path.join(base, `${name}.git`);
      await run(base, ['init', '--bare', '-b', 'main', at]);
      await run(repo, ['remote', 'add', name, at]);
      return at;
    };
    return { base, repo, run, commit, push, remoteHas, bare, append: (file: string, text: string) => appendFileSync(path.join(repo, file), text) };
  }

  it("scans against the remote it pushes to: a secret another remote already has is still read", async () => {
    const r = await pushRepo();
    const privateRemote = await r.bare('private');
    const publicRemote = await r.bare('public');
    await r.run(r.repo, ['switch', '-c', 'leak']);
    const token = ['gh', 'p_', 'P4r1v8Te'.repeat(4), 'Xx2Z'].join('');
    await r.commit('secret.ts', `export const token = '${token}';\n`);
    // Already on the private remote, so `refs/remotes/private/leak` holds the commit.
    await r.run(r.repo, ['push', 'private', 'leak']);
    const refused = await r.push('leak', { remote: 'public' });
    expect(refused.error?.code, refused.summary).toBe('DENIED');
    expect(refused.summary).toMatch(/secret\.ts contains what looks like a GitHub token/);
    expect(await r.remoteHas('refs/heads/leak', publicRemote)).toBe('');
    expect(await r.remoteHas('refs/heads/leak', privateRemote)).not.toBe('');
    // A clean branch goes to the new remote, its whole history read.
    const clean = await r.push('main', { remote: 'public' });
    expect(clean.ok, clean.summary).toBe(true);
  }, 60_000);

  it('sets the upstream in a single-branch clone, whose fetch refspec makes no tracking branch for it', async () => {
    const r = await pushRepo();
    const path = await import('node:path');
    const os = await import('node:os');
    const { git } = await import('@acc/git');
    const clone = path.join(r.base, 'single');
    await r.run(r.base, ['clone', '--single-branch', '--branch', 'main', path.join(r.base, 'origin.git'), clone]);
    for (const args of [['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false'], ['switch', '-c', 'feature']]) await r.run(clone, args);
    await r.run(clone, ['commit', '--allow-empty', '-m', 'feature']);
    const o = op('git.push');
    const ctx = { executionId: 't', taskId: null, cwd: clone, roots: [clone], env: process.env, signal: new AbortController().signal, timeoutMs: 60_000, tempDir: os.tmpdir(), stateDir: os.tmpdir(), shell: async () => null, detection: () => undefined, protectedPaths: [] } as never;
    const pushed = await o.run(o.input.parse({ branch: 'feature', setUpstream: true }), ctx);
    expect(pushed.ok, pushed.summary).toBe(true);
    expect(await r.remoteHas('refs/heads/feature')).toBe(await r.run(clone, ['rev-parse', 'feature']));
    expect((await git(clone, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature'])).code).not.toBe(0);
    expect(await r.run(clone, ['config', 'branch.feature.remote'])).toBe('origin');
    expect(await r.run(clone, ['config', 'branch.feature.merge'])).toBe('refs/heads/feature');
  }, 60_000);

  it('pushes the branch, never a tag or remote-tracking ref of the same name', async () => {
    const r = await pushRepo();
    await r.run(r.repo, ['switch', '-c', 'feature']);
    await r.commit('b.ts', 'export const b = 1;\n');
    const branchTip = await r.run(r.repo, ['rev-parse', 'feature']);
    await r.commit('c.ts', 'export const c = 1;\n');
    await r.run(r.repo, ['tag', 'feature']);
    await r.run(r.repo, ['reset', '--hard', branchTip]);
    const pushed = await r.push('feature');
    expect(pushed.ok, pushed.summary).toBe(true);
    expect(await r.remoteHas('refs/heads/feature')).toBe(branchTip);

    await r.run(r.repo, ['tag', 'v1']);
    const tag = await r.push('v1');
    expect(tag.error?.code).toBe('INVALID_INPUT');
    expect(await r.remoteHas('refs/heads/v1')).toBe('');
    const tracking = await r.push('origin/main');
    expect(tracking.error?.code).toBe('INVALID_INPUT');
    expect(await r.remoteHas('refs/heads/origin/main')).toBe('');
    // `heads/x` and `refs/heads/x` name the branch itself.
    expect((await r.push('refs/heads/feature')).ok).toBe(true);
  }, 60_000);

  it('refuses a token added in a merge commit, and pushes a clean merge', async () => {
    const r = await pushRepo();
    await r.run(r.repo, ['switch', '-c', 'feature/merge']);
    await r.commit('b.ts', 'export const b = 1;\n');
    await r.run(r.repo, ['switch', 'main']);
    await r.commit('c.ts', 'export const c = 1;\n');
    await r.run(r.repo, ['switch', 'feature/merge']);
    await r.run(r.repo, ['merge', '--no-edit', 'main']);
    const clean = await r.push('feature/merge');
    expect(clean.ok, clean.summary).toBe(true);

    await r.run(r.repo, ['switch', '-c', 'feature/leak-in-merge', 'feature/merge~1']);
    await r.run(r.repo, ['merge', '--no-commit', 'main']).catch(() => undefined);
    const token = ['gh', 'p_', 'M3r6e7C0'.repeat(4), 'Qq1W'].join('');
    r.append('b.ts', `export const token = '${token}';\n`);
    await r.run(r.repo, ['add', 'b.ts']);
    await r.run(r.repo, ['commit', '--no-edit']);
    const refused = await r.push('feature/leak-in-merge');
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('DENIED');
    expect(refused.summary).toMatch(/b\.ts contains what looks like a GitHub token/);
    expect(refused.summary).not.toContain(token);
    expect(await r.remoteHas('refs/heads/feature/leak-in-merge')).toBe('');
  }, 60_000);
});

describe('SEC-1: a redirect from a remote site to a wildcard-DNS name for this machine', () => {
  it('is refused, and a redirect between remote sites is still followed', async () => {
    const { guardedFetch, RedirectRefused } = await import('../src/net-guard.js');
    const real = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      if (url === 'https://remote.example/nip') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1.nip.io:8080/admin' } });
      if (url === 'https://remote.example/sslip') return new Response(null, { status: 302, headers: { location: 'http://127.1.2.3.sslip.io/' } });
      if (url === 'https://remote.example/moved') return new Response(null, { status: 301, headers: { location: 'https://other.example/page' } });
      return new Response('page');
    }) as typeof fetch;
    try {
      for (const path of ['nip', 'sslip']) {
        await expect(guardedFetch(`https://remote.example/${path}`, {}, { crossOrigin: 'follow' })).rejects.toBeInstanceOf(RedirectRefused);
        await expect(guardedFetch(`https://remote.example/${path}`, {}, { crossOrigin: 'follow' })).rejects.toThrow(/remote site to this machine/);
      }
      expect(requested.some((u) => u.includes('nip.io') || u.includes('sslip.io'))).toBe(false);
      expect(await (await guardedFetch('https://remote.example/moved', {}, { crossOrigin: 'follow' })).res.text()).toBe('page');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('SEC-1: the curl provider sends each header as one line of its config', () => {
  it('refuses a header that would add a curl option, and sends a quote or a backslash as written', async () => {
    const http = await import('node:http');
    const os = await import('node:os');
    const path = await import('node:path');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const seen: Array<{ trace: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ trace: String(req.headers['x-trace'] ?? ''), body });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-curl-'));
    const file = path.join(dir, 'secret.txt');
    writeFileSync(file, 'TOP-SECRET-CONTENTS');
    const curl = builtinProviders()
      .find((p) => p.id === 'curl')!
      .operations.find((o) => o.id === 'http.request') as ToolOperation;
    const ctx = { executionId: 't', taskId: null, cwd: dir, roots: [dir], env: process.env, signal: new AbortController().signal, timeoutMs: 30_000, tempDir: os.tmpdir(), stateDir: os.tmpdir(), shell: async () => null, detection: () => undefined, protectedPaths: [] } as never;
    try {
      // `\"` then a line break would close the quoted header and start `data-binary = @file`: an upload of any file.
      const injected = { 'X-Trace': `x\\"\ndata-binary = @${file}\nheader = "Y: z` };
      expect(curl.input.safeParse({ method: 'GET', url, headers: injected }).success).toBe(false);
      expect(curl.input.safeParse({ method: 'GET', url, headers: { 'X-A\r\nB': 'c' } }).success).toBe(false);
      // Past the schema too (a stored credential is not checked there), the provider refuses it before curl starts.
      const direct = await curl.run({ ...(curl.input.parse({ method: 'GET', url }) as object), headers: injected }, ctx);
      expect(direct.error?.code, direct.summary).toBe('INVALID_INPUT');
      expect(seen).toEqual([]);
      // Without a line break, a backslash and a quote are part of the value.
      const value = String.raw`a\"b\n"c`;
      const literal = await curl.run(curl.input.parse({ method: 'GET', url, headers: { 'X-Trace': value } }), ctx);
      expect(literal.ok, literal.summary).toBe(true);
      expect(seen).toEqual([{ trace: value, body: '' }]);
    } finally {
      server.close();
    }
  }, 30_000);
});
