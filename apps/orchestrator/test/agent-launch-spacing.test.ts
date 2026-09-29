import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter, type AgentExecutionHandle, type AgentExecutionInput } from '@acc/agent-sdk';
import { AgentRegistry } from '../src/services/agents.js';
import { createTestApp, type TestApp } from './helpers.js';

/**
 * Launches of one agent CLI are spaced (LAUNCH_SPACING_MS): two Claude Code
 * processes started together with an expired sign-in both refresh it and one
 * fails, which knocked a Stage Team's Investigate over to another agent
 * (TASK-0029). A simulated agent signs in to nothing and never waits.
 */

/** A stand-in that reports a real provider, and records when each run started. */
class SignedInAgent extends SimulatedAgentAdapter {
  override readonly usageCapabilities = { ...new SimulatedAgentAdapter('x', 'x').usageCapabilities, provider: 'anthropic' as const };
  readonly starts: number[] = [];
  override execute(input: AgentExecutionInput): Promise<AgentExecutionHandle> {
    this.starts.push(Date.now());
    return super.execute(input);
  }
}

class RecordingSimulated extends SimulatedAgentAdapter {
  readonly starts: number[] = [];
  override execute(input: AgentExecutionInput): Promise<AgentExecutionHandle> {
    this.starts.push(Date.now());
    return super.execute(input);
  }
}

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const SPACING = 400;
const input = (registry: AgentRegistry, id: string, n: number): AgentExecutionInput => ({
  ...registry.runtimeOptions(id),
  executionId: `run-${id}-${n}`,
  cwd: process.cwd(),
  prompt: 'Role: investigator\n\nLook around.',
  model: 'default',
  effort: 'default',
  permissionLevel: 1,
  timeoutMs: 60_000,
});
const attribution = { origin: 'stage' as const, projectId: null, taskId: null, runId: null, workflowId: null, workflowStep: null, agentRole: null, mode: null };

describe('agent launch spacing', () => {
  it('starts a second run of the same CLI only once the first has had its time to sign in', async () => {
    t = await createTestApp();
    const claude = new SignedInAgent('claude', 'Claude Code (stand-in)', 1500);
    const registry = new AgentRegistry(t.services.store, t.services.bus, t.services.settings, [claude], process.env, null, SPACING);
    const runs = await Promise.all([0, 1, 2].map((n) => registry.launch('claude', input(registry, 'claude', n), attribution)));
    await Promise.all(runs.map((r) => r.done));
    const [a, b, c] = claude.starts as [number, number, number];
    // Each waited for the one before it (timers may fire a little early on Windows), and none waited for a whole run.
    expect(b - a).toBeGreaterThanOrEqual(SPACING - 50);
    expect(c - b).toBeGreaterThanOrEqual(SPACING - 50);
    expect(c - a).toBeLessThan(1500 * 2);
  });

  it('hands the turn on as soon as the run before it ends', async () => {
    t = await createTestApp();
    const claude = new SignedInAgent('claude', 'Claude Code (stand-in)', 20);
    const registry = new AgentRegistry(t.services.store, t.services.bus, t.services.settings, [claude], process.env, null, 5_000);
    const first = await registry.launch('claude', input(registry, 'claude', 0), attribution);
    await first.done;
    const started = Date.now();
    await (await registry.launch('claude', input(registry, 'claude', 1), attribution)).done;
    expect(claude.starts[1]! - started).toBeLessThan(1_000);
  });

  it('never makes a simulated agent wait', async () => {
    t = await createTestApp();
    const sim = new RecordingSimulated('claude', 'Claude Code (simulated)', 800);
    const registry = new AgentRegistry(t.services.store, t.services.bus, t.services.settings, [sim], process.env, null, 5_000);
    const runs = await Promise.all([0, 1].map((n) => registry.launch('claude', input(registry, 'claude', n), attribution)));
    await Promise.all(runs.map((r) => r.done));
    expect(Math.abs(sim.starts[1]! - sim.starts[0]!)).toBeLessThan(500);
  });
});
