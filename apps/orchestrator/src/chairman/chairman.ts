import { changesSince } from '@acc/git';
import { redact } from '@acc/security';
import {
  type ChairmanActionInput,
  type ChairmanOverview,
  type ChairmanState,
  type ChairmanStatus,
  type StageDefinition,
  type StageInstance,
  type TaskContract,
  type TaskLimits,
} from '@acc/shared';
import type { Bus } from '../bus.js';
import type { ContextBuilder } from '../engine/context.js';
import type { TaskEngine } from '../engine/engine.js';
import type { RunControl, StageOutcome } from '../engine/runners.js';
import type { SupervisorHooks } from '../engine/supervision.js';
import type { TaskViews } from '../engine/views.js';
import type { AgentRegistry } from '../services/agents.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { RepositoryService } from '../services/repositories.js';
import type { SettingsService } from '../services/settings.js';
import { now, type Store, type TaskRecord } from '../store/store.js';
import { CheckpointService } from './checkpoints.js';
import { completionGate, type GateResult } from './gate.js';
import { ActionGateway } from './gateway.js';
import { decideOnFailure, extendLimits, limitReached, recoveryCandidates, TRIGGER_LABEL, type RecoveryTrigger, type StrategyCandidate } from './policy.js';
import { classifyProgress } from './progress.js';
import { fenceEvidence, Reasoner } from './reasoner.js';
import { pointsAtPlan, signatureOf, type FailureSignature, type FailureSource } from './signatures.js';
import { activeDirectives, SnapshotService } from './snapshot.js';
import { ChairmanStore } from './store.js';

export interface ChairmanDeps {
  store: Store;
  bus: Bus;
  engine: TaskEngine;
  views: TaskViews;
  agents: AgentRegistry;
  settings: SettingsService;
  artifacts: ArtifactService;
  repositories: RepositoryService;
  context: ContextBuilder;
}

const BLOCKING_PROVIDER = new Set(['USAGE_LIMIT', 'MODEL_UNAVAILABLE', 'AUTH_FAILURE']);

/**
 * The Chairman supervisor (docs/systems/chairman.md). One per orchestrator,
 * with one session per task; the same session powers background supervision
 * and chat. It reads fresh state for every decision, decides with the
 * deterministic policy (and the reasoning model where interpretation helps),
 * and changes nothing except through the Action Gateway.
 */
export class Chairman implements SupervisorHooks {
  readonly store: ChairmanStore;
  readonly gateway: ActionGateway;
  readonly snapshots: SnapshotService;
  readonly checkpoints: CheckpointService;
  readonly reasoner: Reasoner;

  constructor(private readonly d: ChairmanDeps) {
    this.store = new ChairmanStore(d.store.db);
    this.snapshots = new SnapshotService(d.store, this.store, d.views, d.agents);
    this.checkpoints = new CheckpointService(d.store, this.store, d.repositories, d.engine.publisher, d.bus);
    this.reasoner = new Reasoner(d.agents, d.settings, d.artifacts, d.store);
    this.gateway = new ActionGateway({
      store: d.store,
      chairman: this.store,
      engine: d.engine,
      checkpoints: this.checkpoints,
      publisher: d.engine.publisher,
      views: d.views,
      bus: d.bus,
      setGuidance: (taskId, guidance) => {
        this.store.updateSession(taskId, { strategySummary: redact(guidance).slice(0, 2000) });
        this.publishState(taskId);
      },
      gate: (task) => this.gate(task),
    });
    d.context.guidance = (taskId) => this.store.session(taskId).strategySummary;
    d.engine.attachSupervisor(this);
  }

  private task(id: string): TaskRecord {
    const task = this.d.store.getTask(id);
    if (!task) throw new Error(`Task ${id} not found`);
    return task;
  }

  // ===========================================================================
  // State and contract
  // ===========================================================================

  contract(task: TaskRecord): TaskContract {
    return this.store.latestContract(task.id) ?? this.store.insertContract(this.initialContract(task));
  }

