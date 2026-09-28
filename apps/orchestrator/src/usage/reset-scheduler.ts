import { formatResetTime, type EventType } from '@acc/shared';
import type { Bus } from '../bus.js';
import type { SettingsService } from '../services/settings.js';
import type { Store, TaskRecord } from '../store/store.js';
import { CAPACITY_STALE_MS, type CapacityStore } from './capacity.js';

/** The scheduler's clock: real timers in the app, a hand-advanced one in tests. */
export interface ResetClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const systemClock: ResetClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** How long after the provider's stated reset a task resumes: clock skew and the provider's own rounding. */
export const RESET_GRACE_MS = 2 * 60_000;
/** Node timers wait at most this long; a later reset is re-armed when the timer fires. */
const MAX_TIMER_MS = 2_147_483_647;

export type AutoResumePhase = 'scheduled' | 'resumed' | 'not_resumed' | 'manual';

/** What stops a waiting task and when it lifts, judged from stored readings. */
export interface ResetPlan {
  taskId: string;
  agentId: string;
  /** The agent run that hit the limit (or was refused at launch for it). */
  executionId: string;
  /** Null when no reading says when the limit lifts: the task stays manual. */
  resetAt: string | null;
  /** `usage-reset:<agent>:<resetAt>`, the gateway's idempotency key: one resume per reset per task. */
  key: string | null;
  fireAt: number | null;
}

export interface UsageResetDeps {
  store: Store;
  settings: SettingsService;
  bus: Bus;
  capacity: CapacityStore;
  /** Whether a gateway action with this key already exists for the task (stored, so it survives a restart). */
  used(taskId: string, key: string): boolean;
  /** RESUME_TASK through the Chairman's Action Gateway as initiator `system`, with the key. */
  resume(taskId: string, key: string, expectedVersion: number): Promise<{ status: string; reason: string | null }>;
  /** A task event through the engine's publisher (phone alerts listen for it). */
  event(taskId: string, type: EventType, message: string, data: Record<string, unknown>): void;
  agentName(agentId: string): string;
  clock?: ResetClock;
  graceMs?: number;
}

/**
 * Auto-resume at a usage reset (docs/systems/usage.md#auto-resume-at-reset).
 * Opt-in (`execution.autoResumeOnReset`). For each task waiting for a usage
 * reset whose limit has a stated reset time, it resumes the task once, as the
 * gateway's `system` initiator, at the reset plus a grace period. The timer is
 * derived from stored state — the task, the run that hit the limit and the
 * capacity readings — so a restart re-arms it, and "once" is the gateway's
 * stored idempotency key, never memory. A limit hit again with the same reset
 * time, or with none, stays manual.
 */
export class UsageResetScheduler {
  private readonly timers = new Map<string, { key: string; fireAt: number; handle: unknown }>();
  /** Timers that fired before `start()`: run once the app has finished recovering. */
  private readonly held = new Map<string, string>();
  private readonly firing = new Set<string>();
  private live = false;
  private unsubscribe: (() => void) | null = null;
  private readonly offRecord: () => void;

  constructor(private readonly d: UsageResetDeps) {
    this.offRecord = d.capacity.onRecord(() => this.replan());
  }

  private get clock(): ResetClock {
    return this.d.clock ?? systemClock;
  }

  private get graceMs(): number {
    return this.d.graceMs ?? RESET_GRACE_MS;
  }

  private enabled(): boolean {
    return this.d.settings.get().execution.autoResumeOnReset;
  }

  /** Startup (UsageService.recover): re-arm from stored state. Nothing fires before `start()`. */
  recover(): void {
    this.replan();
  }

  /** Once the engine and the Chairman have recovered: fire what is due, and follow tasks and settings from now on. */
  start(): void {
    if (this.live) return;
    this.live = true;
    this.unsubscribe = this.d.bus.subscribe((m) => {
      // After the publishing call returns: the engine writes the status, then its event.
      if (m.type === 'task' && (m.task.status === 'WAITING_FOR_USAGE_RESET' || this.timers.has(m.task.id))) queueMicrotask(() => this.replanTask(m.task.id));
      else if (m.type === 'settings') queueMicrotask(() => this.replan());
    });
    const held = [...this.held];
    this.held.clear();
    for (const [taskId, key] of held) void this.fire(taskId, key);
    this.replan();
  }

