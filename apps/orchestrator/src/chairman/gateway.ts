import { redact } from '@acc/security';
import {
  CHAIRMAN_ACTION_LABEL,
  COMPLETE,
  TERMINAL_TASK_STATUSES,
  chairmanActionSchema,
  type ChairmanAction,
  type ChairmanActionInput,
  type ChairmanActionRequest,
  type ChairmanActionType,
  type CommandKind,
  type TaskStatus,
} from '@acc/shared';
import type { Bus } from '../bus.js';
import { EngineError, type TaskEngine } from '../engine/engine.js';
import type { Publisher } from '../engine/publisher.js';
import type { RunControl } from '../engine/runners.js';
import type { TaskViews } from '../engine/views.js';
import type { Store, TaskRecord } from '../store/store.js';
import type { CheckpointService } from './checkpoints.js';
import type { GateResult } from './gate.js';
import type { ChairmanStore } from './store.js';

export type Initiator = ChairmanAction['initiator'];

export interface ActionContext {
  initiator: Initiator;
  source: ChairmanAction['source'];
  decisionId?: string | null;
  messageId?: string | null;
  /** Reject the whole decision if the task changed materially since it was made (§3.17). */
  expectedVersion?: number;
  idempotencyKey?: string | null;
  /** Present when the task's own loop executes the decision at a stage boundary. */
  control?: RunControl;
}

/**
 * Who may ask for what. Directives come only from the user — never from the
 * supervisor, whose reasoning reads untrusted evidence — and nothing can mark
 * a hard blocker on the user's behalf.
 */
const ALLOWED: Record<Initiator, ReadonlySet<ChairmanActionType>> = {
  user: new Set<ChairmanActionType>([
    'CONTINUE',
    'PAUSE_TASK',
    'RESUME_TASK',
    'CANCEL_ACTIVE_STAGE',
    'RETRY_STAGE',
    'RETURN_TO_STAGE',
    'REPLAN',
    'ADD_DIRECTIVE',
    'REMOVE_DIRECTIVE',
    'CHANGE_AGENT',
    'CHANGE_MODEL',
    'CHANGE_EFFORT',
    'RUN_TARGETED_TESTS',
    'RUN_FULL_TESTS',
    'RUN_E2E',
    'CREATE_CHECKPOINT',
    'ROLLBACK_CHECKPOINT',
    'COMPLETE_TASK',
  ]),
  chairman: new Set<ChairmanActionType>([
    'CONTINUE',
    'RETRY_STAGE',
    'RETURN_TO_STAGE',
    'REPLAN',
    'CHANGE_AGENT',
    'CHANGE_MODEL',
    'CHANGE_EFFORT',
    'RUN_TARGETED_TESTS',
    'RUN_FULL_TESTS',
    'RUN_E2E',
    'CREATE_CHECKPOINT',
    'ROLLBACK_CHECKPOINT',
    'MARK_HARD_BLOCKER',
    'COMPLETE_TASK',
  ]),
  system: new Set<ChairmanActionType>(['CONTINUE', 'RESUME_TASK', 'PAUSE_TASK', 'RETRY_STAGE', 'MARK_HARD_BLOCKER']),
};

const RESUMABLE: readonly TaskStatus[] = ['PAUSED', 'INTERRUPTED', 'WAITING_FOR_USAGE_RESET', 'WAITING_FOR_USER', 'FAILED'];

export interface GatewayDeps {
  store: Store;
  chairman: ChairmanStore;
  engine: TaskEngine;
  checkpoints: CheckpointService;
  publisher: Publisher;
  views: TaskViews;
  bus: Bus;
  /** Record the strategy guidance later stages receive. */
  setGuidance: (taskId: string, guidance: string) => void;
  gate: (task: TaskRecord) => Promise<GateResult>;
}

class Rejected extends Error {}

/**
 * The single door for Chairman actions (plan §3.11): automatic decisions,
 * chat commands and API calls all pass schema validation, permission,
 * task-state and version checks, a per-task lock, idempotency and the audit
 * log here, then run as ordinary engine commands.
 */