  private initialContract(task: TaskRecord): TaskContract {
    const has = (pred: (s: StageDefinition) => boolean) => task.workflow.stages.some(pred);
    const criteria = ['The requested change is implemented'];
    if (has((s) => s.kind === 'tests')) criteria.push('The repository checks pass after the last change');
    if (has((s) => s.role === 'reviewer' && s.verdict)) criteria.push('Review passes');
    if (has((s) => s.role === 'verifier' && s.verdict)) criteria.push('Verification passes');
    const repo = this.d.store.getRepository(task.repositoryId);
    return {
      taskId: task.id,
      version: 1,
      goal: `${task.title}\n\n${task.description}`.slice(0, 20_000),
      successCriteria: criteria,
      scope: { repository: repo?.name ?? task.repositoryId, workflow: task.workflow.name },
      autonomyMode: task.mode === 'autopilot' ? 'FULL_AUTOPILOT' : 'DISCUSS_FIRST',
      constraints: [],
      reason: 'Task created',
      createdAt: now(),
    };
  }

  /** A new contract version: the goal changed or a hard constraint was added (§3.4). */
  reviseContract(taskId: string, change: { goal?: string; constraint?: string; reason: string }): TaskContract {
    const current = this.contract(this.task(taskId));
    return this.store.insertContract({
      ...current,
      version: current.version + 1,
      goal: change.goal ? redact(change.goal) : current.goal,
      constraints: change.constraint ? [...current.constraints, redact(change.constraint)] : current.constraints,
      reason: change.reason,
      createdAt: now(),
    });
  }

  state(taskId: string): ChairmanState {
    const task = this.task(taskId);
    const session = this.store.session(taskId);
    const unavailable = this.reasoner.unavailableReason();
    const terminal = task.status === 'COMPLETED' || task.status === 'CANCELLED';
    let status: ChairmanStatus = session.status;
    if (!task.supervised) status = 'off';
    else if (terminal) status = 'idle';
    else if (status !== 'evaluating') status = unavailable ? 'degraded' : 'supervising';
    return {
      taskId,
      supervised: task.supervised,
      status,
      health: session.health,
      recoveryCycle: task.recoveryCycle,
      limits: task.limits,
      usage: this.store.usage(taskId),
      strategySummary: session.strategySummary,
      lastRecoveryReason: session.lastRecoveryReason,
      degradedReason: unavailable ?? session.degradedReason,
      reasoner: { agentId: this.reasoner.agentId(), available: unavailable === null },
      contractVersion: this.contract(task).version,
      updatedAt: session.updatedAt,
    };
  }

  publishState(taskId: string): void {
    try {
      this.d.bus.publish({ type: 'chairman', state: this.state(taskId) });
    } catch {
      /* task deleted */
    }
  }

  overview(taskId: string): ChairmanOverview {
    const task = this.task(taskId);
    return {
      state: this.state(taskId),
      contract: this.contract(task),
      messages: this.store.listMessages(taskId, { limit: 200 }),
      decisions: this.store.listDecisions(taskId, 50),
      actions: this.store.listActions(taskId, 100),
      checkpoints: this.store.listCheckpoints(taskId),
    };
  }

  /** Post a Chairman-authored line into the task's chat (decisions, restart notes). */
  note(taskId: string, body: string, extra: { kind?: 'message' | 'decision'; decisionId?: string | null } = {}): void {
    const message = this.store.insertMessage({ taskId, role: 'chairman', kind: extra.kind ?? 'message', body: redact(body), intent: null, status: 'done', decisionId: extra.decisionId ?? null, actionId: null });
    this.d.bus.publish({ type: 'chairman.message', message });
  }

  // ===========================================================================
  // Engine hooks
  // ===========================================================================

  onTaskCreated(task: TaskRecord): void {
    this.contract(task);
    this.store.updateSession(task.id, { status: task.supervised ? 'supervising' : 'idle' });
  }

  async beforeStage(task: TaskRecord, def: StageDefinition): Promise<boolean> {
    const usage = { recoveryCycle: task.recoveryCycle, ...this.store.usage(task.id) };
    const limit = limitReached(task.limits, usage);
    if (limit) {
      this.decide(task, 'limit', `Stopped before ${def.name}: ${limit}`, 'Pause at limit', { hardBlocker: false });
      await this.d.engine.block(task.id, 'limit', limit, { inLoop: true, stageKey: def.key });
      return false;
    }
    if (def.kind === 'agent' && def.permissionLevel >= 2) {
      try {
        await this.checkpoints.create(task, { label: `Before ${def.name}`, reason: 'before-stage', stageKey: def.key });
      } catch (error) {
        this.d.engine.publisher.event(task.id, 'WATCHDOG', `Checkpoint before ${def.name} failed: ${(error as Error).message}. Rollback will not be available for this change.`);
      }
    }
    return true;
  }