  stop(): void {
    this.live = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.offRecord();
    for (const timer of this.timers.values()) this.clock.clearTimer(timer.handle);
    this.timers.clear();
    this.held.clear();
  }

  /** The armed timers, for tests and diagnostics. */
  pending(): Array<{ taskId: string; key: string; fireAt: string }> {
    return [...this.timers].map(([taskId, t]) => ({ taskId, key: t.key, fireAt: new Date(t.fireAt).toISOString() }));
  }

  /**
   * The reset a waiting task depends on. Readings count only for the agent of
   * the run that hit the limit, as they stood when it was blocked (the run's
   * own and those before it): a later run's reading — the window open again,
   * or a failure that states no reset — never hides the reset this block waits
   * for; if the limit is still on at the resume, that launch is refused and
   * planned as a new block. Of those, a reading counts when it explains the
   * block: a reset after that run ended, or no reset and taken within
   * freshness of it. Every such reading must lift, so any without a reset time
   * makes it unknown.
   */
  planFor(task: TaskRecord): ResetPlan | null {
    if (task.status !== 'WAITING_FOR_USAGE_RESET') return null;
    const run = this.d.store
      .listExecutions(task.id)
      .filter((e) => e.errorClass === 'USAGE_LIMIT' && e.agentId)
      .at(-1);
    if (!run?.agentId) return null;
    const blocked = run.finishedAt ?? run.startedAt;
    const blockedAt = Date.parse(blocked);
    const relevant = this.d.capacity.asOf(run.agentId, blocked, run.id).filter((r) => {
      if (r.status !== 'exhausted' || r.metric === 'overage') return false;
      return r.resetAt ? Date.parse(r.resetAt) > blockedAt : Date.parse(r.capturedAt) >= blockedAt - CAPACITY_STALE_MS;
    });
    const base = { taskId: task.id, agentId: run.agentId, executionId: run.id };
    const resets = relevant.map((r) => (r.resetAt ? Date.parse(r.resetAt) : NaN));
    if (!relevant.length || resets.some((at) => !Number.isFinite(at))) return { ...base, resetAt: null, key: null, fireAt: null };
    const resetAt = new Date(Math.max(...resets)).toISOString();
    return { ...base, resetAt, key: `usage-reset:${run.agentId}:${resetAt}`, fireAt: Date.parse(resetAt) + this.graceMs };
  }

  /** Re-plan every waiting task: arm, move or clear its timer. */
  replan(): void {
    try {
      if (!this.enabled()) {
        for (const id of [...this.timers.keys()]) this.clear(id);
        return;
      }
      const waiting = this.d.store.listTasks({ statuses: ['WAITING_FOR_USAGE_RESET'], limit: 1000 });
      const ids = new Set(waiting.map((t) => t.id));
      for (const id of [...this.timers.keys()]) if (!ids.has(id)) this.clear(id);
      for (const task of waiting) this.planTask(task);
    } catch (error) {
      console.warn(`[usage] auto-resume planning failed: ${(error as Error).message}`);
    }
  }

  private replanTask(taskId: string): void {
    try {
      const task = this.d.store.getTask(taskId);
      if (task) this.planTask(task);
      else this.clear(taskId);
    } catch (error) {
      console.warn(`[usage] auto-resume planning failed for ${taskId}: ${(error as Error).message}`);
    }
  }

