import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Stand-ins for osv-scanner, `pnpm audit` and `npm audit` (VER-1), so the
 * dependency audit is proven offline: each reads the lockfile it is given (or
 * the one in its folder) and reports the advisories of a fixed database for
 * every `name@version` the lockfile text names, in the real tool's JSON shape.
 * Nothing reaches the network. Put the returned folder first on PATH (or
 * alone on it, so a real scanner on this machine is never found).
 */
export interface FakeAdvisory {
  package: string;
  version: string;
  id: string;
  severity: string;
  fixed: string | null;
  summary: string;
}

const SCRIPT = (tool: string, db: FakeAdvisory[], registryError: string | null) => `
const fs = require('fs');
const path = require('path');
const DB = ${JSON.stringify(db)};
const TOOL = ${JSON.stringify(tool)};
const REGISTRY_ERROR = ${JSON.stringify(registryError)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify({ tool: TOOL, args, cwd: process.cwd() }) + '\\n');
if (args.includes('--version')) { console.log(TOOL === 'osv-scanner' ? 'osv-scanner version: 2.0.0' : '10.0.0'); process.exit(0); }
const hits = (text) => DB.filter((a) => text.includes(a.package + '@' + a.version));
if (TOOL === 'osv-scanner') {
  const file = args[args.indexOf('-L') + 1];
  const found = hits(fs.readFileSync(path.resolve(file), 'utf8'));
  const packages = found.map((a) => ({
    package: { name: a.package, version: a.version, ecosystem: 'npm' },
    vulnerabilities: [{ id: a.id, summary: a.summary, affected: [{ package: { ecosystem: 'npm', name: a.package }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }].concat(a.fixed ? [{ fixed: a.fixed }] : []) }] }], database_specific: { severity: a.severity } }],
    groups: [{ ids: [a.id], max_severity: '7.5' }],
  }));
  console.log(JSON.stringify({ results: packages.length ? [{ source: { path: path.resolve(file), type: 'lockfile' }, packages }] : [] }, null, 2));
  process.exit(packages.length ? 1 : 0);
}
const lock = TOOL === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';
if (!fs.existsSync(lock)) { console.error('No ' + lock + ' found'); process.exit(1); }
// An unreachable registry: npm 10 and pnpm print their error as a JSON object on stdout and exit 1, as for findings.
if (REGISTRY_ERROR) {
  console.log(JSON.stringify(TOOL === 'npm' ? { message: REGISTRY_ERROR, error: { code: 'ECONNREFUSED', errno: 'ECONNREFUSED', type: 'system' } } : { error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE', message: REGISTRY_ERROR } }, null, 2));
  process.exit(1);
}
const found = hits(fs.readFileSync(lock, 'utf8'));
if (TOOL === 'pnpm') {
  const advisories = {};
  found.forEach((a, i) => { advisories[String(1000 + i)] = { id: 1000 + i, github_advisory_id: a.id, module_name: a.package, severity: a.severity.toLowerCase(), title: a.summary, patched_versions: a.fixed ? '>=' + a.fixed : '<0.0.0', findings: [{ version: a.version, paths: ['.'] }] }; });
  console.log(JSON.stringify({ actions: [], advisories, muted: [], metadata: {} }, null, 2));
} else {
  const vulnerabilities = {};
  found.forEach((a) => { vulnerabilities[a.package] = { name: a.package, severity: a.severity.toLowerCase(), via: [{ source: 1, name: a.package, title: a.summary, url: 'https://github.com/advisories/' + a.id, severity: a.severity.toLowerCase(), range: a.fixed ? '<' + a.fixed : '*' }], fixAvailable: a.fixed ? { name: a.package, version: a.fixed } : false }; });
  console.log(JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: {} }, null, 2));
}
process.exit(found.length ? 1 : 0);
`;

/**
 * Write the named stand-ins into a fresh folder and return it. With
 * `registryError`, pnpm and npm answer as they do when the registry cannot be
 * reached: their JSON error object instead of a report.
 */
export function installFakeScanners(tools: Array<'osv-scanner' | 'pnpm' | 'npm'>, db: FakeAdvisory[], options: { registryError?: string } = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-fake-scanners-'));
  mkdirSync(dir, { recursive: true });
  for (const tool of tools) {
    writeFileSync(path.join(dir, `${tool}.cjs`), SCRIPT(tool, db, options.registryError ?? null));
    writeFileSync(path.join(dir, `${tool}.cmd`), `@"${process.execPath}" "%~dp0${tool}.cjs" %*\r\n`);
    writeFileSync(path.join(dir, tool), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${tool}.cjs" "$@"\n`);
    if (process.platform !== 'win32') chmodSync(path.join(dir, tool), 0o755);
  }
  return dir;
}

/** `env` with PATH replaced by `dir` alone: only the stand-ins can be found. */
export function onlyOnPath(dir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: dir };
}
