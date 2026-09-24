import path from 'node:path';
import { redact } from '@acc/security';
import type { ChairmanStrategyRun, LearningSignal, LearningSignalKind, StageInstance, ToolExecution } from '@acc/shared';
import type { TaskRecord } from '../store/store.js';

/**
 * Friction in a finished task, read from what the orchestrator recorded
 * (docs/systems/learning.md#signals). Pure over its inputs so every rule is
 * testable; the service gathers the rows. Nothing here comes from a model.
 */

export interface SignalInputs {
  task: Pick<TaskRecord, 'id' | 'fixCycles' | 'finalStatus' | 'status' | 'blocker'>;
  stages: StageInstance[];
  toolCalls: ToolExecution[];
  /** Agent log lines that matched a friction pattern (see `LOG_PATTERNS`). */
  logLines: Array<{ stageId: string | null; text: string }>;
  strategies: ChairmanStrategyRun[];
  /** Failed test runs, for naming what the fix rounds were about. */
  failedTestRuns: number;
  /** Tool-layer providers that offer a capability, to name a missing program. */
  providersFor(capability: string): string[];
}

/** SQL LIKE patterns the service uses to pick candidate log lines; `parseLogLine` decides. */
export const LOG_PATTERNS = ['%command not found%', '%is not recognized as%', 'permission denied: Skill%'];

const SLOW_STAGE_MS = 20 * 60_000;
const BLOCKING = new Set(['USAGE_LIMIT', 'MODEL_UNAVAILABLE', 'AUTH_FAILURE']);
const COMMAND = /^[A-Za-z0-9_.+-]{1,40}$/;

/** A command a shell could not find, or a skill a stage refused, from one log line. */
export function parseLogLine(text: string): { kind: 'command_missing' | 'skill_denied'; key: string } | null {
  const skill = /^permission denied: Skill\s+([A-Za-z0-9][A-Za-z0-9._:-]*)/.exec(text);
  if (skill) return { kind: 'skill_denied', key: skill[1]! };
  const found =
    /The term '([^']{1,120})' is not recognized/i.exec(text)?.[1] ??
    /'([^']{1,120})' is not recognized as an internal or external command/i.exec(text)?.[1] ??
    /(?:^|[\s:'"`])([^\s:'"`]{1,120}): (?:command not found)/i.exec(text)?.[1];
  if (!found) return null;
  const command = path.basename(found.replace(/\\/g, '/')).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '');
  return COMMAND.test(command) ? { kind: 'command_missing', key: command } : null;
}

function stageName(stages: StageInstance[], stageId: string | null): string | null {
  return stageId ? (stages.find((s) => s.id === stageId)?.stageKey ?? null) : null;
}

function durationMs(stage: StageInstance): number {
  if (!stage.startedAt || !stage.finishedAt) return 0;
  return Date.parse(stage.finishedAt) - Date.parse(stage.startedAt);
}

