import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assessVerification,
  builtinProviders,
  classifyFailure,
  decide,
  missing,
  operation,
  planRepair,
  policyCeiling,
  profileForRepository,
  profileIncludes,
  profileRank,
  PROFILES,
  projectType,
  ToolRegistry,
  ToolRouter,
  type ToolDetection,
  type ToolProvider,
} from '../src/index.js';

const installed: ToolDetection = { installed: true, version: '1.0', path: '/x', auth: { required: false, state: 'not_required', message: null }, message: null };

function provider(id: string, capability: string, extra: Partial<ToolProvider> = {}): ToolProvider {
  return {
    id,
    name: id,
    description: id,
    category: 'network',
    detect: async () => installed,
    operations: [operation({ id: capability, title: capability, description: capability, input: z.object({}), level: 1, run: async () => ({ ok: true, summary: id }) })],
    ...extra,
  };
}

describe('ToolRegistry', () => {
  it('registers, looks up, searches and unregisters capabilities', () => {
    const r = new ToolRegistry();
    r.register(provider('a', 'network.port_owner'));
    r.register(provider('b', 'network.port_owner'));
    r.register(provider('c', 'git.status', { category: 'git' }));
    expect(r.offering('network.port_owner').map((o) => o.provider.id)).toEqual(['a', 'b']);
    expect(r.capabilities().map((c) => c.id)).toEqual(['git.status', 'network.port_owner']);
    expect(r.search('port owner')[0]!.id).toBe('network.port_owner');
    expect(r.listProviders({ category: 'git' }).map((p) => p.id)).toEqual(['c']);
    r.unregister('a');
    expect(r.offering('network.port_owner').map((o) => o.provider.id)).toEqual(['b']);
    expect(() => r.register(provider('bad', 'NotValid'))).toThrow(/Invalid capability id/);
  });

  it('registers every built-in pack without id clashes', () => {
    const r = new ToolRegistry();
    for (const p of builtinProviders()) r.register(p);
    const caps = r.capabilities().map((c) => c.id);
    expect(caps.length).toBeGreaterThan(90);
    for (const needed of ['shell.powershell', 'shell.run', 'fs.read', 'git.status', 'git.bisect', 'browser.check_page', 'http.request', 'network.port_owner', 'cloudflare.deploy', 'cloudflare.d1_query', 'database.sqlite_query', 'docker.run', 'android.install_apk', 'process.start', 'terminal.send', 'checkpoint.restore', 'verify.web', 'system.privileged']) {
      expect(caps, needed).toContain(needed);
    }
  });
});

describe('ToolRouter', () => {
  const registry = new ToolRegistry();
  registry.register(provider('windows', 'network.port_owner', { preference: 10, platforms: ['win32'] }));
  registry.register(provider('netstat', 'network.port_owner', { preference: 50 }));
  registry.register(provider('adb', 'android.devices'));
  const router = new ToolRouter(registry);
  const all = () => installed;

  it('prefers the preferred provider on its platform and says why', () => {
    const d = router.route({ capability: 'network.port_owner', platform: 'win32', detection: all });
    expect(d.ok && d.route.provider.id).toBe('windows');
    expect(d.ok && d.reason).toMatch(/preferred provider/);
    expect(d.alternatives).toEqual(['netstat']);
  });

  it('falls back off-platform, after failures, and when the preferred tool is missing', () => {
    expect(router.route({ capability: 'network.port_owner', platform: 'linux', detection: all }).ok && router.route({ capability: 'network.port_owner', platform: 'linux', detection: all })).toMatchObject({ route: { provider: { id: 'netstat' } } });
    const failed = router.route({ capability: 'network.port_owner', platform: 'win32', detection: all, failures: new Map([['windows', 2]]) });
    expect(failed.ok && failed.route.provider.id).toBe('netstat');
    expect(failed.ok && failed.reason).toMatch(/others failed earlier/);
    // A failure of an unrelated tool (another capability) does not explain this choice.
    const unrelated = router.route({ capability: 'network.port_owner', platform: 'win32', detection: all, failures: new Map([['node', 1]]) });
    expect(unrelated.ok && unrelated.reason).not.toMatch(/failed earlier/);
    const noWindows = router.route({ capability: 'network.port_owner', platform: 'win32', detection: (id) => (id === 'windows' ? missing('gone') : installed) });
    expect(noWindows.ok && noWindows.route.provider.id).toBe('netstat');
  });

  it('explains unknown and uninstalled capabilities', () => {
    const unknown = router.route({ capability: 'network.port_ownr', detection: all });
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.code).toBe('UNKNOWN_CAPABILITY');
    const absent = router.route({ capability: 'android.devices', detection: () => missing('adb was not found on PATH') });
    expect(!absent.ok && absent.reason).toMatch(/adb was not found/);
  });
});

