import { Link } from 'react-router';
import { useState } from 'react';
import {
  Banner,
  ColumnChart,
  Disclosure,
  EmptyState,
  Meter,
  Panel,
  SegmentedControl,
  Skeleton,
  StatTile,
  StatusChip,
  ANOMALY_SEVERITY_VISUAL,
  HEALTH_STATE_VISUAL,
  formatDateTime,
} from '@acc/ui';
import { formatRatio, formatTokens, formatUsd, type UsageOverview } from '@acc/shared';
import { useUsageOverview } from '../../api/usage';
import { providerLabel, CapacityList } from './ProvidersTab';
import { bucketLabel, costWithGaps, unpricedNote, type UsageState } from './common';

function Kpis({ data }: { data: UsageOverview }) {
  const t = data.totals;
  const tight = [...data.budgets].filter((b) => b.enabled).sort((a, b) => b.usedRatio - a.usedRatio)[0];
  const warnings = data.anomalies.filter((a) => a.severity !== 'info').length + data.budgets.filter((b) => b.state !== 'ok').length + data.capacity.flatMap((c) => c.capacity).filter((c) => c.status === 'exhausted' || c.status === 'warning').length;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <StatTile
        label="Spend in range"
        value={costWithGaps(t)}
        detail={[`today ${costWithGaps(data.today)}`, `this month ${costWithGaps(data.month)}`, unpricedNote(t)].filter(Boolean).join(' · ')}
      />
      <StatTile label="Tokens" value={formatTokens(t.totalTokens)} detail={`${formatTokens(t.inputTokens)} in · ${formatTokens(t.outputTokens)} out · ${formatTokens(t.cacheReadTokens)} cache read`} />
      <StatTile
        label="Cost per successful task"
        value={data.costPerSuccessfulTaskNanos === null ? '—' : formatUsd(data.costPerSuccessfulTaskNanos)}
        detail={`${data.successfulTasks} completed · ${data.failedTasks} failed or cancelled`}
      />
      <StatTile
        label="Budget left"
        value={tight ? formatUsd(tight.remainingNanos) : 'No budget'}
        detail={tight ? `${tight.scopeLabel} · ${formatRatio(tight.usedRatio)} used` : 'Add one in the Budgets tab'}
      />
      <StatTile label="Warnings" value={String(warnings)} detail={`${t.requests} attempts · ${formatRatio(t.requests ? t.failed / t.requests : null)} failed · retries cost ${formatUsd(t.retryCostNanos)}`} />
    </div>
  );
}

function Trend({ data }: { data: UsageOverview }) {
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');
  const weekly = new Date(data.range.to).getTime() - new Date(data.range.from).getTime() > 92 * 86_400_000;
  const points = data.trend.map((p) => ({
    key: p.bucket,
    label: bucketLabel(p.bucket, weekly),
    value: metric === 'cost' ? p.costNanos : p.totalTokens,
    display: metric === 'cost' ? formatUsd(p.costNanos) : `${p.totalTokens.toLocaleString()} tokens`,
    note: [`${p.requests} attempt${p.requests === 1 ? '' : 's'}`, p.unknownCostRequests && metric === 'cost' ? `${p.unknownCostRequests} not priced` : null].filter(Boolean).join(' · '),
    warn: metric === 'cost' && p.unknownCostRequests > 0,
  }));
  return (
    <Panel
      title={metric === 'cost' ? 'Spend over time' : 'Tokens over time'}
      description={weekly ? 'Per week' : points.some((p) => p.key.includes('T')) ? 'Per hour' : 'Per day'}
      actions={
        <SegmentedControl<'cost' | 'tokens'>
          label="Trend measure"
          size="compact"
          value={metric}
          onValueChange={setMetric}
          options={[
            { value: 'cost', label: 'Spend' },
            { value: 'tokens', label: 'Tokens' },
          ]}
        />
      }
    >
      <ColumnChart
        title={metric === 'cost' ? 'Spend per period' : 'Tokens per period'}
        valueHeader={metric === 'cost' ? 'Spend' : 'Tokens'}
        points={points}
        formatAxis={(v) => (metric === 'cost' ? formatUsd(Math.round(v)) : formatTokens(Math.round(v)))}
        empty={<p className="text-body text-fg-secondary">No agent runs in this range.</p>}
      />
    </Panel>
  );
}

