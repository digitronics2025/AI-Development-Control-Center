import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { git, headCommit } from '@acc/git';
import { builtinProviders, PROFILE_IDS, profileIncludes, profileRank, type OperationContext, type OperationResult, type ToolOperation } from '../src/index.js';
import { compareVersions, parseAuditJson, parseOsvJson, type Advisory } from '../src/packs/security.js';
import { installFakeScanners, onlyOnPath, type FakeAdvisory } from './fixtures/fake-scanners.js';

/**
 * VER-1's security pack and the `git.commit` secret check: the secret scan in
 * each scope, the dependency audit's new-versus-baseline advisories with
 * stand-in scanners (never the network), the unverified answer when no
 * scanner works, and a refused commit. Tokens are assembled at run time.
 */

const token = () => ['gh', 'p_', 'Scan5ecr'.repeat(4), 'Tt3R'].join('');
const DB: FakeAdvisory[] = [
  { package: 'old-vulnerable', version: '2.0.0', id: 'GHSA-oldd-0000-aaaa', severity: 'MODERATE', fixed: '2.0.5', summary: 'Already there before the task' },
  { package: 'sim-vulnerable', version: '1.0.0', id: 'GHSA-simv-1111-bbbb', severity: 'HIGH', fixed: '1.0.1', summary: 'Prototype pollution in sim-vulnerable' },
];

function op(id: string): ToolOperation {
  const found = builtinProviders()
    .flatMap((p) => p.operations)
    .find((o) => o.id === id);
  if (!found) throw new Error(`no operation ${id}`);
  return found as ToolOperation;
}

let repo: string;
let base: string;
const temp = mkdtempSync(path.join(os.tmpdir(), 'acc-security-'));

function ctx(extra: Partial<OperationContext> = {}): OperationContext {
  return {
    executionId: 't',
    taskId: null,
    cwd: repo,
    roots: [repo],
    baseline: base,
    env: process.env,
    signal: new AbortController().signal,
    timeoutMs: 60_000,
    tempDir: temp,
    stateDir: temp,
    shell: async () => null,
    detection: () => undefined,
    protectedPaths: [],
    ...extra,
  };
}

const call = (id: string, input: unknown, context: OperationContext): Promise<OperationResult> => op(id).run(op(id).input.parse(input), context);

async function sh(args: string[]) {
  const r = await git(repo, args);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout;
}

const LOCK = "lockfileVersion: '9.0'\n\npackages:\n\n  old-vulnerable@2.0.0:\n    resolution: {tarball: old-vulnerable-2.0.0.tgz}\n";

beforeEach(async () => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'acc-security-repo-'));
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) await sh(args);
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
  writeFileSync(path.join(repo, 'pnpm-lock.yaml'), LOCK);
  writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\n');
  await sh(['add', '.']);
  await sh(['commit', '-m', 'init']);
  base = (await headCommit(repo))!;
});

const addVulnerable = () => appendFileSync(path.join(repo, 'pnpm-lock.yaml'), '\n  sim-vulnerable@1.0.0:\n    resolution: {tarball: sim-vulnerable-1.0.0.tgz}\n');
const ids = (list: Advisory[] | undefined) => (list ?? []).map((a) => a.id).sort();

