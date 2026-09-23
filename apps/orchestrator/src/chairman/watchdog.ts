import type { TaskEngine } from '../engine/engine.js';
import type { TaskViews } from '../engine/views.js';
import type { SettingsService } from '../services/settings.js';
import type { Store } from '../store/store.js';
import type { Chairman } from './chairman.js';

/** Grace beyond a stage's own timeout before the watchdog steps in. */
const TIMEOUT_GRACE_MS = 120_000;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Watchdog (plan §16). Periodically reconciles the database with the
 * processes actually running:
 *  - a task marked RUNNING with no loop behind it is a ghost → interrupted,
 *    and resumed by the Chairman when supervised;
 *  - for supervised tasks, a worker whose process is gone, that ran well past
 *    its stage timeout, or that has been silent too long is stopped, and the
 *    stage fails into normal recovery.
 */
export class Watchdog {
  private timer: NodeJS.Timeout | null = null;
  private readonly deadStrikes = new Map<string, number>();
  private ticking = false;

  constructor(
    private readonly engine: TaskEngine,
    private readonly store: Store,
    private readonly views: TaskViews,
    private readonly settings: SettingsService,
    private readonly chairman: Chairman,
    private readonly isAlive: (pid: number) => boolean = processAlive,
  ) {}

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(nowMs = Date.now()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const actions: string[] = [];
    try {
      for (const task of this.store.listTasks({ statuses: ['RUNNING'], limit: 500 })) {
        if (this.engine.isRunning(task.id)) continue;
        const reason = 'Watchdog: the task was marked running but no worker was attached';
        if (this.engine.reconcileGhost(task.id, reason)) {
          actions.push(`${task.id}: ghost reconciled`);
          if (task.supervised) await this.chairman.resumeGhost(task.id, reason);
        }
      }

      const stallMs = this.settings.get().chairman.stallMinutes * 60_000;
      for (const { taskId } of this.engine.activeRuns()) {
        const task = this.store.getTask(taskId);
        if (!task?.supervised) continue;
        const exec = this.store.listExecutions(taskId).filter((e) => e.status === 'running').at(-1);
        if (!exec) continue;
        const def = this.views.stageDef(task, task.currentStageKey);
        const age = nowMs - new Date(exec.startedAt).getTime();
        let reason: string | null = null;
        if (exec.pid && !this.isAlive(exec.pid)) {
          const strikes = (this.deadStrikes.get(exec.id) ?? 0) + 1;
          this.deadStrikes.set(exec.id, strikes);
          // Two consecutive observations, so a process that is just exiting is not misread.
          if (strikes >= 2) reason = 'Watchdog: the worker process exited without reporting a result';
        } else {
          this.deadStrikes.delete(exec.id);
        }
        if (!reason && def && age > def.timeoutSec * 1000 + TIMEOUT_GRACE_MS) reason = `Watchdog: ${def.name} ran past its ${Math.round(def.timeoutSec / 60)}-minute timeout`;
        if (!reason && age > stallMs) {
          const last = this.chairman.store.lastLogAt(exec.id);
          const silentMs = nowMs - new Date(last ?? exec.startedAt).getTime();
          if (silentMs > stallMs) reason = `Watchdog: no output for ${Math.round(silentMs / 60_000)} minutes`;
        }
        if (reason && (await this.engine.watchdogStop(taskId, reason))) {
          this.deadStrikes.delete(exec.id);
          actions.push(`${taskId}: ${reason}`);
        }
      }
    } finally {
      this.ticking = false;
    }
    return actions;
  }
}
