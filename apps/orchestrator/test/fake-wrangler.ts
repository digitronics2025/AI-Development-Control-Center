import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A stand-in for Wrangler in the repository's node_modules/.bin: it records
 * its arguments, whether the management token arrived, whether the secret
 * leaked into its environment, and stores what it read on stdin — so a test
 * can prove the value travelled by stdin and nowhere else. State lives in the
 * file named by FAKE_WRANGLER_STATE (pass it in the test app's baseEnv).
 *
 * Tests that reach a Wrangler operation install this rather than depend on a
 * global Wrangler, which CI runners do not have (audit F-17).
 */
const FAKE_WRANGLER = `
const fs = require('fs');
const state = process.env.FAKE_WRANGLER_STATE;
const mode = fs.existsSync(state + '.mode') ? fs.readFileSync(state + '.mode', 'utf8').trim() : 'ok';
const log = (entry) => fs.appendFileSync(state + '.log', JSON.stringify(entry) + '\\n');
const args = process.argv.slice(2);
const data = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {};
const envOf = (a) => (a.includes('--env') ? a[a.indexOf('--env') + 1] : 'default');
if (args[0] === 'secret' && args[1] === 'put') {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const value = Buffer.concat(chunks).toString('utf8');
    log({ args, token: Boolean(process.env.CLOUDFLARE_API_TOKEN), envHasValue: Object.values(process.env).includes(value) });
    if (mode === 'auth') { console.error('Authentication error [code: 10000]: check CLOUDFLARE_API_TOKEN'); process.exit(1); }
    data[args[2] + '@' + envOf(args)] = value;
    fs.writeFileSync(state, JSON.stringify(data));
    console.log('Success! Uploaded secret ' + args[2]);
  });
} else if (args[0] === 'secret' && args[1] === 'list') {
  log({ args });
  const env = envOf(args);
  console.log(JSON.stringify(mode === 'unverified' ? [] : Object.keys(data).filter((k) => k.endsWith('@' + env)).map((k) => ({ name: k.split('@')[0], type: 'secret_text' }))));
} else {
  log({ args });
  console.log('4.129.0');
}
`;

export function fakeWranglerFiles(): Record<string, string> {
  return {
    'node_modules/.bin/fake-wrangler.cjs': FAKE_WRANGLER,
    'node_modules/.bin/wrangler.cmd': '@node "%~dp0fake-wrangler.cjs" %*\r\n',
    'node_modules/.bin/wrangler': '#!/bin/sh\nexec node "$(dirname "$0")/fake-wrangler.cjs" "$@"\n',
  };
}

/** Put the stand-in Wrangler into a repository's node_modules/.bin. */
export function installFakeWrangler(repoPath: string): void {
  mkdirSync(path.join(repoPath, 'node_modules', '.bin'), { recursive: true });
  for (const [file, content] of Object.entries(fakeWranglerFiles())) writeFileSync(path.join(repoPath, file), content);
  if (process.platform !== 'win32') chmodSync(path.join(repoPath, 'node_modules', '.bin', 'wrangler'), 0o755);
}
