import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Tooltip, cn } from '@acc/ui';
import { COST_SOURCE_HELP, COST_SOURCE_LABEL, formatTokens, formatUsd, type CostSource, type UsageTotals } from '@acc/shared';

export type RangeKey = 'today' | '7d' | 'month' | 'custom';

const pad = (n: number) => String(n).padStart(2, '0');
/** A local date as `YYYY-MM-DD` (the value of a date input). */
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The ISO range for a range key, in local time: whole days, end exclusive. */
export function resolveRange(key: RangeKey, fromDate?: string | null, toDate?: string | null, now = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const tomorrow = new Date(y, m, d + 1);
  switch (key) {
    case 'today':
      return { from: new Date(y, m, d).toISOString(), to: tomorrow.toISOString() };
    case 'month':
      return { from: new Date(y, m, 1).toISOString(), to: new Date(y, m + 1, 1).toISOString() };
    case 'custom': {
      const parse = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : null);
      const from = parse(fromDate);
      const to = parse(toDate);
      if (from && to && from <= to) return { from: from.toISOString(), to: new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).toISOString() };
      return resolveRange('7d', null, null, now);
    }
    default:
      return { from: new Date(y, m, d - 6).toISOString(), to: tomorrow.toISOString() };
  }
}

/** Filters that travel in the URL so every view is bookmarkable (design.md §7.10). */
export const FILTER_KEYS = ['provider', 'model', 'agentId', 'projectId', 'role', 'status', 'costSource', 'taskType', 'q'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export function useUsageState() {
  const [params, setParams] = useSearchParams();
  const rangeKey = (['today', '7d', 'month', 'custom'].includes(params.get('range') ?? '') ? params.get('range') : '7d') as RangeKey;
  const fromDate = params.get('from');
  const toDate = params.get('to');
  // Keyed by the local day, not the render: the query key stays stable while the page is open.
  const today = localDate(new Date());
  const range = useMemo(() => resolveRange(rangeKey, fromDate, toDate, new Date(`${today}T12:00:00`)), [rangeKey, fromDate, toDate, today]);
  const filters = useMemo(() => {
    const out: Partial<Record<FilterKey, string>> = {};
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) out[k] = v;
    }
    return out;
  }, [params]);
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  return { params, rangeKey, fromDate, toDate, range, filters, query: { ...range, ...filters }, update };
}

export function SourceBadge({ source }: { source: CostSource }) {
  return (
    <Tooltip content={COST_SOURCE_HELP[source]}>
      <span tabIndex={0} className="rounded-sm focus-visible:outline-2 focus-visible:outline-focus">
        <Badge>{COST_SOURCE_LABEL[source]}</Badge>
      </span>
    </Tooltip>
  );
}

/** A cost, or the word Unknown — never a zero standing in for missing data. */
export function Cost({ nanos, source, className }: { nanos: number | null; source?: CostSource; className?: string }) {
  if (nanos === null) {
    return (
      <Tooltip content={COST_SOURCE_HELP.UNKNOWN}>
        <span tabIndex={0} className={cn('rounded-sm text-fg-secondary focus-visible:outline-2 focus-visible:outline-focus', className)}>
          Unknown
        </span>
      </Tooltip>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      <span className="tabular">{formatUsd(nanos)}</span>
      {source ? <SourceBadge source={source} /> : null}
    </span>
  );
}

export function Tokens({ count, className }: { count: number | null; className?: string }) {
  if (count === null) return <span className={cn('text-fg-secondary', className)}>Not reported</span>;
  if (count < 1000) return <span className={cn('tabular', className)}>{count}</span>;
  return (
    <Tooltip content={`${count.toLocaleString()} tokens`}>
      <span tabIndex={0} className={cn('tabular rounded-sm focus-visible:outline-2 focus-visible:outline-focus', className)}>
        {formatTokens(count)}
      </span>
    </Tooltip>
  );
}

/** "12 not priced" — attempts left out of a cost total. */
export function unpricedNote(totals: Pick<UsageTotals, 'unknownCostRequests'>): string | null {
  return totals.unknownCostRequests ? `${totals.unknownCostRequests} not priced` : null;
}

/** "$1.23" plus how many attempts it excludes. */
export function costWithGaps(totals: Pick<UsageTotals, 'costNanos' | 'unknownCostRequests' | 'requests'>): string {
  if (totals.requests > 0 && totals.unknownCostRequests === totals.requests) return 'Unknown';
  return formatUsd(totals.costNanos);
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** Axis label for a trend bucket: an hour, a day, or a week (labelled by its Monday). */
export function bucketLabel(bucket: string, weekly: boolean): string {
  if (bucket.includes('T')) return hourFormat.format(new Date(`${bucket}:00:00`));
  const day = dayFormat.format(new Date(`${bucket}T00:00:00`));
  return weekly ? `Week of ${day}` : day;
}

export type UsageState = ReturnType<typeof useUsageState>;
