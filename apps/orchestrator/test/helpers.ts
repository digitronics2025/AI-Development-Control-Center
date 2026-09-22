import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SimulatedAgentAdapter, type AgentAdapter } from '@acc/agent-sdk';
import { git } from '@acc/git';
import type { TaskStatus } from '@acc/shared';
import type { FastifyInstance } from 'fastify';
import { createServices, type AppServices } from '../src/app.js';
import type { OrchestratorConfig } from '../src/config.js';
import { buildServer } from '../src/http/server.js';

export const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuv';
export const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

export interface TestApp {
  services: AppServices;
  app: FastifyInstance;
  dataDir: string;
  api: <T = any>(method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
}

export function simAdapters(delayMs = 10): AgentAdapter[] {
  return [new SimulatedAgentAdapter('codex', 'Codex (simulated)', delayMs), new SimulatedAgentAdapter('claude', 'Claude Code (simulated)', delayMs)];
}

export async function createTestApp(options: { adapters?: AgentAdapter[]; dataDir?: string; baseEnv?: NodeJS.ProcessEnv } = {}): Promise<TestApp> {
  const dataDir = options.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'acc-data-'));
  const config: OrchestratorConfig = {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    resourcesDir: ROOT,
    dashboardDir: null,
    token: TOKEN,
    simulatedAgents: true,
    allowedOrigins: [],
    version: 'test',
  };
  const services = createServices(config, { adapters: options.adapters ?? simAdapters(), baseEnv: options.baseEnv });
  services.engine.recover();
  const app = await buildServer(services);
  const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}`, ...headers },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    let parsed: any = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* not JSON */
    }
    return { status: res.statusCode, body: parsed };
  };
  return {
    services,
    app,
    dataDir,
    api,
    async close() {
      await services.close();
      await app.close();
    },
  };
}

export interface RepoOptions {
  scripts?: Record<string, string>;
  dirty?: Record<string, string>;
  noPackageJson?: boolean;
}

/** A real Git repository with a package.json whose scripts become verification commands. */
export async function makeRepo(options: RepoOptions = {}): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-repo-'));
  const run = async (args: string[]) => {
    const r = await git(dir, args);
    if (r.code !== 0) throw new Error(r.stderr);
  };
  await run(['init', '-b', 'main']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Test']);
  await run(['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'README.md'), '# Test repo\n');
  if (!options.noPackageJson) {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', private: true, scripts: options.scripts ?? { test: 'node -e "console.log(\'3 passed\')"' } }, null, 2),
    );
  }
  await run(['add', '.']);
  await run(['commit', '-m', 'init']);
  for (const [file, content] of Object.entries(options.dirty ?? {})) writeFileSync(path.join(dir, file), content);
  return dir;
}

export async function waitFor<T>(fn: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs = 30_000, label = 'condition'): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)?.slice(0, 600)}`);
}

export function waitForStatus(t: TestApp, taskId: string, statuses: TaskStatus[], timeoutMs = 30_000) {
  return waitFor(
    () => t.services.store.getTask(taskId)!,
    (task) => statuses.includes(task.status),
    timeoutMs,
    `${taskId} to reach ${statuses.join('/')}`,
  );
}

export async function addRepo(t: TestApp, repoPath: string): Promise<string> {
  const res = await t.api('POST', '/api/repositories', { path: repoPath });
  if (res.status !== 201) throw new Error(`add repo failed: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

export async function createTask(t: TestApp, repositoryId: string, description: string, extra: Record<string, unknown> = {}) {
  const res = await t.api('POST', '/api/tasks', { description, repositoryId, workflowId: 'normal-development', mode: 'autopilot', ...extra });
  if (res.status !== 201) throw new Error(`create task failed: ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}
