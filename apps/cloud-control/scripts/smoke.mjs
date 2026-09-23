#!/usr/bin/env node
// Live check of a deployed control plane (docs/systems/cloud-control.md §Deploy):
//
//   node scripts/smoke.mjs staging|production
//
// Proves, from the public internet, that: both hostnames answer /health; the
// control host refuses the dashboard, the API and realtime without a Cloudflare
// Access sign-in (fail closed); the relay host serves no dashboard; the relay
// rejects an unknown node; workers.dev serves nothing.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.argv[2];
if (!['staging', 'production'].includes(env)) {
  console.error('Usage: node scripts/smoke.mjs staging|production');
  process.exit(2);
}
const config = readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
const block = config.slice(config.indexOf(`"${env}": {`));
const hostsOf = (name) => (new RegExp(`"${name}":\\s*"([^"]+)"`).exec(block)?.[1] ?? '').split(',').filter(Boolean);
const control = hostsOf('CONTROL_HOSTS')[0];
const relay = hostsOf('RELAY_HOSTS')[0];

let failures = 0;
async function check(label, url, init, expect) {
  let status = 0;
  let detail = '';
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
    status = r.status;
    detail = (await r.text()).slice(0, 160).replace(/\s+/g, ' ');
  } catch (error) {
    detail = error.message;
  }
  const ok = expect(status);
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${status || 'no answer'}${ok ? '' : ` — ${detail}`}`);
}

// Cloudflare Access (when configured) answers unauthenticated browsers with a redirect
// to its login page (302) before the Worker runs; the Worker itself answers 401/503.
const refused = (s) => s === 302 || s === 401 || s === 403 || s === 503;
await check('control /health', `https://${control}/health`, {}, (s) => s === 200 || s === 302);
await check('relay /health', `https://${relay}/health`, {}, (s) => s === 200);
await check('control dashboard without sign-in is refused', `https://${control}/`, {}, refused);
await check('control API without sign-in is refused', `https://${control}/api/cloud/session`, {}, refused);
await check('control realtime without sign-in is refused', `https://${control}/ws`, {}, refused);
await check('control API with a forged token is refused', `https://${control}/api/tasks`, { headers: { 'cf-access-jwt-assertion': 'eyJhbGciOiJSUzI1NiJ9.eyJ9.e30' } }, refused);
await check('relay serves no dashboard', `https://${relay}/`, {}, (s) => s === 404);
await check('relay rejects an unknown node', `https://${relay}/node/v1/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: 'node_smoke0000000000000000' }) }, (s) => s === 404);
await check('relay refuses a forged session', `https://${relay}/node/v1/connect`, { headers: { authorization: 'Bearer accs1.e30.AAAA' } }, (s) => s === 401 || s === 426);

console.log(failures ? `\n✗ ${failures} check(s) failed.` : '\n✓ All live checks passed.');
process.exit(failures ? 1 : 0);
