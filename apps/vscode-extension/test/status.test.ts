import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Role, TaskSummary } from '@acc/shared';
import { discover } from '../src/connection';
import { deriveStatus, shortAgentName } from '../src/status';

const base: TaskSummary = {
  id: 'TASK-0001',
  title: 'Do things',
  repositoryId: 'r',
  repositoryName: 'repo',
  workflowId: 'normal-development',
  workflowName: 'Normal Development',
  mode: 'autopilot',
  status: 'RUNNING',
  currentStageKey: 'implement',
  currentStageId: 's',
  currentStageName: 'Implement',
  currentAssignment: { agentId: 'claude', model: 'default', effort: 'high' },
  stageProgress: { total: 6, completed: 2, currentIndex: 2 },
  fixCycles: 0,
  supervised: true,
  recoveryCycle: 0,
  version: 1,
  blocker: null,
  lastEvent: null,
  finalStatus: null,
  pauseRequested: false,
  pauseAfterStage: false,
  createdAt: '2026-09-23T10:00:00.000Z',
  startedAt: '2026-09-23T10:00:00.000Z',
  finishedAt: null,
  updatedAt: '2026-09-23T10:05:00.000Z',
};
const names = (id: string) => ({ claude: 'Claude Code', codex: 'Codex (simulated)' })[id] ?? id;
const now = Date.parse('2026-09-23T10:06:00.000Z');
const role = (r: Role | null) => () => r;

describe('deriveStatus (PLAN §25 status bar)', () => {
  it('is idle with nothing going on', () => {
    expect(deriveStatus([], names, role(null), now).text).toBe('AI: Idle');
  });

  it('names the agent and activity of the running stage', () => {
    expect(deriveStatus([base], names, role('implementer'), now).text).toBe('AI: Claude Implementing');
    const investigating = { ...base, currentAssignment: { agentId: 'codex', model: 'default', effort: 'medium' } };
    expect(deriveStatus([investigating], names, role('investigator'), now).text).toBe('AI: Codex Investigating');
  });

  it('reports test stages', () => {
    expect(deriveStatus([{ ...base, currentAssignment: null, currentStageName: 'Test' }], names, role('tester'), now).text).toBe('AI: Tests Running');
  });

  it('puts approvals ahead of running work', () => {
    const waiting = { ...base, id: 'TASK-0002', status: 'WAITING_FOR_USER' as const, blocker: { kind: 'approval' as const, message: 'Approval needed' } };
    const view = deriveStatus([base, waiting], names, role('implementer'), now);
    expect(view).toMatchObject({ text: 'AI: Waiting Approval', taskId: 'TASK-0002', severity: 'attention' });
  });

  it('shows recent failure and completion, then falls back to idle', () => {
    expect(deriveStatus([{ ...base, status: 'FAILED' }], names, role(null), now).text).toBe('AI: Failed');
    expect(deriveStatus([{ ...base, status: 'COMPLETED', finalStatus: 'READY' }], names, role(null), now).text).toBe('AI: Complete');
    const old = { ...base, status: 'COMPLETED' as const, updatedAt: '2026-09-22T10:00:00.000Z' };
    expect(deriveStatus([old], names, role(null), now).text).toBe('AI: Idle');
  });

  it('shortens agent names for the status bar', () => {
    expect(shortAgentName('Claude Code (simulated)')).toBe('Claude');
    expect(shortAgentName('Codex')).toBe('Codex');
  });
});

describe('discover', () => {
  it('reads the runtime file and token', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-ext-'));
    writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ url: 'http://127.0.0.1:4317' }));
    writeFileSync(path.join(dir, 'auth-token'), 'tok-123\n');
    expect(discover(dir)).toEqual({ url: 'http://127.0.0.1:4317', token: 'tok-123', dataDir: dir });
  });

  it('refuses non-loopback URLs and missing files', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-ext-'));
    expect(discover(dir)).toBeNull();
    writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ url: 'http://evil.example.com:4317' }));
    writeFileSync(path.join(dir, 'auth-token'), 'tok');
    expect(discover(dir)).toBeNull();
  });
});
