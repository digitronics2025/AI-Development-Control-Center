import { CheckCircle2, ChevronRight, Circle, CircleMinus, FlaskConical, Loader2, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Banner, EmptyState, LogViewer, Skeleton, cn, formatDuration, useFeedback } from '@acc/ui';
import { COMMAND_KIND_LABEL, type CommandKind, type TaskDetail, type TestRun } from '@acc/shared';
import { useExecutionLogs, useTaskDirectives, useTaskTests } from '../../api/hooks';

/** A failure the baseline commit already had is shown apart from the task's own (AUTOPILOT_GATES_PLAN §3.B). */
const preexisting = (run: TestRun) => run.status === 'failed' && run.classification === 'preexisting';

function RunIcon({ run }: { run: TestRun }) {
  const { status } = run;
  if (status === 'passed') return <CheckCircle2 size={16} className="text-success" aria-hidden />;
  if (preexisting(run)) return <CircleMinus size={16} className="text-warning" aria-hidden />;
  if (status === 'failed') return <XCircle size={16} className="text-danger" aria-hidden />;
  if (status === 'running') return <Loader2 size={16} className="animate-spin text-accent" aria-hidden />;
  return <Circle size={16} className="text-fg-tertiary" aria-hidden />;
}

const STATUS_TEXT: Record<TestRun['status'], string> = { passed: 'passed', failed: 'failed', running: 'running', not_run: 'not run', blocked: 'blocked' };

function RunOutput({ executionId }: { executionId: string }) {
  const logs = useExecutionLogs(executionId);
  const { toast } = useFeedback();
  if (logs.isLoading) return <Skeleton className="h-40" />;
  return <LogViewer lines={logs.data ?? []} height={320} ariaLabel="Command output" onCopy={() => toast('Output copied')} />;
}

/** What a run's status means once the baseline and reuse are known. */
function statusText(run: TestRun): string {
  if (preexisting(run)) return 'failed · already failing before this task';
  if (run.status === 'failed' && run.classification === 'new') return 'failed · new since the baseline';
  return STATUS_TEXT[run.status];
}

/** The checks the operator waived for this task, with the directive that said so. */
function Waivers({ taskId }: { taskId: string }) {
  const directives = useTaskDirectives(taskId);
  const waivers = (directives.data ?? []).filter((d) => d.state === 'active' && d.rule?.type === 'waive_check');
  if (!waivers.length) return null;
  return (
    <Banner tone="info" title="Not gating this task on some checks">
      <ul className="flex flex-col gap-1">
        {waivers.map((d) => (
          <li key={d.id}>
            {((d.rule as { kinds: CommandKind[] }).kinds).map((k) => COMMAND_KIND_LABEL[k]).join(', ')} — waived by your directive: “{d.text}”
          </li>
        ))}
      </ul>
    </Banner>
  );
}

/**
 * Tests tab (design.md §7.3): each command is a run item — ✓ lint 8.2s —
 * and selecting a row reveals its output. Runs are grouped per test stage.
 * A failure the baseline already had, a pass reused from identical files and
 * a waived check each say so.
 */
export function TestsTab({ task }: { task: TaskDetail }) {
  const tests = useTaskTests(task.id);
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const byStage = new Map<string, TestRun[]>();
    for (const run of tests.data ?? []) {
      const key = run.stageId ?? 'none';
      byStage.set(key, [...(byStage.get(key) ?? []), run]);
    }
    return [...byStage.entries()]
      .map(([stageId, runs]) => ({ stage: task.stages.find((s) => s.id === stageId) ?? null, runs }))
      .reverse();
  }, [tests.data, task.stages]);

  if (tests.isLoading) return <Skeleton className="h-48" />;
  if (!groups.length) {
    return (
      <div className="flex flex-col gap-5">
        <Waivers taskId={task.id} />
        <EmptyState icon={FlaskConical} title="No test runs yet" description="The repository's lint, typecheck, test and build commands run after implementation. An agent saying “done” is not proof — these results are." />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <Waivers taskId={task.id} />
      {groups.map(({ stage, runs }, index) => {
        const old = runs.filter(preexisting).length;
        const failed = runs.filter((r) => r.status === 'failed').length - old;
        const passed = runs.filter((r) => r.status === 'passed').length;
        return (
          <section key={stage?.id ?? index} aria-label={`${stage?.name ?? 'Test'} run ${groups.length - index}`} className="flex flex-col gap-2">
            <h3 className="flex flex-wrap items-baseline gap-2 text-h3 text-fg">
              {stage?.name ?? 'Commands'} · run {groups.length - index}
              <span className="text-small font-normal text-fg-secondary">
                {passed} passed · {failed} failed{old ? ` · ${old} already failing before this task` : ''}{stage?.cycle ? ` · fix cycle ${stage.cycle}` : ''}
                {index === 0 ? ' · latest' : ''}
              </span>
            </h3>
            <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
              {runs.map((run) => {
                const expanded = open === run.id;
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      disabled={!run.executionId}
                      onClick={() => setOpen(expanded ? null : run.id)}
                      className="grid w-full grid-cols-[16px_16px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-left hover:bg-elevated focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <ChevronRight size={16} aria-hidden className={cn('text-fg-secondary transition-transform duration-[120ms]', expanded && 'rotate-90', !run.executionId && 'invisible')} />
                      <RunIcon run={run} />
                      <span className="flex min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-mono text-code text-fg">
                            {run.name} <span className="font-sans text-small text-fg-secondary">· {COMMAND_KIND_LABEL[run.kind]} · {statusText(run)}</span>
                          </span>
                          {run.reusedFrom ? <Badge title="Nothing changed since this command last passed in this task, so it was not run again">reused</Badge> : null}
                          {preexisting(run) ? <Badge title="The same tests fail on the commit this task started from: recorded and reported, not blocking">pre-existing</Badge> : null}
                        </span>
                        {run.summary ? <span className="truncate text-small text-fg">{run.summary}</span> : null}
                        {run.status === 'failed' && run.failures?.length ? (
                          <span className="truncate text-small text-fg-secondary">
                            {run.failures.length} failing test{run.failures.length === 1 ? '' : 's'}: {run.failures.slice(0, 3).join(' · ')}
                            {run.failures.length > 3 ? ` · +${run.failures.length - 3} more` : ''}
                          </span>
                        ) : null}
                        <span className="truncate font-mono text-small text-fg-secondary">{run.command}</span>
                      </span>
                      <span className="tabular text-small text-fg-secondary">{run.durationMs !== null ? formatDuration(run.durationMs) : run.status === 'not_run' ? 'not run' : '—'}</span>
                    </button>
                    {expanded && run.executionId ? (
                      <div className="px-4 pb-4">
                        <RunOutput executionId={run.executionId} />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
