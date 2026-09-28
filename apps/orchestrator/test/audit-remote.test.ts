import { describe, expect, it } from 'vitest';
import { settingsSchema } from '@acc/shared';
import { guardRemoteCommand, type GuardContext } from '../src/remote/guards.js';
import { DEFAULT_ROLE_DEFAULTS } from '../src/services/settings.js';

/** Regression tests for the 2026-09-24 pre-release audit: remote guards (F-20, F-50). */

const settings = settingsSchema.parse({ roleDefaults: DEFAULT_ROLE_DEFAULTS });
const builtin = { stages: [{ key: 'staging', name: 'Staging deploy', requiresApproval: true, permissionLevel: 4 }, { key: 'git', name: 'Git checkpoint', requiresApproval: false, permissionLevel: 3 }] };
const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  settings: { ...settings, execution: { ...settings.execution, terminals: false, exposeToolsToAgents: false, autoRepair: false }, learning: { ...settings.learning, autonomy: 'propose' } },
  repository: () => null,
  workflow: (id) => (id === 'full-autopilot' ? (builtin as never) : null),
  agent: () => ({ loadUserConfig: false }),
  ...over,
});

describe('F-20: the cloud cannot create a workflow without its approval steps', () => {
  it('refuses saving an unknown id and lowering a stage level; keeps allowing a harmless edit', () => {
    expect(guardRemoteCommand('workflow.save', { id: 'open-deploy' }, { stages: [] }, ctx()).ok).toBe(false);
    expect(guardRemoteCommand('workflow.save', { id: 'full-autopilot' }, { stages: [{ ...builtin.stages[0], permissionLevel: 4 }, { ...builtin.stages[1], permissionLevel: 1 }] }, ctx()).ok).toBe(false);
    expect(guardRemoteCommand('workflow.save', { id: 'full-autopilot' }, { name: 'Renamed', stages: builtin.stages }, ctx()).ok).toBe(true);
  });
});

describe('F-50: switches that widen what runs are turned on locally only', () => {
  it.each([
    [{ execution: { terminals: true } }],
    [{ execution: { exposeToolsToAgents: true } }],
    [{ execution: { autoRepair: true } }],
    [{ learning: { autonomy: 'act' } }],
    // Auto-resume at a usage reset spends a new usage window unasked (AGT-1).
    [{ execution: { autoResumeOnReset: true } }],
  ])('%j is refused from the cloud', (patch) => {
    expect(guardRemoteCommand('settings.update', {}, patch, ctx()).ok).toBe(false);
  });

  it('allows turning them off, and refuses loading user CLI customisations into an agent', () => {
    const on = ctx({ settings });
    expect(guardRemoteCommand('settings.update', {}, { execution: { terminals: false } }, on).ok).toBe(true);
    const resuming = ctx({ settings: { ...settings, execution: { ...settings.execution, autoResumeOnReset: true } } });
    expect(guardRemoteCommand('settings.update', {}, { execution: { autoResumeOnReset: false } }, resuming).ok).toBe(true);
    expect(guardRemoteCommand('settings.update', {}, { execution: { autoResumeOnReset: true } }, resuming).ok).toBe(true);
    expect(guardRemoteCommand('agent.update', { id: 'claude' }, { loadUserConfig: true }, ctx()).ok).toBe(false);
    expect(guardRemoteCommand('agent.update', { id: 'claude' }, { loadUserConfig: false }, ctx()).ok).toBe(true);
  });
});

describe('agent isolation is changed locally only (SEC-3, docs/systems/security.md#agent-os-boundary)', () => {
  it('refuses turning it on, turning it off or renaming the account from the cloud; allows sending it unchanged', () => {
    const off = ctx();
    const on = ctx({ settings: { ...off.settings, agentIsolation: { mode: 'account', account: 'acc-agent' } } });
    expect(guardRemoteCommand('settings.update', {}, { agentIsolation: { mode: 'account' } }, off)).toEqual({ ok: false, message: 'Agent isolation can only be changed on this machine.' });
    expect(guardRemoteCommand('settings.update', {}, { agentIsolation: { mode: 'off' } }, on).ok).toBe(false);
    expect(guardRemoteCommand('settings.update', {}, { agentIsolation: { account: 'other-agent' } }, on).ok).toBe(false);
    expect(guardRemoteCommand('settings.update', {}, { agentIsolation: { mode: 'account', account: 'acc-agent' } }, on).ok).toBe(true);
    expect(guardRemoteCommand('settings.update', {}, { agentIsolation: { mode: 'off' } }, off).ok).toBe(true);
    expect(guardRemoteCommand('settings.update', {}, { theme: 'light' }, on).ok).toBe(true);
  });
});

describe('paid media generation is loosened locally only (docs/systems/design-agent.md)', () => {
  it('refuses turning it on, raising the task budget or lowering a price from the cloud; allows tightening', () => {
    expect(guardRemoteCommand('settings.update', {}, { media: { allowPaidGeneration: true } }, ctx()).ok).toBe(false);
    expect(guardRemoteCommand('settings.update', {}, { media: { taskBudgetUsd: 50 } }, ctx()).ok).toBe(false);
    expect(guardRemoteCommand('settings.update', {}, { media: { taskBudgetUsd: 1 } }, ctx()).ok).toBe(true);
    const priced = ctx({ settings: { ...settings, media: { ...settings.media, allowPaidGeneration: true, prices: { 'fal-ai/flux/dev': 0.1 } } } });
    expect(guardRemoteCommand('settings.update', {}, { media: { prices: { 'fal-ai/flux/dev': 0.01 } } }, priced).ok).toBe(false);
    expect(guardRemoteCommand('settings.update', {}, { media: { prices: {} } }, priced).ok).toBe(false);
    expect(guardRemoteCommand('settings.update', {}, { media: { prices: { 'fal-ai/flux/dev': 0.2 } } }, priced).ok).toBe(true);
    expect(guardRemoteCommand('settings.update', {}, { media: { allowPaidGeneration: false } }, priced).ok).toBe(true);
  });

  it('refuses loosening or removing a media budget from the cloud; other budgets are unchanged', () => {
    const media = { scopeType: 'MEDIA' as const, amountNanos: 5_000_000_000, policy: 'STOP_NEW_RUNS' as const, enabled: true };
    const withBudget = ctx({ budget: (id) => (id === 'm1' ? media : id === 'g1' ? { ...media, scopeType: 'GLOBAL' as const } : null) });
    expect(guardRemoteCommand('usage.budgetRemove', { id: 'm1' }, {}, withBudget).ok).toBe(false);
    expect(guardRemoteCommand('usage.budgetUpdate', { id: 'm1' }, { amountUsd: 50 }, withBudget).ok).toBe(false);
    expect(guardRemoteCommand('usage.budgetUpdate', { id: 'm1' }, { policy: 'WARN_ONLY' }, withBudget).ok).toBe(false);
    expect(guardRemoteCommand('usage.budgetUpdate', { id: 'm1' }, { enabled: false }, withBudget).ok).toBe(false);
    expect(guardRemoteCommand('usage.budgetUpdate', { id: 'm1' }, { amountUsd: 2 }, withBudget).ok).toBe(true);
    expect(guardRemoteCommand('usage.budgetRemove', { id: 'g1' }, {}, withBudget).ok).toBe(true);
  });
});
