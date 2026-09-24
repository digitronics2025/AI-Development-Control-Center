import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AgentGuardError } from '@acc/agent-sdk';
import { redact } from '@acc/security';
import { ACTIVE_TASK_STATUSES, ASK_SOURCE_LABEL, ASK_SOURCES, type AskLookup, type AskMessage, type AskSource, type AskSourceCheck, type AskThread, type AskThreadDetail, type ToolExecution } from '@acc/shared';
import type { Bus } from '../bus.js';
import type { Chairman } from '../chairman/chairman.js';
import { EngineError } from '../engine/engine.js';
import type { EngineTooling } from '../engine/tooling.js';
import type { TaskViews } from '../engine/views.js';
import type { AgentRegistry } from '../services/agents.js';
import type { RepositoryService } from '../services/repositories.js';
import type { SettingsService } from '../services/settings.js';
import { newId, type Store } from '../store/store.js';
import type { CredentialBroker } from '../tools/credentials.js';
import type { ReadOnlyScope, ToolScope, ToolService } from '../tools/service.js';
import type { ToolStore } from '../tools/store.js';
import { askPrompt, HISTORY_TURNS, taskReferences, type AskDataSection } from './prompt.js';
import { MAX_LOOKUPS_PER_ANSWER, SOURCE_CAPABILITIES, sourceStates } from './sources.js';
import { AskStore } from './store.js';

export interface AskDeps {
  store: Store;
  askStore: AskStore;
  bus: Bus;
  views: TaskViews;
  agents: AgentRegistry;
  repositories: RepositoryService;
  settings: SettingsService;
  chairman: Chairman;
  dataDir: string;
  /** Read-only data tools (docs/plans/ASK_READ_ONLY_DATA_PLAN.md). */
  tools: ToolService;
  toolStore: ToolStore;
  tooling: EngineTooling;
  credentials: CredentialBroker;
}

const NEW_TITLE = 'New question';
const TITLE_CHARS = 60;
const ANSWER_CHARS = 20_000;
/** Streaming: at most one draft per thread this often, and never more than this much text. */
const DRAFT_INTERVAL_MS = 150;
const DRAFT_CHARS = 16_000;
const ASK_TIMEOUT_MS = 10 * 60_000;
/** A lookup reads live data when it went to Cloudflare. */
const LIVE_PREFIX = 'cloudflare.';

interface Running {
  executionId: string | null;
  agentId: string;
  cancelled: boolean;
}

/**
 * Ask (docs/systems/ask.md): read-only questions outside tasks. Every answer
 * is one level-1 agent run through `AgentRegistry.launch` — metered, under
 * the subscription guard — whose working directory is the chosen repository
 * or an empty folder. Its data tools come through a read-only tool session:
 * an allow-list of reads for the sources the conversation chose, pinned
 * read-only keys, personal data masked. Questions in one conversation are
 * answered one at a time.
 */