  afterSuccess(taskId: string, def: StageDefinition, stage: StageInstance): void {
    const source: FailureSource | null = def.kind === 'tests' ? 'tests' : stage.verdict === 'PASS' ? (def.role === 'verifier' ? 'verify' : 'review') : null;
    if (!source) return;
    const task = this.task(taskId);
    const failures = this.store.listFailures(taskId, { recoveryCycle: task.recoveryCycle }).filter((f) => f.source === source);
    if (!failures.length) return;
    this.store.updateSession(taskId, { health: classifyProgress(failures, true) });
    this.publishState(taskId);
  }

  private recordFailure(task: TaskRecord, stage: StageInstance, sig: FailureSignature) {
    this.store.insertFailure({
      taskId: task.id,
      stageId: stage.id,
      stageKey: stage.stageKey,
      source: sig.source,
      category: sig.category,
      signature: sig.signature,
      hash: sig.hash,
      failureCount: sig.failureCount,
      message: redact(sig.message),
      recoveryCycle: task.recoveryCycle,
    });
    const history = this.store.listFailures(task.id, { recoveryCycle: task.recoveryCycle }).filter((f) => f.source === sig.source);
    const health = classifyProgress(history);
    this.store.updateSession(task.id, { health });
    this.publishState(task.id);
    return { health, repeats: history.filter((f) => f.hash === sig.hash).length };
  }

  private async testEvidence(taskId: string, stageId: string): Promise<{ detail: string; commandName: string | null }> {
    const failed = this.d.store.listTestRuns(taskId, stageId).find((r) => r.status === 'failed');
    if (!failed?.executionId) return { detail: '', commandName: failed?.name ?? null };
    return { detail: this.d.store.tailLogLines(failed.executionId, 80).map((l) => l.text).join('\n'), commandName: failed.name };
  }

  async onFailure(taskId: string, def: StageDefinition, stage: StageInstance, outcome: Extract<StageOutcome, { kind: 'verdict_fail' | 'tests_failed' }>, control: RunControl): Promise<'local_fix' | 'continue' | 'stop'> {
    const task = this.task(taskId);
    let sig: FailureSignature;
    let detail: string;
    if (outcome.kind === 'tests_failed') {
      const evidence = await this.testEvidence(taskId, stage.id);
      detail = evidence.detail;
      sig = signatureOf({ source: 'tests', stageKey: def.key, message: outcome.message, detail, commandName: evidence.commandName });
    } else {
      const source: FailureSource = def.role === 'verifier' ? 'verify' : 'review';
      detail = (await this.d.artifacts.latestText(taskId, def.role === 'verifier' ? 'verification' : 'review', 40_000)) ?? '';
      const latest = this.d.store.getStage(stage.id);
      sig = signatureOf({ source, stageKey: def.key, message: latest?.summary ?? `${def.name} requested changes`, detail });
    }
    const { health, repeats } = this.recordFailure(task, stage, sig);
    const decision = decideOnFailure({
      source: sig.source,
      health,
      hasOnFail: Boolean(def.onFail),
      fixCycles: task.fixCycles,
      maxFixCycles: task.maxFixCycles,
      pointsAtPlan: pointsAtPlan(detail),
      repeats,
    });
    if (decision.kind === 'local_fix') return 'local_fix';
    return this.recover(this.task(taskId), { trigger: decision.trigger, failingStageKey: def.key, sig, evidence: detail }, control);
  }

