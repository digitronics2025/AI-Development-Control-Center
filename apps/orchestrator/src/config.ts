import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '@acc/shared';

export interface OrchestratorConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Where task worktrees, task workspaces and Stage Team checkouts live: outside the data folder (`defaultWorkDir`). */
  workDir: string;
  /** Root holding `workflows/` and `prompts/` (the repository checkout). */
  resourcesDir: string;
  /** Built dashboard to serve at `/`, or null when not built. */
  dashboardDir: string | null;
  token: string;
  /** Register simulated agents instead of the real CLIs (tests and demos only). */
  simulatedAgents: boolean;
  /** Start repository discovery and background sync (off for demos and e2e, which must not touch real repositories). */
  repositoryAutomation: boolean;
  /** Extra origins allowed to call the API (e.g. the Vite dev server). */
  allowedOrigins: string[];
  version: string;
}

/** Stamped by build.mjs from the commit being built; absent when running from source (tests, tsx). */
declare const __ACC_BUILD__: { version: string; commit: string; dirty: boolean; builtAt: string } | undefined;

/** The identity of this binary, shown by /api/health (audit F-45). */
export const BUILD: { version: string; commit: string | null; dirty: boolean; builtAt: string | null } =
  typeof __ACC_BUILD__ === 'undefined' ? { version: '0.1.0-dev', commit: null, dirty: false, builtAt: null } : __ACC_BUILD__;

export function defaultDataDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'AIDevControlCenter');
  }
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'ai-control-center');
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * Where the agents' files are (SEC-3): beside the data folder, never inside
 * it, under a name no self-reference rule matches (`AIDevControlCenter`,
 * `ai-control-center`, the data folder's own path as a prefix), so an agent
 * can name its own worktree while the data folder stays refused. The default
 * data folder gets `AccWork` (`acc-work` off Windows) beside it; any other —
 * a demo, a test, a second instance — gets its own `acc-work-<hash of its
 * path>` beside it, so two instances never share one, or `work-<hash>` when
 * the data folder's name starts that one (`acc`, `a`).
 */
export function defaultWorkDir(dataDir: string): string {
  const resolved = path.resolve(dataDir);
  if (samePath(resolved, defaultDataDir())) return path.join(path.dirname(resolved), process.platform === 'win32' ? 'AccWork' : 'acc-work');
  const tag = createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 10);
  const workDir = path.join(path.dirname(resolved), `acc-work-${tag}`);
  // A name starting with `a` cannot also start `work-…`.
  return startsWithDataDirPath(resolved, workDir) ? path.join(path.dirname(resolved), `work-${tag}`) : workDir;
}

/**
 * Whether `workDir`'s path starts with the data folder's as the self-reference
 * rule reads it (`setSelfReferences`: any case, either separator, nothing
 * required after it): `D:\acc` starts `D:\acc-work-…` and `D:\acc2`, and every
 * path there would then be refused to agents.
 */
function startsWithDataDirPath(dataDir: string, workDir: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  return norm(workDir).startsWith(norm(dataDir));
}

/** Repository root: two levels up from `apps/orchestrator/{src,dist}`. */
function defaultResourcesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

/**
 * The local API token. Created once, readable only by the current user, and
 * shared with the dashboard (injected into its HTML) and the VS Code
 * extension (read from this file). Browsers on other origins cannot read it.
 */
export function loadOrCreateToken(dataDir: string): string {
  const file = path.join(dataDir, 'auth-token');
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(token)) return token;
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: the file lives in the user's private profile directory. */
  }
  return token;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const dataDir = path.resolve(env.ACC_DATA_DIR ?? defaultDataDir());
  mkdirSync(path.join(dataDir, 'tasks'), { recursive: true });
  const resourcesDir = path.resolve(env.ACC_RESOURCES_DIR ?? defaultResourcesDir());
  const dashboardCandidate = path.resolve(env.ACC_DASHBOARD_DIR ?? path.join(resourcesDir, 'apps', 'dashboard', 'dist', 'web'));
  const host = env.ACC_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && env.ACC_ALLOW_REMOTE !== '1') {
    throw new Error(`Refusing to bind to ${host}: V1 listens on localhost only (set ACC_ALLOW_REMOTE=1 to override).`);
  }
  const port = Number(env.ACC_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid ACC_PORT: ${env.ACC_PORT}`);
  const workDir = path.resolve(env.ACC_WORK_DIR ?? defaultWorkDir(dataDir));
  const rel = path.relative(dataDir, workDir);
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error(`ACC_WORK_DIR must be outside the data folder (${dataDir}): agents are refused every path inside it.`);
  if (startsWithDataDirPath(dataDir, workDir)) throw new Error(`ACC_WORK_DIR must not start with the data folder's path (${dataDir}): agents are refused every path that does.`);
  return {
    host,
    port,
    dataDir,
    workDir,
    resourcesDir,
    dashboardDir: existsSync(path.join(dashboardCandidate, 'index.html')) ? dashboardCandidate : null,
    token: env.ACC_TOKEN_OVERRIDE ?? loadOrCreateToken(dataDir),
    simulatedAgents: env.ACC_SIMULATED_AGENTS === '1',
    repositoryAutomation: env.ACC_REPOSITORY_AUTOMATION !== '0',
    allowedOrigins: (env.ACC_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    version: env.ACC_VERSION ?? BUILD.version,
  };
}
