#!/usr/bin/env node
// Release the cloud control plane to one environment (docs/systems/cloud-control.md §Deploy):
//
//   node scripts/deploy.mjs staging|production
//
// 1. Refuses test-only settings (a static Access key set).
// 2. Applies D1 migrations to the remote database. A failure stops here: no code
//    that expects the new schema is ever deployed.
// 3. Deploys the Worker (dashboard assets included), then makes sure the node session
//    secret exists (a random one on first release) and no test key set is configured.
// 4. Runs the smoke check against the live hostnames.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.argv[2];
const DATABASES = { staging: 'acc-control-staging', production: 'acc-control-production' };
if (!DATABASES[env]) {
  console.error('Usage: node scripts/deploy.mjs staging|production');
  process.exit(2);
}

function wrangler(args, options = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args], { cwd: root, encoding: 'utf8', stdio: options.capture ? ['pipe', 'pipe', 'inherit'] : ['pipe', 'inherit', 'inherit'], input: options.input });
  if (r.status !== 0) {
    console.error(`\n✗ wrangler ${args.slice(0, 3).join(' ')} failed (exit ${r.status}). Nothing further was changed.`);
    process.exit(r.status || 1);
  }
  return r.stdout ?? '';
}

// 1. Configuration guards.
const config = readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
if (/ACCESS_JWKS/.test(config)) {
  console.error('✗ wrangler.jsonc sets ACCESS_JWKS (a test key set). Remove it before releasing.');
  process.exit(1);
}
// 2. Schema first.
console.log(`• Applying D1 migrations to ${DATABASES[env]}…`);
wrangler(['d1', 'migrations', 'apply', DATABASES[env], '--remote', '--env', env]);

// 3. Code.
console.log(`• Deploying the ${env} Worker…`);
wrangler(['deploy', '--env', env]);

// Secrets exist only once the Worker does (first release), so they are checked right after the deploy.
// Until NODE_SESSION_SECRET exists the relay refuses every session (fail closed).
const secrets = JSON.parse(wrangler(['secret', 'list', '--env', env, '--format', 'json'], { capture: true }) || '[]');
if (secrets.some((s) => s.name === 'ACCESS_JWKS')) {
  console.error(`✗ The ${env} Worker has an ACCESS_JWKS secret (test only). Delete it: wrangler secret delete ACCESS_JWKS --env ${env}`);
  process.exit(1);
}
if (!secrets.some((s) => s.name === 'NODE_SESSION_SECRET')) {
  console.log('• Creating NODE_SESSION_SECRET (random, stored only in Cloudflare)…');
  wrangler(['secret', 'put', 'NODE_SESSION_SECRET', '--env', env], { input: randomBytes(48).toString('base64url') });
}

// 4. Live check.
const smoke = spawnSync(process.execPath, [path.join(root, 'scripts', 'smoke.mjs'), env], { stdio: 'inherit' });
process.exit(smoke.status ?? 1);