export function OverviewTab({ state }: { state: UsageState }) {
  const overview = useUsageOverview(state.query);
  if (overview.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-56" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (overview.isError || !overview.data) {
    return <Banner tone="danger" title="Usage could not be loaded" role="alert">{(overview.error as Error)?.message ?? 'Try Refresh.'}</Banner>;
  }
  const data = overview.data;
  const unhealthy = data.health.filter((h) => h.state !== 'healthy');
  return (
    <div className="flex flex-col gap-4">
      {data.simulated ? (
        <Banner tone="info" title="Simulated agents are in use">
          Their runs contact no provider; their usage and costs are test figures.
        </Banner>
      ) : null}
      <Kpis data={data} />
      <p className="text-small text-fg-secondary">
        {data.billingNote}
        {data.trackingStartedAt ? ` Usage tracking started on ${formatDateTime(data.trackingStartedAt)}; earlier runs were not recorded.` : ''}
      </p>
      <Trend data={data} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Where the cost went" description="Share of known spend in this range">
          {data.providers.length ? (
            <div className="flex flex-col gap-4">
              {[{ title: 'Providers', rows: data.providers, label: (k: string) => providerLabel(k) }, { title: 'Models', rows: data.models, label: (k: string) => k }].map((group) => (
                <section key={group.title} className="flex flex-col gap-2">
                  <h3 className="text-small font-semibold text-fg-secondary">{group.title}</h3>
                  <ul className="flex flex-col gap-2">
                    {group.rows.map((r) => (
                      <li key={r.key} className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-2 text-body">
                          <span className="min-w-0 truncate text-fg">{group.label(r.key)}</span>
                          <span className="tabular text-fg">
                            {costWithGaps(r.totals)} <span className="text-small text-fg-secondary">· {formatRatio(r.shareOfCost)}</span>
                          </span>
                        </div>
                        <Meter ratio={r.shareOfCost ?? 0} share />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="text-body text-fg-secondary">No agent runs in this range.</p>
          )}
        </Panel>
        <Panel title="Capacity & limits" description="Each figure with where it came from and when">
          <div className="flex flex-col gap-4">
            {data.capacity.map((p) => (
              <section key={p.provider} className="flex flex-col gap-1">
                <h3 className="text-small font-semibold text-fg-secondary">{providerLabel(p.provider)}</h3>
                <CapacityList summary={p} budgets={data.budgets} />
              </section>
            ))}
          </div>
        </Panel>
        <Panel title="Most expensive tasks" description="Open a task for its full cost ledger">
          {data.topTasks.length ? (
            <ul className="flex flex-col divide-y divide-border-subtle">
              {data.topTasks.map((t) => (
                <li key={t.taskId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link to={`/usage/tasks/${t.taskId}`} className="min-w-0 rounded-sm text-body font-semibold text-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus">
                    <span className="tabular font-mono text-small text-fg-secondary">{t.taskId}</span> {t.taskTitle ?? ''}
                  </Link>
                  <span className="tabular text-body text-fg">
                    {costWithGaps(t.totals)}
                    <span className="text-small text-fg-secondary">
                      {' '}
                      · {t.totals.requests} attempts{t.retries ? ` · ${t.retries} retries` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body text-fg-secondary">No task runs in this range.</p>
          )}
        </Panel>
        <Panel title="Waste & anomalies" description="Fixed rules; each says what triggered it">
          {data.anomalies.length ? (
            <ul className="flex flex-col divide-y divide-border-subtle">
              {data.anomalies.map((a) => (
                <li key={a.id} className="flex flex-col gap-1 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip visual={ANOMALY_SEVERITY_VISUAL[a.severity]} size="compact" />
                    {a.taskId ? (
                      <Link to={`/usage/tasks/${a.taskId}`} className="min-w-0 rounded-sm text-body font-semibold text-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus">
                        {a.title}
                      </Link>
                    ) : (
                      <span className="text-body font-semibold text-fg">{a.title}</span>
                    )}
                  </div>
                  <p className="text-small text-fg-secondary">{a.explanation}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Nothing wasteful found" description="No retry loops, duplicate requests, failed-attempt spend or unusual costs in this range." />
          )}
        </Panel>
      </div>
      <Disclosure
        title={unhealthy.length ? `Usage health: ${unhealthy.length} check${unhealthy.length === 1 ? '' : 's'} need attention` : 'Usage health: all checks healthy'}
        description="Ingestion, cost engine, aggregates, capacity readings, pricing and reconciliation"
        defaultOpen={unhealthy.some((h) => h.state === 'degraded')}
      >
        <ul className="flex flex-col divide-y divide-border-subtle">
          {data.health.map((h) => (
            <li key={h.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <span className="text-body font-semibold text-fg">{h.label}</span>
              <span className="flex min-w-0 max-w-prose flex-col items-end gap-1 text-right">
                <StatusChip visual={HEALTH_STATE_VISUAL[h.state]} size="compact" />
                <span className="text-small text-fg-secondary">{h.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}
