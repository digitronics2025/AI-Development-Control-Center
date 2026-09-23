import { redact } from '@acc/security';
import {
  CHAIRMAN_ACTION_LABEL,
  TERMINAL_TASK_STATUSES,
  type ChairmanAction,
  type ChairmanActionInput,
  type ChairmanMessage,
  type ChatIntent,
} from '@acc/shared';
import type { Bus } from '../bus.js';
import { EngineError } from '../engine/engine.js';
import type { TaskViews } from '../engine/views.js';
import type { AgentRegistry } from '../services/agents.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { Store, TaskRecord } from '../store/store.js';
import type { Chairman } from './chairman.js';
import { classifyMessage, INTERPRETABLE_ACTIONS, type IntentContext, type ParsedMessage } from './intent.js';
import { activeDirectives } from './snapshot.js';

export interface ChatDeps {
  store: Store;
  bus: Bus;
  views: TaskViews;
  agents: AgentRegistry;
  artifacts: ArtifactService;
  chairman: Chairman;
}

/**
 * Chairman chat (plan §3.12–3.16). Messages are persisted at once and
 * processed one at a time per task: questions are answered from a fresh
 * snapshot and never change anything; instructions become typed actions that
 * go through the same Action Gateway as automatic decisions.
 */
export class ChairmanChat {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly d: ChatDeps) {}

  /** Persist a user message (idempotent per client id) and process it in the background. */
  post(taskId: string, text: string, clientMessageId: string): { message: ChairmanMessage; duplicate: boolean } {
    const task = this.d.store.getTask(taskId);
    if (!task) throw new EngineError(`Task ${taskId} not found`, 'NOT_FOUND');
    const existing = this.d.chairman.store.messageByClientId(taskId, clientMessageId);
    if (existing) return { message: existing, duplicate: true };
    const message = this.d.chairman.store.insertMessage({
      taskId,
      role: 'user',
      kind: 'message',
      body: redact(text.trim()),
      intent: null,
      status: 'pending',
      decisionId: null,
      actionId: null,
      clientMessageId,
    });
    this.d.bus.publish({ type: 'chairman.message', message });
    this.enqueue(taskId, message);
    return { message, duplicate: false };
  }

  /** Wait until every queued message of a task has been answered (tests, shutdown). */
  async idle(taskId?: string): Promise<void> {
    const pending = taskId ? [this.queues.get(taskId)] : [...this.queues.values()];
    await Promise.all(pending.filter(Boolean));
  }

  private enqueue(taskId: string, message: ChairmanMessage): void {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const next = previous.then(() => this.process(message)).catch(() => undefined);
    this.queues.set(taskId, next);
    void next.finally(() => {
      if (this.queues.get(taskId) === next) this.queues.delete(taskId);
    });
  }

  /** After a restart: answer what was never answered; never re-run actions already taken. */
  recoverPending(): void {
    for (const message of this.d.chairman.store.pendingUserMessages()) {
      const taken = this.d.chairman.store.actionsForMessage(message.id);
      if (taken.length) {
        this.finish(message, 'done');
        this.reply(message.taskId, `(After a restart) I had already acted on "${message.body.slice(0, 80)}": ${taken.map((a) => describeAction(a)).join('; ')}.`);
        continue;
      }
      this.enqueue(message.taskId, message);
    }
  }

  private reply(taskId: string, body: string, kind: ChairmanMessage['kind'] = 'message', link: { decisionId?: string | null; actionId?: string | null } = {}): ChairmanMessage {
    const message = this.d.chairman.store.insertMessage({
      taskId,
      role: 'chairman',
      kind,
      body: redact(body).slice(0, 8000),
      intent: null,
      status: 'done',
      decisionId: link.decisionId ?? null,
      actionId: link.actionId ?? null,
    });
    this.d.bus.publish({ type: 'chairman.message', message });
    return message;
  }

  private finish(message: ChairmanMessage, status: 'done' | 'failed', intent?: ChatIntent): void {
    const updated = this.d.chairman.store.updateMessage(message.id, { status, ...(intent ? { intent } : {}) });
    this.d.bus.publish({ type: 'chairman.message', message: updated });
  }

  intentContext(task: TaskRecord): IntentContext {
    return {
      stages: task.workflow.stages.map((s) => ({ key: s.key, name: s.name, role: s.role, kind: s.kind })),
      agents: this.d.agents.ids().map((id) => ({ id, name: this.d.agents.adapter(id).displayName })),
      directives: activeDirectives(this.d.store.listDirectives(task.id)).map((d) => ({ id: d.id, text: d.text })),
    };
  }

  /** The shared evidence service, chat-sized. A failure to gather it only means a thinner answer. */
  private async evidence(task: TaskRecord): Promise<string> {
    try {
      return this.d.chairman.evidence.render(await this.d.chairman.evidence.forChat(task));
    } catch {
      return '';
    }
  }

  private async process(message: ChairmanMessage): Promise<void> {
    const task = this.d.store.getTask(message.taskId);
    if (!task) return;
    try {
      const parsed = classifyMessage(message.body, this.intentContext(task));
      await this.handle(task, message, parsed);
    } catch (error) {
      this.reply(message.taskId, `I could not handle that: ${(error as Error).message}. Nothing was changed.`);
      this.finish(message, 'failed');
    }
  }

  private async handle(task: TaskRecord, message: ChairmanMessage, parsed: ParsedMessage): Promise<void> {
    const { chairman } = this.d;
    const snapshot = () => chairman.snapshots.build(task.id);
    const terminal = TERMINAL_TASK_STATUSES.includes(task.status);

    if (parsed.clarification) {
      this.reply(task.id, parsed.clarification);
      return this.finish(message, 'done', parsed.intent);
    }
    if (parsed.intent === 'STATUS') {
      this.reply(task.id, chairman.snapshots.describe(snapshot(), parsed.topic ?? 'status'));
      return this.finish(message, 'done', parsed.intent);
    }
    if (parsed.note && !parsed.actions.length) {
      this.reply(task.id, parsed.note);
      return this.finish(message, 'done', parsed.intent);
    }

    const history = this.d.chairman.store
      .listMessages(task.id, { limit: 12 })
      .filter((m) => m.id !== message.id && m.kind === 'message')
      .map((m) => ({ role: m.role, body: m.body }));

    if (parsed.intent === 'QUESTION') {
      // Questions never mutate: the model is offered no actions at all.
      const unavailable = chairman.reasoner.unavailableReason();
      if (unavailable) {
        this.reply(task.id, `${chairman.snapshots.describe(snapshot())}\n\n(Answered from the task record only: ${unavailable})`);
        return this.finish(message, 'done', 'QUESTION');
      }
      const answer = await chairman.reasoner.reply(snapshot(), message.body, parsed, history, await this.evidence(task), []);
      this.reply(task.id, answer.ok ? answer.value.reply : `${chairman.snapshots.describe(snapshot())}\n\n(The Chairman model could not answer: ${answer.reason})`);
      return this.finish(message, 'done', 'QUESTION');
    }

    if (terminal) {
      this.reply(task.id, `${task.id} is ${task.status.toLowerCase()}, so there is nothing left to change. Ask me anything about how it went.`);
      return this.finish(message, 'done', parsed.intent);
    }

    let intent: ChatIntent = parsed.intent;
    let actions = parsed.actions;
    let modelReply: string | null = null;
    if (!parsed.confident && !chairman.reasoner.unavailableReason()) {
      // Uncertain wording: the model may interpret it, but only into non-destructive actions.
      const interpreted = await chairman.reasoner.reply(snapshot(), message.body, parsed, history, await this.evidence(task), [...INTERPRETABLE_ACTIONS]);
      if (interpreted.ok) {
        intent = interpreted.value.intent;
        modelReply = interpreted.value.reply;
        if (intent === 'QUESTION' || intent === 'STATUS') {
          this.reply(task.id, interpreted.value.reply);
          return this.finish(message, 'done', intent);
        }
        if (interpreted.value.actions.length) actions = interpreted.value.actions.map((a) => pinDirectiveText(a, message.body));
      }
    }

    actions = actions.map((a) => this.prepare(task, a));
    if (intent === 'GOAL_CHANGE') {
      const goal = message.body.replace(/^.*?goal\s*(?:to|:)\s*/i, '').trim();
      const contract = chairman.reviseContract(task.id, { goal, reason: 'Goal changed in chat' });
      chairman.publishState(task.id);
      actions = [...actions, { type: 'REPLAN', params: { guidance: `The goal changed (contract v${contract.version}): ${goal}. Plan for the new goal.` } }];
    } else if (actions.some((a) => a.type === 'ADD_DIRECTIVE' && a.params.kind === 'constraint')) {
      const constraint = actions.find((a) => a.type === 'ADD_DIRECTIVE')! as Extract<ChairmanActionInput, { type: 'ADD_DIRECTIVE' }>;
      chairman.reviseContract(task.id, { constraint: constraint.params.text, reason: 'Constraint added in chat' });
      chairman.publishState(task.id);
    }

    const results = await chairman.gateway.executeDecision(task.id, actions, { initiator: 'user', source: 'chat', messageId: message.id });
    for (const action of results) this.reply(task.id, describeAction(action), 'action', { actionId: action.id });
    const failed = results.filter((r) => r.status !== 'completed');
    const done = results.filter((r) => r.status === 'completed');
    const lines: string[] = [];
    if (modelReply) lines.push(modelReply);
    else if (done.length) lines.push(done.map((a) => a.result).filter(Boolean).join('. ') + '.');
    if (failed.length) lines.push(`Not done: ${failed.map((a) => a.reason ?? 'rejected').join('; ')}`);
    if (!results.length) lines.push('I understood that as an instruction but found nothing to change. Try rephrasing as a command, e.g. "Re-investigate the root cause".');
    this.reply(task.id, lines.join('\n'));
    this.finish(message, failed.length && !done.length ? 'failed' : 'done', intent);
  }

  /** Context-dependent parameters: constraints interrupt a running write stage (§5.2). */
  private prepare(task: TaskRecord, action: ChairmanActionInput): ChairmanActionInput {
    if (action.type === 'ADD_DIRECTIVE' && action.params.kind === 'constraint') {
      return { ...action, params: { ...action.params, interrupt: true } };
    }
    return action;
  }
}

/** A directive a model proposes must carry the user's own words, not text it composed from evidence. */
function pinDirectiveText(action: ChairmanActionInput, text: string): ChairmanActionInput {
  if (action.type !== 'ADD_DIRECTIVE') return action;
  return { ...action, params: { ...action.params, text } };
}

export function describeAction(action: ChairmanAction): string {
  const label = CHAIRMAN_ACTION_LABEL[action.type] ?? action.type;
  if (action.status === 'completed') return `${label} — ${action.result ?? 'done'}`;
  if (action.status === 'running') return `${label} — running`;
  return `${label} — ${action.status}: ${action.reason ?? 'no reason given'}`;
}