  async onError(taskId: string, def: StageDefinition, stage: StageInstance, outcome: Extract<StageOutcome, { kind: 'error' }>, control: RunControl, mode: 'exhausted' | 'blocked'): Promise<'continue' | 'stop' | 'legacy'> {
    const task = this.task(taskId);
    const sig = signatureOf({ source: 'worker', stageKey: def.key, message: outcome.message, errorClass: outcome.errorClass });
    this.recordFailure(task, stage, sig);
    if (mode === 'blocked') {
      // Provider blocks: hand the stage to another subscription agent if one is healthy; otherwise wait as before.
      if (!BLOCKING_PROVIDER.has(outcome.errorClass) || def.kind !== 'agent') return 'legacy';
      const candidates = recoveryCandidates(this.candidateContext(task, 'provider_blocked', def.key, sig));
      const choice = candidates[0];
      if (!choice) return 'legacy';
      const decision = this.decide(task, 'provider_blocked', `${def.name} is blocked (${outcome.message.slice(0, 160)}). ${choice.label}.`, choice.label, { fingerprint: choice.fingerprint });
      this.rememberStrategy(taskId, choice, `${def.name} moved to another agent after: ${outcome.message.slice(0, 200)}`);
      const results = await this.gateway.executeDecision(taskId, choice.actions, { initiator: 'chairman', source: 'supervisor', decisionId: decision.id, control });
      return results.every((r) => r.status === 'completed') ? 'continue' : 'legacy';
    }
    return this.recover(task, { trigger: 'worker_failure', failingStageKey: def.key, sig, evidence: outcome.message }, control);
  }

  private candidateContext(task: TaskRecord, trigger: RecoveryTrigger, failingStageKey: string, sig: FailureSignature) {
    const assignments: Record<string, string> = {};
    for (const s of task.workflow.stages) if (s.kind === 'agent') assignments[s.key] = this.d.views.assignmentFor(task, s).agentId;
    const available = this.d.agents.list().filter((a) => a.settings.enabled && ['connected', 'unknown'].includes(a.health.state)).map((a) => a.id);
    const triedAgents: Record<string, string[]> = {};
    for (const s of this.d.store.listStages(task.id)) {
      if (!s.agentId || s.status === 'CANCELLED') continue;
      const list = (triedAgents[s.stageKey] ??= []);
      if (!list.includes(s.agentId)) list.push(s.agentId);
    }
    const regression = trigger === 'regression' ? this.checkpoints.lastChangeTarget(task) : null;
    return {
      trigger,
      workflow: task.workflow,
      failingStageKey,
      signatureHash: sig.hash,
      failureMessage: sig.message,
      assignments,
      availableAgents: available,
      triedAgents,
      triedFingerprints: new Set(this.store.session(task.id).strategyFingerprints),
      rollbackCheckpointId: regression?.id ?? null,
    };
  }

  private decide(
    task: TaskRecord,
    trigger: string,
    summary: string,
    decision: string,
    extra: { reasoningSummary?: string; expectedResult?: string; hardBlocker?: boolean; reasoner?: 'model' | 'policy'; fingerprint?: string | null } = {},
  ) {
    const session = this.store.session(task.id);
    const rec = this.store.insertDecision({
      taskId: task.id,
      source: 'supervisor',
      trigger,
      taskVersion: task.version,
      summary: capitalize(redact(summary)).slice(0, 600),
      reasoningSummary: redact(extra.reasoningSummary ?? '').slice(0, 1500),
      decision: redact(decision).slice(0, 300),
      expectedResult: redact(extra.expectedResult ?? '').slice(0, 600),
      hardBlocker: Boolean(extra.hardBlocker),
      health: session.health,
      reasoner: extra.reasoner ?? 'policy',
      strategyFingerprint: extra.fingerprint ?? null,
    });
    this.store.updateSession(task.id, { lastDecisionId: rec.id });
    this.d.bus.publish({ type: 'chairman.decision', decision: rec });
    this.d.engine.publisher.event(task.id, 'CHAIRMAN_DECISION', `Chairman: ${rec.summary}`, { decisionId: rec.id, trigger });
    this.note(task.id, rec.summary, { kind: 'decision', decisionId: rec.id });
    return rec;
  }

  private rememberStrategy(taskId: string, candidate: StrategyCandidate, guidance: string): void {
    const session = this.store.session(taskId);
    this.store.updateSession(taskId, {
      strategyFingerprints: [...session.strategyFingerprints, candidate.fingerprint].slice(-200),
      strategySummary: redact(guidance).slice(0, 2000),
      lastRecoveryReason: candidate.label,
    });
  }

