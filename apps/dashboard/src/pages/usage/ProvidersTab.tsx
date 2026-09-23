import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Button, EmptyState, Panel, RelativeTime, Skeleton, StatusChip, CAPACITY_STATUS_VISUAL, formatDateTime, useFeedback } from '@acc/ui';
import { CONFIDENCE_LABEL, USAGE_BILLING_LABEL, formatUsd, type BudgetStatus, type ProviderSummary } from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useBudgets, useUsageMutations, useUsageProviders } from '../../api/usage';
import { Tokens, costWithGaps, unpricedNote, type UsageState } from './common';

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Anthropic (Claude Code)', openai: 'OpenAI (Codex)', simulated: 'Simulated agents' };
export const providerLabel = (provider: string) => PROVIDER_LABEL[provider] ?? provider;

function Row({ label, children, confidence }: { label: string; children: ReactNode; confidence?: string }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2">
      <span className="min-w-0 text-body text-fg">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-body text-fg">
        {children}
        {confidence ? <Badge>{confidence}</Badge> : null}
      </span>
    </li>
  );
}

/** The budget that governs a provider: its own, else the global one. */
function providerBudget(provider: string, budgets: BudgetStatus[]): BudgetStatus | null {
  return budgets.find((b) => b.enabled && b.scopeType === 'PROVIDER' && b.scopeId === provider) ?? budgets.find((b) => b.enabled && b.scopeType === 'GLOBAL') ?? null;
}

/**
 * Remaining capacity, never collapsed into one number (design.md §7.10):
 * internal budget, provider credit, quota windows and rate limits are
 * separate rows, each with its confidence and time; unsupported ones say
 * Unavailable.
 */
export function CapacityList({ summary, budgets }: { summary: ProviderSummary; budgets: BudgetStatus[] }) {
  const caps = summary.capabilities;
  const budget = providerBudget(summary.provider, budgets);
  const windows = summary.capacity.filter((c) => c.metric.startsWith('window:'));
  const others = summary.capacity.filter((c) => !c.metric.startsWith('window:'));
  return (
    <ul className="flex flex-col divide-y divide-border-subtle">
      <Row label="Internal budget" confidence={budget ? CONFIDENCE_LABEL.CALCULATED : undefined}>
        {budget ? (
          <span className="tabular">
            {formatUsd(budget.remainingNanos)} left of {formatUsd(budget.amountNanos)}
            <span className="text-fg-secondary"> · {budget.scopeType === 'GLOBAL' ? 'global' : 'provider'} budget</span>
          </span>
        ) : (
          <span className="text-fg-secondary">Not configured</span>
        )}
      </Row>
      {windows.map((w) => (
        <Row key={w.id} label={`Quota · ${w.label}`} confidence={w.stale ? 'Stale' : CONFIDENCE_LABEL[w.confidence]}>
          <StatusChip visual={CAPACITY_STATUS_VISUAL[w.status]} size="compact" />
          <span className="tabular">{w.remainingPercent === null ? 'Remaining not reported' : `${w.remainingPercent}% left`}</span>
          {w.resetAt ? <span className="text-small text-fg-secondary">resets {formatDateTime(w.resetAt)}</span> : null}
          <span className="text-small text-fg-secondary">
            read <RelativeTime iso={w.capturedAt} />
          </span>
          {w.stale && w.staleReason ? <span className="w-full text-right text-small text-fg-secondary">{w.staleReason}</span> : null}
        </Row>
      ))}
      {others.map((c) => (
        <Row key={c.id} label={c.label} confidence={c.stale ? 'Stale' : CONFIDENCE_LABEL[c.confidence]}>
          <StatusChip visual={CAPACITY_STATUS_VISUAL[c.status]} size="compact" />
          {c.detail ? <span className="text-small text-fg-secondary">{c.detail}</span> : null}
          <span className="text-small text-fg-secondary">
            read <RelativeTime iso={c.capturedAt} />
          </span>
        </Row>
      ))}
      {!others.some((c) => c.metric === 'credit') ? (
        <Row label="Provider credit" confidence={CONFIDENCE_LABEL.UNAVAILABLE}>
          <span className="text-fg-secondary">{caps?.credit ? 'No reading yet' : 'Not exposed by this provider'}</span>
        </Row>
      ) : null}
      {!windows.length ? (
        <Row label="Quota and rate limits" confidence={CONFIDENCE_LABEL.UNAVAILABLE}>
          <span className="text-fg-secondary">{caps?.quota || caps?.rateLimits ? 'No reading yet — it arrives with the next run' : 'Not exposed by this provider'}</span>
        </Row>
      ) : null}
    </ul>
  );
}

export function ProvidersTab({ state }: { state: UsageState }) {
  const providers = useUsageProviders(state.query);
  const budgets = useBudgets();
  const { refreshCapacity } = useUsageMutations();
  const { toast } = useFeedback();
  if (providers.isLoading) return <Skeleton className="h-64" />;
  const list = providers.data ?? [];
  if (!list.length) return <EmptyState title="No providers" description="No agent is installed and no run has been recorded yet." />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-body text-fg-secondary">
          Limit readings arrive with each agent run — the provider command-line tools have no separate limits endpoint, so a reading is never fetched or guessed in between.
        </p>
        <Button
          icon={RefreshCw}
          loading={refreshCapacity.isPending}
          onClick={() => refreshCapacity.mutate(undefined, { onSuccess: () => toast('Readings re-checked for freshness', 'success'), onError: (e) => toast(errorMessage(e), 'info') })}
        >
          Re-check readings
        </Button>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {list.map((p) => (
          <Panel
            key={p.provider}
            title={providerLabel(p.provider)}
            description={`${p.billing.length ? p.billing.map((b) => USAGE_BILLING_LABEL[b]).join(', ') : 'No runs yet'} · agents: ${p.agentIds.join(', ') || '—'}`}
          >
            <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 text-body sm:grid-cols-4">
              <div>
                <dt className="text-small text-fg-secondary">Spend</dt>
                <dd className="tabular text-fg">{costWithGaps(p.totals)}</dd>
                {unpricedNote(p.totals) ? <dd className="text-small text-fg-secondary">{unpricedNote(p.totals)}</dd> : null}
              </div>
              <div>
                <dt className="text-small text-fg-secondary">Tokens</dt>
                <dd>
                  <Tokens count={p.totals.totalTokens} />
                </dd>
              </div>
              <div>
                <dt className="text-small text-fg-secondary">Attempts · failed</dt>
                <dd className="tabular text-fg">
                  {p.totals.requests} · {p.totals.failed}
                </dd>
              </div>
              <div>
                <dt className="text-small text-fg-secondary">Usage-limit stops</dt>
                <dd className="tabular text-fg">{p.usageLimitEvents}</dd>
              </div>
            </dl>
            <CapacityList summary={p} budgets={budgets.data ?? []} />
          </Panel>
        ))}
      </div>
    </div>
  );
}
