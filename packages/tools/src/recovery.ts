/**
 * Tool-level recovery (V2 plan §17): recognise failures that are about the
 * environment rather than the code, and say how to repair them. Real test
 * and build failures are recognised too — but only so they are never
 * "repaired": they belong to the fix loop and the Chairman.
 */

export const FAILURE_CATEGORIES = [
  'missing_dependency',
  'missing_command',
  'port_conflict',
  'transient_network',
  'file_lock',
  'missing_browser',
  'rate_limit',
  'auth_failure',
  'timeout',
  'test_failure',
  'build_failure',
  'unknown',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const FAILURE_LABEL: Record<FailureCategory, string> = {
  missing_dependency: 'Missing dependency',
  missing_command: 'Missing command',
  port_conflict: 'Port already in use',
  transient_network: 'Network hiccup',
  file_lock: 'File locked by another process',
  missing_browser: 'Browser not installed',
  rate_limit: 'Rate limited',
  auth_failure: 'Authentication needed',
  timeout: 'Timed out',
  test_failure: 'Test failure',
  build_failure: 'Build failure',
  unknown: 'Unrecognised failure',
};

export interface FailureClassification {
  category: FailureCategory;
  /** The output line that decided it (bounded), shown as evidence. */
  evidence: string | null;
  detail: { module?: string; command?: string; port?: number };
}

interface Rule {
  category: FailureCategory;
  test: RegExp;
  detail?: (m: RegExpExecArray) => FailureClassification['detail'];
}

// Order matters: the first rule that matches any line wins.
const RULES: Rule[] = [
  { category: 'missing_browser', test: /Executable doesn't exist at .*ms-playwright|Looks like Playwright .* was just installed or updated|npx playwright install|browserType\.launch: .*(?:not found|doesn't exist)/i },
  { category: 'port_conflict', test: /EADDRINUSE[^\n]*?:(\d{2,5})\b/i, detail: (m) => ({ port: Number(m[1]) }) },
  { category: 'port_conflict', test: /(?:address already in use|Port|port)\D{0,20}?(\d{2,5}) (?:is )?(?:already )?(?:in use|allocated)/i, detail: (m) => ({ port: Number(m[1]) }) },
  { category: 'missing_dependency', test: /ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH|Run `?(?:npm|pnpm|yarn)(?: install)?`? (?:to install|first)|node_modules (?:is )?missing|Local package\.json exists, but node_modules missing/i },
  { category: 'missing_dependency', test: /Cannot find (?:module|package) ['"]([^'"]+)['"]/i, detail: (m) => ({ module: m[1] }) },
  { category: 'missing_dependency', test: /ERR_MODULE_NOT_FOUND[^\n]*?['"]([^'"]+)['"]/i, detail: (m) => ({ module: m[1] }) },
  { category: 'missing_dependency', test: /Module not found: (?:Error: )?Can't resolve ['"]([^'"]+)['"]/i, detail: (m) => ({ module: m[1] }) },
  { category: 'missing_dependency', test: /Failed to resolve (?:import|entry for package) ["']([^"']+)["']/i, detail: (m) => ({ module: m[1] }) },
  { category: 'missing_dependency', test: /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/i, detail: (m) => ({ module: m[1] }) },
  { category: 'missing_command', test: /'([\w.@/-]+)' is not recognized as an internal or external command/i, detail: (m) => ({ command: m[1] }) },
  { category: 'missing_command', test: /(?:^|\s)(?:\S+: )?(?:line \d+: )?([\w.-]+): (?:command )?not found\b/i, detail: (m) => ({ command: m[1] }) },
  { category: 'missing_command', test: /The term '([\w.-]+)' is not recognized as (?:the )?name of a cmdlet/i, detail: (m) => ({ command: m[1] }) },
  { category: 'file_lock', test: /\bEBUSY\b|EPERM: operation not permitted, (?:unlink|rename|rmdir|open|scandir)|resource busy or locked|being used by another process/i },
  { category: 'rate_limit', test: /\b429\b.*(?:Too Many Requests|rate)|rate limit(?:ed| exceeded)/i },
  { category: 'transient_network', test: /\b(?:ECONNRESET|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|ERR_SOCKET_TIMEOUT|socket hang up)\b|npm ERR! network|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_\d+|getaddrinfo ENOTFOUND registry|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i },
  { category: 'auth_failure', test: /\b401\b.*Unauthori[sz]ed|authentication (?:failed|required)|You are not (?:logged in|authenticated)|not logged in|wrangler login|gh auth login/i },
  { category: 'test_failure', test: /\b\d+ (?:failed|failing)\b|Tests?:\s+\d+ failed|AssertionError|\bFAIL\b\s+\S|✕|×\s|expected .* to (?:be|equal|match)/i },
  { category: 'build_failure', test: /error TS\d+:|SyntaxError:|Build failed|Failed to compile|ERROR in |error: could not compile|BUILD FAILED/i },
];