describe('security.secret_scan', () => {
  it('finds a token the task wrote, in the change since the baseline, and names the kind, never the value', async () => {
    writeFileSync(path.join(repo, 'config.ts'), `export const githubToken = '${token()}';\n`);
    const r = await call('security.secret_scan', { scope: 'task' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({ scope: 'task', files: 1, findings: [{ path: 'config.ts', reason: 'contains what looks like a GitHub token' }] });
    expect(r.summary).toContain('config.ts contains what looks like a GitHub token');
    expect(JSON.stringify(r)).not.toContain(token());
    expect(r.evidence).toEqual(['secret scan (task): 1 file(s), 1 finding(s)']);
    // A clean change passes.
    writeFileSync(path.join(repo, 'config.ts'), "export const githubToken = process.env.GITHUB_TOKEN ?? '';\n");
    expect((await call('security.secret_scan', {}, ctx())).output).toMatchObject({ findings: [] });
  });

  it('reads the index with scope "staged" and whole files or folders with scope "paths", inside the roots only', async () => {
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src', 'old.ts'), `const t = '${token()}';\n`);
    expect((await call('security.secret_scan', { scope: 'staged' }, ctx())).output).toMatchObject({ findings: [] });
    await sh(['add', 'src/old.ts']);
    expect((await call('security.secret_scan', { scope: 'staged' }, ctx())).output).toMatchObject({ findings: [{ path: 'src/old.ts' }] });
    expect((await call('security.secret_scan', { scope: 'paths', paths: ['src'] }, ctx())).output).toMatchObject({ files: 1, findings: [{ path: 'src/old.ts' }] });
    expect((await call('security.secret_scan', { scope: 'paths', paths: ['app.ts'] }, ctx())).output).toMatchObject({ files: 1, findings: [] });
    expect((await call('security.secret_scan', { scope: 'paths', paths: ['../elsewhere'] }, ctx())).error?.code).toBe('OUTSIDE_ROOT');
    expect((await call('security.secret_scan', { scope: 'paths' }, ctx())).error?.code).toBe('INVALID_INPUT');
  });

  it('never reads through a link out of the roots: a file link or a linked folder in the task is not followed', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'acc-security-outside-'));
    mkdirSync(path.join(outside, 'dir'));
    writeFileSync(path.join(outside, 'dir', 'secret.ts'), `const t = '${token()}';\n`);
    writeFileSync(path.join(outside, 'npmrc'), `token ${token()}\n`);
    // A folder link (a junction on Windows, which needs no privilege; Git lists the files under it) ...
    symlinkSync(path.join(outside, 'dir'), path.join(repo, 'linked'), 'junction');
    // ... and a file link, where this machine may create one.
    let fileLink = true;
    try {
      symlinkSync(path.join(outside, 'npmrc'), path.join(repo, 'probe'));
    } catch {
      fileLink = false;
    }
    writeFileSync(path.join(repo, 'mine.ts'), `const t = '${token()}';\n`);
    for (const input of [{ scope: 'task' }, { scope: 'paths', paths: ['.'] }]) {
      const r = await call('security.secret_scan', input, ctx());
      expect(r.ok, r.summary).toBe(true);
      // Only the task's own file is read; nothing outside the roots is reported on.
      expect((r.output as { findings: Array<{ path: string }> }).findings.map((f) => f.path), input.scope).toEqual(['mine.ts']);
    }
    expect((await call('security.secret_scan', { scope: 'paths', paths: ['linked'] }, ctx())).error?.code).toBe('OUTSIDE_ROOT');
    if (fileLink) expect((await call('security.secret_scan', { scope: 'paths', paths: ['probe'] }, ctx())).error?.code).toBe('OUTSIDE_ROOT');
  });

  it('says there is no baseline outside a task instead of scanning something else', async () => {
    const r = await call('security.secret_scan', { scope: 'task' }, ctx({ baseline: null }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNAVAILABLE');
  });

  it('is a Level 1 read every profile offers, listed after the profile\'s own tools', () => {
    for (const id of ['security.secret_scan', 'security.dependency_audit']) {
      expect(op(id).level).toBe(1);
      expect(op(id).readOnly).toBe(true);
      for (const profile of PROFILE_IDS) expect(profileIncludes(profile, id), profile).toBe(true);
      expect(profileRank('cloudflare-worker', id)).toBeGreaterThan(profileRank('cloudflare-worker', 'process.start'));
    }
    expect(op('security.dependency_audit').classify?.({}, { cwd: repo })).toMatchObject({ effects: ['network'] });
  });
});

describe('security.dependency_audit', () => {
  it('with osv-scanner, lists the advisory the change brings in and not the one the baseline lockfile already had', async () => {
    const bin = installFakeScanners(['osv-scanner'], DB);
    addVulnerable();
    const r = await call('security.dependency_audit', {}, ctx({ env: onlyOnPath(bin) }));
    expect(r.ok, r.summary).toBe(true);
    const out = r.output as { newAdvisories: Advisory[]; advisories: Advisory[]; lockfiles: Array<{ scanner: string; baseline: string }> };
    expect(out.lockfiles).toEqual([{ path: 'pnpm-lock.yaml', scanner: 'osv-scanner', advisories: 2, new: 1, baseline: 'compared' }]);
    expect(out.newAdvisories).toEqual([{ id: 'GHSA-simv-1111-bbbb', package: 'sim-vulnerable', version: '1.0.0', severity: 'HIGH', fixedIn: '1.0.1', summary: 'Prototype pollution in sim-vulnerable', lockfile: 'pnpm-lock.yaml' }]);
    expect(ids(out.advisories)).toEqual(['GHSA-oldd-0000-aaaa', 'GHSA-simv-1111-bbbb']);
    expect(r.summary).toContain('1 new advisory since the baseline, 1 already there');
    // The baseline was audited from `git show`, in a folder of its own, never from the working tree.
    const calls = readFileSync(path.join(bin, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { cwd: string });
    expect(calls).toHaveLength(2);
    expect(path.resolve(calls[1]!.cwd)).not.toBe(path.resolve(repo));
  });

  it('falls back to pnpm audit without osv-scanner, and reads an unchanged lockfile as bringing in nothing', async () => {
    const bin = installFakeScanners(['pnpm'], DB);
    const unchanged = await call('security.dependency_audit', {}, ctx({ env: onlyOnPath(bin) }));
    expect(unchanged.output).toMatchObject({ lockfiles: [{ scanner: 'pnpm audit', baseline: 'unchanged', advisories: 1, new: 0 }], newAdvisories: [] });
    addVulnerable();
    const r = await call('security.dependency_audit', {}, ctx({ env: onlyOnPath(bin) }));
    expect(r.ok, r.summary).toBe(true);
    const out = r.output as { newAdvisories: Advisory[]; unverified?: string[] };
    expect(out.newAdvisories).toMatchObject([{ id: 'GHSA-simv-1111-bbbb', package: 'sim-vulnerable', severity: 'HIGH', fixedIn: '1.0.1' }]);
    // osv-scanner was looked for first and its absence noted.
    expect(out.unverified).toEqual(['pnpm-lock.yaml: osv-scanner is not installed']);
  });

  it('lists every advisory outside a task, and a lockfile that did not exist at the baseline brings in all of its own', async () => {
    const bin = installFakeScanners(['osv-scanner'], DB);
    const outside = await call('security.dependency_audit', {}, ctx({ env: onlyOnPath(bin), baseline: null }));
    expect(outside.output).toMatchObject({ lockfiles: [{ baseline: 'none', advisories: 1, new: 1 }] });
    mkdirSync(path.join(repo, 'web'));
    writeFileSync(path.join(repo, 'web', 'pnpm-lock.yaml'), '  sim-vulnerable@1.0.0: {}\n');
    const added = await call('security.dependency_audit', { lockfiles: ['web/pnpm-lock.yaml'] }, ctx({ env: onlyOnPath(bin) }));
    expect(added.output).toMatchObject({ lockfiles: [{ path: 'web/pnpm-lock.yaml', baseline: 'new-lockfile', new: 1 }] });
  });

  it('reports unverified, with the reasons, when no scanner works; it never passes on nothing', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'acc-no-scanners-'));
    addVulnerable();
    const r = await call('security.dependency_audit', {}, ctx({ env: onlyOnPath(empty) }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNAVAILABLE');
    expect(r.summary).toBe('Dependency audit unverified: pnpm-lock.yaml: osv-scanner is not installed; pnpm-lock.yaml: pnpm is not installed');
    expect((await call('security.dependency_audit', { lockfiles: ['nope.lock'] }, ctx({ env: onlyOnPath(empty) }))).error?.code).toBe('INVALID_INPUT');
    expect((await call('security.dependency_audit', { lockfiles: ['../x/pnpm-lock.yaml'] }, ctx())).error?.code).toBe('OUTSIDE_ROOT');
  });

  it('names each lockfile no scanner could read, with why, beside the ones that were audited', async () => {
    const bin = installFakeScanners(['pnpm'], DB);
    writeFileSync(path.join(repo, 'Cargo.lock'), 'version = 3\n');
    addVulnerable();
    const r = await call('security.dependency_audit', {}, ctx({ env: onlyOnPath(bin) }));
    expect(r.ok, r.summary).toBe(true);
    expect(r.output).toMatchObject({ status: 'partial', lockfiles: [{ path: 'pnpm-lock.yaml', scanner: 'pnpm audit' }], notAudited: [{ path: 'Cargo.lock', reason: 'osv-scanner is not installed' }] });
    expect(r.summary).toContain('Not audited: Cargo.lock (osv-scanner is not installed)');
    // Every lockfile read: nothing is left out.
    const whole = await call('security.dependency_audit', { lockfiles: ['pnpm-lock.yaml'] }, ctx({ env: onlyOnPath(bin) }));
    expect(whole.output).toMatchObject({ status: 'audited' });
    expect((whole.output as { notAudited?: unknown }).notAudited).toBeUndefined();
  });

  it('never follows a lockfile-named link out of the roots when it looks for the root\'s lockfiles', async (context) => {
    const bin = installFakeScanners(['npm', 'pnpm'], DB);
    const outside = mkdtempSync(path.join(os.tmpdir(), 'acc-security-outside-'));
    writeFileSync(path.join(outside, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, note: 'sim-vulnerable@1.0.0' }));
    try {
      symlinkSync(path.join(outside, 'package-lock.json'), path.join(repo, 'package-lock.json'));
    } catch {
      context.skip('this machine cannot create a file link');
    }
    const r = await call('security.dependency_audit', {}, ctx({ env: onlyOnPath(bin) }));
    expect(r.ok, r.summary).toBe(true);
    expect(r.output).toMatchObject({ lockfiles: [{ path: 'pnpm-lock.yaml' }], notAudited: [{ path: 'package-lock.json', reason: 'it leads outside the folders this task may touch' }] });
    expect(JSON.stringify(r.output)).not.toContain('GHSA-simv-1111-bbbb');
    // npm never read it.
    expect(readFileSync(path.join(bin, 'calls.log'), 'utf8')).not.toContain('"tool":"npm"');
    // Named, it is refused as before; alone at the root, it leaves nothing to audit.
    expect((await call('security.dependency_audit', { lockfiles: ['package-lock.json'] }, ctx({ env: onlyOnPath(bin) }))).error?.code).toBe('OUTSIDE_ROOT');
    await sh(['rm', '-q', 'pnpm-lock.yaml']);
    expect((await call('security.dependency_audit', {}, ctx({ env: onlyOnPath(bin) }))).error?.code).toBe('OUTSIDE_ROOT');
  });

  it.runIf(process.platform === 'win32')('never runs a node.cmd the repository holds when the pnpm shim calls a bare node', async () => {
    const bin = installFakeScanners(['pnpm'], DB);
    // The shape of npm's pnpm.cmd with no node.exe beside it: cmd.exe looks for `node` in the current folder first.
    writeFileSync(path.join(bin, 'pnpm.cmd'), '@node "%~dp0pnpm.cjs" %*\r\n');
    const marker = path.join(temp, `node-cmd-ran-${Date.now()}.txt`);
    writeFileSync(path.join(repo, 'node.cmd'), `@echo ran> "${marker}"\r\n`);
    addVulnerable();
    // The caller's own environment does not already turn the current-folder lookup off.
    const env = Object.fromEntries(Object.entries(onlyOnPath(`${bin}${path.delimiter}${path.dirname(process.execPath)}`)).filter(([name]) => name.toUpperCase() !== 'NODEFAULTCURRENTDIRECTORYINEXEPATH'));
    const r = await call('security.dependency_audit', {}, ctx({ env }));
    expect(existsSync(marker)).toBe(false);
    expect(r.ok, r.summary).toBe(true);
    expect(r.output).toMatchObject({ newAdvisories: [{ id: 'GHSA-simv-1111-bbbb' }] });
  });

  it('reports unverified when npm or pnpm audit prints its error object (a registry it cannot reach), never zero advisories', async () => {
    const unreachable = 'request to http://127.0.0.1:1/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:1';
    const bin = installFakeScanners(['npm', 'pnpm'], DB, { registryError: unreachable });
    // The change adds a vulnerable package: an audit that could not ask the registry must not say it brings in nothing.
    writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/sim-vulnerable': { version: '1.0.0' } }, note: 'sim-vulnerable@1.0.0' }));
    addVulnerable();
    for (const lockfile of ['package-lock.json', 'pnpm-lock.yaml']) {
      const r = await call('security.dependency_audit', { lockfiles: [lockfile] }, ctx({ env: onlyOnPath(bin) }));
      expect(r.ok, lockfile).toBe(false);
      expect(r.error?.code).toBe('UNAVAILABLE');
      expect(r.output).toMatchObject({ status: 'unverified' });
      expect(r.summary).toContain(`Dependency audit unverified: ${lockfile}: osv-scanner is not installed; ${lockfile}: ${lockfile === 'pnpm-lock.yaml' ? 'pnpm' : 'npm'} audit failed (exit 1): ${unreachable}`);
    }
  });
});

