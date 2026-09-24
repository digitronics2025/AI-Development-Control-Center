import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { redact, registerSecretValues } from '@acc/security';
import { builtinProviders, ToolRegistry, type OperationContext } from '../src/index.js';

/**
 * Live probe of the read-only data packs against the real Cloudflare and
 * GitHub APIs (docs/plans/ASK_READ_ONLY_DATA_PLAN.md). Skipped unless
 * ACC_LIVE_DATA=1; uses CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID and
 * GH_TOKEN / ACC_GITHUB_OWNERS from the environment and prints one summary
 * line per read — never a value, never a row.
 *
 *   ACC_LIVE_DATA=1 pnpm --filter @acc/tools exec vitest run test/live-data.test.ts
 */

const live = process.env.ACC_LIVE_DATA === '1';
const registry = new ToolRegistry();
for (const p of builtinProviders()) registry.register(p);

const env: Record<string, string> = {};
for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GH_TOKEN', 'ACC_GITHUB_OWNERS', 'ACC_READ_ONLY']) if (process.env[k]) env[k] = process.env[k]!;
registerSecretValues([env.CLOUDFLARE_API_TOKEN, env.GH_TOKEN].filter((v): v is string => Boolean(v)));

function ctx(): OperationContext {
  return { executionId: 'probe', taskId: null, cwd: os.tmpdir(), roots: [os.tmpdir()], env, signal: new AbortController().signal, timeoutMs: 60_000, tempDir: os.tmpdir(), stateDir: os.tmpdir(), shell: async () => null, detection: () => undefined, protectedPaths: [] };
}

async function run(capability: string, input: unknown): Promise<{ ok: boolean; output: any; summary: string }> {
  const op = registry.offering(capability)[0]!.operation;
  const r = await op.run(op.input.parse(input), ctx());
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${capability} ${JSON.stringify(input).slice(0, 80)} → ${redact(r.summary).slice(0, 200)}`);
  return { ok: r.ok, output: r.output, summary: r.summary };
}

describe.skipIf(!live || !env.CLOUDFLARE_API_TOKEN)('live Cloudflare reads', () => {
  it('lists, describes and reads', async () => {
    const cat = await run('cloudflare.catalog', {});
    expect(cat.ok).toBe(true);
    const c = cat.output as { d1: Array<{ name: string }>; kv: Array<{ title: string }>; r2: Array<{ name: string }> };
    if (c.d1[0]) {
      expect((await run('cloudflare.d1_schema', { database: c.d1[0].name })).ok).toBe(true);
      expect((await run('cloudflare.d1_read', { database: c.d1[0].name, sql: "SELECT COUNT(*) AS tables FROM sqlite_schema WHERE type = 'table'" })).ok).toBe(true);
      expect((await run('cloudflare.d1_read', { database: c.d1[0].name, sql: 'DELETE FROM x' })).ok).toBe(false);
    }
    if (c.kv[0]) expect((await run('cloudflare.kv_keys', { namespace: c.kv[0].title, limit: 10 })).ok).toBe(true);
    if (c.r2[0]) {
      const list = await run('cloudflare.r2_list', { bucket: c.r2[0].name, limit: 5 });
      expect(list.ok).toBe(true);
      const first = (list.output as { objects: Array<{ key: string }> }).objects[0];
      if (first) expect((await run('cloudflare.r2_get', { bucket: c.r2[0].name, key: first.key })).ok).toBe(true);
    }
  }, 180_000);
});

describe.skipIf(!live || !env.GH_TOKEN)('live GitHub reads', () => {
  it('lists repositories and reads one', async () => {
    const repos = await run('github.repos', { limit: 5 });
    expect(repos.ok).toBe(true);
    const first = (repos.output as { repos: Array<{ repo: string }> }).repos[0]?.repo;
    expect(first).toBeTruthy();
    expect((await run('github.file_read', { repo: first!, path: '' })).ok).toBe(true);
    expect((await run('github.commits', { repo: first!, limit: 3, withFiles: true })).ok).toBe(true);
    expect((await run('github.pulls', { repo: first!, state: 'all', limit: 3 })).ok).toBe(true);
    expect((await run('github.issues', { repo: first!, state: 'all', limit: 3 })).ok).toBe(true);
    const runs = await run('github.runs', { repo: first!, limit: 10 });
    expect(runs.ok).toBe(true);
    const failed = (runs.output as { runs: Array<{ id: number; conclusion: string }> }).runs.find((r) => r.conclusion === 'failure');
    if (failed) expect((await run('github.runs', { repo: first!, runId: failed.id })).ok).toBe(true);
    const search = await run('github.code_search', { repo: first!, query: 'function', limit: 3 });
    // Code search can be unavailable for some tokens or repositories; it must still answer in words.
    expect(search.summary.length).toBeGreaterThan(0);
  }, 180_000);
});