  /**
   * A recovery cycle (§3.9): pick a materially different strategy, record the
   * decision, start the cycle (fresh local fix budget) and execute it through
   * the gateway. Never repeats a strategy already tried against this failure.
   */
  private async recover(
    task: TaskRecord,
    input: { trigger: RecoveryTrigger; failingStageKey: string; sig: FailureSignature; evidence: string },
    control: RunControl,
    attempt = 0,
  ): Promise<'continue' | 'stop'> {
    const usage = { recoveryCycle: task.recoveryCycle, ...this.store.usage(task.id) };
    const limit = limitReached(task.limits, usage, { startingRecovery: true });
    if (limit) {
      this.decide(task, input.trigger, `${TRIGGER_LABEL[input.trigger]}, and ${limit.charAt(0).toLowerCase()}${limit.slice(1)}`, 'Pause at limit');
      await this.d.engine.block(task.id, 'limit', limit, { inLoop: true, stageKey: input.failingStageKey });
      return 'stop';
    }
    const candidates = recoveryCandidates(this.candidateContext(task, input.trigger, input.failingStageKey, input.sig));
    if (!candidates.length) return this.hardBlock(task, input);

    this.store.updateSession(task.id, { status: 'evaluating' });
    this.publishState(task.id);
    const decidedOn = this.task(task.id).version;
    let ordered = candidates;
    let choice: { summary: string; reasoningSummary: string; guidance: string; expectedResult: string; reasoner: 'model' | 'policy' } = {
      summary: `${TRIGGER_LABEL[input.trigger]}. Next: ${candidates[0]!.label}.`,
      reasoningSummary: '',
      guidance: '',
      expectedResult: '',
      reasoner: 'policy',
    };
    if (!this.reasoner.unavailableReason()) {
      const result = await this.reasoner.chooseRecovery(this.snapshots.build(task.id), TRIGGER_LABEL[input.trigger], candidates, this.evidence(task.id, input.evidence), {
        onCancel: (cancel) => {
          control.cancelCurrent = cancel;
        },
      });
      control.cancelCurrent = null;
      if (!result.ok && result.cancelled) {
        this.store.updateSession(task.id, { status: 'supervising' });
        return 'stop';
      }
      if (result.ok) {
        const picked = candidates.find((c) => c.id === result.value.choice)!;
        ordered = [picked, ...candidates.filter((c) => c !== picked)];
        choice = { ...result.value, reasoner: 'model', summary: `${TRIGGER_LABEL[input.trigger]}. ${result.value.summary}` };
        this.store.updateSession(task.id, { degradedReason: null });
      } else {
        this.store.updateSession(task.id, { degradedReason: `Model unavailable for the last decision (${result.reason.slice(0, 200)}); used the rules.` });
      }
    }
    this.store.updateSession(task.id, { status: 'supervising' });
    if (control.stopReason) return 'stop';
    // The task changed while the decision was being made: it is stale; decide again on fresh state (§3.17).
    if (this.task(task.id).version !== decidedOn && attempt < 2) return this.recover(this.task(task.id), input, control, attempt + 1);

    for (const candidate of ordered) {
      const current = this.task(task.id);
      const decision = this.decide(current, input.trigger, candidate === ordered[0] ? choice.summary : `${TRIGGER_LABEL[input.trigger]}. Previous option failed; next: ${candidate.label}.`, candidate.label, {
        reasoningSummary: choice.reasoningSummary,
        expectedResult: choice.expectedResult,
        reasoner: candidate === ordered[0] ? choice.reasoner : 'policy',
        fingerprint: candidate.fingerprint,
      });
      const cycle = current.recoveryCycle + 1;
      const started = this.d.engine.applyInLoop(task.id, { recoveryCycle: cycle, fixCycles: 0 });
      this.d.engine.publisher.event(task.id, 'RECOVERY_CYCLE', `Recovery cycle ${cycle}: ${candidate.label}`, { cycle, decisionId: decision.id });
      const guidance = candidate === ordered[0] && choice.guidance ? choice.guidance : guidanceOf(candidate);
      this.rememberStrategy(task.id, candidate, guidance);
      if (candidate.kind !== 'rollback') {
        await this.checkpoints.create(started, { label: `Recovery cycle ${cycle}`, reason: 'recovery-pivot', stageKey: current.currentStageKey }).catch(() => null);
      }
      const actions = candidate.actions.map((a) => withGuidance(a, guidance));
      const results = await this.gateway.executeDecision(task.id, actions, {
        initiator: 'chairman',
        source: 'supervisor',
        decisionId: decision.id,
        expectedVersion: this.task(task.id).version,
        control,
      });
      this.publishState(task.id);
      if (results.every((r) => r.status === 'completed')) return 'continue';
      if (control.stopReason) return 'stop';
    }
    return this.hardBlock(this.task(task.id), input);
  }

