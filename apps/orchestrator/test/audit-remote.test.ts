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
  ])('%j is refused from the cloud', (patch) => {
    expect(guardRemoteCommand('settings.update', {}, patch, ctx()).ok).toBe(false);
  });

  it('allows turning them off, and refuses loading user CLI customisations into an agent', () => {
    const on = ctx({ settings });
    expect(guardRemoteCommand('settings.update', {}, { execution: { terminals: false } }, on).ok).toBe(true);
    expect(guardRemoteCommand('agent.update', { id: 'claude' }, { loadUserConfig: true }, ctx()).ok).toBe(false);
    expect(guardRemoteCommand('agent.update', { id: 'claude' }, { loadUserConfig: false }, ctx()).ok).toBe(true);
  });
});
