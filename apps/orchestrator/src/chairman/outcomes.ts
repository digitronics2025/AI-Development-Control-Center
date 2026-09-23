import type { ChairmanHealth, ChairmanStrategyOutcomeStatus, ChairmanStrategyRun } from '@acc/shared';
import type { Store } from '../store/store.js';
import type { FailureSource } from './signatures.js';
import type { ChairmanStore } from './store.js';

/**
 * Strategy outcomes (docs/systems/chairman.md §Strategy outcomes). After a
 * recovery strategy starts, the next *comparable* objective observation —
 * the same kind of check passing or failing again — decides what the
 * strategy achieved. Deterministic: it reads only what the orchestrator
 * recorded (stage results and failure signatures), never the model's
 * `expectedResult`, and absence of evidence is never a failure.
 */

export type FinalOutcome = Exclude<ChairmanStrategyOutcomeStatus, 'RUNNING'>;

export interface OutcomeVerdict {
  status: FinalOutcome;
  summary: string;
  healthAfter: ChairmanHealth | null;
}

/** One recorded result after the strategy started, oldest first. */
export type Observation =
  | { kind: 'passed'; source: FailureSource; stageKey: string }
  | { kind: 'failed'; source: FailureSource; stageKey: string; hash: string; failureCount: number | null };

const PASSED: Record<FailureSource, string> = {
  tests: 'The checks pass after this strategy.',
  review: 'Review passed after this strategy.',
  verify: 'Verification passed after this strategy.',
  worker: 'The stage ran successfully after this strategy.',
  gate: 'The completion check is met.',
};

const COUNTED: Record<FailureSource, string> = {
  tests: 'Failing tests',
  review: 'Review issues',
  verify: 'Verification issues',
  worker: 'Failures',
  gate: 'Unmet checks',
};

function comparable(run: ChairmanStrategyRun, o: Observation): boolean {
  if (o.source !== run.failureSource) return false;
  // An agent failure is about one stage; any other stage's run says nothing about it.
  return run.failureSource !== 'worker' || o.stageKey === run.failureStageKey;
}

/** The verdict from the first comparable observation, or null while there is none yet. */
export function evaluateStrategy(run: ChairmanStrategyRun, observations: Observation[]): OutcomeVerdict | null {
  const o = observations.find((x) => comparable(run, x));
  if (!o) return null;
  if (o.kind === 'passed') return { status: 'SUCCEEDED', summary: PASSED[run.failureSource as FailureSource] ?? 'The failure no longer occurs.', healthAfter: 'PROGRESSING' };
  const label = COUNTED[run.failureSource as FailureSource] ?? 'Failures';
  if (run.failureCount !== null && o.failureCount !== null) {
    if (o.failureCount < run.failureCount) return { status: 'IMPROVED', summary: `${label} went from ${run.failureCount} to ${o.failureCount}.`, healthAfter: 'PROGRESSING' };
    if (o.failureCount > run.failureCount) return { status: 'REGRESSED', summary: `${label} went from ${run.failureCount} to ${o.failureCount}.`, healthAfter: 'REGRESSING' };
  }
  if (o.hash === run.failureHash) return { status: 'FAILED', summary: 'The same failure remains after this strategy.', healthAfter: 'STALLED' };
  return { status: 'INCONCLUSIVE', summary: 'A different failure appeared; there is no comparable improvement to measure.', healthAfter: null };
}

export type FinishStrategy = (decisionId: string, status: FinalOutcome, summary: string, healthAfter: ChairmanHealth | null) => unknown;

export class OutcomeEvaluator {
  constructor(
    private readonly store: Store,
    private readonly chairman: ChairmanStore,
    private readonly finish: FinishStrategy,
  ) {}

  /**
   * Evaluate every open strategy of a task against what was recorded since
   * it started. Safe to call from any hook, any number of times, and after a
   * restart: a finished strategy is never evaluated again.
   */
  reconcile(taskId: string): void {
    const open = this.chairman.openStrategyRuns(taskId).filter((r) => r.failureSource !== 'gate');
    if (!open.length) return;
    const stages = this.store.listStages(taskId);
    const failures = new Map(this.chairman.listFailures(taskId).filter((f) => f.stageId).map((f) => [f.stageId!, f]));
    for (const run of open) {
      const verdict = evaluateStrategy(run, observationsSince(run.startedAt, stages, failures));
      if (verdict) this.finish(run.decisionId, verdict.status, verdict.summary, verdict.healthAfter);
    }
  }

  /** The completion gate is the comparable observation for its own remedies — and success for everything. */
  completionGate(taskId: string, result: { pass: boolean; failureHashes: string[] }): void {
    for (const run of this.chairman.openStrategyRuns(taskId)) {
      if (result.pass) this.finish(run.decisionId, 'SUCCEEDED', 'The task passed its completion checks.', 'PROGRESSING');
      else if (run.failureSource !== 'gate') continue;
      else if (result.failureHashes.includes(run.failureHash)) this.finish(run.decisionId, 'FAILED', 'The completion check is still not met.', 'STALLED');
      else this.finish(run.decisionId, 'SUCCEEDED', PASSED.gate, 'PROGRESSING');
    }
  }

  /** Close what is still open with a non-engineering outcome (new goal, cancellation, a newer strategy). */
  close(taskId: string, status: 'SUPERSEDED' | 'INCONCLUSIVE', summary: string, filter: (run: ChairmanStrategyRun) => boolean = () => true): void {
    for (const run of this.chairman.openStrategyRuns(taskId)) if (filter(run)) this.finish(run.decisionId, status, summary, null);
  }
}

interface StageLike {
  id: string;
  stageKey: string;
  kind: string;
  role: string;
  status: string;
  verdict: 'PASS' | 'FAIL' | null;
  createdAt: string;
}

/** Stage results since `since`, in order, as comparable observations. */
export function observationsSince(since: string, stages: StageLike[], failures: Map<string, { source: FailureSource; stageKey: string; hash: string; failureCount: number | null }>): Observation[] {
  const out: Observation[] = [];
  for (const s of stages) {
    if (s.createdAt < since) continue;
    const failure = failures.get(s.id);
    if (failure) {
      out.push({ kind: 'failed', source: failure.source, stageKey: failure.stageKey, hash: failure.hash, failureCount: failure.failureCount });
      continue;
    }
    if (s.status !== 'SUCCESS') continue;
    if (s.kind === 'tests') out.push({ kind: 'passed', source: 'tests', stageKey: s.stageKey });
    else if (s.verdict === 'PASS') out.push({ kind: 'passed', source: s.role === 'verifier' ? 'verify' : 'review', stageKey: s.stageKey });
    if (s.kind === 'agent') out.push({ kind: 'passed', source: 'worker', stageKey: s.stageKey });
  }
  return out;
}
