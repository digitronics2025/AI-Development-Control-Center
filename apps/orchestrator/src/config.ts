import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '@acc/shared';

export interface OrchestratorConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Root holding `workflows/` and `prompts/` (the repository checkout). */
  resourcesDir: string;
  /** Built dashboard to serve at `/`, or null when not built. */
  dashboardDir: string | null;
  token: string;
  /** Register simulated agents instead of the real CLIs (tests and demos only). */
  simulatedAgents: boolean;
  /** Extra origins allowed to call the API (e.g. the Vite dev server). */
  allowedOrigins: string[];
  version: string;
}

export function defaultDataDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'AIDevControlCenter');
  }
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'ai-control-center');
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
  return {
    host,
    port,
    dataDir,
    resourcesDir,
    dashboardDir: existsSync(path.join(dashboardCandidate, 'index.html')) ? dashboardCandidate : null,
    token: env.ACC_TOKEN_OVERRIDE ?? loadOrCreateToken(dataDir),
    simulatedAgents: env.ACC_SIMULATED_AGENTS === '1',
    allowedOrigins: (env.ACC_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    version: env.ACC_VERSION ?? '0.1.0',
  };
}