export class AskService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly running = new Map<string, Running>();

  constructor(private readonly d: AskDeps) {}

  // ----- conversations --------------------------------------------------------------

  list(): AskThread[] {
    return this.d.askStore.listThreads();
  }

  detail(threadId: string): AskThreadDetail {
    const thread = this.thread(threadId);
    return { thread, messages: this.withLookups(thread.id, this.d.askStore.listMessages(threadId)) };
  }

  /** Whether each source is set up (Settings → Ask). */
  sources(): Record<AskSource, { ready: boolean; reason: string | null }> {
    return sourceStates(this.d.settings.get().ask, this.d.credentials);
  }

  /**
   * Settings → Ask → Check access: one real read per source, through the same
   * read-only session an answer gets, so a green result means answers can read.
   */
  async checkSources(): Promise<AskSourceCheck[]> {
    const states = this.sources();
    const probes: Record<AskSource, { capability: string; input: unknown }> = {
      controlcenter: { capability: 'controlcenter.tasks', input: { limit: 1 } },
      github: { capability: 'github.repos', input: { limit: 5 } },
      cloudflare: { capability: 'cloudflare.catalog', input: {} },
    };
    const out: AskSourceCheck[] = [];
    for (const source of ASK_SOURCES) {
      const state = states[source];
      if (!state.ready) {
        out.push({ source, ok: false, message: state.reason ?? 'Needs setup' });
        continue;
      }
      const cwd = this.emptyFolder();
      const outcome = await this.d.tools.invoke({ capability: probes[source].capability, input: probes[source].input, origin: 'operator', scope: { ...this.readOnlyScope(cwd, null, [source], true), sessionId: null, escalated: new Set() } });
      out.push({ source, ok: outcome.result.ok, message: outcome.result.ok ? `Ready: ${outcome.result.summary}` : outcome.result.summary });
    }
    return out;
  }

  create(input: { repositoryId?: string | null; agentId?: string; model?: string; effort?: string; sources?: AskSource[]; showPersonal?: boolean }): AskThread {
    const repositoryId = input.repositoryId ?? null;
    if (repositoryId) this.d.repositories.record(repositoryId);
    if (input.agentId && !this.d.agents.has(input.agentId)) throw new EngineError(`Unknown agent "${input.agentId}"`, 'INVALID_INPUT');
    const defaults = this.d.settings.get().ask;
    const agentId = input.agentId ?? defaults.agentId;
    // A model or effort belongs to its agent: another agent without them means its own defaults.
    const own = agentId === defaults.agentId;
    const inserted = this.d.askStore.insertThread({
      title: NEW_TITLE,
      repositoryId,
      agentId,
      model: input.model ?? (own ? defaults.model : 'default'),
      effort: input.effort ?? (own ? defaults.effort : 'default'),
      // By default a conversation may look wherever a key is set up.
      sources: normalizeSources(input.sources ?? ASK_SOURCES.filter((s) => this.sources()[s].ready)),
    });
    const thread = input.showPersonal ? this.d.askStore.updateThread(inserted.id, { showPersonal: true }) : inserted;
    this.d.bus.publish({ type: 'ask.thread', thread });
    return thread;
  }

  update(threadId: string, patch: Partial<Pick<AskThread, 'title' | 'repositoryId' | 'agentId' | 'model' | 'effort' | 'sources' | 'showPersonal'>>): AskThread {
    this.thread(threadId);
    if (patch.repositoryId) this.d.repositories.record(patch.repositoryId);
    if (patch.agentId && !this.d.agents.has(patch.agentId)) throw new EngineError(`Unknown agent "${patch.agentId}"`, 'INVALID_INPUT');
    const thread = this.d.askStore.updateThread(threadId, { ...patch, ...(patch.sources ? { sources: normalizeSources(patch.sources) } : {}) });
    this.d.bus.publish({ type: 'ask.thread', thread });
    return thread;
  }

  async remove(threadId: string): Promise<void> {
    this.thread(threadId);
    await this.cancel(threadId);
    this.d.askStore.deleteThread(threadId);
    this.d.bus.publish({ type: 'ask.thread.deleted', threadId });
  }

  // ----- questions ------------------------------------------------------------------

  /** Persist a question (idempotent per client id) and answer it in the background. */
  post(threadId: string, text: string, clientMessageId: string): { message: AskMessage; duplicate: boolean } {
    const thread = this.thread(threadId);
    const existing = this.d.askStore.messageByClientId(threadId, clientMessageId);
    if (existing) return { message: existing, duplicate: true };
    const body = redact(text.trim());
    const message = this.d.askStore.insertMessage({ threadId, role: 'user', body, status: 'pending', clientMessageId });
    this.publishMessage(message);
    const titled = thread.title === NEW_TITLE ? this.d.askStore.updateThread(threadId, { title: titleFrom(body) }) : this.d.askStore.touchThread(threadId);
    if (titled) this.d.bus.publish({ type: 'ask.thread', thread: titled });
    this.enqueue(threadId, message);
    return { message, duplicate: false };
  }

  /** Stop the answer being written and drop questions still waiting in this conversation. */
  async cancel(threadId: string): Promise<void> {
    this.thread(threadId);
    for (const m of this.d.askStore.listMessages(threadId)) {
      if (m.role === 'user' && m.status === 'pending') this.publishMessage(this.d.askStore.updateMessage(m.id, { status: 'cancelled' }));
    }
    const run = this.running.get(threadId);
    if (!run) return;
    run.cancelled = true;
    if (run.executionId) await this.d.agents.adapter(run.agentId).cancel(run.executionId).catch(() => undefined);
  }

  /** Wait until every queued question has been answered (tests, shutdown). */
  async idle(threadId?: string): Promise<void> {
    const pending = threadId ? [this.queues.get(threadId)] : [...this.queues.values()];
    await Promise.all(pending.filter(Boolean));
  }

  /** Shutdown: stop answers in progress, then wait for their queues to settle. */
  async stopAll(): Promise<void> {
    for (const threadId of this.running.keys()) await this.cancel(threadId).catch(() => undefined);
    await this.idle();
  }

  /** After a restart: an answer cut off mid-way is marked failed; unanswered questions are answered. */
  recoverPending(): void {
    for (const m of this.d.askStore.unfinished()) {
      if (m.role === 'assistant') {
        this.publishMessage(this.d.askStore.updateMessage(m.id, { status: 'failed', error: 'The Control Center restarted while this answer was being written. Ask again.' }));
      } else {
        this.enqueue(m.threadId, m);
      }
    }
  }

  private enqueue(threadId: string, message: AskMessage): void {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.answer(message)).catch(() => undefined);
    this.queues.set(threadId, next);
    void next.finally(() => {
      if (this.queues.get(threadId) === next) this.queues.delete(threadId);
    });
  }

  private async answer(question: AskMessage): Promise<void> {
    const thread = this.d.askStore.thread(question.threadId);
    // Cancelled while it waited, or the conversation was deleted.
    if (!thread || this.d.askStore.message(question.id)?.status !== 'pending') return;
    this.publishMessage(this.d.askStore.updateMessage(question.id, { status: 'done' }));
    const reply = this.d.askStore.insertMessage({ threadId: thread.id, role: 'assistant', body: '', status: 'running' });
    this.publishMessage(reply);
    const run: Running = { executionId: null, agentId: thread.agentId, cancelled: false };
    this.running.set(thread.id, run);
    try {
      const outcome = await this.run(thread, question, reply, run);
      this.finish(reply.id, outcome);
    } catch (error) {
      this.finish(reply.id, { status: 'failed', body: '', error: redact((error as Error).message) });
    } finally {
      this.running.delete(thread.id);
      const touched = this.d.askStore.touchThread(thread.id);
      if (touched) this.d.bus.publish({ type: 'ask.thread', thread: touched });
    }
  }

  private async run(thread: AskThread, question: AskMessage, reply: AskMessage, run: Running): Promise<{ status: AskMessage['status']; body: string; error: string | null }> {
    const unavailable = this.unavailableReason(thread.agentId);
    if (unavailable) return { status: 'failed', body: '', error: unavailable };
    const repo = thread.repositoryId ? this.repository(thread.repositoryId) : null;
    const cwd = repo?.path ?? this.emptyFolder();
    const history = this.d.askStore
      .listMessages(thread.id, HISTORY_TURNS * 2 + 2)
      .filter((m) => m.seq < question.seq && m.status === 'done' && m.body)
      .map((m) => ({ role: m.role, body: m.body }));
    // The read-only data tools: a session limited to the sources this conversation chose and that are set up.
    const states = this.sources();
    const usable = thread.sources.filter((s) => states[s].ready);
    const bridge = this.d.tooling.openBridge(this.readOnlyScope(cwd, thread.repositoryId, usable, !thread.showPersonal), ASK_TIMEOUT_MS + 5 * 60_000);
    if (bridge) this.d.askStore.updateMessage(reply.id, { toolSessionId: bridge.sessionId });
    const data: AskDataSection = {
      toolsOff: bridge ? null : this.d.tooling.bridgeUnavailableReason(),
      sources: ASK_SOURCES.map((s) => ({
        label: ASK_SOURCE_LABEL[s],
        state: !thread.sources.includes(s) ? 'off in this conversation' : states[s].ready ? 'available' : `not set up: ${states[s].reason}`,
      })),
      personalMasked: this.d.settings.get().ask.maskPersonalData && !thread.showPersonal,
      dataMap: this.d.settings.get().ask.dataMap,
      githubOwners: usable.includes('github') ? this.d.settings.get().ask.sources.github.owners : [],
    };
    const prompt = askPrompt({
      question: question.body,
      repository: repo ? { name: repo.name } : null,
      overview: this.overview(),
      tasks: taskReferences(question.body).map((id) => ({ id, text: this.describeTask(id) })),
      history,
      data,
    });
    try {
      return await this.launch(thread, reply, run, cwd, prompt, bridge);
    } finally {
      bridge?.close();
    }
  }

  private async launch(thread: AskThread, reply: AskMessage, run: Running, cwd: string, prompt: string, bridge: ReturnType<EngineTooling['openBridge']>): Promise<{ status: AskMessage['status']; body: string; error: string | null }> {
    const draft = new Draft((text, activity) => this.d.bus.publish({ type: 'ask.delta', threadId: thread.id, messageId: reply.id, text, activity }));
    const executionId = newId();
    run.executionId = executionId;
    let handle;
    try {
      handle = await this.d.agents.launch(
        thread.agentId,
        {
          ...this.d.agents.runtimeOptions(thread.agentId),
          executionId,
          cwd,
          prompt,
          model: thread.model,
          effort: thread.effort,
          // Read-only, always: no route or setting raises it.
          permissionLevel: 1,
          timeoutMs: ASK_TIMEOUT_MS,
          ...(bridge ? { toolBridge: { name: 'acc', command: bridge.command, args: bridge.args, env: bridge.env } } : {}),
          onLine: (stream, text) => {
            if (stream === 'stdout') draft.line(text);
          },
        },
        { origin: 'ask', projectId: thread.repositoryId, taskId: null, runId: null, workflowId: null, workflowStep: 'ask', agentRole: 'ask', mode: null },
      );
    } catch (error) {
      const reason = error instanceof AgentGuardError ? error.message : `The agent could not start: ${(error as Error).message}`;
      return { status: 'failed', body: '', error: redact(reason) };
    }
    // A Stop pressed while the agent was starting.
    if (run.cancelled) await this.d.agents.adapter(thread.agentId).cancel(executionId).catch(() => undefined);
    const result = await handle.done;
    draft.close();
    const output = clip(redact(result.output.trim()));
    if (run.cancelled || result.status === 'cancelled') return { status: 'cancelled', body: output || clip(draft.text), error: null };
    if (result.status !== 'succeeded') {
      const name = this.d.agents.adapter(thread.agentId).displayName;
      return { status: 'failed', body: '', error: redact(result.errorMessage ?? `${name} did not answer (${result.status.replace('_', ' ')}).`) };
    }
    if (!output) return { status: 'failed', body: '', error: `${this.d.agents.adapter(thread.agentId).displayName} returned an empty answer.` };
    return { status: 'done', body: output, error: null };
  }

  private finish(messageId: string, outcome: { status: AskMessage['status']; body: string; error: string | null }): void {
    if (!this.d.askStore.message(messageId)) return;
    this.publishMessage(this.d.askStore.updateMessage(messageId, outcome));
  }

  /** Answers carry their lookups (read from tool_executions, the one record of them). */
  private publishMessage(message: AskMessage): void {
    const [withLookups] = message.role === 'assistant' ? this.withLookups(message.threadId, [message]) : [message];
    this.d.bus.publish({ type: 'ask.message', message: withLookups! });
  }

  private withLookups(threadId: string, messages: AskMessage[]): AskMessage[] {
    const sessions = this.d.askStore.toolSessions(threadId);
    const wanted = messages.map((m) => sessions.get(m.id)).filter((s): s is string => Boolean(s));
    if (!wanted.length) return messages;
    const bySession = new Map<string, AskLookup[]>();
    for (const e of this.d.toolStore.listExecutionsBySession(wanted, 2000)) {
      const list = bySession.get(e.sessionId!) ?? [];
      list.push(lookupOf(e));
      bySession.set(e.sessionId!, list);
    }
    return messages.map((m) => {
      const session = sessions.get(m.id);
      return session ? { ...m, lookups: bySession.get(session) ?? [] } : m;
    });
  }

  /**
   * The scope every answer's tools run in (docs/systems/ask.md): Level 1,
   * the safe policy, no task — and a read-only allow-list of the given sources'
   * reads, pinned read-only keys, and personal data masked unless the
   * conversation turned that off.
   */
  private readOnlyScope(cwd: string, repositoryId: string | null, sources: readonly AskSource[], mask: boolean): Omit<ToolScope, 'sessionId' | 'escalated'> {
    const settings = this.d.settings.get().ask;
    const readOnly: ReadOnlyScope = {
      allow: new Set(sources.flatMap((s) => SOURCE_CAPABILITIES[s])),
      credentials: {
        ...(sources.includes('github') && settings.sources.github.credential ? { github: settings.sources.github.credential } : {}),
        ...(sources.includes('cloudflare') && settings.sources.cloudflare.credential ? { cloudflare: settings.sources.cloudflare.credential } : {}),
      },
      env: {
        ...(settings.sources.cloudflare.accountId ? { CLOUDFLARE_ACCOUNT_ID: settings.sources.cloudflare.accountId } : {}),
        ACC_GITHUB_OWNERS: settings.sources.github.owners.join(','),
      },
      maskPersonal: settings.maskPersonalData && mask,
      maxCalls: MAX_LOOKUPS_PER_ANSWER,
      calls: { count: 0 },
    };
    return { taskId: null, stageId: null, repositoryId, cwd, roots: [cwd], stageLevel: 1, autoApproveUpToLevel: 1, mode: 'safe', profile: 'analysis', protectedPaths: [], readOnly };
  }

  // ----- context --------------------------------------------------------------------

  private thread(threadId: string): AskThread {
    const thread = this.d.askStore.thread(threadId);
    if (!thread) throw new EngineError(`Conversation ${threadId} not found`, 'NOT_FOUND');
    return thread;
  }

  private repository(id: string): { name: string; path: string } | null {
    try {
      const r = this.d.repositories.record(id);
      return { name: r.name, path: r.path };
    } catch {
      return null;
    }
  }

  /** A folder with nothing in it: a question with no repository reads no files. */
  private emptyFolder(): string {
    const dir = path.join(this.d.dataDir, 'ask');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private unavailableReason(agentId: string): string | null {
    if (!this.d.agents.has(agentId)) return `The agent "${agentId}" is not installed. Choose another under Options.`;
    const name = this.d.agents.adapter(agentId).displayName;
    if (!this.d.agents.isEnabled(agentId)) return `${name} is disabled in Settings → Agents & Models.`;
    const state = this.d.agents.get(agentId).health.state;
    if (!['connected', 'unknown'].includes(state)) return `${name} is not available (${state.replace(/_/g, ' ')}).`;
    return null;
  }

  private overview(): string {
    const c = this.d.views.overview();
    const active = this.d.store.listTasks({ statuses: [...ACTIVE_TASK_STATUSES], limit: 10 });
    const recent = this.d.store.listTasks({ limit: 8 });
    const repositories = this.d.store.listRepositories().map((r) => r.name);
    const line = (t: { id: string; status: string; title: string }) => `- ${t.id} [${t.status}] ${t.title}`;
    return [
      `Tasks: ${c.active} active, ${c.waitingForMe} waiting for the operator, ${c.failed} failed, ${c.completedToday} completed today; ${c.pendingApprovals} approvals pending.`,
      `Repositories: ${repositories.length ? repositories.join(', ') : 'none'}.`,
      ...(active.length ? ['Active tasks:', ...active.map(line)] : []),
      ...(recent.length ? ['Most recent tasks:', ...recent.map(line)] : []),
    ].join('\n');
  }

  private describeTask(id: string): string | null {
    if (!this.d.store.getTask(id)) return null;
    try {
      const snapshot = this.d.chairman.snapshots.build(id);
      return `${snapshot.title}\n${this.d.chairman.snapshots.describe(snapshot)}`;
    } catch {
      return null;
    }
  }
}

