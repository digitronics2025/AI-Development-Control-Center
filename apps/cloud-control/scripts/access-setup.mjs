#!/usr/bin/env node
// Turn on Cloudflare Access for one environment (docs/systems/cloud-control.md §Access):
//
//   node scripts/access-setup.mjs --env production --team <team>.cloudflareaccess.com \
//     --aud <application audience tag> --email you@example.com[,other@example.com] [--no-deploy]
//
// Run it after the self-hosted Access application exists for the control hostname
// (the relay hostname must NOT be behind Access: nodes authenticate with their own keys).
// It writes the team domain, the audience tag and the allowed emails into that
// environment's vars in wrangler.jsonc, then releases with scripts/deploy.mjs, whose
// smoke check proves the control host still refuses anyone without a sign-in.
// None of these values is a secret; commit the changed wrangler.jsonc afterwards.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const env = flag('env');
const team = (flag('team') ?? '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
const aud = (flag('aud') ?? '').trim().toLowerCase();
const emails = (flag('email') ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const problems = [];
if (!['staging', 'production'].includes(env)) problems.push('--env staging|production');
if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) problems.push('--team <team>.cloudflareaccess.com (Zero Trust → Settings shows the team domain)');
if (!/^[a-f0-9]{64}$/.test(aud)) problems.push('--aud <64-character Application Audience (AUD) tag from the Access application>');
if (!emails.length || emails.some((e) => !/^[^\s@,"]+@[^\s@,"]+\.[^\s@,"]+$/.test(e))) problems.push('--email you@example.com[,other@example.com]');
if (problems.length) {
  console.error(`Missing or invalid:\n  ${problems.join('\n  ')}`);
  process.exit(2);
}

// Edit only the chosen environment's block, keeping comments and layout.
const file = path.join(root, 'wrangler.jsonc');
const config = readFileSync(file, 'utf8');
const start = config.indexOf(`"${env}": {`);
const varsAt = start === -1 ? -1 : config.indexOf('"vars": {', start);
const varsEnd = varsAt === -1 ? -1 : config.indexOf('}', varsAt);
if (varsEnd === -1) {
  console.error(`✗ Could not find the ${env} vars block in wrangler.jsonc.`);
  process.exit(1);
}
let vars = config.slice(varsAt, varsEnd);
const set = (name, value) => {
  const re = new RegExp(`"${name}":\\s*"[^"]*"`);
  if (re.test(vars)) vars = vars.replace(re, `"${name}": "${value}"`);
  else vars = vars.replace(/\s*$/, `,\n        "${name}": "${value}"\n      `);
};
set('ACCESS_TEAM_DOMAIN', team);
set('ACCESS_AUD', aud);
set('ALLOWED_EMAILS', emails.join(','));
writeFileSync(file, config.slice(0, varsAt) + vars + config.slice(varsEnd));
console.log(`• wrangler.jsonc (${env}): ACCESS_TEAM_DOMAIN=${team}, ACCESS_AUD=${aud.slice(0, 8)}…, ALLOWED_EMAILS=${emails.join(',')}`);

if (args.includes('--no-deploy')) {
  console.log('• Not released (--no-deploy). Release with: node scripts/deploy.mjs ' + env);
  process.exit(0);
}
const deploy = spawnSync(process.execPath, [path.join(root, 'scripts', 'deploy.mjs'), env], { stdio: 'inherit' });
if (deploy.status === 0) console.log(`\n✓ Access is on for ${env}. Open the control hostname in a browser: you should see the Cloudflare sign-in, then the dashboard.`);
process.exit(deploy.status ?? 1);
