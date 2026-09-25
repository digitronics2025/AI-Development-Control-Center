import type { StageInstance, TaskEvent, TimeBreakdown } from '@acc/shared';
import type { Store, TaskRecord } from '../store/store.js';
import { taskRepositories } from './task-repositories.js';

/**
 * Where a task's time went (docs/plans/LEAD_TIME_PLAN.md §3.3), computed on
 * demand from what the database already records: stage instances, task events
 * and executions. Every millisecond from creation to the end goes to exactly
 * one bucket, in this order of precedence: a stage, parked for the operator,
 * queued, and whatever is left (overhead between stages). So the buckets
 * always add up to the total, and nothing unexplained hides in another bucket.
 */

type Bucket = keyof NonNullable<TimeBreakdown['buckets']>;

export interface TimeInput {
  createdAt: string;
  /** The task's end, or now for a task that has not finished. */
  endAt: string;
  finished: boolean;
  stages: Array<Pick<StageInstance, 'id' | 'kind' | 'startedAt' | 'finishedAt'>>;
  events: Array<Pick<TaskEvent, 'type' | 'at' | 'data' | 'stageId'>>;
  /** Executions that compared a failure with the baseline commit. */
  baselineRuns: Array<{ startedAt: string; finishedAt: string | null }>;
  /** Agents' `[tool] Bash …` log lines. */
  agentBashLines: string[];
  /** The repositories' configured test and e2e commands. */
  suiteCommands: string[];
}

const PARK_START = new Set(['TASK_WAITING', 'APPROVAL_REQUESTED', 'TASK_FAILED', 'TASK_INTERRUPTED']);
const PARK_END = new Set(['TASK_RESUMED', 'APPROVAL_RESOLVED', 'STAGE_RETRY', 'TASK_COMPLETED', 'TASK_CANCELLED']);
const CHECK_KINDS = new Set(['tests', 'command', 'verify', 'git']);