  private clear(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) this.clock.clearTimer(timer.handle);
    this.timers.delete(taskId);
  }

  private planTask(task: TaskRecord): void {
    if (this.firing.has(task.id)) return;
    const plan = this.enabled() ? this.planFor(task) : null;
    if (!plan) return this.clear(task.id);
    const name = this.d.agentName(plan.agentId);
    if (!plan.key || plan.fireAt === null || !plan.resetAt) {
      this.clear(task.id);
      this.announce(plan, 'manual', `Waits for you: ${name} did not say when its usage limit resets, so this task does not resume by itself.`);
      return;
    }
    if (this.d.used(task.id, plan.key)) {
      this.clear(task.id);
      this.announce(plan, 'manual', `Waits for you: it already resumed by itself once for ${name}'s reset at ${this.time(plan.resetAt)}, and the limit came back with the same reset time. Resume it by hand once the limit has lifted.`);
      return;
    }
    const current = this.timers.get(task.id);
    if (current?.key === plan.key && current.fireAt === plan.fireAt) return;
    this.clear(task.id);
    this.arm(task.id, plan.key, plan.fireAt);
    this.announce(
      plan,
      'scheduled',
      `Resumes by itself at ${this.time(new Date(plan.fireAt).toISOString())}, ${Math.round(this.graceMs / 60_000)} minutes after ${name}'s usage limit resets (${this.time(plan.resetAt)}). Auto-resume is on in Tools → Policy.`,
    );
  }

  private arm(taskId: string, key: string, fireAt: number): void {
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, fireAt - this.clock.now()));
    const handle = this.clock.setTimer(() => void this.fire(taskId, key), delay);
    this.timers.set(taskId, { key, fireAt, handle });
  }

  private time(iso: string): string {
    return formatResetTime(iso, new Date(this.clock.now()));
  }

  /**
   * One timeline event per phase, reset and limit hit: a restart re-arms
   * without saying it twice, and a resume that did not go through has already
   * said the task waits for you.
   */
  private announce(plan: ResetPlan, phase: AutoResumePhase, message: string): void {
    const data = { phase, key: plan.key, agentId: plan.agentId, resetAt: plan.resetAt, executionId: plan.executionId };
    if (phase === 'scheduled' || phase === 'manual') {
      const covers: AutoResumePhase[] = phase === 'manual' ? ['manual', 'not_resumed'] : ['scheduled'];
      const said = this.d.store
        .eventsOfType(plan.taskId, ['USAGE_AUTO_RESUME'], 2000)
        .some((e) => covers.includes(e.data?.phase as AutoResumePhase) && e.data?.key === plan.key && e.data?.executionId === plan.executionId);
      if (said) return;
    }
    this.d.event(plan.taskId, 'USAGE_AUTO_RESUME', message, data);
  }

  private async fire(taskId: string, key: string): Promise<void> {
    if (this.timers.get(taskId)?.key === key) this.timers.delete(taskId);
    if (!this.live) {
      this.held.set(taskId, key);
      return;
    }
    if (this.firing.has(taskId)) return;
    this.firing.add(taskId);
    let replan = false;
    try {
      const task = this.d.store.getTask(taskId);
      const plan = task && this.enabled() ? this.planFor(task) : null;
      if (!task || !plan) {
        replan = Boolean(task);
      } else if (plan.key !== key || plan.fireAt === null || plan.fireAt > this.clock.now() || this.d.used(taskId, key)) {
        // A newer limit hit moved the reset, it was already used, or a capped timer woke early: plan again instead.
        replan = true;
      } else {
        const name = this.d.agentName(plan.agentId);
        const action = await this.d.resume(taskId, key, task.version);
        if (action.status === 'completed') this.announce(plan, 'resumed', `Resumed by itself: ${name}'s usage limit reset at ${this.time(plan.resetAt!)}.`);
        else this.announce(plan, 'not_resumed', `Did not resume by itself after ${name}'s reset at ${this.time(plan.resetAt!)}: ${action.reason ?? action.status}. Resume it by hand.`);
      }
    } catch (error) {
      console.warn(`[usage] auto-resume of ${taskId} failed: ${(error as Error).message}`);
    } finally {
      this.firing.delete(taskId);
    }
    if (replan) this.replanTask(taskId);
  }
}
