import { AlertTriangle } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface ColumnPoint {
  key: string;
  /** Short axis label (e.g. "Sep 23"). */
  label: string;
  value: number;
  /** Exact value as text, for the tooltip and the table. */
  display: string;
  /** Extra tooltip line, e.g. "3 runs not priced". */
  note?: string;
  /** Marks a column whose value is incomplete. */
  warn?: boolean;
}

/**
 * One series over time (design.md §8.11). Columns grow from one baseline;
 * the chart is one keyboard stop — arrow keys move between columns — and a
 * visually hidden table carries the same data for screen readers.
 */
export function ColumnChart({
  title,
  points,
  formatAxis,
  valueHeader,
  height = 180,
  empty,
  className,
}: {
  title: string;
  points: ColumnPoint[];
  formatAxis: (value: number) => string;
  valueHeader: string;
  height?: number;
  empty?: ReactNode;
  className?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const tooltipId = useId();
  if (!points.length) return <>{empty ?? null}</>;
  const max = Math.max(...points.map((p) => p.value));
  const top = max > 0 ? max : 1;
  const ticks = [top, top / 2, 0];
  const current = active !== null ? points[active] : null;
  const labelIndexes = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = points.length - 1;
    const from = active ?? -1;
    const next =
      event.key === 'ArrowRight' ? Math.min(last, from + 1) : event.key === 'ArrowLeft' ? Math.max(0, from === -1 ? last : from - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };

  return (
    <figure className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex min-w-0 gap-2">
        <div aria-hidden className="flex shrink-0 flex-col justify-between text-right text-small tabular text-fg-secondary" style={{ height }}>
          {ticks.map((t, i) => (
            <span key={i} className="leading-none">
              {formatAxis(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div
            role="group"
            aria-label={`${title}. Use the arrow keys to read each value.`}
            aria-describedby={current ? tooltipId : undefined}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
            onMouseLeave={() => setActive(null)}
            className="relative flex items-end gap-0.5 rounded-sm border-b border-border-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            style={{ height }}
          >
            {ticks.slice(0, 2).map((_, i) => (
              <span key={i} aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-border-subtle" style={{ top: `${i * 50}%` }} />
            ))}
            {points.map((p, i) => (
              <div key={p.key} className="relative flex h-full min-w-0 flex-1 items-end justify-center" onMouseEnter={() => setActive(i)}>
                <div
                  aria-hidden
                  className={cn('w-full max-w-6 rounded-t-sm bg-accent transition-opacity duration-[120ms]', active !== null && active !== i && 'opacity-60')}
                  style={{ height: p.value > 0 ? `max(${(p.value / top) * 100}%, 2px)` : 0 }}
                />
                {p.warn ? <AlertTriangle aria-hidden size={12} className="absolute -top-1 text-warning" /> : null}
              </div>
            ))}
          </div>
          {current ? (
            <div
              id={tooltipId}
              role="status"
              className="pointer-events-none absolute -top-2 z-10 max-w-[240px] -translate-y-full rounded-md border border-border-strong bg-elevated px-2.5 py-1.5 text-small text-fg shadow-float"
              style={{ left: `clamp(0px, calc(${((active! + 0.5) / points.length) * 100}% - 60px), calc(100% - 120px))` }}
            >
              <div className="font-semibold">{current.label}</div>
              <div className="tabular">{current.display}</div>
              {current.note ? <div className="text-fg-secondary">{current.note}</div> : null}
            </div>
          ) : null}
          <div aria-hidden className="mt-1 flex text-small text-fg-secondary">
            {points.map((p, i) => (
              <span key={p.key} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center">
                {labelIndexes.has(i) ? p.label : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}>
              <th scope="row">{p.label}</th>
              <td>
                {p.display}
                {p.note ? ` (${p.note})` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Label · value · detail (design.md §8.12). */
export function StatTile({ label, value, detail, className }: { label: string; value: ReactNode; detail?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 rounded-lg border border-border-subtle bg-surface px-4 py-3', className)}>
      <div className="text-small text-fg-secondary">{label}</div>
      <div className="text-h2 tabular text-fg wrap-anywhere">{value}</div>
      {detail ? <div className="text-small text-fg-secondary wrap-anywhere">{detail}</div> : null}
    </div>
  );
}

/**
 * A ratio against a limit (design.md §8.13). The bar is decoration for the
 * text beside it, so it is hidden from assistive technology; the tone follows
 * the thresholds, or stays accent for a share of a total.
 */
export function Meter({
  ratio,
  warning = 0.8,
  critical = 0.95,
  share = false,
  className,
}: {
  ratio: number;
  warning?: number;
  critical?: number;
  /** A share of a total, not a limit: never turns warning or danger. */
  share?: boolean;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const tone = share || ratio < warning ? 'bg-accent' : ratio < critical ? 'bg-warning' : 'bg-danger';
  return (
    <div aria-hidden className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className={cn('h-full rounded-full', tone)} style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}