describe('advisory parsing', () => {
  it('reads osv-scanner groups as one advisory each, with the first fixed version above the pinned one', () => {
    const json = JSON.stringify({
      results: [
        {
          source: { path: '/r/package-lock.json' },
          packages: [
            {
              package: { name: 'lodash', version: '4.17.20', ecosystem: 'npm' },
              vulnerabilities: [
                { id: 'CVE-2021-23337', summary: 'alias' },
                {
                  id: 'GHSA-35jh-r3h4-6jhm',
                  summary: 'Command Injection in lodash',
                  database_specific: { severity: 'HIGH' },
                  affected: [{ package: { name: 'lodash' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.9' }, { introduced: '4.17.10' }, { fixed: '4.17.21' }] }] }],
                },
              ],
              groups: [{ ids: ['CVE-2021-23337', 'GHSA-35jh-r3h4-6jhm'], max_severity: '7.2' }],
            },
            { package: { name: 'minimist', version: '1.2.5' }, vulnerabilities: [{ id: 'OSV-1', summary: 'no severity named' }], groups: [{ ids: ['OSV-1'], max_severity: '9.8' }] },
          ],
        },
      ],
    });
    expect(parseOsvJson(json, 'package-lock.json')).toEqual([
      { id: 'GHSA-35jh-r3h4-6jhm', package: 'lodash', version: '4.17.20', severity: 'HIGH', fixedIn: '4.17.21', summary: 'Command Injection in lodash', lockfile: 'package-lock.json' },
      { id: 'OSV-1', package: 'minimist', version: '1.2.5', severity: 'CRITICAL', fixedIn: null, summary: 'no severity named', lockfile: 'package-lock.json' },
    ]);
  });

  it('reads npm 7+ audit reports, skipping entries that only inherit a problem', () => {
    const json = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        lodash: { name: 'lodash', severity: 'high', via: [{ source: 1096310, name: 'lodash', title: 'Command Injection', url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', severity: 'high', range: '<4.17.21' }], fixAvailable: true },
        wrapper: { name: 'wrapper', severity: 'high', via: ['lodash'], fixAvailable: { name: 'wrapper', version: '2.0.0' } },
      },
    });
    expect(parseAuditJson(json, 'package-lock.json')).toEqual([{ id: 'GHSA-35jh-r3h4-6jhm', package: 'lodash', version: null, severity: 'HIGH', fixedIn: '4.17.21', summary: 'Command Injection', lockfile: 'package-lock.json' }]);
  });

  it('refuses JSON that is not an audit report instead of reading it as no advisories', () => {
    const npmError = JSON.stringify({ message: 'request to https://registry.example/-/npm/v1/security/audits/quick failed', error: { code: 'ECONNREFUSED' } });
    expect(() => parseAuditJson(npmError, 'package-lock.json')).toThrow('request to https://registry.example/-/npm/v1/security/audits/quick failed');
    expect(() => parseAuditJson(JSON.stringify({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } }), 'package-lock.json')).toThrow('This command requires an existing lockfile.');
    expect(() => parseAuditJson('{}', 'pnpm-lock.yaml')).toThrow('the output is not an audit report');
    expect(() => parseOsvJson(JSON.stringify({ error: 'no package sources found' }), 'pnpm-lock.yaml')).toThrow('no package sources found');
    expect(() => parseOsvJson('{}', 'pnpm-lock.yaml')).toThrow('the output is not an audit report');
    // A clean report is still a clean report.
    expect(parseAuditJson(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} }), 'package-lock.json')).toEqual([]);
    expect(parseAuditJson(JSON.stringify({ actions: [], advisories: {}, muted: [], metadata: {} }), 'pnpm-lock.yaml')).toEqual([]);
    expect(parseOsvJson(JSON.stringify({ results: [] }), 'pnpm-lock.yaml')).toEqual([]);
  });

  it('compares versions part by part', () => {
    expect(compareVersions('4.17.9', '4.17.21')).toBeLessThan(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
  });
});

describe('git.commit', () => {
  it('refuses to commit a file holding a token: a failure naming it, nothing committed, nothing left staged', async () => {
    writeFileSync(path.join(repo, 'config.ts'), `export const githubToken = '${token()}';\n`);
    const r = await call('git.commit', { paths: ['config.ts'], message: 'add config' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('DENIED');
    expect(r.summary).toContain('config.ts contains what looks like a GitHub token');
    expect(r.output).toEqual({ findings: [{ path: 'config.ts', reason: 'contains what looks like a GitHub token' }] });
    expect(JSON.stringify(r)).not.toContain(token());
    expect(await headCommit(repo)).toBe(base);
    expect(await sh(['diff', '--cached', '--name-only'])).toBe('');
    // Once the token is gone, the same call commits.
    writeFileSync(path.join(repo, 'config.ts'), "export const githubToken = process.env.GITHUB_TOKEN ?? '';\n");
    const ok = await call('git.commit', { paths: ['config.ts'], message: 'add config' }, ctx());
    expect(ok.ok, ok.summary).toBe(true);
    expect(await headCommit(repo)).not.toBe(base);
  });
});