  private async hardBlock(task: TaskRecord, input: { trigger: RecoveryTrigger; failingStageKey: string; sig: FailureSignature }): Promise<'stop'> {
    const tried = this.store.session(task.id).lastRecoveryReason;
    const message = `No safe new strategy remains for "${input.sig.message.slice(0, 200)}" (${TRIGGER_LABEL[input.trigger]}).${tried ? ` Last strategy tried: ${tried}.` : ''} Add a directive with what to do differently, then resume.`;
    this.decide(task, input.trigger, message, 'Hard blocker', { hardBlocker: true });
    await this.d.engine.block(task.id, 'hard_blocker', message, { inLoop: true, stageKey: input.failingStageKey });
    return 'stop';
  }

  private evidence(taskId: string, primary: string): string {
    const failures = this.store.listFailures(taskId).slice(-6).map((f) => `- [${f.source} ${f.stageKey}] ${f.message}${f.failureCount !== null ? ` (${f.failureCount})` : ''}`);
    return [fenceEvidence('latest failure', primary || '(no detail)'), fenceEvidence('failure history', failures.join('\n') || '(none)')].join('\n\n');
  }

  // ===========================================================================
  // Completion
  // ===========================================================================

  async gate(task: TaskRecord): Promise<GateResult> {
    const repo = this.d.store.getRepository(task.repositoryId);
    const baseline = task.git.baselineSnapshotId ? this.d.store.getSnapshot(task.git.baselineSnapshotId) : null;
    let taskFiles: string[] | null = null;
    if (repo && baseline) {
      try {
        taskFiles = (await changesSince(repo.path, baseline)).filter((f) => f.origin !== 'preexisting').map((f) => f.path);
      } catch {
        taskFiles = null;
      }
    }
    return completionGate({
      workflow: task.workflow,
      stages: this.d.store.listStages(task.id),
      testRuns: this.d.store.listTestRuns(task.id),
      activeDirectives: activeDirectives(this.d.store.listDirectives(task.id)),
      taskFiles,
      configuredKinds: new Set((repo?.commands ?? []).filter((c) => c.enabled).map((c) => c.kind)),
    });
  }

  async beforeComplete(taskId: string, control: RunControl): Promise<{ kind: 'complete'; limitations: string[] } | { kind: 'continue' } | { kind: 'stop' }> {
    const task = this.task(taskId);
    const gate = await this.gate(task);
    if (gate.pass) return { kind: 'complete', limitations: [] };
    const tried = new Set(this.store.session(taskId).strategyFingerprints);
    const usage = { recoveryCycle: task.recoveryCycle, ...this.store.usage(taskId) };
    for (const failure of gate.failures) {
      if (!failure.remedy) continue;
      const sig = signatureOf({ source: 'gate', stageKey: 'complete', message: failure.message });
      const candidate: StrategyCandidate = {
        id: `gate:${failure.code}`,
        kind: 'retry_stage',
        level: 2,
        label: `Satisfy completion check: ${failure.code.replace('_', ' ')}`,
        description: failure.message,
        actions: failure.remedy,
        fingerprint: sig.hash,
      };
      if (tried.has(candidate.fingerprint)) continue;
      if (limitReached(task.limits, usage, { startingRecovery: true })) break;
      const decision = this.decide(task, 'completion_gate', `Not complete yet: ${failure.message} Fixing that before finishing.`, candidate.label, { fingerprint: candidate.fingerprint });
      const cycle = task.recoveryCycle + 1;
      this.d.engine.applyInLoop(taskId, { recoveryCycle: cycle, fixCycles: 0 });
      this.d.engine.publisher.event(taskId, 'RECOVERY_CYCLE', `Recovery cycle ${cycle}: ${candidate.label}`, { cycle, decisionId: decision.id });
      this.rememberStrategy(taskId, candidate, guidanceOf(candidate) || failure.message);
      const results = await this.gateway.executeDecision(taskId, candidate.actions, { initiator: 'chairman', source: 'supervisor', decisionId: decision.id, control });
      if (results.every((r) => r.status === 'completed')) return { kind: 'continue' };
      if (control.stopReason) return { kind: 'stop' };
    }
    // Nothing safe left to try: finish honestly, with every unmet check in the report.
    const limitations = gate.failures.map((f) => `Completion check not met: ${f.message}`);
    this.decide(task, 'completion_gate', `Completing with unmet checks: ${gate.failures.map((f) => f.message).join(' ')}`, 'Complete — needs your attention');
    return { kind: 'complete', limitations };
  }