function normalizeSources(list: readonly AskSource[]): AskSource[] {
  // The Control Center's own records are always readable.
  return ASK_SOURCES.filter((s) => s === 'controlcenter' || list.includes(s));
}

function lookupOf(e: ToolExecution): AskLookup {
  return { id: e.id, capability: e.capability, summary: e.summary, status: e.status, live: e.capability.startsWith(LIVE_PREFIX) && e.status === 'succeeded', durationMs: e.durationMs, startedAt: e.startedAt };
}

function titleFrom(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1)}…` : flat || NEW_TITLE;
}

function clip(text: string): string {
  return text.length > ANSWER_CHARS ? `${text.slice(0, ANSWER_CHARS)}\n\n[answer shortened]` : text;
}

/**
 * The answer as it is written. Tool lines (`[tool] Read …`) are activity,
 * not answer text. Publishes at most every DRAFT_INTERVAL_MS, redacted.
 */
class Draft {
  text = '';
  private activity: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly publish: (text: string, activity: string | null) => void) {}

  line(raw: string): void {
    const line = raw.trimEnd();
    if (/^\[[\w-]+\]/.test(line)) this.activity = redact(line).slice(0, 200);
    else if (this.text.length < DRAFT_CHARS) this.text = `${this.text}${this.text ? '\n' : ''}${line}`.slice(0, DRAFT_CHARS);
    this.dirty = true;
    this.schedule();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The first line goes out at once; later ones at most every DRAFT_INTERVAL_MS. */
  private schedule(): void {
    if (this.timer) return;
    this.flush();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.schedule();
    }, DRAFT_INTERVAL_MS);
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.publish(redact(this.text), this.activity);
  }
}