export class ActionGateway {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly d: GatewayDeps) {}

  /** Serialise work per task. The loop itself never waits here (it already owns the task). */
  private async locked<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(taskId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.locks.set(taskId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(taskId) === run) this.locks.delete(taskId);
    }
  }

  async execute(taskId: string, input: ChairmanActionInput, ctx: ActionContext): Promise<ChairmanAction> {
    return (await this.executeDecision(taskId, [input], ctx))[0]!;
  }

  /**
   * Execute a decision's actions in order. The version check happens once,
   * against the state the decision was made on; the first failure stops the
   * rest (they depended on it).
   */
  async executeDecision(taskId: string, inputs: ChairmanActionInput[], ctx: ActionContext): Promise<ChairmanAction[]> {
    if (!this.d.store.getTask(taskId)) throw new EngineError(`Task ${taskId} not found`, 'NOT_FOUND');
    const run = async () => {
      const out: ChairmanAction[] = [];
      let blocked: string | null = null;
      for (let i = 0; i < inputs.length; i++) {
        const key = ctx.idempotencyKey ? (inputs.length > 1 ? `${ctx.idempotencyKey}:${i}` : ctx.idempotencyKey) : null;
        const action = await this.one(taskId, inputs[i]!, ctx, key, i === 0, blocked);
        out.push(action);
        if (action.status !== 'completed' && !blocked) blocked = `Not run: the earlier ${CHAIRMAN_ACTION_LABEL[action.type] ?? action.type} did not complete`;
      }
      return out;
    };
    return ctx.control ? run() : this.locked(taskId, run);
  }

  private async one(taskId: string, input: ChairmanActionInput, ctx: ActionContext, key: string | null, first: boolean, blocked: string | null): Promise<ChairmanAction> {
    if (key) {
      const existing = this.d.chairman.actionByKey(taskId, key);
      if (existing) return existing;
    }
    const task = this.d.store.getTask(taskId)!;
    const parsed = chairmanActionSchema.safeParse(input);
    const type = (parsed.success ? parsed.data.type : String((input as { type?: unknown })?.type ?? 'UNKNOWN').slice(0, 40)) as ChairmanActionType;
    const record = (status: ChairmanAction['status'], reason: string | null) =>
      this.publish(
        this.d.chairman.insertAction({
          taskId,
          decisionId: ctx.decisionId ?? null,
          messageId: ctx.messageId ?? null,
          type,
          params: parsed.success ? (parsed.data.params as Record<string, unknown>) : {},
          initiator: ctx.initiator,
          source: ctx.source,
          taskVersion: task.version,
          status,
          reason: reason ? redact(reason) : null,
          idempotencyKey: key,
        }),
      );

    if (!parsed.success) return this.finishRejected(record, `Invalid action: ${parsed.error.issues[0]?.message ?? 'does not match any action'}`);
    if (blocked) return this.finishRejected(record, blocked);
    if (!ALLOWED[ctx.initiator].has(parsed.data.type)) return this.finishRejected(record, `${ctx.initiator === 'chairman' ? 'The supervisor' : 'This source'} may not ${CHAIRMAN_ACTION_LABEL[parsed.data.type].toLowerCase()}`);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) return this.finishRejected(record, `Task is ${task.status.toLowerCase()}`);
    if (first && ctx.expectedVersion !== undefined && ctx.expectedVersion !== task.version) {
      return this.finishRejected(record, `STALE: the task changed since this decision was made (version ${ctx.expectedVersion} → ${task.version}); re-evaluating instead`);
    }
    if (ctx.control?.stopReason) return this.finishRejected(record, `Superseded: a ${ctx.control.stopReason} was requested while deciding`);

    const running = record('running', null);
    try {
      const result = redact(await this.apply(task, parsed.data, ctx));
      const done = this.publish(this.d.chairman.finishAction(running.id, 'completed', result));
      this.d.publisher.event(taskId, 'CHAIRMAN_ACTION', `${CHAIRMAN_ACTION_LABEL[done.type]}: ${result}`, { actionId: done.id, initiator: ctx.initiator, source: ctx.source });
      return done;
    } catch (error) {
      const message = error instanceof Rejected || error instanceof EngineError ? error.message : `Failed: ${(error as Error).message}`;
      return this.publish(this.d.chairman.finishAction(running.id, 'failed', null, message));
    }
  }

  private finishRejected(record: (status: ChairmanAction['status'], reason: string | null) => ChairmanAction, reason: string): ChairmanAction {
    return record('rejected', reason);
  }

  private publish(action: ChairmanAction): ChairmanAction {
    this.d.bus.publish({ type: 'chairman.action', action });
    return action;
  }

  private stageKeyOf(task: TaskRecord, match: (s: TaskRecord['workflow']['stages'][number]) => boolean, what: string): string {
    const def = task.workflow.stages.find(match);
    if (!def) throw new Rejected(`This workflow has no ${what} stage`);
    return def.key;
  }

  private async goTo(task: TaskRecord, stageKey: string, reason: string, ctx: ActionContext, guidance?: string): Promise<string> {
    if (guidance) this.d.setGuidance(task.id, guidance);
    const name = stageKey === COMPLETE ? 'completion' : (this.d.views.stageDef(task, stageKey)?.name ?? stageKey);
    if (ctx.control) {
      this.d.engine.redirectInLoop(task.id, stageKey, { reason });
      return `Continuing at ${name}`;
    }
    await this.d.engine.redirect(task.id, stageKey, { reason });
    return this.d.engine.isRunning(task.id) || this.d.store.getTask(task.id)?.status === 'QUEUED' ? `Returning to ${name}` : `Set to ${name}`;
  }

  private writeStageRunning(task: TaskRecord): boolean {
    if (!this.d.engine.isRunning(task.id)) return false;
    const def = this.d.views.stageDef(task, task.currentStageKey);
    return Boolean(def && def.permissionLevel >= 2);
  }

  private configuredKinds(task: TaskRecord): Set<CommandKind> {
    return new Set((this.d.store.getRepository(task.repositoryId)?.commands ?? []).filter((c) => c.enabled).map((c) => c.kind));
  }

  private async apply(task: TaskRecord, action: ChairmanActionRequest, ctx: ActionContext): Promise<string> {
    const { engine } = this.d;
    const who = ctx.initiator === 'user' ? 'requested by you' : ctx.initiator === 'chairman' ? 'Chairman decision' : 'automatic';
    switch (action.type) {
      case 'CONTINUE': {
        engine.clearPauseAfterStage(task.id);
        const current = this.d.store.getTask(task.id)!;
        if (RESUMABLE.includes(current.status) && current.blocker?.kind !== 'approval') {
          await engine.resume(task.id);
          return 'Resumed';
        }
        if (current.blocker?.kind === 'approval') return 'Waiting for your approval in Approvals; it continues once you decide';
        return current.status === 'RUNNING' || current.status === 'QUEUED' ? 'Already running; nothing to change' : `Nothing to continue (${current.status.toLowerCase()})`;
      }
      case 'PAUSE_TASK':
        if (action.params.when === 'after_stage') {
          engine.pauseAfterStage(task.id);
          return 'Will pause after the current stage';
        }
        await engine.pause(task.id);
        return 'Paused; the stopped stage runs again on resume';
      case 'RESUME_TASK':
        if (task.status === 'RUNNING' || task.status === 'QUEUED') return 'Already running';
        await engine.resume(task.id);
        return 'Resumed';
      case 'CANCEL_ACTIVE_STAGE':
        await engine.stopActiveStage(task.id, who);
        return 'Stopped the active stage; the task is paused';
      case 'RETRY_STAGE': {
        const key = action.params.stageKey ?? task.currentStageKey;
        if (!key || key === COMPLETE) throw new Rejected('There is no stage to retry');
        return this.goTo(task, key, `retry, ${who}`, ctx, action.params.guidance);
      }
      case 'RETURN_TO_STAGE':
        return this.goTo(task, action.params.stageKey, who, ctx, action.params.guidance);
      case 'REPLAN': {
        const key = this.stageKeyOf(task, (s) => s.role === 'planner' && s.kind === 'agent', 'planning');
        return this.goTo(task, key, `re-plan, ${who}`, ctx, action.params.guidance ?? 'Produce a new plan that takes the history of this task into account.');
      }
      case 'ADD_DIRECTIVE': {
        const directive = await engine.addDirective(task.id, {
          text: action.params.text,
          scope: action.params.scope,
          kind: action.params.kind,
          rule: action.params.rule,
          supersedes: action.params.supersedes,
          sourceMessageId: ctx.messageId ?? null,
        });
        if (action.params.interrupt && this.writeStageRunning(task)) {
          const key = task.currentStageKey!;
          await engine.redirect(task.id, key, { reason: 'new constraint from you; re-running under it' });
          this.d.setGuidance(task.id, `The user added a constraint while this stage was running: "${directive.text}". The previous attempt was stopped; check its partial changes against the constraint and undo anything that violates it.`);
          return `Directive added; the running stage was stopped and re-runs under it`;
        }
        return directive.kind === 'routing' ? 'Routing directive recorded' : `Directive added${directive.scope === 'NEXT_RELEVANT_STAGE' ? ' for the next agent stage' : ' for the rest of the task'}`;
      }
      case 'REMOVE_DIRECTIVE':
        engine.removeDirective(task.id, action.params.directiveId);
        return 'Directive removed; later stages no longer receive it';
      case 'CHANGE_AGENT':
        engine.setAssignment(task.id, { stageKey: action.params.stageKey, agentId: action.params.agentId, model: action.params.model, effort: action.params.effort, applyToRole: action.params.applyToRole }, who);
        return `${this.d.views.stageDef(task, action.params.stageKey)?.name ?? action.params.stageKey} will run on ${action.params.agentId}`;
      case 'CHANGE_MODEL':
        engine.setAssignment(task.id, { stageKey: action.params.stageKey, model: action.params.model }, who);
        return `Model set to ${action.params.model}`;
      case 'CHANGE_EFFORT':
        engine.setAssignment(task.id, { stageKey: action.params.stageKey, effort: action.params.effort }, who);
        return `Effort set to ${action.params.effort}`;
      case 'RUN_TARGETED_TESTS':
      case 'RUN_FULL_TESTS':
      case 'RUN_E2E': {
        const testsKey = this.stageKeyOf(task, (s) => s.kind === 'tests', 'test');
        const configured = this.configuredKinds(task);
        let kinds: CommandKind[] = [];
        if (action.type === 'RUN_E2E') {
          if (!configured.has('e2e')) throw new Rejected('No end-to-end command is configured for this repository. Add one in Repositories → Commands.');
          kinds = ['e2e'];
        } else if (action.type === 'RUN_FULL_TESTS') {
          kinds = (['lint', 'typecheck', 'test', 'build', 'e2e'] as CommandKind[]).filter((k) => configured.has(k));
        }
        if (kinds.length) engine.requestChecks(task.id, kinds);
        const label = kinds.length ? kinds.join(', ') : 'the configured checks';
        if (ctx.control) {
          engine.redirectInLoop(task.id, testsKey, { reason: `run ${label}, ${who}` });
          return `Running ${label}`;
        }
        if (engine.isRunning(task.id) || task.status === 'QUEUED') return `Queued: the next Test stage runs ${label}`;
        await engine.redirect(task.id, testsKey, { reason: `run ${label}, ${who}` });
        return `Running ${label} now`;
      }
      case 'CREATE_CHECKPOINT': {
        if (!ctx.control && this.writeStageRunning(task)) throw new Rejected('A stage is changing files right now. Checkpoints are also taken automatically before every write stage.');
        const cp = await this.d.checkpoints.create(task, { label: action.params.label ?? 'Requested checkpoint', reason: 'user', stageKey: task.currentStageKey });
        if (!cp) throw new Rejected('Checkpoints need a Git repository and a task that has started changing files.');
        return `Checkpoint ${cp.seq} created`;
      }
      case 'ROLLBACK_CHECKPOINT': {
        const target = action.params.checkpointId ? this.d.chairman.checkpoint(action.params.checkpointId) : this.d.checkpoints.lastChangeTarget(task);
        if (!target) throw new Rejected('There is no checkpoint to roll back to yet; one is taken before every write stage.');
        const wasActive = ['RUNNING', 'QUEUED'].includes(task.status);
        if (!ctx.control && engine.isRunning(task.id)) await engine.stopActiveStage(task.id, 'rolling back');
        const { checkpoint, result } = await this.d.checkpoints.restore(this.d.store.getTask(task.id)!, target.id);
        const summary = `Rolled back to checkpoint ${checkpoint.seq}: ${result.restored.length} file(s) restored, ${result.removed.length} removed${result.skipped.length ? `, ${result.skipped.length} of your own left untouched` : ''}`;
        if (!ctx.control && wasActive && checkpoint.stageKey) {
          await this.goTo(this.d.store.getTask(task.id)!, checkpoint.stageKey, 'after rollback', ctx, 'The previous attempt was rolled back. Take a different approach than the one that was undone.');
          return `${summary}; re-running from there`;
        }
        return summary;
      }
      case 'MARK_HARD_BLOCKER':
        await engine.block(task.id, 'hard_blocker', action.params.reason, { inLoop: Boolean(ctx.control) });
        return 'Task waits for you';
      case 'COMPLETE_TASK': {
        const gate = await this.d.gate(task);
        if (!gate.pass) throw new Rejected(`Not complete yet: ${gate.failures.map((f) => f.message).join(' ')}`);
        return this.goTo(task, COMPLETE, `completion, ${who}`, ctx);
      }
    }
  }
}
