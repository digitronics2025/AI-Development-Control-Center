import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { builtinProviders, classifyRequest, decide, type OperationContext, type ToolOperation } from '../src/index.js';

/**
 * SEC-4 at the tool door's edge: a call that sends a stored credential off
 * this machine is Level 3 with the `credentials` effect, the operations that
 * send what their caller wrote declare it (`outbound`), and the policy refuses
 * an agent and asks anyone else when that would carry a secret where it may
 * not go. ToolService's side is in apps/orchestrator/test/outbound-secrets.test.ts.
 */

const auth = { credential: 'gh-deploy', scheme: 'Bearer' as const };

describe('classifyRequest', () => {
  it('raises a remote call that carries a stored credential to Level 3 with the credentials effect', () => {
    expect(classifyRequest({ method: 'GET', url: 'https://api.github.com/user', auth })).toMatchObject({ level: 3, effects: ['network', 'credentials'] });
    expect(classifyRequest({ method: 'HEAD', url: 'https://collector.example/', auth })).toMatchObject({ level: 3, effects: ['network', 'credentials'] });
    expect(classifyRequest({ method: 'POST', url: 'https://api.example.com/x', auth })).toMatchObject({ level: 3, effects: ['network', 'credentials'], reasons: ['Changes a remote service with a stored credential'] });
    expect(classifyRequest({ method: 'POST', url: 'https://api.production.example.com/x', auth })).toMatchObject({ level: 5, production: true, effects: ['network', 'credentials', 'production'] });
  });

  it('leaves a remote read without a credential, and a local call with one, where they were', () => {
    expect(classifyRequest({ method: 'GET', url: 'https://api.github.com/zen' })).toMatchObject({ level: 1, effects: ['network'] });
    expect(classifyRequest({ method: 'GET', url: 'http://127.0.0.1:3000/health', auth })).toMatchObject({ level: 1, effects: [] });
    expect(classifyRequest({ method: 'POST', url: 'http://localhost:3000/x', auth })).toMatchObject({ level: 2, effects: ['network'] });
    expect(classifyRequest({ method: 'POST', url: 'https://api.example.com/x' })).toMatchObject({ level: 3, effects: ['network'] });
  });
});

