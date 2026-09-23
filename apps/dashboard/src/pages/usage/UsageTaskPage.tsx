import { ArrowLeft, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  Meter,
  PageHeader,
  Panel,
  Skeleton,
  StatTile,
  StatusChip,
  TaskStatusChip,
  ANOMALY_SEVERITY_VISUAL,
  BUDGET_STATE_VISUAL,
  durationBetween,
  formatDuration,
} from '@acc/ui';
import { TASK_STATUSES, formatRatio, formatTokens, formatUsd, type TaskStatus } from '@acc/shared';
import { useUsageTaskLedger } from '../../api/usage';
import { useBreadcrumb } from '../../app/breadcrumbs';
import { EventDrawer } from './EventDrawer';
import { eventColumns } from './EventsTab';
import { costWithGaps, unpricedNote } from './common';

/** design.md §7.10 — task ledger: where the tokens and money went, stage by stage. */
export function UsageTaskPage() {
  const { id = '' } = useParams();
  useBreadcrumb([{ label: 'Usage & Costs', to: '/usage?tab=tasks' }, { label: id }]);
  const ledger = useUsageTaskLedger(id);
  const [selected, setSelected] = useState<string | null>(null);
  const shell = 'flex flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8';
  if (ledger.isLoading) {
    return (
      <div className={shell}>
        <Skeleton className="h-12 w-80" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (!ledger.data) {
    return (
      <div className={shell}>
        <EmptyState icon={ListChecks} title="No usage for this task" description="The task does not exist, or no agent has run for it." action={<Link to="/usage?tab=tasks">Back to Usage & Costs</Link>} />
      </div>
    );
  }
  const { task, flow, events, anomalies, budgets, reconciliation } = ledger.data;
  const t = task.totals;
  const flowMax = Math.max(1, ...flow.map((f) => f.totals.costNanos));
  const status = (TASK_STATUSES as readonly string[]).includes(task.taskStatus ?? '') ? (task.taskStatus as TaskStatus) : null;
  return (
    <div className={shell}>
      <PageHeader
        eyebrow={
          <span className="font-mono">
            {task.taskId}
            {task.projectName ? ` · ${task.projectName}` : ''}
          </span>
        }
        title={task.taskTitle ?? task.taskId}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {status ? <TaskStatusChip status={status} size="compact" /> : null}
            <span>{task.workflowId ?? ''}</span>
            <span>· {formatDuration(durationBetween(task.firstAt, task.lastAt))} from first to last attempt</span>
          </span>
        }
        actions={
          <Button icon={ArrowLeft} onClick={() => history.back()}>
            Back
          </Button>
        }
      />
      {ledger.data.live ? (
        <Banner tone="info" title="This task is running" role="status">
          Figures update as each attempt finishes.
        </Banner>
      ) : null}
      {!reconciliation.matches ? (
        <Banner tone="danger" title="Totals do not reconcile" role="alert">
          The attempts add up to {formatUsd(reconciliation.eventTotalNanos)} but the stage flow to {formatUsd(reconciliation.flowTotalNanos)}. The ledger is the source of truth.
        </Banner>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Total cost" value={costWithGaps(t)} detail={unpricedNote(t) ?? `${t.providerCostRequests} provider · ${t.calculatedCostRequests} calculated`} />
        <StatTile label="Tokens" value={formatTokens(t.totalTokens)} detail={`${formatTokens(t.inputTokens)} in · ${formatTokens(t.outputTokens)} out · ${formatTokens(t.cacheReadTokens + t.cacheWriteTokens)} cache`} />
        <StatTile label="Attempts" value={String(t.requests)} detail={`${task.retries} retries or re-runs · ${t.failed} failed`} />
        <StatTile label="Spent on failures and retries" value={formatUsd(t.failedCostNanos + t.retryCostNanos)} detail={`failed ${formatUsd(t.failedCostNanos)} · retries ${formatUsd(t.retryCostNanos)}`} />
        <StatTile label="Agent time" value={formatDuration(t.durationMs)} detail={task.models.join(', ')} />
      </div>
      <Panel title="Cost flow" description="Each stage run in order, with its share of the task's known cost">
        {flow.length ? (
          <ol className="flex flex-col gap-3">
            {flow.map((f, i) => (
              <li key={`${f.runId ?? f.stageKey}-${i}`} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-body">
                  <span className="min-w-0 text-fg">
                    <span className="font-semibold">{f.stageName}</span>
                    <span className="text-small text-fg-secondary">
                      {' '}
                      · {f.agentId ?? '—'} · {f.models.join(', ')}
                      {f.attempts > 1 ? ` · ${f.attempts} attempts` : ''}
                    </span>
                  </span>
                  <span className="tabular text-fg">
                    {costWithGaps(f.totals)}
                    <span className="text-small text-fg-secondary"> · {formatTokens(f.totals.totalTokens)} tokens</span>
                  </span>
                </div>
                <Meter ratio={f.totals.costNanos / flowMax} share />
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-body text-fg-secondary">No agent has run for this task yet.</p>
        )}
      </Panel>
      {anomalies.length || budgets.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {anomalies.length ? (
            <Panel title="Waste & anomalies">
              <ul className="flex flex-col divide-y divide-border-subtle">
                {anomalies.map((a) => (
                  <li key={a.id} className="flex flex-col gap-1 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip visual={ANOMALY_SEVERITY_VISUAL[a.severity]} size="compact" />
                      <span className="text-body font-semibold text-fg">{a.title}</span>
                    </div>
                    <p className="text-small text-fg-secondary">{a.explanation}</p>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          {budgets.length ? (
            <Panel title="Budgets that apply">
              <ul className="flex flex-col gap-3">
                {budgets.map((b) => (
                  <li key={b.id} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-body">
                      <span className="text-fg">{b.scopeLabel}</span>
                      <StatusChip visual={BUDGET_STATE_VISUAL[b.state]} size="compact" />
                    </div>
                    <Meter ratio={b.usedRatio} warning={b.warningThreshold} critical={b.criticalThreshold} />
                    <span className="tabular text-small text-fg-secondary">
                      {formatUsd(b.spentNanos)} of {formatUsd(b.amountNanos)} ({formatRatio(b.usedRatio)}) · {formatUsd(b.remainingNanos)} left
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      ) : null}
      <section className="flex flex-col gap-2">
        <h2 className="text-h2 text-fg">Attempts</h2>
        <DataTable caption="Attempts of this task" columns={eventColumns(setSelected)} rows={[...events].reverse()} rowKey={(e) => e.id} onRowClick={(e) => setSelected(e.id)} empty={<p className="text-body text-fg-secondary">No attempts recorded.</p>} />
      </section>
      <EventDrawer eventId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