export function classifyFailure(output: string | readonly string[], opts: { timedOut?: boolean } = {}): FailureClassification {
  if (opts.timedOut) return { category: 'timeout', evidence: null, detail: {} };
  const lines = (typeof output === 'string' ? output.split(/\r?\n/) : [...output]).map((l) => l.trim()).filter(Boolean);
  for (const rule of RULES) {
    for (const line of lines) {
      const m = rule.test.exec(line);
      if (m) return { category: rule.category, evidence: line.length > 300 ? `${line.slice(0, 297)}...` : line, detail: rule.detail?.(m) ?? {} };
    }
  }
  return { category: 'unknown', evidence: null, detail: {} };
}

export type RepairStrategy = 'install_dependencies' | 'install_dependencies_unfrozen' | 'free_port' | 'retry_after_backoff' | 'install_browser';

export interface RepairPlan {
  strategy: RepairStrategy;
  description: string;
  /** Shell command for install-type repairs. */
  command?: string;
  port?: number;
  delayMs?: number;
}

export interface RepairContext {
  /** Package manager detected for the repository (`pnpm`, `npm`, `yarn`, `bun`), if any. */
  packageManager: string | null;
  hasRequirementsTxt: boolean;
  /** Names of the repository's declared dependencies (to tell a missing install from a missing tool). */
  declaredDependencies: readonly string[];
  nodeModulesPresent: boolean;
  /** Repairs already attempted for this command in this stage. */
  attempted: ReadonlyArray<RepairStrategy>;
}

/** Common binaries and the package that provides them. */
const BIN_PACKAGE: Record<string, string> = {
  tsc: 'typescript',
  vite: 'vite',
  vitest: 'vitest',
  jest: 'jest',
  eslint: 'eslint',
  prettier: 'prettier',
  next: 'next',
  playwright: '@playwright/test',
  wrangler: 'wrangler',
  tsx: 'tsx',
  esbuild: 'esbuild',
  webpack: 'webpack',
  mocha: 'mocha',
  nodemon: 'nodemon',
  'ts-node': 'ts-node',
};

function installCommand(pm: string, frozen: boolean): string {
  switch (pm) {
    case 'pnpm':
      return frozen ? 'pnpm install --frozen-lockfile' : 'pnpm install';
    case 'yarn':
      return frozen ? 'yarn install --frozen-lockfile' : 'yarn install';
    case 'bun':
      return frozen ? 'bun install --frozen-lockfile' : 'bun install';
    default:
      return frozen ? 'npm ci' : 'npm install';
  }
}

/**
 * A bounded repair for a classified failure, or null when the failure is not
 * the environment's fault (or its one repair was already tried).
 */
export function planRepair(failure: FailureClassification, ctx: RepairContext): RepairPlan | null {
  const tried = (s: RepairStrategy) => ctx.attempted.includes(s);
  const retries = ctx.attempted.filter((s) => s === 'retry_after_backoff').length;
  switch (failure.category) {
    case 'missing_dependency':
    case 'missing_command': {
      if (failure.category === 'missing_command') {
        const pkg = BIN_PACKAGE[failure.detail.command ?? ''] ?? failure.detail.command ?? '';
        const declared = ctx.declaredDependencies.includes(pkg);
        // A tool the project does not declare is not something an install can fix.
        if (!declared && ctx.nodeModulesPresent) return null;
      }
      if (/ModuleNotFoundError/.test(failure.evidence ?? '') || (!ctx.packageManager && ctx.hasRequirementsTxt)) {
        if (!ctx.hasRequirementsTxt || tried('install_dependencies')) return null;
        return { strategy: 'install_dependencies', command: 'python -m pip install -r requirements.txt', description: 'Install the Python requirements, then run it again' };
      }
      if (!ctx.packageManager) return null;
      if (!tried('install_dependencies')) {
        return { strategy: 'install_dependencies', command: installCommand(ctx.packageManager, true), description: `Install the project's dependencies with ${ctx.packageManager} (locked versions), then run it again` };
      }
      if (!tried('install_dependencies_unfrozen')) {
        return { strategy: 'install_dependencies_unfrozen', command: installCommand(ctx.packageManager, false), description: `Locked install did not fix it; install with ${ctx.packageManager} and let it update the lockfile, then run it again` };
      }
      return null;
    }
    case 'port_conflict':
      if (!failure.detail.port || tried('free_port')) return null;
      return { strategy: 'free_port', port: failure.detail.port, description: `Stop this task's own process on port ${failure.detail.port} (never anyone else's), then run it again` };
    case 'transient_network':
    case 'file_lock':
      if (retries >= 2) return null;
      return { strategy: 'retry_after_backoff', delayMs: 2000 * 2 ** retries, description: `Wait ${2 * 2 ** retries}s and run it again (${failure.category === 'file_lock' ? 'a file was locked' : 'the network failed'})` };
    case 'rate_limit':
      if (retries >= 1) return null;
      return { strategy: 'retry_after_backoff', delayMs: 15_000, description: 'Wait 15s for the rate limit, then run it again' };
    case 'missing_browser':
      if (tried('install_browser')) return null;
      return { strategy: 'install_browser', command: 'npx --yes playwright install chromium', description: "Install Playwright's Chromium, then run it again" };
    default:
      return null;
  }
}
