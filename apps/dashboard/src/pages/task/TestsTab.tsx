import { CheckCircle2, ChevronRight, Circle, FlaskConical, Loader2, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState, LogViewer, Skeleton, cn, formatDuration, useFeedback } from '@acc/ui';
import { COMMAND_KIND_LABEL, type TaskDetail, type TestRun } from '@acc/shared';
import { useExecutionLogs, useTaskTests } from '../../api/hooks';

function RunIcon({ status }: { status: TestRun['status'] }) {
  if (status === 'passed') return <CheckCircle2 size={16} className="text-success" aria-hidden />;
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

/**
 * Tests tab (design.md §7.3): each command is a run item — ✓ lint 8.2s —
 * and selecting a row reveals its output. Runs are grouped per test stage.
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
    return <EmptyState icon={FlaskConical} title="No test runs yet" description="The repository's lint, typecheck, test and build commands run after implementation. An agent saying “done” is not proof — these results are." />;
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map(({ stage, runs }, index) => {
        const failed = runs.filter((r) => r.status === 'failed').length;
        const passed = runs.filter((r) => r.status === 'passed').length;
        return (
          <section key={stage?.id ?? index} aria-label={`${stage?.name ?? 'Test'} run ${groups.length - index}`} className="flex flex-col gap-2">
            <h3 className="flex flex-wrap items-baseline gap-2 text-h3 text-fg">
              {stage?.name ?? 'Commands'} · run {groups.length - index}
              <span className="text-small font-normal text-fg-secondary">
                {passed} passed · {failed} failed{stage?.cycle ? ` · fix cycle ${stage.cycle}` : ''}
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
                      <RunIcon status={run.status} />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-mono text-code text-fg">
                          {run.name} <span className="font-sans text-small text-fg-secondary">· {COMMAND_KIND_LABEL[run.kind]} · {STATUS_TEXT[run.status]}</span>
                        </span>
                        {run.summary && run.status === 'failed' ? <span className="truncate text-small text-fg">{run.summary}</span> : null}
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
