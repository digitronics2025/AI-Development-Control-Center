import { randomUUID } from 'node:crypto';
import type { CapacityObservation } from '@acc/agent-sdk';
import type { CapacityReading, CapacitySnapshot } from '@acc/shared';
import type { Db } from '../db/database.js';

type Row = Record<string, any>;

/** A reading older than this is shown as stale (its value is kept, never replaced by zero). */
export const CAPACITY_STALE_MS = 30 * 60 * 1000;
/** Superseded readings older than this are pruned; the latest reading per metric is always kept. */
const RETENTION_MS = 90 * 24 * 3_600_000;

function toSnapshot(r: Row): CapacitySnapshot {
  return {
    id: r.id,
    provider: r.provider,
    agentId: r.agent_id,
    metric: r.metric,
    label: r.label,
    usedPercent: r.used_percent,
    remainingPercent: r.remaining_percent,
    status: r.status,
    resetAt: r.reset_at,
    source: r.source,
    confidence: r.confidence,
    capturedAt: r.captured_at,
    detail: r.detail,
  };
}

/** Judge a stored reading's freshness at `now`. */
export function toReading(snapshot: CapacitySnapshot, now = Date.now()): CapacityReading {
  const age = now - new Date(snapshot.capturedAt).getTime();
  const reset = snapshot.resetAt ? new Date(snapshot.resetAt).getTime() : null;
  if (reset !== null && reset <= now) {
    return { ...snapshot, stale: true, staleReason: 'The window has reset since this reading; the next run will report the new value.' };
  }
  if (age > CAPACITY_STALE_MS) {
    return { ...snapshot, stale: true, staleReason: `Last reported ${Math.round(age / 60_000)} minutes ago; readings arrive with each agent run.` };
  }
  return { ...snapshot, stale: false, staleReason: null };
}

/**
 * Capacity readings (docs/systems/usage.md#capacity). They arrive with agent
 * runs — the provider CLIs expose no separate limits endpoint — so they are
 * stored as snapshots with their source and time, and the latest per metric
 * is shown with its freshness.
 */
export class CapacityStore {
  private readonly listeners = new Set<(agentId: string) => void>();

  /** `now` judges freshness (an injectable clock for tests of the reset scheduler). */
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Called after every recorded reading (the reset scheduler re-plans from it). A listener's error never fails the write. */
  onRecord(listener: (agentId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(provider: string, agentId: string, eventId: string | null, source: string, observations: CapacityObservation[]): void {
    const insert = this.db.prepare(
      `INSERT INTO capacity_snapshots (id, provider, agent_id, metric, label, used_percent, remaining_percent, status, reset_at, source, confidence, captured_at, detail, event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const o of observations) {
        const remaining = o.usedPercent === null ? null : Math.max(0, Math.round((100 - o.usedPercent) * 10) / 10);
        insert.run(randomUUID(), provider, agentId, o.metric, o.label, o.usedPercent, remaining, o.status, o.resetsAt, source, 'LIVE', o.observedAt, o.detail, eventId);
      }
    })();
    for (const listener of this.listeners) {
      try {
        listener(agentId);
      } catch (error) {
        console.warn(`[usage] after a capacity reading: ${(error as Error).message}`);
      }
    }
  }

  /** Latest snapshot per agent and metric. */
  latest(): CapacitySnapshot[] {
    return (
      this.db
        .prepare(
          `SELECT s.* FROM capacity_snapshots s
           JOIN (SELECT agent_id, metric, MAX(captured_at) AS at FROM capacity_snapshots GROUP BY agent_id, metric) m
             ON m.agent_id = s.agent_id AND m.metric = s.metric AND m.at = s.captured_at
           ORDER BY s.provider, s.agent_id, s.metric`,
        )
        .all() as Row[]
    ).map(toSnapshot);
  }

  /**
   * One agent's latest snapshot per metric as it stood at `at` (an ISO time):
   * what a run that ended then was judged on. The readings recorded from that
   * run itself (its usage event is keyed by `executionId`) count whatever time
   * they carry; readings of later runs never do, so they cannot hide the reset
   * a blocked task waits for (docs/systems/usage.md#auto-resume-at-reset).
   */
  asOf(agentId: string, at: string, executionId: string): CapacitySnapshot[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM (
             SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.metric ORDER BY s.captured_at DESC) AS n FROM capacity_snapshots s
             WHERE s.agent_id = ? AND (s.captured_at <= ? OR s.event_id IN (SELECT id FROM usage_events WHERE idempotency_key = ?))
           ) WHERE n = 1 ORDER BY metric`,
        )
        .all(agentId, at, executionId) as Row[]
    ).map(toSnapshot);
  }

  readings(now = this.now()): CapacityReading[] {
    return this.latest().map((s) => toReading(s, now));
  }

  history(agentId: string, metric: string, limit = 50): CapacitySnapshot[] {
    return (this.db.prepare('SELECT * FROM capacity_snapshots WHERE agent_id = ? AND metric = ? ORDER BY captured_at DESC LIMIT ?').all(agentId, metric, limit) as Row[]).map(toSnapshot);
  }

  /** Drop superseded readings past retention. Usage events are never pruned. */
  prune(now = Date.now()): number {
    const cutoff = new Date(now - RETENTION_MS).toISOString();
    return this.db
      .prepare(
        `DELETE FROM capacity_snapshots WHERE captured_at < ? AND id NOT IN (
           SELECT s.id FROM capacity_snapshots s
           JOIN (SELECT agent_id, metric, MAX(captured_at) AS at FROM capacity_snapshots GROUP BY agent_id, metric) m
             ON m.agent_id = s.agent_id AND m.metric = s.metric AND m.at = s.captured_at)`,
      )
      .run(cutoff).changes;
  }
}
