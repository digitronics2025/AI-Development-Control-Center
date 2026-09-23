import { useState } from 'react';
import { DataTable, EmptyState, SegmentedControl, Select, Skeleton, formatDuration, type Column } from '@acc/ui';
import { formatRatio, formatUsd, type UsageBreakdownRow } from '@acc/shared';
import { useWorkflows } from '../../api/hooks';
import { useUsageBreakdown } from '../../api/usage';
import { PricingPanel } from './PricingPanel';
import { providerLabel } from './ProvidersTab';
import { Tokens, costWithGaps, unpricedNote, type UsageState } from './common';

function columns(dimension: 'model' | 'role' | 'agent'): Column<UsageBreakdownRow>[] {
  const name = dimension === 'model' ? 'Model' : dimension === 'role' ? 'Role' : 'Agent';
  return [
    {
      key: 'name',
      header: name,
      primary: true,
      sortValue: (r) => r.label.toLowerCase(),
      cell: (r) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-fg">{r.label}</span>
          {r.extra?.provider ? <span className="text-small text-fg-secondary">{providerLabel(String(r.extra.provider))}</span> : null}
        </div>
      ),
    },
    { key: 'attempts', header: 'Attempts', align: 'right', sortValue: (r) => r.totals.requests, cell: (r) => <span className="tabular">{r.totals.requests}</span> },
    { key: 'tasks', header: 'Tasks', align: 'right', sortValue: (r) => r.tasks, cell: (r) => <span className="tabular">{r.tasks}</span> },
    {
      key: 'outcome',
      header: 'OK · failed',
      align: 'right',
      sortValue: (r) => r.failureRate ?? 0,
      cell: (r) => (
        <span className="tabular">
          {r.totals.succeeded} · {r.totals.failed}
        </span>
      ),
    },
    {
      key: 'tokens',
      header: 'Tokens (in · out · cache)',
      align: 'right',
      sortValue: (r) => r.totals.totalTokens,
      cell: (r) => (
        <span className="inline-flex flex-wrap justify-end gap-1">
          <Tokens count={r.totals.inputTokens} /> · <Tokens count={r.totals.outputTokens} /> · <Tokens count={r.totals.cacheReadTokens + r.totals.cacheWriteTokens} />
        </span>
      ),
    },
    {
      key: 'spend',
      header: 'Spend',
      align: 'right',
      sortValue: (r) => r.totals.costNanos,
      cell: (r) => (
        <span className="flex flex-col items-end">
          <span className="tabular">{costWithGaps(r.totals)}</span>
          {unpricedNote(r.totals) ? <span className="text-small text-fg-secondary">{unpricedNote(r.totals)}</span> : null}
        </span>
      ),
    },
    { key: 'share', header: 'Share', align: 'right', sortValue: (r) => r.shareOfCost ?? 0, cell: (r) => <span className="tabular">{formatRatio(r.shareOfCost)}</span> },
    { key: 'median', header: 'Median / task', align: 'right', sortValue: (r) => r.medianTaskCostNanos ?? -1, cell: (r) => <span className="tabular">{r.medianTaskCostNanos === null ? '—' : formatUsd(r.medianTaskCostNanos)}</span> },
    {
      key: 'perSuccess',
      header: 'Cost / success',
      align: 'right',
      sortValue: (r) => r.costPerSuccessfulTaskNanos ?? -1,
      cell: (r) => <span className="tabular">{r.costPerSuccessfulTaskNanos === null ? '—' : formatUsd(r.costPerSuccessfulTaskNanos)}</span>,
    },
    { key: 'retry', header: 'Retry rate', align: 'right', sortValue: (r) => r.retryRate ?? 0, cell: (r) => <span className="tabular">{formatRatio(r.retryRate)}</span> },
    { key: 'failure', header: 'Failure rate', align: 'right', sortValue: (r) => r.failureRate ?? 0, cell: (r) => <span className="tabular">{formatRatio(r.failureRate)}</span> },
    { key: 'latency', header: 'Median time', align: 'right', sortValue: (r) => r.medianLatencyMs ?? 0, cell: (r) => <span className="tabular">{formatDuration(r.medianLatencyMs)}</span> },
    { key: 'cache', header: 'Cache reuse', align: 'right', sortValue: (r) => r.cacheHitRate ?? 0, cell: (r) => <span className="tabular">{formatRatio(r.cacheHitRate)}</span> },
  ];
}

/**
 * Models and Agents views (design.md §7.10): transparent per-group metrics,
 * no ranking or score. Filter by task type before comparing.
 */
export function BreakdownTab({ state, dimension }: { state: UsageState; dimension: 'model' | 'role' }) {
  const [agentView, setAgentView] = useState<'role' | 'agent'>('role');
  const effective = dimension === 'model' ? 'model' : agentView;
  const rows = useUsageBreakdown(effective, state.query);
  const workflows = useWorkflows();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {dimension === 'role' ? (
          <SegmentedControl<'role' | 'agent'>
            label="Group by"
            value={agentView}
            onValueChange={setAgentView}
            options={[
              { value: 'role', label: 'By role' },
              { value: 'agent', label: 'By agent' },
            ]}
          />
        ) : null}
        <div className="w-full sm:w-64">
          <Select
            aria-label="Task type"
            value={state.filters.taskType ?? 'all'}
            onValueChange={(v) => state.update({ taskType: v === 'all' ? null : v })}
            options={[{ value: 'all', label: 'All task types' }, ...(workflows.data ?? []).map((w) => ({ value: w.id, label: w.name }))]}
          />
        </div>
        <p className="min-w-0 text-small text-fg-secondary">Compare within one task type: different workloads are not comparable.</p>
      </div>
      {rows.isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <DataTable
          caption={dimension === 'model' ? 'Usage by model' : `Usage by ${agentView}`}
          columns={columns(effective)}
          rows={rows.data ?? []}
          rowKey={(r) => r.key}
          stackedBelow={1200}
          initialSort={{ key: 'spend', direction: 'desc' }}
          empty={<EmptyState title="No agent runs in this range" description="Choose a longer range or clear the task type." />}
        />
      )}
      {dimension === 'model' ? <PricingPanel /> : null}
    </div>
  );
}