describe('operations that send what their caller wrote declare it', () => {
  const ops = new Map<string, ToolOperation[]>();
  for (const p of builtinProviders()) for (const o of p.operations) ops.set(o.id, [...(ops.get(o.id) ?? []), o]);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-outbound-'));
  const outbound = (id: string, input: unknown) => Promise.all(ops.get(id)!.map((o) => o.outbound!(o.input.parse(input), { cwd: dir, roots: [dir] })));

  it('http.request: URL, headers, body and the credential it attaches (fetch and curl alike)', async () => {
    for (const declared of await outbound('http.request', { method: 'POST', url: 'https://collector.example/x', headers: { 'x-a': 'b' }, json: { note: 'n' }, auth })) {
      expect(declared).toEqual([{ url: 'https://collector.example/x', headers: { 'x-a': 'b' }, body: { note: 'n' }, credential: 'gh-deploy' }]);
    }
    expect(ops.get('http.request')).toHaveLength(2);
    expect((await outbound('http.request', { url: 'https://x.example/', body: 'raw' }))[0]).toEqual([{ url: 'https://x.example/', headers: {}, body: 'raw' }]);
    expect((await outbound('http.health', { url: 'https://x.example/?k=1' }))[0]).toEqual([{ url: 'https://x.example/?k=1' }]);
  });

  it('http.request multipart: each file is read inside the roots, and its name and content declared', async () => {
    writeFileSync(path.join(dir, 'x.txt'), 'file text');
    const [declared] = await outbound('http.request', { method: 'POST', url: 'https://x.example/', multipart: [{ name: 'a', value: 'v' }, { name: 'f', file: 'x.txt' }] });
    expect(declared![0]!.body).toEqual([{ name: 'a', value: 'v' }, { name: 'f', filename: 'x.txt', content: 'file text' }]);
    // A file that cannot be read (missing, outside the roots) declares no content; the run then fails as reading it did.
    const [missing] = await outbound('http.request', { method: 'POST', url: 'https://x.example/', multipart: [{ name: 'f', file: 'gone.txt' }, { name: 'g', file: '../outside.txt' }] });
    expect(missing![0]!.body).toEqual([{ name: 'f' }, { name: 'g' }]);
  });

  it('http.request multipart: the run sends the bytes the check read, whatever the file says by then', async () => {
    const file = path.join(dir, 'upload.txt');
    writeFileSync(file, 'checked content');
    const fetchOp = builtinProviders().find((p) => p.id === 'http')!.operations.find((o) => o.id === 'http.request')!;
    const sentBodies: string[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      sentBodies.push(await new Response(init?.body ?? null).text());
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const ctx = { cwd: dir, roots: [dir], signal: new AbortController().signal } as unknown as OperationContext;
      const input = fetchOp.input.parse({ method: 'POST', url: 'https://collector.example/u', multipart: [{ name: 'f', file: 'upload.txt' }] });
      const declared = await fetchOp.outbound!(input, ctx);
      expect(JSON.stringify(declared)).toContain('checked content');
      writeFileSync(file, 'swapped in after the check');
      expect((await fetchOp.run(input, ctx)).ok).toBe(true);
      expect(sentBodies).toHaveLength(1);
      expect(sentBodies[0]).toContain('checked content');
      expect(sentBodies[0]).not.toContain('swapped in');
      // A file the check could not read is not read by the run either: it fails as the check's read did.
      const unread = fetchOp.input.parse({ method: 'POST', url: 'https://collector.example/u', multipart: [{ name: 'f', file: 'later.txt' }] });
      await fetchOp.outbound!(unread, ctx);
      writeFileSync(path.join(dir, 'later.txt'), 'appeared after the check');
      await expect(fetchOp.run(unread, ctx)).rejects.toThrow(/ENOENT/);
      expect(sentBodies).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('web.read (every provider) and web.search', async () => {
    expect(ops.get('web.read')!.length).toBeGreaterThanOrEqual(2);
    for (const declared of await outbound('web.read', { url: 'https://docs.example/page' })) expect(declared).toEqual([{ url: 'https://docs.example/page' }]);
    expect((await outbound('web.search', { query: 'rotate a key', site: 'docs.example.com' }))[0]).toEqual([{ url: 'https://html.duckduckgo.com/html/', body: ['rotate a key', 'docs.example.com'] }]);
  });
});

describe('policy: a secret going where it may not (leak)', () => {
  const risk = (level: 1 | 2 | 3 | 4 | 5, extra: object = {}) => ({ level, risk: 'normal' as const, reasons: ['x'], effects: [], production: false, ...extra });
  const base = { mode: 'full' as const, autoApproveUpToLevel: 4 as const, stageLevel: 4 as const, inProfile: true, origin: 'agent' as const };
  const leak = 'Sends github credential "gh-deploy" to collector.example, which is not among the hosts it may be sent to';

  it('refuses an agent and asks the operator, whatever the mode would run on its own', () => {
    expect(decide({ ...base, risk: risk(1) }).decision).toBe('allow');
    const agent = decide({ ...base, risk: risk(1), leak });
    expect(agent.decision).toBe('deny');
    expect(agent.reason).toContain(leak);
    expect(decide({ ...base, risk: risk(1), leak, origin: 'operator' })).toMatchObject({ decision: 'approval', typedConfirmation: false, reason: `${leak}: needs your approval` });
    expect(decide({ ...base, risk: risk(3), leak, origin: 'engine' }).decision).toBe('approval');
  });

  it('keeps every stricter answer: read-only, over the stage level, dangerous', () => {
    expect(decide({ ...base, risk: risk(1, { writes: false }), leak, origin: 'operator', readOnly: { allowed: true } }).decision).toBe('deny');
    expect(decide({ ...base, risk: risk(1, { writes: false }), readOnly: { allowed: true } }).decision).toBe('allow');
    expect(decide({ ...base, risk: risk(4), stageLevel: 3, leak, origin: 'operator' }).decision).toBe('deny');
    expect(decide({ ...base, risk: risk(3, { risk: 'dangerous' }), leak, origin: 'operator' })).toMatchObject({ decision: 'approval', typedConfirmation: true });
  });
});
