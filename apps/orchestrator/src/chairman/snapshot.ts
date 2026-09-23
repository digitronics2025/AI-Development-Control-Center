import {
  CHAIRMAN_HEALTH_LABEL,
  COMPLETE,
  STRATEGY_KIND_LABEL,
  STRATEGY_OUTCOME_LABEL,
  TASK_STATUS_LABEL,
  type ChairmanHealth,
  type ChairmanStrategyKind,
  type ChairmanStrategyOutcomeStatus,
  type Directive,
  type EventType,
  type TaskBlocker,
  type TaskLimits,
} from '@acc/shared';
import type { AgentRegistry } from '../services/agents.js';
import type { Store, TaskRecord } from '../store/store.js';
import type { TaskViews } from '../engine/views.js';
import type { ChairmanStore } from './store.js';

/**
 * The Chairman's view of a task (plan §3.3), rebuilt from the database
 * before every decision and every chat answer. Nothing here is remembered
 * between calls, so the Chairman can never act on a stale picture of its own.
 */
export interface ChairmanTaskSnapshot {
  taskId: string;
  version: number;
  title: string;
  goal: string;
  successCriteria: string[];
  contractVersion: number;
  status: string;
  autonomyMode: 'FULL_AUTOPILOT' | 'DISCUSS_FIRST';
  supervised: boolean;
  currentStage: { key: string; name: string; status: string | null } | null;
  currentWorker: { agentId: string; model: string | null; startedAt: string; status: string } | null;
  retryState: { localAttempt: number; localLimit: number; recoveryCycle: number };
  health: ChairmanHealth;
  blocker: TaskBlocker | null;
  activeDirectives: Array<{ id: string; text: string; kind: string; scope: string; status: string }>;
  recentEvents: Array<{ type: EventType; message: string; at: string }>;
  unresolvedFailures: Array<{ stageKey: string; source: string; message: string; failureCount: number | null; at: string }>;
  latestReview: { verdict: string | null; summary: string | null; at: string } | null;
  latestVerify: { verdict: string | null; summary: string | null; at: string } | null;
  latestTests: Array<{ name: string; kind: string; status: string; summary: string | null }>;
  checkpoints: Array<{ id: string; seq: number; label: string; stageKey: string | null; at: string }>;
  usage: { agentRuns: number; workMinutes: number };
  limits: TaskLimits | null;
  strategySummary: string | null;
  /** The latest recovery strategy and what objectively came of it (plan §3.16). */
  lastStrategy: {
    kind: ChairmanStrategyKind;
    targetStageKey: string | null;
    diagnosis: string;
    confidence: string;
    outcome: ChairmanStrategyOutcomeStatus;
    outcomeSummary: string | null;
  } | null;
  stages: Array<{ key: string; name: string; role: string; kind: string; agentId: string | null }>;
}

/** Chat replies render as Markdown: blank lines keep each fact on its own paragraph. */
const PARA = '\n\n';
const LINE = '\n';

const NOISE = new Set<EventType>(['AGENT_STARTED', 'COMMAND_STARTED', 'COMMAND_FINISHED', 'TEST_STARTED', 'STAGE_STARTED', 'ARTIFACT_CREATED', 'DIRECTIVE_APPLIED']);

export function activeDirectives(directives: Directive[]): Directive[] {
  return directives.filter((d) => d.state === 'active');
}

export class SnapshotService {
  constructor(
    private readonly store: Store,
    private readonly chairman: ChairmanStore,
    private readonly views: TaskViews,
    private readonly agents: AgentRegistry,
  ) {}

  build(taskOrId: string | TaskRecord): ChairmanTaskSnapshot {
    const task = typeof taskOrId === 'string' ? this.store.getTask(taskOrId) : taskOrId;
    if (!task) throw new Error('Task not found');
    const session = this.chairman.session(task.id);
    const contract = this.chairman.latestContract(task.id);
    const stages = this.store.listStages(task.id);
    const def = this.views.stageDef(task, task.currentStageKey);
    const instance = task.currentStageId ? stages.find((s) => s.id === task.currentStageId) ?? null : null;
    const running = this.store.listExecutions(task.id).filter((e) => e.status === 'running' && e.kind === 'agent').at(-1) ?? null;
    const lastVerdict = (role: 'reviewer' | 'verifier') => {
      const s = [...stages].reverse().find((x) => x.role === role && x.verdict !== null);
      return s ? { verdict: s.verdict, summary: s.summary, at: s.finishedAt ?? s.createdAt } : null;
    };
    const lastTests = [...stages].reverse().find((s) => s.kind === 'tests' && ['SUCCESS', 'FAILED'].includes(s.status));
    const usage = this.chairman.usage(task.id);
    const failures = this.chairman.listFailures(task.id, { recoveryCycle: task.recoveryCycle });
    const events = this.store.listEvents(task.id, { limit: 2000 }).filter((e) => !NOISE.has(e.type)).slice(-25);
    const last = this.chairman.listStrategyRuns(task.id, 1)[0] ?? null;
    return {
      taskId: task.id,
      version: task.version,
      title: task.title,
      goal: contract?.goal ?? task.description,
      successCriteria: contract?.successCriteria ?? [],
      contractVersion: contract?.version ?? 0,
      status: task.status,
      autonomyMode: task.mode === 'autopilot' ? 'FULL_AUTOPILOT' : 'DISCUSS_FIRST',
      supervised: task.supervised,
      currentStage: task.currentStageKey
        ? { key: task.currentStageKey, name: task.currentStageKey === COMPLETE ? 'Complete' : (def?.name ?? task.currentStageKey), status: instance?.status ?? null }
        : null,
      currentWorker: running ? { agentId: running.agentId ?? 'unknown', model: running.model, startedAt: running.startedAt, status: running.status } : null,
      retryState: { localAttempt: task.fixCycles, localLimit: task.maxFixCycles, recoveryCycle: task.recoveryCycle },
      health: session.health,
      blocker: task.blocker,
      activeDirectives: activeDirectives(this.store.listDirectives(task.id)).map((d) => ({ id: d.id, text: d.text, kind: d.kind, scope: d.scope, status: d.status })),
      recentEvents: events.map((e) => ({ type: e.type, message: e.message, at: e.at })),
      unresolvedFailures: failures.slice(-5).map((f) => ({ stageKey: f.stageKey, source: f.source, message: f.message, failureCount: f.failureCount, at: f.createdAt })),
      latestReview: lastVerdict('reviewer'),
      latestVerify: lastVerdict('verifier'),
      latestTests: lastTests ? this.store.listTestRuns(task.id, lastTests.id).map((r) => ({ name: r.name, kind: r.kind, status: r.status, summary: r.summary })) : [],
      checkpoints: this.chairman.listCheckpoints(task.id).slice(-5).map((c) => ({ id: c.id, seq: c.seq, label: c.label, stageKey: c.stageKey, at: c.createdAt })),
      usage: { agentRuns: usage.agentRuns, workMinutes: Math.round(usage.workMs / 60_000) },
      limits: task.limits,
      strategySummary: session.strategySummary,
      lastStrategy: last
        ? { kind: last.strategyKind, targetStageKey: last.targetStageKey, diagnosis: last.diagnosis.summary, confidence: last.diagnosis.confidence, outcome: last.status, outcomeSummary: last.outcomeSummary }
        : null,
      stages: task.workflow.stages.map((s) => ({
        key: s.key,
        name: s.name,
        role: s.role,
        kind: s.kind,
        agentId: s.kind === 'agent' ? this.views.assignmentFor(task, s).agentId : null,
      })),
    };
  }