interface Span {
  start: number;
  end: number;
  bucket: Bucket;
  rank: number;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How many Bash calls ran one of `commands` in full: the command alone, or
 * with only its output redirected. `npm test -- a.test.ts` is a targeted run
 * and does not count.
 */
export function countSuiteRuns(bashLines: string[], commands: string[]): number {
  const patterns = [...new Set(commands.map((c) => c.trim()).filter(Boolean))].map((c) => new RegExp(`^${escapeRegExp(c)}(?:\\s*$|\\s+\\d?>)`));
  if (!patterns.length) return 0;
  let runs = 0;
  for (const line of bashLines) {
    const m = /^\[tool\] Bash\s+(.*)$/s.exec(line);
    if (!m) continue;
    const segments = m[1]!.split(/&&|\|\||;|\|/).map((s) => s.trim());
    if (segments.some((s) => patterns.some((p) => p.test(s)))) runs++;
  }
  return runs;
}

export function timeBreakdown(input: TimeInput): TimeBreakdown {
  const start = ms(input.createdAt);
  const end = ms(input.endAt);
  const agentSuiteRuns = countSuiteRuns(input.agentBashLines, input.suiteCommands);
  const empty = (reason: string): TimeBreakdown => ({ totalMs: start !== null && end !== null ? Math.max(0, end - start) : 0, finished: input.finished, buckets: null, baselineMs: 0, agentSuiteRuns, reason });
  if (start === null || end === null || end < start) return empty('the task has no usable start or end time');

  const clip = (a: number, b: number) => [Math.max(start, a), Math.min(end, b)] as const;
  const spans: Span[] = [];
  const add = (a: number | null, b: number | null, bucket: Bucket, rank: number) => {
    if (a === null || b === null) return;
    const [s, e] = clip(a, b);
    if (e > s) spans.push({ start: s, end: e, bucket, rank });
  };

  // Rework starts at the first failure that sent the task back: a failed test stage that was not
  // entirely pre-existing, or a failed review.
  const testStages = new Set(input.stages.filter((s) => s.kind === 'tests').map((s) => s.id));
  const firstFailure = input.events.find(
    (e) => (e.type === 'TEST_FAILED' && e.stageId !== null && testStages.has(e.stageId) && e.data?.classification !== 'preexisting' && e.data?.classification !== 'flaky') || e.type === 'REVIEW_FAILED',
  );
  const reworkFrom = ms(firstFailure?.at);

  for (const stage of input.stages) {
    const a = ms(stage.startedAt);
    if (a === null) continue;
    // A stage still running is measured up to the end.
    const b = ms(stage.finishedAt) ?? end;
    if (stage.kind === 'agent') add(a, b, reworkFrom !== null && a > reworkFrom ? 'agentRework' : 'agentFirstPass', 3);
    else if (stage.kind === 'release') add(a, b, 'release', 3);
    else if (CHECK_KINDS.has(stage.kind)) add(a, b, 'checks', 3);
  }

  let parkedSince: number | null = null;
  for (const e of input.events) {
    const at = ms(e.at);
    if (at === null) continue;
    if (parkedSince === null && PARK_START.has(e.type)) parkedSince = at;
    else if (parkedSince !== null && PARK_END.has(e.type)) {
      add(parkedSince, at, 'parked', 2);
      parkedSince = null;
    }
  }
  if (parkedSince !== null) add(parkedSince, end, 'parked', 2);

  const firstStart = input.events.find((e) => e.type === 'TASK_STARTED');
  add(start, ms(firstStart?.at) ?? end, 'queued', 1);

  const buckets: Record<Bucket, number> = { queued: 0, agentFirstPass: 0, agentRework: 0, checks: 0, release: 0, parked: 0, overhead: 0 };
  const points = [...new Set([start, end, ...spans.flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    let best: Span | null = null;
    for (const s of spans) if (s.start <= a && s.end >= b && (!best || s.rank > best.rank)) best = s;
    buckets[best ? best.bucket : 'overhead'] += b - a;
  }

  let baselineMs = 0;
  for (const run of input.baselineRuns) {
    const a = ms(run.startedAt);
    const b = ms(run.finishedAt) ?? end;
    if (a === null) continue;
    const [s, e] = clip(a, b);
    if (e > s) baselineMs += e - s;
  }
  return { totalMs: end - start, finished: input.finished, buckets, baselineMs, agentSuiteRuns };
}

/** Gather one task's records and divide its time. Never throws: an error gives `buckets: null` with the reason. */
export function taskTimeBreakdown(store: Store, task: TaskRecord, at: string = new Date().toISOString()): TimeBreakdown {
  try {
    const events: TaskEvent[] = [];
    for (let after = 0; ; ) {
      const page = store.listEvents(task.id, { after, limit: 2000 });
      events.push(...page);
      if (page.length < 2000) break;
      after = page[page.length - 1]!.id;
    }
    const executions = store.listExecutions(task.id);
    const agentBashLines = executions
      .filter((e) => e.kind === 'agent')
      .flatMap((e) => store.listLogLines(e.id, { search: '[tool] Bash ', limit: 5000 }).map((l) => l.text));
    const suiteCommands = taskRepositories(store, task).flatMap((u) => u.repo.commands.filter((c) => c.enabled && (c.kind === 'test' || c.kind === 'e2e')).map((c) => c.command));
    return timeBreakdown({
      createdAt: task.createdAt,
      endAt: task.finishedAt ?? at,
      finished: Boolean(task.finishedAt),
      stages: store.listStages(task.id),
      events,
      baselineRuns: executions.filter((e) => e.kind === 'command' && e.command.startsWith('baseline ')).map((e) => ({ startedAt: e.startedAt, finishedAt: e.finishedAt })),
      agentBashLines,
      suiteCommands,
    });
  } catch (error) {
    return { totalMs: 0, finished: Boolean(task.finishedAt), buckets: null, baselineMs: 0, agentSuiteRuns: 0, reason: (error as Error).message.slice(0, 200) };
  }
}

const min = (value: number) => `${(value / 60_000).toFixed(1)} min`;

/** The report's **Where the time went** lines. */
export function timeBreakdownLines(b: TimeBreakdown): string[] {
  if (!b.buckets) return [`Not enough data${b.reason ? `: ${b.reason}` : ''}.`];
  const k = b.buckets;
  return [
    `- Total: ${min(b.totalMs)}${b.finished ? '' : ' so far'}`,
    `- Waiting to start: ${min(k.queued)}`,
    `- Agents, first pass: ${min(k.agentFirstPass)}`,
    `- Agents, rework after a failure: ${min(k.agentRework)}`,
    `- Checks: ${min(k.checks)}${b.baselineMs ? ` (of which comparing failures with the baseline: ${min(b.baselineMs)})` : ''}`,
    ...(k.release ? [`- Release: ${min(k.release)}`] : []),
    `- Waiting for you: ${min(k.parked)}`,
    `- Between stages (worktree, installs, the Chairman): ${min(k.overhead)}`,
    ...(b.agentSuiteRuns ? [`- Agents ran a configured test suite in full themselves ${b.agentSuiteRuns} time${b.agentSuiteRuns === 1 ? '' : 's'}`] : []),
  ];
}
