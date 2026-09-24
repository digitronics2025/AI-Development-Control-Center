import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, webcrypto, type webcrypto as WebCrypto } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Runs the Worker in the real Workers runtime (`wrangler dev`, local D1, R2
 * and Durable Objects) for integration tests, with a test Access key set and
 * a random node-session secret. Everything lives in a temporary folder.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
/** The dashboard build the Worker serves (wrangler.jsonc `assets.directory`). */
const DASHBOARD_ASSETS = path.resolve(ROOT, '..', 'dashboard', 'dist', 'web');
export const ACCESS_TEAM = 'acc-test.cloudflareaccess.com';
export const ACCESS_AUD = 'acc-test-audience';
export const USER = 'operator@example.com';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function b64url(data: Uint8Array | string): string {
  return Buffer.from(data).toString('base64url');
}

export interface AccessSigner {
  jwks: string;
  token(claims?: Record<string, unknown>, options?: { kid?: string; key?: WebCrypto.CryptoKey }): Promise<string>;
  otherKey: WebCrypto.CryptoKey;
}

export async function accessSigner(): Promise<AccessSigner> {
  const gen = () => webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pair = await gen();
  const other = await gen();
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const jwks = JSON.stringify({ keys: [{ kid: 'test-key', kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256' }] });
  return {
    jwks,
    otherKey: other.privateKey,
    async token(claims = {}, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      const header = b64url(JSON.stringify({ alg: 'RS256', kid: options.kid ?? 'test-key', typ: 'JWT' }));
      const body = b64url(JSON.stringify({ aud: [ACCESS_AUD], iss: `https://${ACCESS_TEAM}`, email: USER, iat: now, nbf: now, exp: now + 3600, type: 'app', ...claims }));
      const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', options.key ?? pair.privateKey, new TextEncoder().encode(`${header}.${body}`));
      return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
    },
  };
}

/** JSON over node:http with no keep-alive (the local dev proxy resets reused sockets now and then). */
export function httpJson(base: string, method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const target = new URL(pathname, base);
  const payload = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: target.hostname, port: target.port, path: target.pathname + target.search, method, agent: false, headers: { ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}), ...headers } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(response.headers)) if (typeof v === 'string') h.set(k, v);
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          resolve({ status: response.statusCode ?? 0, body: parsed, headers: h });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

export interface Cloud {
  url: string;
  port: number;
  signer: AccessSigner;
  /** Authenticated request to the control host. */
  api: (method: string, pathname: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers }>;
  d1: (sql: string) => Promise<any[]>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  logs: string[];
}

export async function startCloud(options: { vars?: Record<string, string>; port?: number } = {}): Promise<Cloud> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-cloud-'));
  const persist = path.join(dir, 'state');
  const signer = await accessSigner();
  const vars: Record<string, string> = {
    ENVIRONMENT: 'test',
    CONTROL_HOSTS: '127.0.0.1,control.test',
    RELAY_HOSTS: '127.0.0.1,relay.test',
    ACCESS_TEAM_DOMAIN: ACCESS_TEAM,
    ACCESS_AUD,
    ACCESS_JWKS: signer.jwks,
    NODE_SESSION_SECRET: randomBytes(32).toString('base64url'),
    ...options.vars,
  };
  const migrate = spawnSync(process.execPath, [WRANGLER, 'd1', 'migrations', 'apply', 'acc-control-dev', '--local', '--env', '', '--persist-to', persist], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  if (migrate.status !== 0) throw new Error(`D1 migrations failed: ${migrate.stderr || migrate.stdout}`);
  const port = options.port ?? (await freePort());
  // Without a dashboard build (`pnpm check` before `pnpm build`), serve a placeholder
  // from the temporary folder: these tests exercise the Worker, not the dashboard.
  const assetArgs: string[] = [];
  if (!existsSync(DASHBOARD_ASSETS)) {
    const placeholder = path.join(dir, 'assets');
    mkdirSync(placeholder);
    writeFileSync(path.join(placeholder, 'index.html'), '<!doctype html><title>test placeholder</title><div id="root"></div>');
    assetArgs.push('--assets', placeholder);
  }
  const logs: string[] = [];
  let child: ChildProcess | null = null;

  const launch = async () => {
    const args = [WRANGLER, 'dev', '--env', '', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(await freePort()), '--persist-to', persist, '--show-interactive-dev-session=false', '--log-level', process.env.ACC_CLOUD_LOG_LEVEL ?? 'warn', ...assetArgs];
    for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
    child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (d: Buffer) => logs.push(d.toString()));
    child.stderr!.on('data', (d: Buffer) => logs.push(d.toString()));
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`wrangler dev exited: ${logs.join('').slice(-2000)}`);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`wrangler dev did not start: ${logs.join('').slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  const kill = async () => {
    const c = child as ChildProcess | null;
    if (!c || c.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      c.once('exit', () => resolve());
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGTERM');
      setTimeout(resolve, 10_000);
    });
  };

  await launch();
  const url = `http://127.0.0.1:${port}`;
  const token = await signer.token();
  return {
    url,
    port,
    signer,
    logs,
    api(method, pathname, body, headers = {}) {
      return httpJson(url, method, pathname, body, { 'cf-access-jwt-assertion': token, origin: url, ...headers });
    },
    async d1(sql) {
      const r = spawnSync(process.execPath, [WRANGLER, 'd1', 'execute', 'acc-control-dev', '--local', '--env', '', '--persist-to', persist, '--json', '--command', sql], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);
      return (JSON.parse(r.stdout) as Array<{ results: any[] }>)[0]!.results;
    },
    async stop() {
      await kill();
      // workerd releases its files a moment after exit; a leftover temp folder is harmless.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        /* left for the OS temp cleaner */
      }
    },
    async restart() {
      await kill();
      await launch();
    },
  };
}
