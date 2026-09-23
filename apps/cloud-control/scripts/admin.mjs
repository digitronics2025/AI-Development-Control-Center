#!/usr/bin/env node
// Emergency administration of the cloud control plane through Wrangler — it works
// even when Cloudflare Access or the dashboard is unavailable, because it writes D1
// directly with the operator's own Wrangler login (docs/systems/cloud-control.md).
//
//   node scripts/admin.mjs pair-code --env production [--label "Desk PC"]
//   node scripts/admin.mjs revoke    --env production --node node_xxxxxxxx
//   node scripts/admin.mjs nodes     --env production
//
// A revoked node is refused at its next session at once and its live socket is
// closed at its next heartbeat (within about a minute).
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const env = flag('env');
const DATABASES = { staging: 'acc-control-staging', production: 'acc-control-production' };
if (!DATABASES[env]) {
  console.error('Choose --env staging or --env production.');
  process.exit(2);
}
const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

function d1(sql) {
  const r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'd1', 'execute', DATABASES[env], '--remote', '--env', env, '--json', '--command', sql], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(1);
  }
  return JSON.parse(r.stdout)[0].results;
}

if (command === 'pair-code') {
  const token = `accpair_${randomBytes(32).toString('base64url')}`;
  // Same hash the Worker uses (auth/node.ts secretHash): the code itself is never stored.
  const hash = createHash('sha256').update(`acc-cloud:${token}`).digest('hex');
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  const label = flag('label', 'Paired from the admin CLI');
  d1(`INSERT INTO pairing_tokens (id, token_hash, label, created_by, created_at, expires_at) VALUES (${sqlString(randomUUID())}, ${sqlString(hash)}, ${sqlString(label)}, 'admin-cli', ${sqlString(new Date().toISOString())}, ${sqlString(expires)});
      INSERT INTO audit_events (at, actor, action, result) VALUES (${sqlString(new Date().toISOString())}, 'admin-cli', 'pairing.create', 'ok');`);
  console.log(`Pairing code (works once, until ${expires}):\n\n  ${token}\n`);
} else if (command === 'revoke') {
  const node = flag('node');
  if (!/^node_[A-Za-z0-9_-]{16,64}$/.test(node ?? '')) {
    console.error('Give --node node_… (see: nodes).');
    process.exit(2);
  }
  const ts = new Date().toISOString();
  d1(`UPDATE nodes SET revoked_at = ${sqlString(ts)}, revoked_by = 'admin-cli', status = 'offline' WHERE id = ${sqlString(node)} AND revoked_at IS NULL;
      UPDATE remote_commands SET status = 'rejected', error_code = 'NODE_REVOKED', finished_at = ${sqlString(ts)} WHERE node_id = ${sqlString(node)} AND status IN ('pending','delivered');
      UPDATE repository_leases SET released_at = ${sqlString(ts)} WHERE node_id = ${sqlString(node)} AND released_at IS NULL;
      INSERT INTO audit_events (at, actor, action, node_id, result) VALUES (${sqlString(ts)}, 'admin-cli', 'node.revoke', ${sqlString(node)}, 'ok');`);
  console.log(`Revoked ${node}. New sessions are refused now; the live connection closes at its next heartbeat.`);
} else if (command === 'nodes') {
  for (const n of d1('SELECT id, label, status, last_seen_at, revoked_at, key_version FROM nodes ORDER BY created_at')) console.log(`${n.id}  ${n.label}  ${n.revoked_at ? 'REVOKED' : n.status}  last seen ${n.last_seen_at ?? 'never'}  key v${n.key_version}`);
} else {
  console.error('Commands: pair-code, revoke, nodes (with --env staging|production).');
  process.exit(2);
}