  agentName(id: string | null | undefined): string {
    if (!id) return 'the system';
    return this.agents.has(id) ? this.agents.adapter(id).displayName : id;
  }

  /** Plain-language status for deterministic answers (§3.12 header, /status). */
  describe(s: ChairmanTaskSnapshot, topic: 'status' | 'blockers' | 'directives' = 'status'): string {
    const lines: string[] = [];
    if (topic === 'directives') {
      if (!s.activeDirectives.length) return 'There are no active directives. Anything you tell me that is not a question becomes one.';
      return `Active directives:${PARA}${s.activeDirectives.map((d, i) => `${i + 1}. ${d.text} (${d.kind}, ${d.scope === 'CURRENT_TASK' ? 'whole task' : 'next stage only'}, ${d.status})`).join(LINE)}`;
    }
    const status = TASK_STATUS_LABEL[s.status as keyof typeof TASK_STATUS_LABEL] ?? s.status;
    const stage = s.currentStage ? `${s.currentStage.name}${s.currentStage.status ? ` (${s.currentStage.status.toLowerCase().replace(/_/g, ' ')})` : ''}` : 'not started';
    if (topic === 'blockers') {
      if (!s.blocker) lines.push(`Nothing is blocking ${s.taskId}. It is ${status.toLowerCase()} at ${stage}.`);
      else lines.push(`${s.taskId} is ${status.toLowerCase()} at ${stage}: ${s.blocker.message}`);
      const f = s.unresolvedFailures.at(-1);
      if (f) lines.push(`Latest failure (${f.stageKey}): ${f.message}`);
      return lines.join(PARA);
    }
    lines.push(`${s.taskId} is ${status.toLowerCase()}. Stage: ${stage}.`);
    if (s.currentWorker) lines.push(`${this.agentName(s.currentWorker.agentId)} is working on it.`);
    if (s.supervised) {
      lines.push(`Health: ${CHAIRMAN_HEALTH_LABEL[s.health]}. Fix attempt ${s.retryState.localAttempt} of ${s.retryState.localLimit}${s.retryState.recoveryCycle ? `, recovery cycle ${s.retryState.recoveryCycle}` : ''}.`);
    }
    // A finished task has no "current" failure or strategy; only its outcome matters.
    const finished = s.status === 'COMPLETED' || s.status === 'CANCELLED';
    const sentence = (text: string) => text.replace(/[.\s]+$/, '');
    if (s.blocker && s.blocker.kind !== 'queued') lines.push(`Blocked: ${s.blocker.message}`);
    const f = s.unresolvedFailures.at(-1);
    if (f && !finished) lines.push(`Latest failure (${f.stageKey}): ${f.message}`);
    if (s.latestVerify) lines.push(`Last verification: ${s.latestVerify.verdict === 'PASS' ? 'passed' : 'rejected'}${s.latestVerify.summary ? ` — ${sentence(s.latestVerify.summary)}` : ''}.`);
    else if (s.latestReview) lines.push(`Last review: ${s.latestReview.verdict === 'PASS' ? 'passed' : 'changes requested'}${s.latestReview.summary ? ` — ${sentence(s.latestReview.summary)}` : ''}.`);
    if (s.strategySummary && !finished) lines.push(`Current strategy: ${s.strategySummary}`);
    if (s.lastStrategy) {
      const l = s.lastStrategy;
      const what = `${STRATEGY_KIND_LABEL[l.kind]}${l.targetStageKey ? ` at ${l.targetStageKey}` : ''}`;
      lines.push(`Last strategy: ${what} — ${STRATEGY_OUTCOME_LABEL[l.outcome]}${l.outcomeSummary ? `: ${sentence(l.outcomeSummary)}` : ''}.`);
    }
    if (s.activeDirectives.length) lines.push(`${s.activeDirectives.length} active directive${s.activeDirectives.length === 1 ? '' : 's'}.`);
    return lines.join(PARA);
  }
}
