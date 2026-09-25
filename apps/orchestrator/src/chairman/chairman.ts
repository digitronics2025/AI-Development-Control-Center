import { inFolder, taskRepositories } from '../engine/task-repositories.js';
import { changesSince, committableTree } from '@acc/git';
import { redact } from '@acc/security';
import {
  STRATEGY_OUTCOME_LABEL,
  type ChairmanAction,
  type ChairmanActionInput,
  type ChairmanDiagnosis,
  type ChairmanOverview,
  type ChairmanState,
  type ChairmanStatus,
  type ChairmanStrategyOutcomeStatus,
  type ChairmanStrategyRun,
  type StageDefinition,
  type StageInstance,
  type TaskContract,
  type TaskLimits,
} from '@acc/shared';
import type { Bus } from '../bus.js';
import type { ContextBuilder } from '../engine/context.js';
import type { TaskEngine } from '../engine/engine.js';
import { waivedKinds, type RunControl, type StageOutcome } from '../engine/runners.js';
import type { SupervisorHooks } from '../engine/supervision.js';
import type { TaskViews } from '../engine/views.js';
import type { AgentRegistry } from '../services/agents.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { RepositoryService } from '../services/repositories.js';
import type { RepositoryCoordinator } from '../services/repository-coordinator.js';
import type { SettingsService } from '../services/settings.js';
import { now, type Store, type TaskRecord } from '../store/store.js';
import { CheckpointService } from './checkpoints.js';
import { ChairmanEvidenceService, describeFailure, digestOf, type ChairmanEvidencePacket, type EvidenceDeps, type EvidenceFailure } from './evidence.js';
import { completionGate, type GateResult } from './gate.js';
import { ActionGateway } from './gateway.js';
import { decideOnFailure, extendLimits, limitReached, policyDiagnosis, rankCandidates, recoveryCandidates, TRIGGER_LABEL, type RecoveryTrigger, type StrategyCandidate } from './policy.js';
import { OutcomeEvaluator } from './outcomes.js';
import { classifyProgress } from './progress.js';
import { Reasoner } from './reasoner.js';
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
  /** The tool layer's store (tool calls and recovery attempts as evidence); null without the tool layer. */
  toolStore: EvidenceDeps['tools'];
  /** Rollbacks rewrite the working tree: they hold the repository's writer lock like a stage (audit F-10). */
  coordinator?: RepositoryCoordinator;
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
  readonly evidence: ChairmanEvidenceService;
  readonly outcomes: OutcomeEvaluator;

  constructor(private readonly d: ChairmanDeps) {
    this.store = new ChairmanStore(d.store.db);
    this.outcomes = new OutcomeEvaluator(d.store, this.store, (id, status, summary, health) => this.finishStrategy(id, status, summary, health));
    this.evidence = new ChairmanEvidenceService({ store: d.store, chairman: this.store, artifacts: d.artifacts, agents: d.agents, tools: d.toolStore });
    this.snapshots = new SnapshotService(d.store, this.store, d.views, d.agents);
    this.checkpoints = new CheckpointService(d.store, this.store, d.repositories, d.engine.publisher, d.bus, d.coordinator);
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
      scope: { repository: taskRepositories(this.d.store, task).map((u) => u.repo.name).join(', ') || (repo?.name ?? task.repositoryId), workflow: task.workflow.name },
      autonomyMode: task.mode === 'autopilot' ? 'FULL_AUTOPILOT' : 'DISCUSS_FIRST',
      constraints: [],
      reason: 'Task created',
      createdAt: now(),
    };
  }

  /** A new contract version: the goal changed or a hard constraint was added (§3.4). */
  reviseContract(taskId: string, change: { goal?: string; constraint?: string; reason: string }): TaskContract {
    const current = this.contract(this.task(taskId));
    const next = this.store.insertContract({
      ...current,
      version: current.version + 1,
      goal: change.goal ? redact(change.goal) : current.goal,
      constraints: change.constraint ? [...current.constraints, redact(change.constraint)] : current.constraints,
      reason: change.reason,
      createdAt: now(),
    });
    // A strategy chosen for the old contract is judged by it no longer (§3.8).
    this.outcomes.close(taskId, 'SUPERSEDED', `The ${change.goal ? 'goal' : 'constraints'} changed (contract v${next.version}) before this strategy produced a result.`, (run) => run.contractVersion < next.version);
    return next;
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
    this.outcomes.reconcile(taskId);
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
    // The failure is recorded first, then the previous strategy is judged on it, then the next decision is made.
    this.outcomes.reconcile(task.id);
    this.publishState(task.id);
    return { health, repeats: history.filter((f) => f.hash === sig.hash).length };
  }

  async onFailure(taskId: string, def: StageDefinition, stage: StageInstance, outcome: Extract<StageOutcome, { kind: 'verdict_fail' | 'tests_failed' }>, control: RunControl): Promise<'local_fix' | 'continue' | 'stop'> {
    const task = this.task(taskId);
    let sig: FailureSignature;
    let detail: string;
    if (outcome.kind === 'tests_failed') {
      const evidence = this.evidence.testFailure(taskId, stage.id);
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
    return this.recover(this.task(taskId), { trigger: decision.trigger, failingStageKey: def.key, stageId: stage.id, sig }, control);
  }

  async onError(taskId: string, def: StageDefinition, stage: StageInstance, outcome: Extract<StageOutcome, { kind: 'error' }>, control: RunControl, mode: 'exhausted' | 'blocked'): Promise<'continue' | 'stop' | 'legacy'> {
    const task = this.task(taskId);
    const sig = signatureOf({ source: 'worker', stageKey: def.key, message: outcome.message, errorClass: outcome.errorClass });
    this.recordFailure(task, stage, sig);
    if (mode === 'blocked') {
      // Provider blocks: hand the stage to another subscription agent if one is healthy; otherwise wait as before.
      if (!BLOCKING_PROVIDER.has(outcome.errorClass) || def.kind !== 'agent') return 'legacy';
      const candidates = recoveryCandidates({
        ...this.candidateContext(task, 'provider_blocked', def.key, sig),
        // A model the CLI rejects is one stage's problem; credits, usage windows and sign-in are the whole agent's.
        providerWide: outcome.errorClass !== 'MODEL_UNAVAILABLE',
      });
      const choice = candidates[0];
      if (!choice) return 'legacy';
      const input: RecoveryInput = { trigger: 'provider_blocked', failingStageKey: def.key, stageId: stage.id, sig };
      const packet = await this.evidencePacket(task, input);
      // Name the blocked agent: without it, later answers could not say which provider ran out.
      const blocked = stage.agentId ? (this.d.agents.list().find((a) => a.id === stage.agentId)?.name ?? stage.agentId) : 'its agent';
      const decision = this.decide(task, 'provider_blocked', `${def.name} is blocked on ${blocked} (${outcome.message.slice(0, 160)}). ${choice.label}.`, choice.label, {
        fingerprint: choice.fingerprint,
        strategy: this.strategyStart(choice, input, this.diagnose(input), packet.digest, task.recoveryCycle),
      });
      // A provider reroute runs alongside the current strategy: it must not replace that strategy's guidance.
      this.rememberStrategy(taskId, choice, null);
      const results = await this.gateway.executeDecision(taskId, choice.actions, { initiator: 'chairman', source: 'supervisor', decisionId: decision.id, control });
      if (results.every((r) => r.status === 'completed')) return 'continue';
      this.strategyNotStarted(decision.id, results);
      return 'legacy';
    }
    // A check command that failed, and a review that left files unread, are not an agent failing to run (§3.D).
    const trigger: RecoveryTrigger =
      outcome.errorClass === 'REVIEW_INCOMPLETE' ? 'review_incomplete' : outcome.errorClass === 'COMMAND_FAILURE' && def.kind !== 'agent' ? 'check_failed' : 'worker_failure';
    return this.recover(task, { trigger, failingStageKey: def.key, stageId: stage.id, sig }, control);
  }

  /**
   * Running a failed command stage again would change nothing (AUTOPILOT_GATES_PLAN §3.E):
   * every failed command would run with the same command line, on the same
   * repository settings, on exactly the files it failed on.
   */
  private async commandRetryIsNoop(task: TaskRecord, stageKey: string): Promise<boolean> {
    const def = this.d.views.stageDef(task, stageKey);
    if (!def || (def.kind !== 'command' && def.kind !== 'tests')) return false;
    const last = this.d.store.listStages(task.id).filter((s) => s.stageKey === stageKey).at(-1);
    if (last?.status !== 'FAILED') return false;
    const failed = this.d.store.listTestRuns(task.id, last.id).filter((r) => r.status === 'failed');
    if (!failed.length || failed.some((r) => !r.treeId)) return false;
    const units = taskRepositories(this.d.store, task);
    for (const run of failed) {
      const unit = units.length > 1 ? units.find((u) => u.repo.id === run.repositoryId) : units[0];
      if (!unit || unit.repo.updatedAt > last.createdAt) return false;
      if (!unit.repo.commands.some((c) => c.enabled && redact(c.command) === run.command)) return false;
      if ((await committableTree(unit.workdir).catch(() => null)) !== run.treeId) return false;
    }
    return true;
  }

  private candidateContext(task: TaskRecord, trigger: RecoveryTrigger, failingStageKey: string, sig: FailureSignature, retryIsNoop = false) {
    const assignments: Record<string, string> = {};
    for (const s of task.workflow.stages) if (s.kind === 'agent') assignments[s.key] = this.d.views.assignmentFor(task, s).agentId;
    // An agent whose last run reported it out of credits or out of its window is no escape route.
    const available = this.d.agents
      .list()
      .filter((a) => a.settings.enabled && ['connected', 'unknown'].includes(a.health.state) && !a.capacityBlock)
      .map((a) => a.id);
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
      retryIsNoop,
    };
  }

  private decide(
    task: TaskRecord,
    trigger: string,
    summary: string,
    decision: string,
    extra: { reasoningSummary?: string; expectedResult?: string; hardBlocker?: boolean; reasoner?: 'model' | 'policy'; fingerprint?: string | null; strategy?: StrategyStart } = {},
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
    let strategy: ChairmanStrategyRun | null = null;
    if (extra.strategy && rec.strategyFingerprint) {
      // A reroute around a blocked provider runs alongside the current strategy; a new recovery strategy replaces it.
      if (trigger !== 'provider_blocked') this.outcomes.close(task.id, 'INCONCLUSIVE', 'A new recovery strategy started before this one produced a comparable result.');
      strategy = this.store.insertStrategyRun({
        ...extra.strategy,
        decisionId: rec.id,
        taskId: task.id,
        contractVersion: this.contract(task).version,
        trigger,
        strategyFingerprint: rec.strategyFingerprint,
        expectedResult: rec.expectedResult,
        status: 'RUNNING',
        outcomeSummary: null,
        healthBefore: session.health,
        healthAfter: null,
        startedAt: rec.createdAt,
        evaluatedAt: null,
      });
    }
    this.d.bus.publish({ type: 'chairman.decision', decision: { ...rec, strategy } });
    this.d.engine.publisher.event(task.id, 'CHAIRMAN_DECISION', `Chairman: ${rec.summary}`, { decisionId: rec.id, trigger });
    this.note(task.id, rec.summary, { kind: 'decision', decisionId: rec.id });
    return rec;
  }

  /** `guidance: null` keeps the current strategy's guidance (a provider reroute is not a new strategy for the work). */
  private rememberStrategy(taskId: string, candidate: StrategyCandidate, guidance: string | null): void {
    const session = this.store.session(taskId);
    this.store.updateSession(taskId, {
      strategyFingerprints: [...session.strategyFingerprints, candidate.fingerprint].slice(-200),
      ...(guidance === null ? {} : { strategySummary: redact(guidance).slice(0, 2000), lastRecoveryReason: candidate.label }),
    });
  }

  /**
   * A recovery cycle (§3.9): pick a materially different strategy, record the
   * decision, start the cycle (fresh local fix budget) and execute it through
   * the gateway. Never repeats a strategy already tried against this failure.
   */
  private async recover(
    task: TaskRecord,
    input: RecoveryInput,
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
    const rules = this.diagnose(input);
    const noop = input.trigger === 'check_failed' && (await this.commandRetryIsNoop(task, input.failingStageKey));
    if (noop) input = { ...input, noopRetry: true };
    // Safe candidates first, then ordered by what earlier strategies achieved under this contract.
    const candidates = rankCandidates(recoveryCandidates(this.candidateContext(task, input.trigger, input.failingStageKey, input.sig, noop)), {
      trigger: input.trigger,
      failedFamilies: this.store.failedStrategyFamilies(task.id, this.contract(task).version, input.sig.category),
      confidence: rules.confidence,
    });
    if (!candidates.length) return this.hardBlock(task, input);

    this.store.updateSession(task.id, { status: 'evaluating' });
    this.publishState(task.id);
    const decidedOn = this.task(task.id).version;
    // Gathered even without a model: its digest is the decision's audit trail.
    const packet = await this.evidencePacket(task, input);
    let diagnosis: ChairmanDiagnosis = rules;
    let ordered = candidates;
    let choice: { summary: string; reasoningSummary: string; guidance: string; expectedResult: string; reasoner: 'model' | 'policy' } = {
      summary: `${TRIGGER_LABEL[input.trigger]}. Next: ${candidates[0]!.label}.`,
      reasoningSummary: '',
      guidance: '',
      expectedResult: '',
      reasoner: 'policy',
    };
    if (!this.reasoner.unavailableReason()) {
      const cancellable = {
        onCancel: (cancel: () => Promise<void>) => {
          control.cancelCurrent = cancel;
        },
      };
      const result = await this.reasoner.chooseRecovery(this.snapshots.build(task.id), TRIGGER_LABEL[input.trigger], candidates, this.evidence.render(packet), cancellable, { category: rules.category, summary: rules.summary });
      control.cancelCurrent = null;
      if (!result.ok && result.cancelled) {
        this.store.updateSession(task.id, { status: 'supervising' });
        return 'stop';
      }
      if (result.ok) {
        const picked = candidates.find((c) => c.id === result.value.choice)!;
        ordered = [picked, ...candidates.filter((c) => c !== picked)];
        choice = { ...result.value, reasoner: 'model', summary: `${TRIGGER_LABEL[input.trigger]}. ${result.value.summary}` };
        // The model words the hypothesis; the category stays the failure signature's.
        if (result.value.diagnosis) diagnosis = { category: rules.category, confidence: result.value.diagnosis.confidence, summary: result.value.diagnosis.summary.slice(0, 400), source: 'model' };
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
      // The cycle a strategy would open; it is counted only once the strategy has really started (§3.D).
      const cycle = current.recoveryCycle + 1;
      const decision = this.decide(current, input.trigger, candidate === ordered[0] ? choice.summary : `${TRIGGER_LABEL[input.trigger]}. Previous option failed; next: ${candidate.label}.`, candidate.label, {
        reasoningSummary: choice.reasoningSummary,
        expectedResult: choice.expectedResult,
        reasoner: candidate === ordered[0] ? choice.reasoner : 'policy',
        fingerprint: candidate.fingerprint,
        strategy: this.strategyStart(candidate, input, diagnosis, packet.digest, cycle),
      });
      const guidance = candidate === ordered[0] && choice.guidance ? choice.guidance : guidanceOf(candidate);
      this.rememberStrategy(task.id, candidate, guidance);
      if (candidate.kind !== 'rollback') {
        await this.checkpoints.create(current, { label: `Recovery cycle ${cycle}`, reason: 'recovery-pivot', stageKey: current.currentStageKey }).catch(() => null);
      }
      const actions = candidate.actions.map((a) => withGuidance(a, guidance));
      const results = await this.gateway.executeDecision(task.id, actions, {
        initiator: 'chairman',
        source: 'supervisor',
        decisionId: decision.id,
        expectedVersion: this.task(task.id).version,
        control,
      });
      if (results.every((r) => r.status === 'completed')) {
        this.startCycle(task.id, cycle, candidate.label, decision.id);
        return 'continue';
      }
      this.publishState(task.id);
      this.strategyNotStarted(decision.id, results);
      if (control.stopReason) return 'stop';
    }
    return this.hardBlock(this.task(task.id), input);
  }

  /** Count a recovery cycle whose strategy started: a fresh local fix budget, and the timeline says so. */
  private startCycle(taskId: string, cycle: number, label: string, decisionId: string): void {
    this.d.engine.applyInLoop(taskId, { recoveryCycle: cycle, fixCycles: 0 });
    this.d.engine.publisher.event(taskId, 'RECOVERY_CYCLE', `Recovery cycle ${cycle}: ${label}`, { cycle, decisionId });
    this.publishState(taskId);
  }

  private diagnose(input: RecoveryInput): ChairmanDiagnosis {
    return policyDiagnosis({ category: input.sig.category, source: input.sig.source, trigger: input.trigger, message: input.sig.message, failureCount: input.sig.failureCount });
  }

  private strategyStart(candidate: StrategyCandidate, input: RecoveryInput, diagnosis: ChairmanDiagnosis, evidenceDigest: string, recoveryCycle: number): StrategyStart {
    return {
      recoveryCycle,
      strategyKind: candidate.kind,
      targetStageKey: candidate.targetStageKey,
      targetAgentId: candidate.targetAgentId,
      failureSource: input.sig.source,
      failureStageKey: input.failingStageKey,
      failureCategory: input.sig.category,
      failureHash: input.sig.hash,
      failureCount: input.sig.failureCount,
      diagnosis: { ...diagnosis, summary: redact(diagnosis.summary).slice(0, 400) },
      evidenceDigest,
    };
  }

  /**
   * The gateway refused the strategy's actions: that says nothing about the
   * engineering, so it is never FAILED. A stale task version means the
   * situation moved on (superseded); anything else is inconclusive.
   */
  private strategyNotStarted(decisionId: string, results: ChairmanAction[]): void {
    const refused = results.find((r) => r.status !== 'completed');
    const stale = results.some((r) => r.reason?.startsWith('STALE'));
    this.finishStrategy(
      decisionId,
      stale ? 'SUPERSEDED' : 'INCONCLUSIVE',
      stale ? 'The task changed before this strategy could start; the Chairman re-evaluated.' : `The strategy could not be started: ${(refused?.reason ?? 'refused').slice(0, 300)}`,
      null,
    );
  }

  /** Record a strategy's outcome once, and show it on the same decision card everywhere. */
  finishStrategy(decisionId: string, status: Exclude<ChairmanStrategyOutcomeStatus, 'RUNNING'>, summary: string, healthAfter: ChairmanStrategyRun['healthAfter']): ChairmanStrategyRun | null {
    const run = this.store.finishStrategyRun(decisionId, { status, summary: redact(summary), healthAfter });
    if (!run) return null;
    // The observed result is the task's health now (a strategy can resolve a failure without a new one to classify).
    if (healthAfter) {
      this.store.updateSession(run.taskId, { health: healthAfter });
      this.publishState(run.taskId);
    }
    const decision = this.store.decision(decisionId);
    if (decision) {
      this.d.bus.publish({ type: 'chairman.decision', decision });
      this.d.engine.publisher.event(run.taskId, 'CHAIRMAN_DECISION', `Chairman: ${decision.decision} — ${STRATEGY_OUTCOME_LABEL[status]}. ${run.outcomeSummary ?? ''}`.trim(), { decisionId, outcome: status });
    }
    return run;
  }

  private async hardBlock(task: TaskRecord, input: RecoveryInput): Promise<'stop'> {
    const tried = this.store.session(task.id).lastRecoveryReason;
    // What the Chairman understood about the failure is what the operator needs to decide what to do differently.
    const diagnosis = this.store
      .listDecisions(task.id, 20)
      .reverse()
      .find((d) => d.strategy?.diagnosis.summary)?.strategy!.diagnosis.summary;
    const same = input.noopRetry ? ' Running it again would change nothing: the files, the command and the repository settings are the same as when it failed.' : '';
    const message = `No safe new strategy remains for "${input.sig.message.slice(0, 200)}" (${TRIGGER_LABEL[input.trigger]}).${same}${tried ? ` Last strategy tried: ${tried}.` : ''}${diagnosis ? ` Diagnosis: ${diagnosis.slice(0, 400)}` : ''} Add a directive with what to do differently, then resume.`;
    this.decide(task, input.trigger, message, 'Hard blocker', { hardBlocker: true });
    await this.d.engine.block(task.id, 'hard_blocker', message, { inLoop: true, stageKey: input.failingStageKey });
    return 'stop';
  }

  /**
   * Evidence for a recovery decision. Enrichment never stops supervision: if
   * the evidence service itself fails, the decision falls back to the
   * failure it already knows, and that is noted on the task.
   */
  private async evidencePacket(task: TaskRecord, input: RecoveryInput): Promise<ChairmanEvidencePacket> {
    const failure: EvidenceFailure = { source: input.sig.source, stageKey: input.failingStageKey, stageId: input.stageId, category: input.sig.category, hash: input.sig.hash, message: input.sig.message, failureCount: input.sig.failureCount };
    try {
      return await this.evidence.forRecovery(task, failure);
    } catch (error) {
      this.d.engine.publisher.event(task.id, 'WATCHDOG', `Chairman evidence could not be gathered (${redact((error as Error).message).slice(0, 160)}); deciding from the failure alone.`);
      const section = { kind: 'failure' as const, reliability: 'OBSERVED' as const, label: 'current failure', sourceId: input.stageId, text: redact(describeFailure(failure)).slice(0, 1_500), truncated: false };
      return { purpose: 'recovery', taskId: task.id, generatedAt: now(), digest: digestOf([section]), sections: [section], availableKinds: ['failure'], unavailableKinds: [], unavailable: [] };
    }
  }

  // ===========================================================================
  // Completion
  // ===========================================================================

  async gate(task: TaskRecord): Promise<GateResult> {
    const units = taskRepositories(this.d.store, task);
    let taskFiles: string[] | null = null;
    for (const unit of units) {
      const baseline = unit.git.baselineSnapshotId ? this.d.store.getSnapshot(unit.git.baselineSnapshotId) : null;
      if (!baseline) continue;
      try {
        const files = (await changesSince(unit.workdir, baseline)).filter((f) => f.origin !== 'preexisting').map((f) => inFolder(units.length > 1 ? unit.folder : null, f.path));
        taskFiles = [...(taskFiles ?? []), ...files];
      } catch {
        // A repository that cannot be read makes the whole list unknown, never a partial one.
        taskFiles = null;
        break;
      }
    }
    return completionGate({
      workflow: task.workflow,
      stages: this.d.store.listStages(task.id),
      testRuns: this.d.store.listTestRuns(task.id),
      activeDirectives: activeDirectives(this.d.store.listDirectives(task.id)),
      taskFiles,
      // Across repositories a check kind is available when any of them configures it.
      configuredKinds: new Set(units.flatMap((u) => u.repo.commands).filter((c) => c.enabled).map((c) => c.kind)),
      waivedKinds: waivedKinds(this.d.store, task.id),
    });
  }

  async beforeComplete(taskId: string, control: RunControl): Promise<{ kind: 'complete'; limitations: string[] } | { kind: 'continue' } | { kind: 'stop' }> {
    const task = this.task(taskId);
    const gate = await this.gate(task);
    this.outcomes.reconcile(taskId);
    this.outcomes.completionGate(taskId, { pass: gate.pass, failureHashes: gate.failures.map((f) => signatureOf({ source: 'gate', stageKey: 'complete', message: f.message }).hash) });
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
        targetStageKey: null,
        targetAgentId: null,
      };
      if (tried.has(candidate.fingerprint)) continue;
      if (limitReached(task.limits, usage, { startingRecovery: true })) break;
      const cycle = task.recoveryCycle + 1;
      const input: RecoveryInput = { trigger: 'completion_gate', failingStageKey: 'complete', stageId: null, sig };
      const digest = digestOf([{ kind: 'failure', sourceId: null, text: redact(describeFailure({ ...sig, stageKey: 'complete', hash: sig.hash })) }]);
      const decision = this.decide(task, 'completion_gate', `Not complete yet: ${failure.message} Fixing that before finishing.`, candidate.label, {
        fingerprint: candidate.fingerprint,
        strategy: this.strategyStart(candidate, input, this.diagnose(input), digest, cycle),
      });
      this.rememberStrategy(taskId, candidate, guidanceOf(candidate) || failure.message);
      const results = await this.gateway.executeDecision(taskId, candidate.actions, { initiator: 'chairman', source: 'supervisor', decisionId: decision.id, control });
      if (results.every((r) => r.status === 'completed')) {
        this.startCycle(taskId, cycle, candidate.label, decision.id);
        return { kind: 'continue' };
      }
      this.strategyNotStarted(decision.id, results);
      if (control.stopReason) return { kind: 'stop' };
    }
    // Nothing safe left to try: finish honestly, with every unmet check in the report.
    const limitations = gate.failures.map((f) => `Completion check not met: ${f.message}`);
    this.decide(task, 'completion_gate', `Completing with unmet checks: ${gate.failures.map((f) => f.message).join(' ')}`, 'Complete — needs your attention');
    return { kind: 'complete', limitations };
  }

  /**
   * A person resolving a hard blocker with a new directive (or a changed
   * repository setting) is new evidence (§5.3): strategies tried before may be
   * tried again under it. A bare resume is not: the tried strategies are kept,
   * so the same ones are never repeated against the same facts (§3.D).
   */
  onResume(task: TaskRecord): void {
    if (task.blocker?.kind !== 'hard_blocker') return;
    const blockedAt = this.store.listDecisions(task.id, 50).reverse().find((d) => d.hardBlocker)?.createdAt ?? '';
    const newDirective = this.d.store.listDirectives(task.id).some((d) => d.state === 'active' && d.createdAt > blockedAt);
    const repositoryChanged = taskRepositories(this.d.store, task).some((u) => u.repo.updatedAt > blockedAt);
    if (newDirective || repositoryChanged) {
      this.store.updateSession(task.id, { strategyFingerprints: [] });
      this.note(task.id, `Resumed by you after a hard blocker, with ${newDirective ? 'a new directive' : 'a changed repository setting'}. Earlier strategies may be tried again under it.`);
      return;
    }
    this.note(task.id, 'Resumed by you after a hard blocker with no new directive: the strategies already tried are not repeated. Add a directive saying what to do differently if this stops again.');
  }

  extendedLimits(task: TaskRecord): TaskLimits {
    return extendLimits(task.limits!, { recoveryCycle: task.recoveryCycle, ...this.store.usage(task.id) });
  }

  onTerminal(taskId: string): void {
    const task = this.d.store.getTask(taskId);
    if (!task) return;
    this.closeTerminalStrategies(task);
    this.store.updateSession(taskId, { status: 'idle' });
    void this.checkpoints.prune(task);
    this.publishState(taskId);
  }

  /** A finished task leaves no strategy open: judged on what was recorded, else closed without blame. */
  private closeTerminalStrategies(task: TaskRecord): void {
    this.outcomes.reconcile(task.id);
    if (task.status === 'CANCELLED') this.outcomes.close(task.id, 'SUPERSEDED', 'The task was cancelled before this strategy produced a result.');
    else if (task.status === 'COMPLETED') this.outcomes.close(task.id, 'INCONCLUSIVE', 'The task finished before a comparable result was recorded.');
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
    // Strategies left open by the restart are judged from what was already recorded — nothing is re-run to find out.
    for (const taskId of this.store.tasksWithOpenStrategies()) {
      const task = this.d.store.getTask(taskId);
      if (!task) continue;
      if (task.status === 'COMPLETED' || task.status === 'CANCELLED') this.closeTerminalStrategies(task);
      else this.outcomes.reconcile(taskId);
    }
    if (!this.d.settings.get().chairman.resumeAfterRestart) return;
    // Interrupted by the crash just reconciled, or by a graceful shutdown before it.
    for (const task of this.d.store.listTasks({ statuses: ['INTERRUPTED'], limit: 1000 })) {
      const id = task.id;
      if (!task.supervised || task.blocker?.kind !== 'interrupted') continue;
      const stageName = this.d.views.stageDef(task, task.currentStageKey)?.name ?? 'the task';
      // A drained task stopped between stages; anything else was cut off in one.
      const where = task.blocker.message.startsWith('Stopped between stages') ? `before ${stageName}` : `during ${stageName}`;
      const decision = this.decide(task, 'restart', `The orchestrator restarted ${where}. Resuming where it stopped.`, 'Resume after restart');
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

/** What a strategy run knows when it starts; the rest is filled in by `decide`. */
type StrategyStart = Pick<
  ChairmanStrategyRun,
  'recoveryCycle' | 'strategyKind' | 'targetStageKey' | 'targetAgentId' | 'failureSource' | 'failureStageKey' | 'failureCategory' | 'failureHash' | 'failureCount' | 'diagnosis' | 'evidenceDigest'
>;

interface RecoveryInput {
  trigger: RecoveryTrigger;
  failingStageKey: string;
  /** The stage instance whose failure is being recovered from. */
  stageId: string | null;
  sig: FailureSignature;
  /** A retry of the failing command stage was ruled out as a no-op (§3.E). */
  noopRetry?: boolean;
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