export function collectSignals(input: SignalInputs): LearningSignal[] {
  const raw: Array<Omit<LearningSignal, 'id'>> = [];
  const add = (kind: LearningSignalKind, key: string, summary: string, count: number, stageKeys: Array<string | null>) =>
    raw.push({ kind, key, summary: redact(summary).slice(0, 300), count, stageKeys: [...new Set(stageKeys.filter((k): k is string => Boolean(k)))] });

  // Programs the tool layer could not find. The learning loop's own installs never count.
  const calls = input.toolCalls.filter((c) => c.origin !== 'chairman');
  const missing = new Map<string, ToolExecution[]>();
  for (const c of calls.filter((c) => c.errorCode === 'NOT_INSTALLED')) {
    const key = c.providerId ?? input.providersFor(c.capability)[0] ?? c.capability;
    missing.set(key, [...(missing.get(key) ?? []), c]);
  }
  for (const [key, list] of missing) {
    add('tool_missing', key, `${list[0]!.capability} could not run: ${list[0]!.summary ?? `${key} is not installed`}`, list.length, list.map((c) => stageName(input.stages, c.stageId)));
  }

  // A capability that kept failing for other reasons.
  const failing = new Map<string, ToolExecution[]>();
  for (const c of calls.filter((c) => c.status === 'failed' && c.errorCode && !['NOT_INSTALLED', 'INVALID_INPUT', 'CANCELLED'].includes(c.errorCode))) {
    failing.set(c.capability, [...(failing.get(c.capability) ?? []), c]);
  }
  for (const [capability, list] of failing) {
    if (list.length < 2) continue;
    add('tool_failures', capability, `${capability} failed ${list.length} times; last: ${list.at(-1)!.summary ?? list.at(-1)!.errorCode}`, list.length, list.map((c) => stageName(input.stages, c.stageId)));
  }

  // Commands a shell could not find, and skills a stage's level refused.
  const fromLogs = new Map<string, { kind: 'command_missing' | 'skill_denied'; key: string; count: number; stages: Array<string | null>; example: string }>();
  for (const line of input.logLines) {
    const hit = parseLogLine(line.text);
    if (!hit) continue;
    const id = `${hit.kind}:${hit.key}`;
    const entry = fromLogs.get(id) ?? { ...hit, count: 0, stages: [], example: line.text };
    entry.count++;
    entry.stages.push(stageName(input.stages, line.stageId));
    fromLogs.set(id, entry);
  }
  for (const e of fromLogs.values()) {
    if (e.kind === 'command_missing' && missing.has(e.key)) continue;
    add(e.kind, e.key, e.kind === 'command_missing' ? `An agent's command "${e.key}" was not found (${e.count}×): ${e.example.slice(0, 160)}` : `The stage's permission level refused the skill ${e.key} (${e.count}×)`, e.count, e.stages);
  }

  // Rounds of fixing before the checks passed.
  const fixers = input.stages.filter((s) => s.role === 'fixer' && s.kind === 'agent').length;
  const rounds = Math.max(input.task.fixCycles, fixers);
  if (rounds >= 2) {
    const source = input.failedTestRuns >= 2 ? 'tests' : 'review';
    add('fix_loops', source, `${rounds} fix rounds before the ${source === 'tests' ? 'tests passed' : 'review passed'}`, rounds, input.stages.filter((s) => s.role === 'fixer').map((s) => s.stageKey));
  }

  // Chairman recovery strategies, grouped by what failed.
  const byCategory = new Map<string, ChairmanStrategyRun[]>();
  for (const r of input.strategies.filter((r) => r.trigger !== 'provider_blocked')) byCategory.set(r.failureCategory, [...(byCategory.get(r.failureCategory) ?? []), r]);
  for (const [category, runs] of byCategory) {
    const outcomes = runs.map((r) => `${r.strategyKind}→${r.status}`).join(', ');
    add('recovery', category, `The Chairman needed ${runs.length} recovery strateg${runs.length === 1 ? 'y' : 'ies'} for ${category} failures (${outcomes})`, runs.length, runs.map((r) => r.failureStageKey));
  }

  for (const s of input.stages.filter((s) => s.errorClass === 'TIMEOUT')) add('stage_timeout', s.stageKey, `${s.name} timed out${s.errorMessage ? `: ${s.errorMessage}` : ''}`, 1, [s.stageKey]);

  const blocked = input.stages.filter((s) => s.errorClass && BLOCKING.has(s.errorClass));
  for (const agent of new Set(blocked.map((s) => s.agentId ?? 'agent'))) {
    const list = blocked.filter((s) => (s.agentId ?? 'agent') === agent);
    add('provider_block', agent, `${agent} was blocked ${list.length}× (${[...new Set(list.map((s) => s.errorClass))].join(', ')})`, list.length, list.map((s) => s.stageKey));
  }

  if (input.task.status !== 'COMPLETED' && input.task.blocker) {
    add('task_stuck', input.task.blocker.kind, `The task stopped (${input.task.status.toLowerCase().replace(/_/g, ' ')}): ${input.task.blocker.message}`, 1, []);
  }

  if (input.task.finalStatus === 'NEEDS_USER_ACTION') add('completion_limits', 'final', 'The task finished with checks it could not meet (needs your attention)', 1, []);

  for (const s of input.stages.filter((s) => s.kind === 'agent' && durationMs(s) > SLOW_STAGE_MS)) {
    add('slow_stage', s.stageKey, `${s.name} ran ${Math.round(durationMs(s) / 60_000)} minutes`, 1, [s.stageKey]);
  }

  return raw.map((s, i) => ({ id: `s${i + 1}`, ...s }));
}
