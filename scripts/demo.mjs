#!/usr/bin/env node
// Starts the orchestrator with SIMULATED agents against throwaway sample
// repositories and seeds tasks in several states. No provider is contacted.
//
// Used for demos, visual QA and as the Playwright end-to-end server.
//   node scripts/demo.mjs [--port 4390] [--data <dir>] [--no-seed]
//
// Requires a build: `pnpm build` (orchestrator bundle + dashboard).
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const port = Number(flag('port', process.env.ACC_PORT ?? 4390));
const seed = !args.includes('--no-seed');
const base = flag('data', null) ?? mkdtempSync(path.join(os.tmpdir(), 'acc-demo-'));
const dataDir = path.join(base, 'data');
const reposDir = path.join(base, 'repos');
rmSync(dataDir, { recursive: true, force: true });
rmSync(path.join(base, 'ready'), { force: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(reposDir, { recursive: true });

const main = path.join(root, 'apps', 'orchestrator', 'dist', 'main.js');
if (!existsSync(main)) {
  console.error('Orchestrator bundle missing. Run `pnpm build` first.');
  process.exit(1);
}

function makeRepo(name, { dirty = false, failingTests = false } = {}) {
  const dir = path.join(reposDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'demo@example.com');
  git('config', 'user.name', 'Demo');
  git('config', 'commit.gpgsign', 'false');
  const test = failingTests ? 'node -e "console.log(\'2 failed, 10 passed\');process.exit(1)"' : 'node -e "console.log(\'12 passed\')"';
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, private: true, scripts: { lint: 'node -e "console.log(\'lint ok\')"', test, build: 'node -e "console.log(\'built\')"' } }, null, 2),
  );
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git('add', '-A');
  git('commit', '-qm', 'init');
  if (dirty) writeFileSync(path.join(dir, 'NOTES.md'), 'work in progress\n');
  return dir;
}

const env = {
  ...process.env,
  ACC_DATA_DIR: dataDir,
  ACC_PORT: String(port),
  ACC_SIMULATED_AGENTS: '1',
  ACC_SIM_DELAY_MS: process.env.ACC_SIM_DELAY_MS ?? '600',
  ACC_TOKEN_OVERRIDE: process.env.ACC_TOKEN_OVERRIDE ?? '',
};
if (!env.ACC_TOKEN_OVERRIDE) delete env.ACC_TOKEN_OVERRIDE;

const child = spawn(process.execPath, [main], { env, stdio: ['ignore', 'pipe', 'inherit'] });
// Keep the orchestrator's structured log next to the demo data for diagnostics.
const log = createWriteStream(path.join(base, 'orchestrator.log'), { flags: 'w' });
child.stdout.pipe(log);
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));

const url = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${url}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 150));
}
const token = readFileSync(path.join(dataDir, 'auth-token'), 'utf8').trim();
const api = async (method, p, body) => {
  const res = await fetch(`${url}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

if (seed) {
  const shop = await api('POST', '/api/repositories', { path: makeRepo('demo-shop', { dirty: true }), name: 'demo-shop' });
  const billing = await api('POST', '/api/repositories', { path: makeRepo('billing-api'), name: 'billing-api' });
  const mobile = await api('POST', '/api/repositories', { path: makeRepo('mobile-app'), name: 'mobile-app' });
  const docs = await api('POST', '/api/repositories', { path: makeRepo('docs-site', { failingTests: true }), name: 'docs-site' });
  const task = (b) => api('POST', '/api/tasks', { workflowId: 'normal-development', mode: 'autopilot', ...b });
  const waitFor = async (id, statuses) => {
    for (let i = 0; i < 400; i++) {
      const t = await api('GET', `/api/tasks/${id}`);
      if (statuses.includes(t.status)) return t;
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const done = await task({ repositoryId: shop.id, workflowId: 'quick-change', description: 'Add a product search box to the catalog page. Keep the existing filters working.' });
  await waitFor(done.id, ['COMPLETED', 'FAILED']);
  await task({ repositoryId: shop.id, description: 'Fix the invoice rounding bug for multi-currency orders. [sim:slow] [sim:review-fail-once]' });
  await task({ repositoryId: billing.id, mode: 'discuss', description: 'Add Stripe webhook retries with idempotency keys.' });
  await task({ repositoryId: mobile.id, workflowId: 'quick-change', description: 'Migrate the settings screen to the new navigation. [sim:usage-limit]' });
  await task({ repositoryId: docs.id, workflowId: 'quick-change', maxFixCycles: 1, description: 'Update the changelog page layout.' });
  await api('POST', '/api/tasks', { repositoryId: billing.id, workflowId: 'quick-change', mode: 'autopilot', description: 'Rename the PaymentIntent helper for clarity.', start: false });
}

// Marker for callers (e.g. the Playwright global setup) that seeding is done.
writeFileSync(path.join(base, 'ready'), new Date().toISOString());
console.log(JSON.stringify({ url, dataDir, reposDir }));
