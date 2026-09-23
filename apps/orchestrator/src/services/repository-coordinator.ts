/**
 * One coordinator per orchestrator for every registered repository
 * (docs/systems/source-control.md, "Coordination").
 *
 * Two kinds of work change a repository:
 *  - task stages that can edit files (permission level ≥ 2) — "writers";
 *  - Source Control mutations (stage, commit, fetch, sync…).
 *
 * Mutations run one at a time per repository. A writer waits for the
 * mutation in flight before it starts; a mutation that finds a writer active
 * is refused by its caller (it never waits minutes for an agent). Reads never
 * take part, so status, diffs and history stay available throughout.
 */
export interface ActiveWriter {
  taskId: string;
  stageName: string;
}

export class RepositoryCoordinator {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly running = new Map<string, string>();
  private readonly writers = new Map<string, Map<string, string>>();
  private readonly listeners = new Set<(repositoryId: string) => void>();

  /** Called whenever writers or mutations start or stop in a repository. */
  onChange(listener: (repositoryId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(repositoryId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(repositoryId);
      } catch {
        /* a listener must not break coordination */
      }
    }
  }

  activeWriters(repositoryId: string): ActiveWriter[] {
    return [...(this.writers.get(repositoryId) ?? new Map()).entries()].map(([taskId, stageName]) => ({ taskId, stageName }));
  }

  /** Kind of the Source Control mutation running now, or null. */
  runningMutation(repositoryId: string): string | null {
    return this.running.get(repositoryId) ?? null;
  }

  /**
   * Register a task stage that may edit files. Waits for any queued
   * Source Control mutation to finish first. Returns the release function.
   */
  async acquireWriter(repositoryId: string, taskId: string, stageName: string): Promise<() => void> {
    // Loop: a mutation queued while we waited must also finish before we start.
    for (let queue = this.queues.get(repositoryId); queue; queue = this.queues.get(repositoryId)) await queue;
    let map = this.writers.get(repositoryId);
    if (!map) this.writers.set(repositoryId, (map = new Map()));
    map.set(taskId, stageName);
    this.notify(repositoryId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.writers.get(repositoryId);
      current?.delete(taskId);
      if (current && current.size === 0) this.writers.delete(repositoryId);
      this.notify(repositoryId);
    };
  }

  /**
   * Run a Source Control mutation exclusively. While `fn` runs no writer can
   * start; `fn` itself must check `activeWriters` first and refuse when a
   * writer is already active.
   */
  async runMutation<T>(repositoryId: string, kind: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(repositoryId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.queues.set(repositoryId, tail);
    await previous;
    this.running.set(repositoryId, kind);
    this.notify(repositoryId);
    try {
      return await fn();
    } finally {
      this.running.delete(repositoryId);
      release();
      if (this.queues.get(repositoryId) === tail) this.queues.delete(repositoryId);
      this.notify(repositoryId);
    }
  }
}
