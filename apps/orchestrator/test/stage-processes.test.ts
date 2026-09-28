import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { addRepo, createTask, createTestApp, makeRepo, waitForStatus, type TestApp } from './helpers.js';

/**
 * What an agent stage starts ends with that stage (docs/systems/tool-system.md#task-processes-processests). Seen live
 * on TASK-0024 (2026-09-28): the designer's dev server outlived Implement and took the port the App check starts on.
 */

let t: TestApp;
beforeEach(async () => {
  SimulatedAgentAdapter.reset();
  t = await createTestApp();
  // The tool route must be reachable over HTTP, as it is for a real agent's MCP bridge.
  const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
  t.services.tooling.setListenUrl(address);
  (t.services.tooling as unknown as { d: { bridgePath: string } }).d.bridgePath = 'acc-mcp.js';
});
afterEach(async () => {
  await t.close();
});

describe('stage-end cleanup in a real run', () => {
  it("stops the dev server Implement's agent started when Implement ends, before the next stage starts", async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const dir = await makeRepo({ files: { 'server.cjs': "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n" } });
    const repoId = await addRepo(t, dir);
    const call = JSON.stringify({ name: 'dev server', command: 'node server.cjs', port, readyTimeoutSec: 30 });
    const id = await createTask(t, repoId, `Add a page [sim:call:implementer:process.start:${call}]`);
    await waitForStatus(t, id, ['COMPLETED']);
    // It ran, and Implement's end stopped it — not the task's.
    expect(t.services.processes.list(id).find((p) => p.name === 'dev server')).toMatchObject({ stopReason: 'Implement ended' });
    const events = t.services.store.listEvents(id, { limit: 500 });
    const stopped = events.findIndex((e) => e.type === 'PROCESS_STOPPED' && /^Implement ended: stopped 1 background process\(es\) \(dev server\) it left running$/.test(e.message));
    expect(stopped).toBeGreaterThan(-1);
    expect(events.findIndex((e, i) => i > stopped && e.type === 'STAGE_STARTED')).toBeGreaterThan(stopped);
    expect(await fetch(`http://127.0.0.1:${port}`).then(() => 'up', () => 'down')).toBe('down');
  }, 120_000);
});
