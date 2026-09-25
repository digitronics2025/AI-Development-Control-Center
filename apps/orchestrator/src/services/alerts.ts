import { redact } from '@acc/security';
import type { EventType, FinalStatus, TaskEvent } from '@acc/shared';
import type { Bus } from '../bus.js';
import type { ApprovalRecord, Store, TaskRecord } from '../store/store.js';
import type { SettingsService } from './settings.js';

/**
 * Phone alerts (docs/plans/LEAD_TIME_PLAN.md §3.4). When a task enters a
 * state that needs the operator (a decision, an approval, a stop, a failure)
 * or finishes, one alert goes to the operator's messenger, which pushes it to
 * the phone with no dashboard open. It is posted as the messenger's scoped
 * `control_center` bot.
 *
 * "Already sent" is a task event, never memory: every attempt writes
 * ALERT_SENT or ALERT_NOT_SENT naming the event or approval it is about, and
 * nothing is sent twice for one of them. An alert is never part of the task's
 * state and never blocks or delays anything.
 */

export type AlertKind = 'approval' | 'decision' | 'stopped' | 'usage' | 'failed' | 'completed';

export interface AlertServiceDeps {
  store: Store;
  bus: Bus;
  settings: SettingsService;
  /** The broker's `value`, read with `reserved: 'orchestrator'` (the token is kept from every tool path). */
  credentials: { value(name: string, repositoryId: string | null, opts: { reserved: 'orchestrator' }): Promise<string | null> };
  /** Writes a task event through the engine's publisher. */
  event: (taskId: string, type: EventType, message: string, data: Record<string, unknown>) => void;
  fetch?: typeof fetch;
  /** Wait before the one retry (network error, 5xx, 429). */
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface AlertDelivery {
  ok: boolean;
  /** HTTP status when the messenger answered. */
  status?: number;
  /** Why it was not sent; names a field or a status, never a value. */
  reason?: string;
}

/** The messenger's ingest route (whatsapp-inbox-saas-1, internal-notifications.ts). */
const INGEST_PATH = '/api/v1/internal/notifications/ingest';
/** Events that mark a task entering an alerting state. */
const ENTRY_EVENTS: ReadonlySet<EventType> = new Set(['TASK_WAITING', 'TASK_FAILED', 'TASK_COMPLETED']);
/** After a restart, states entered longer ago than this are not alerted late. */
const CATCH_UP_MS = 60 * 60_000;
const MAX_TITLE = 120;
const MAX_BODY = 600;

const TOGGLE: Record<AlertKind, 'approvals' | 'failures' | 'completions'> = {
  approval: 'approvals',
  decision: 'approvals',
  stopped: 'failures',
  usage: 'failures',
  failed: 'failures',
  completed: 'completions',
};

function cut(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Which alert, if any, a task's entry event calls for, judged by the state the task is in now. */
export function alertKindFor(task: Pick<TaskRecord, 'status' | 'blocker'>, eventType: EventType): Exclude<AlertKind, 'approval'> | null {
  if (eventType === 'TASK_COMPLETED') return task.status === 'COMPLETED' ? 'completed' : null;
  if (eventType === 'TASK_FAILED') return task.status === 'FAILED' ? 'failed' : null;
  if (eventType !== 'TASK_WAITING') return null;
  if (task.status === 'WAITING_FOR_USAGE_RESET') return 'usage';
  if (task.status !== 'WAITING_FOR_USER') return null;
  // An approval is alerted from the approval itself; a queued task needs nobody.
  if (task.blocker?.kind === 'approval' || task.blocker?.kind === 'queued') return null;
  return task.blocker?.kind === 'decision' ? 'decision' : 'stopped';
}

interface Alert {
  taskId: string;
  kind: AlertKind;
  /** `event:<id>` or `approval:<id>`: what the alert is about, once. */
  source: string;
  title: string;
  body: string;
  severity: 'info' | 'warn' | 'critical';
}

export class AlertService {
  private unsubscribe: (() => void) | null = null;
  private readonly inFlight = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly d: AlertServiceDeps) {}

  private config() {
    const phone = this.d.settings.get().notifications.phone;
    return phone.url && phone.credentialName && phone.recipientEmail ? phone : null;
  }

  /** Watch for alerting states, and send what a restart may have left unsent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.d.bus.subscribe((m) => {
      if (m.type === 'event' && ENTRY_EVENTS.has(m.event.type)) void this.onEntry(m.event).catch(() => undefined);
      else if (m.type === 'approval' && m.approval.status === 'pending') void this.onApproval(m.approval).catch(() => undefined);
    });
    void this.catchUp().catch(() => undefined);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private async catchUp(): Promise<void> {
    if (!this.config()) return;
    const since = Date.now() - CATCH_UP_MS;
    const recent = (iso: string) => Date.parse(iso) >= since;
    for (const task of this.d.store.listTasks({ statuses: ['WAITING_FOR_USER', 'WAITING_FOR_USAGE_RESET', 'FAILED', 'COMPLETED'], limit: 200 })) {
      const entry = this.d.store.lastEventOfType(task.id, [...ENTRY_EVENTS]);
      if (entry && recent(entry.at)) await this.onEntry(entry);
    }
    for (const approval of this.d.store.listApprovals({ status: 'pending', limit: 200 })) {
      if (recent(approval.createdAt)) await this.onApproval(approval);
    }
  }

  private async onEntry(event: Pick<TaskEvent, 'id' | 'taskId' | 'type' | 'message'>): Promise<void> {
    const task = this.d.store.getTask(event.taskId);
    if (!task) return;
    const kind = alertKindFor(task, event.type);
    if (!kind) return;
    const phrase: Record<typeof kind, string> = {
      decision: 'needs your decision',
      stopped: 'is stopped',
      usage: 'waits for usage to reset',
      failed: 'failed',
      completed: `is done · ${task.finalStatus === 'READY' ? 'ready' : 'needs your attention'}`,
    };
    const severity = kind === 'failed' ? 'critical' : kind === 'usage' || (kind === 'completed' && task.finalStatus === 'READY') ? 'info' : 'warn';
    const detail = kind === 'completed' ? this.completionLine(task.finalStatus) : (task.blocker?.message ?? event.message);
    await this.deliver({ taskId: task.id, kind, source: `event:${event.id}`, title: `${task.id} ${phrase[kind]} · ${task.title}`, body: this.body(task, detail), severity });
  }

  private async onApproval(approval: ApprovalRecord): Promise<void> {
    const task = this.d.store.getTask(approval.taskId);
    if (!task) return;
    await this.deliver({
      taskId: task.id,
      kind: 'approval',
      source: `approval:${approval.id}`,
      title: `${task.id} needs your approval · ${task.title}`,
      body: this.body(task, `${approval.action}: ${approval.reason}`),
      severity: 'warn',
    });
  }

  private completionLine(finalStatus: FinalStatus | null): string {
    return finalStatus === 'READY' ? 'Finished and ready.' : 'Finished, but the completion report lists what still needs you.';
  }

  private body(task: TaskRecord, detail: string): string {
    const repo = this.d.store.getRepository(task.repositoryId)?.name ?? 'repository';
    return cut(redact(`${repo} — ${detail}`), MAX_BODY);
  }

  private alreadySent(taskId: string, source: string): boolean {
    return this.d.store.eventsOfType(taskId, ['ALERT_SENT']).some((e) => e.data?.source === source);
  }

  private async deliver(alert: Alert): Promise<void> {
    const config = this.config();
    if (!config || !this.d.settings.get().notifications[TOGGLE[alert.kind]]) return;
    if (this.inFlight.has(alert.source) || this.alreadySent(alert.taskId, alert.source)) return;
    this.inFlight.add(alert.source);
    try {
      const title = cut(redact(alert.title), MAX_TITLE);
      const openUrl = config.openUrl ? `${config.openUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(alert.taskId)}` : undefined;
      const payload = { title, body: alert.body, severity: alert.severity, dedupeKey: `acc:${alert.taskId}:${alert.source}`, ...(openUrl ? { deepLink: openUrl } : {}) };
      let result = await this.post(payload);
      if (!result.ok && result.retry && this.unsubscribe) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            resolve();
          }, this.d.retryDelayMs ?? 30_000);
          this.timers.add(timer);
        });
        result = await this.post(payload);
      }
      if (result.ok) this.d.event(alert.taskId, 'ALERT_SENT', `Phone alert sent: ${title}`, { source: alert.source, kind: alert.kind });
      else this.d.event(alert.taskId, 'ALERT_NOT_SENT', `Phone alert not sent: ${result.reason}`, { source: alert.source, kind: alert.kind, reason: result.reason ?? null, status: result.status ?? null });
    } finally {
      this.inFlight.delete(alert.source);
    }
  }

  /** Send a test alert from Settings; reports what happened, with a reason when it failed. */
  async test(): Promise<AlertDelivery> {
    if (!this.config()) return { ok: false, reason: 'Phone alerts need the messenger address, the credential and the recipient' };
    const result = await this.post({
      title: 'Control Center test alert',
      body: 'Phone alerts are set up: tasks that need you, fail or finish will show here.',
      severity: 'info',
      dedupeKey: `acc:test:${Date.now()}`,
    });
    return { ok: result.ok, ...(result.status !== undefined ? { status: result.status } : {}), ...(result.reason ? { reason: result.reason } : {}) };
  }

  private async post(payload: { title: string; body: string; severity: string; dedupeKey: string; deepLink?: string }): Promise<AlertDelivery & { retry?: boolean }> {
    const config = this.config();
    if (!config) return { ok: false, reason: 'phone alerts are not configured' };
    let url: URL;
    try {
      url = new URL(INGEST_PATH, config.url);
    } catch {
      return { ok: false, reason: 'the messenger address is not a valid URL' };
    }
    if (url.protocol !== 'https:') return { ok: false, reason: 'the messenger address must be https' };
    const token = await this.d.credentials.value(config.credentialName, null, { reserved: 'orchestrator' }).catch(() => null);
    if (!token) return { ok: false, reason: 'the credential is missing, or not saved to MyVault yet' };
    try {
      const res = await (this.d.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'acc-control-center' },
        body: JSON.stringify({ sourceApp: 'control_center', recipientEmail: config.recipientEmail, ...payload }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.d.timeoutMs ?? 10_000),
      });
      if (res.status === 200 || res.status === 201) return { ok: true, status: res.status };
      const retry = res.status >= 500 || res.status === 429;
      return { ok: false, status: res.status, retry, reason: `the messenger answered HTTP ${res.status}` };
    } catch (error) {
      const name = (error as Error)?.name;
      return { ok: false, retry: true, reason: name === 'TimeoutError' || name === 'AbortError' ? 'the messenger did not answer in time' : 'the messenger could not be reached' };
    }
  }
}