  /**
   * A person resolving a hard blocker is new evidence (§5.3): strategies tried
   * before may be tried again, now with whatever directives they added.
   */
  onResume(task: TaskRecord): void {
    if (task.blocker?.kind !== 'hard_blocker') return;
    this.store.updateSession(task.id, { strategyFingerprints: [] });
    this.note(task.id, 'Resumed by you after a hard blocker. Earlier strategies may be tried again, now with your directives.');
  }

  extendedLimits(task: TaskRecord): TaskLimits {
    return extendLimits(task.limits!, { recoveryCycle: task.recoveryCycle, ...this.store.usage(task.id) });
  }

  onTerminal(taskId: string): void {
    const task = this.d.store.getTask(taskId);
    if (!task) return;
    this.store.updateSession(taskId, { status: 'idle' });
    void this.checkpoints.prune(task);
    this.publishState(taskId);
  }

  // ===========================================================================
  // Restart
  // ===========================================================================

  /**
   * After a restart (§20): interrupted supervised tasks are resumed through
   * the gateway (the engine reconciled their workers already, so nothing can
   * run twice). Called once, after `engine.recover()` and before scheduling.
   */
  async onStartup(): Promise<void> {
    if (!this.d.settings.get().chairman.resumeAfterRestart) return;
    // Interrupted by the crash just reconciled, or by a graceful shutdown before it.
    for (const task of this.d.store.listTasks({ statuses: ['INTERRUPTED'], limit: 1000 })) {
      const id = task.id;
      if (!task.supervised || task.blocker?.kind !== 'interrupted') continue;
      const decision = this.decide(task, 'restart', `The orchestrator restarted during ${this.d.views.stageDef(task, task.currentStageKey)?.name ?? 'the task'}. Resuming where it stopped.`, 'Resume after restart');
      await this.gateway.execute(id, { type: 'RESUME_TASK', params: {} }, { initiator: 'system', source: 'supervisor', decisionId: decision.id });
    }
  }

  /** Recovery used by the watchdog for ghost tasks. */
  async resumeGhost(taskId: string, reason: string): Promise<void> {
    const task = this.task(taskId);
    if (!task.supervised) return;
    const decision = this.decide(task, 'watchdog', `${reason}. Resuming the task.`, 'Resume after watchdog');
    await this.gateway.execute(taskId, { type: 'RESUME_TASK', params: {} }, { initiator: 'system', source: 'supervisor', decisionId: decision.id });
  }
}

/** Trigger labels are lower-case phrases; a decision summary starts a sentence. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function guidanceOf(candidate: StrategyCandidate): string {
  for (const a of candidate.actions) {
    const g = (a.params as { guidance?: string } | undefined)?.guidance;
    if (g) return g;
  }
  return candidate.description;
}

function withGuidance(action: ChairmanActionInput, guidance: string): ChairmanActionInput {
  if (action.type === 'RETURN_TO_STAGE' || action.type === 'REPLAN' || action.type === 'RETRY_STAGE') {
    return { ...action, params: { ...(action.params ?? {}), guidance } } as ChairmanActionInput;
  }
  return action;
}