describe('profiles', () => {
  it('picks a profile from repository tooling and level', () => {
    expect(profileForRepository(['node', 'pnpm', 'react', 'vite'], 2)).toBe('web-development');
    expect(profileForRepository(['node', 'wrangler'], 2)).toBe('cloudflare-worker');
    expect(profileForRepository(['gradle'], 2)).toBe('android-development');
    expect(profileForRepository(['react'], 1)).toBe('analysis');
  });

  it('includes by pattern and keeps MCP opt-in', () => {
    expect(profileIncludes('web-development', 'browser.check_page')).toBe(true);
    expect(profileIncludes('web-development', 'android.install_apk')).toBe(false);
    expect(profileIncludes('analysis', 'fs.write')).toBe(true); // level, not profile, stops writes in Analyze stages
    expect(profileIncludes('general', 'mcp.github.create_issue')).toBe(false);
    expect(profileIncludes('operator', 'mcp.github.create_issue')).toBe(true);
  });

  it('lets every stage look at pages and read the web, and only building stages act on pages', () => {
    for (const id of ['analysis', 'general', 'web-development', 'cloudflare-worker'] as const) {
      for (const cap of ['browser.open', 'browser.snapshot', 'browser.logs', 'browser.close', 'web.search', 'web.read']) expect(profileIncludes(id, cap), `${id} ${cap}`).toBe(true);
    }
    expect(profileIncludes('analysis', 'browser.act')).toBe(false);
    expect(profileIncludes('analysis', 'browser.evaluate')).toBe(false);
    expect(profileIncludes('web-development', 'browser.act')).toBe(true);
    expect(profileIncludes('python', 'web.search')).toBe(true);
  });

  it('ranks a profile’s speciality before general tools, and escalations last', () => {
    expect(profileRank('cloudflare-worker', 'cloudflare.logs_query')).toBe(0);
    expect(profileRank('cloudflare-worker', 'browser.open')).toBeLessThan(profileRank('cloudflare-worker', 'process.start'));
    expect(profileRank('cloudflare-worker', 'process.start')).toBeLessThan(profileRank('cloudflare-worker', 'github.pr_create'));
    expect(profileRank('web-development', 'android.install_apk')).toBe(PROFILES['web-development'].include.length);
    expect(profileRank('operator', 'git.push')).toBe(0);
  });
});

describe('policy', () => {
  const risk = (level: 1 | 2 | 3 | 4 | 5, extra: object = {}) => ({ level, risk: 'normal' as const, reasons: ['x'], effects: [], production: false, ...extra });
  const base = { mode: 'autopilot' as const, autoApproveUpToLevel: 3 as const, stageLevel: 3 as const, inProfile: true, origin: 'agent' as const };

  it('computes ceilings per mode', () => {
    expect(policyCeiling('safe', 3)).toBe(2);
    expect(policyCeiling('autopilot', 3)).toBe(3);
    expect(policyCeiling('full', 3)).toBe(4);
  });

  it('allows, escalates, refuses and asks as specified', () => {
    expect(decide({ ...base, risk: risk(2) }).decision).toBe('allow');
    expect(decide({ ...base, risk: risk(2), inProfile: false }).decision).toBe('escalate');
    expect(decide({ ...base, risk: risk(3), stageLevel: 1 }).decision).toBe('deny');
    expect(decide({ ...base, risk: risk(4), stageLevel: 4 }).decision).toBe('deny');
    expect(decide({ ...base, risk: risk(4), stageLevel: 4, origin: 'engine' })).toMatchObject({ decision: 'approval', typedConfirmation: false });
    expect(decide({ ...base, risk: risk(4), stageLevel: 4, mode: 'full' }).decision).toBe('allow');
    expect(decide({ ...base, risk: risk(3), mode: 'safe', origin: 'operator' }).decision).toBe('approval');
  });

  it('always asks a person for dangerous or production work, even in Full Autopilot+', () => {
    expect(decide({ ...base, mode: 'full', stageLevel: 5, risk: risk(5, { risk: 'dangerous' }), origin: 'operator' })).toMatchObject({ decision: 'approval', typedConfirmation: true });
    expect(decide({ ...base, mode: 'full', stageLevel: 5, risk: risk(4, { production: true }) }).decision).toBe('deny');
  });
});

