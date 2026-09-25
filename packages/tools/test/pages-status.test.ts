import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveShell } from '@acc/executor';
import { builtinProviders, decide, ToolRegistry, type OperationContext, type OperationResult } from '../src/index.js';

/** cloudflare.pages_status (docs/plans/RELEASE_STAGE_PLAN.md §3.7) against a local stand-in for the Cloudflare API. */

const registry = new ToolRegistry();
for (const p of builtinProviders()) registry.register(p);

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const PUSHED = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const deployment = (id: string, commit: string, stage: string, status: string) => ({
  id,
  url: `https://${id}.shop.pages.dev`,
  environment: 'production',
  created_on: '2026-09-25T10:00:00Z',
  latest_stage: { name: stage, status },
  deployment_trigger: { type: 'github:push', metadata: { branch: 'main', commit_hash: commit } },
});

let scenario: { canonical: unknown; list: unknown[]; accounts?: string[]; projectStatus?: number } = { canonical: null, list: [] };
let seen: string[] = [];
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/cf/accounts') return json(200, { success: true, result: (scenario.accounts ?? [ACCOUNT]).map((id) => ({ id, name: 'TenTen' })) });
    const project = `/cf/accounts/${ACCOUNT}/pages/projects/shop`;
    if (u.pathname === project) {
      if (scenario.projectStatus) return json(scenario.projectStatus, { success: false, errors: [{ message: 'Authentication error' }] });
      return json(200, { success: true, result: { name: 'shop', production_branch: 'main', canonical_deployment: scenario.canonical } });
    }
    if (u.pathname === `${project}/deployments`) {
      expect(u.searchParams.get('env')).toBe('production');
      return json(200, { success: true, result: scenario.list });
    }
    json(404, { success: false, errors: [{ message: 'not found' }] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  seen = [];
  scenario = { canonical: null, list: [] };
});

function ctx(env: Record<string, string>): OperationContext {
  const tmp = os.tmpdir();
  return {
    executionId: 'test',
    taskId: null,
    cwd: tmp,
    roots: [tmp],
    env: { ACC_CF_API_BASE: `${base}/cf`, ...env },
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    tempDir: tmp,
    stateDir: tmp,
    shell: (k) => resolveShell(k),
    detection: () => undefined,
    protectedPaths: [],
  };
}

const env = { CLOUDFLARE_API_TOKEN: 'pages-read', CLOUDFLARE_ACCOUNT_ID: ACCOUNT };

async function call(input: unknown, e: Record<string, string> = env): Promise<OperationResult> {
  const op = registry.offering('cloudflare.pages_status')[0]!.operation;
  return op.run(op.input.parse(input), ctx(e));
}

describe('cloudflare.pages_status', () => {
  it('is a Level 1 read that nothing needs to approve, and declares itself read-only', () => {
    const offering = registry.offering('cloudflare.pages_status');
    expect(offering).toHaveLength(1);
    const op = offering[0]!.operation;
    expect(op.readOnly).toBe(true);
    expect(op.level).toBe(1);
    const risk = { level: 1 as const, risk: 'normal' as const, effects: ['network' as const], reasons: [], production: false, writes: false };
    expect(decide({ risk, mode: 'safe', autoApproveUpToLevel: 1, stageLevel: 1, inProfile: true, origin: 'engine' }).decision).toBe('allow');
  });

  it('reports the live deployment when it is the pushed commit and its deploy succeeded', async () => {
    scenario = { canonical: deployment('d-new', PUSHED, 'deploy', 'success'), list: [deployment('d-new', PUSHED, 'deploy', 'success')] };
    const r = await call({ project: 'shop', commit: PUSHED.slice(0, 7) });
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({ productionBranch: 'main', live: { id: 'd-new', commit: PUSHED, stage: 'deploy', status: 'success' } });
    expect(seen.every((s) => s.endsWith('Bearer pages-read'))).toBe(true);
  });

  it('tells a build still running and a failed build apart from the live one', async () => {
    scenario = { canonical: deployment('d-old', OLD, 'deploy', 'success'), list: [deployment('d-new', PUSHED, 'build', 'active'), deployment('d-old', OLD, 'deploy', 'success')] };
    let r = await call({ project: 'shop', commit: PUSHED });
    expect(r.output).toMatchObject({ live: { id: 'd-old', commit: OLD }, candidate: { id: 'd-new', stage: 'build', status: 'active' } });
    expect(r.evidence?.join(' ')).toContain('aaaaaaa');

    scenario = { canonical: deployment('d-old', OLD, 'deploy', 'success'), list: [deployment('d-new', PUSHED, 'build', 'failure')] };
    r = await call({ project: 'shop', commit: PUSHED });
    expect(r.output).toMatchObject({ live: { commit: OLD }, candidate: { status: 'failure' } });

    // A different commit is live and nothing was built from the pushed one yet.
    scenario = { canonical: deployment('d-old', OLD, 'deploy', 'success'), list: [deployment('d-old', OLD, 'deploy', 'success')] };
    r = await call({ project: 'shop', commit: PUSHED });
    expect(r.output).toMatchObject({ live: { commit: OLD }, candidate: null });
  });

  it('works out the account when the key sees exactly one, and asks when it sees several', async () => {
    scenario = { canonical: deployment('d-new', PUSHED, 'deploy', 'success'), list: [] };
    expect((await call({ project: 'shop' }, { CLOUDFLARE_API_TOKEN: 'pages-read' })).ok).toBe(true);
    scenario = { ...scenario, accounts: [ACCOUNT, 'f'.repeat(32)] };
    const r = await call({ project: 'shop' }, { CLOUDFLARE_API_TOKEN: 'pages-read' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNAVAILABLE');
  });

  it('says a key is missing or refused in words, and never guesses a result', async () => {
    const none = await call({ project: 'shop' }, {});
    expect(none.ok).toBe(false);
    expect(none.error?.code).toBe('UNAVAILABLE');
    expect(none.summary).toMatch(/No Cloudflare key/);
    expect(seen).toEqual([]);
    scenario = { canonical: null, list: [], projectStatus: 403 };
    const refused = await call({ project: 'shop' });
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('AUTH_REQUIRED');
  });

  it('refuses a project name that is not one', async () => {
    const op = registry.offering('cloudflare.pages_status')[0]!.operation;
    expect(op.input.safeParse({ project: '../x' }).success).toBe(false);
    expect(op.input.safeParse({ project: 'shop', commit: 'zzzz' }).success).toBe(false);
  });
});
