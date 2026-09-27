import path from 'node:path';
import { redact } from '@acc/security';
import { formatUsd, isJudgeRole, isWriteRole, type ChairmanStrategyRun, type LearningSignal, type LearningSignalKind, type StageInstance, type ToolExecution } from '@acc/shared';
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
  /** The task's estimated paid-media spend and its budget (Settings → Media), in nano-dollars. */
  media?: { spentNanos: number; budgetNanos: number };
}

/** axe rule ids, as `browser.accessibility` names them in its summary ("… violation(s) (dark): color-contrast at p, …"). */
const AXE_RULE = /^[a-z0-9][a-z0-9-]{1,59}$/;

export function axeRulesOf(summary: string | null): string[] {
  const list = /^\d+ accessibility violation\(s\)[^:]*: (.+)$/.exec(summary ?? '')?.[1];
  if (!list) return [];
  return [...new Set(list.split(', ').map((part) => part.split(' at ')[0]!.trim()).filter((id) => AXE_RULE.test(id)))];
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

  // A capability that kept failing for other reasons. An accessibility check that found violations worked: those count as a11y_rule below.
  const failing = new Map<string, ToolExecution[]>();
  for (const c of calls.filter((c) => c.status === 'failed' && c.errorCode && !['NOT_INSTALLED', 'INVALID_INPUT', 'CANCELLED'].includes(c.errorCode) && !(c.capability === 'browser.accessibility' && axeRulesOf(c.summary).length))) {
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

  // Rounds of fixing before the checks passed; a design workflow fixes in its build stage (a designer run in a fix cycle).
  const fixers = input.stages.filter((s) => s.role === 'fixer' && s.kind === 'agent').length;
  const rounds = Math.max(input.task.fixCycles, fixers);
  if (rounds >= 2) {
    const source = input.failedTestRuns >= 2 ? 'tests' : 'review';
    add('fix_loops', source, `${rounds} fix rounds before the ${source === 'tests' ? 'tests passed' : 'review passed'}`, rounds, input.stages.filter((s) => s.role === 'fixer' || (s.role === 'designer' && s.cycle > 0)).map((s) => s.stageKey));
  }

  // Design work judged failing more than once in one judge stage: a visual critique, or a review of work only a
  // designer did (Frontend Design). In Full Autopilot a design fix may run among implementer and fixer work, so a
  // code review failing there is not design friction (DESIGNER_ROUTING_PLAN §5).
  const writers = input.stages.filter((s) => isWriteRole(s.role) && s.kind === 'agent');
  const designOnly = writers.length > 0 && writers.every((s) => s.role === 'designer');
  const judged = new Map<string, StageInstance[]>();
  for (const s of input.stages.filter((s) => s.verdict === 'FAIL' && isJudgeRole(s.role) && (s.role === 'visual-critic' || designOnly))) judged.set(s.stageKey, [...(judged.get(s.stageKey) ?? []), s]);
  for (const [stageKey, fails] of judged) {
    if (fails.length < 2) continue;
    add('design_critique', stageKey, `${fails[0]!.name} failed the design ${fails.length} times`, fails.length, [stageKey]);
  }

  // The same accessibility rule failing in more than one check (a width, a theme, or a later round). Outside a design
  // workflow (a critique in Full Autopilot looks in both themes once per pass) it must fail in two stage runs: a rule
  // the repository already broke is not friction the task met twice (DESIGNER_ROUTING_PLAN §5).
  const rules = new Map<string, ToolExecution[]>();
  for (const c of calls.filter((c) => c.capability === 'browser.accessibility')) for (const id of axeRulesOf(c.summary)) rules.set(id, [...(rules.get(id) ?? []), c]);
  for (const [id, list] of rules) {
    if (list.length < 2 || (!designOnly && new Set(list.map((c) => c.stageId ?? '')).size < 2)) continue;
    add('a11y_rule', id, `The accessibility rule ${id} failed in ${list.length} checks`, list.length, list.map((c) => stageName(input.stages, c.stageId)));
  }

  // Paid media: most of the task budget used, or a call refused because it would not fit.
  const refusedForBudget = calls.filter((c) => c.errorCode === 'DENIED' && c.capability.startsWith('media.') && /\bbudget\b/i.test(c.summary ?? ''));
  const media = input.media;
  const nearCap = media && media.budgetNanos > 0 && media.spentNanos >= media.budgetNanos * 0.8;
  if (nearCap || refusedForBudget.length) {
    const used = media ? `${formatUsd(media.spentNanos)} of the ${formatUsd(media.budgetNanos)} task budget` : 'the task budget';
    add('media_spend', 'task_budget', `Paid media used ${used}${refusedForBudget.length ? `; ${refusedForBudget.length} call(s) refused for the budget` : ''}`, Math.max(1, refusedForBudget.length), refusedForBudget.map((c) => stageName(input.stages, c.stageId)));
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