describe('recovery classification', () => {
  it.each([
    ["Error: Cannot find module 'left-pad'", 'missing_dependency'],
    ['Error: listen EADDRINUSE: address already in use 127.0.0.1:5173', 'port_conflict'],
    ["'vitest' is not recognized as an internal or external command,", 'missing_command'],
    ['npm ERR! network request to https://registry.npmjs.org failed, reason: socket hang up', 'transient_network'],
    ["EBUSY: resource busy or locked, rename 'dist'", 'file_lock'],
    ["browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium-1\\chrome.exe", 'missing_browser'],
    ['Tests  3 failed | 10 passed (13)', 'test_failure'],
    ["src/a.ts(3,1): error TS2304: Cannot find name 'x'.", 'build_failure'],
  ])('%s → %s', (line, category) => {
    expect(classifyFailure(['noise', line]).category).toBe(category);
  });

  it('plans bounded repairs and never repairs real failures', () => {
    const ctx = { packageManager: 'pnpm', hasRequirementsTxt: false, declaredDependencies: ['vitest'], nodeModulesPresent: false, attempted: [] };
    const missingModule = classifyFailure("Cannot find module 'x'");
    expect(planRepair(missingModule, ctx)).toMatchObject({ strategy: 'install_dependencies', command: 'pnpm install --frozen-lockfile' });
    expect(planRepair(missingModule, { ...ctx, attempted: ['install_dependencies'] })).toMatchObject({ strategy: 'install_dependencies_unfrozen', command: 'pnpm install' });
    expect(planRepair(missingModule, { ...ctx, attempted: ['install_dependencies', 'install_dependencies_unfrozen'] })).toBeNull();
    expect(planRepair(classifyFailure("'rustc' is not recognized as an internal or external command"), { ...ctx, nodeModulesPresent: true })).toBeNull();
    expect(planRepair(classifyFailure('EADDRINUSE :::3000'), ctx)).toMatchObject({ strategy: 'free_port', port: 3000 });
    expect(planRepair(classifyFailure('ECONNRESET'), { ...ctx, attempted: ['retry_after_backoff', 'retry_after_backoff'] })).toBeNull();
    expect(planRepair(classifyFailure('Tests 1 failed'), ctx)).toBeNull();
    expect(planRepair(classifyFailure('', { timedOut: true }), ctx)).toBeNull();
  });

  it('does not treat a missing project file as a missing dependency', () => {
    const ctx = { packageManager: 'npm', hasRequirementsTxt: false, declaredDependencies: [], nodeModulesPresent: false, attempted: [] };
    for (const line of [
      "Error: Cannot find module '/home/me/shop/test'",
      "Error: Cannot find module './src/cart.mjs'",
      "Error: Cannot find module '..'",
      "Error: Cannot find module 'C:\\code\\shop\\test'",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'file:///home/me/shop/src/missing.mjs' imported from /home/me/shop/test/a.test.mjs",
    ]) {
      const failure = classifyFailure(['noise', line]);
      expect(failure.category, line).not.toBe('missing_dependency');
      expect(planRepair(failure, ctx), line).toBeNull();
    }
    // A package is still a dependency, scoped or not.
    expect(classifyFailure("Error: Cannot find module '@acme/ui'").category).toBe('missing_dependency');
    expect(classifyFailure("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from /app/src/a.js").category).toBe('missing_dependency');
  });
});

describe('verification matrix', () => {
  it('requires only relevant checks per project type', () => {
    expect(projectType(['node', 'react', 'vite'])).toBe('web');
    const web = assessVerification('web', { passedKinds: new Set(['test', 'build', 'lint']), observed: new Set() });
    expect(web.blocking.map((c) => c.id)).toEqual(['browser']);
    const withBrowser = assessVerification('web', { passedKinds: new Set(['test', 'build']), observed: new Set(['browser']) });
    expect(withBrowser.blocking).toEqual([]);
    expect(assessVerification('library', { passedKinds: new Set(['test']), observed: new Set() }).blocking).toEqual([]);
    // A plain Node server checked in a browser gets credit for it.
    const plain = assessVerification('library', { passedKinds: new Set(['test']), observed: new Set(['browser']) });
    expect(plain.satisfied.map((c) => c.id)).toEqual(['tests', 'browser']);
    expect(plain.blocking).toEqual([]);
    expect(withBrowser.satisfied.filter((c) => c.id === 'browser')).toHaveLength(1);
  });
});
