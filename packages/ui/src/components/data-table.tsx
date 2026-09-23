import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useMediaQuery } from '../hooks/index.js';
import { cn } from '../lib/cn.js';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Enables sorting on this column. */
  sortValue?: (row: T) => string | number;
  className?: string;
  /** Hide this column in the stacked (narrow) layout. */
  hideStacked?: boolean;
  /** The row's title in the stacked layout. */
  primary?: boolean;
  align?: 'left' | 'right';
}

/**
 * Operational table (design.md §5.3): sticky header, 44px rows, hover,
 * keyboard-reachable primary action (a link or button in a cell), sort
 * indicators, and a stacked layout below 900px instead of a forced desktop
 * table.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  onRowClick,
  empty,
  stackedBelow = 900,
  initialSort,
  className,
  rowClassName,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption: string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  stackedBelow?: number;
  initialSort?: { key: string; direction: 'asc' | 'desc' };
  className?: string;
  rowClassName?: (row: T) => string | undefined;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const stacked = !useMediaQuery(`(min-width: ${stackedBelow}px)`);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * factor;
    });
  }, [rows, sort, columns]);

  if (rows.length === 0 && empty) return <>{empty}</>;

  if (stacked) {
    const primary = columns.find((c) => c.primary) ?? columns[0]!;
    return (
      <ul aria-label={caption} className={cn('flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface', className)}>
        {sorted.map((row) => (
          <li
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cn('flex flex-col gap-2 px-4 py-3', onRowClick && 'cursor-pointer hover:bg-elevated', rowClassName?.(row))}
          >
            <div className="min-w-0">{primary.cell(row)}</div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-small">
              {columns
                .filter((c) => c !== primary && !c.hideStacked)
                .map((c) => (
                  <div key={c.key} className="contents">
                    <dt className="text-fg-secondary">{c.header}</dt>
                    <dd className="min-w-0 text-fg">{c.cell(row)}</dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className={cn('min-w-0 overflow-x-auto rounded-lg border border-border-subtle bg-surface', className)}>
      <table className="w-full border-collapse text-body">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-border-subtle">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const ariaSort = active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : c.sortValue ? 'none' : undefined;
              return (
                <th key={c.key} scope="col" aria-sort={ariaSort} className={cn('h-10 whitespace-nowrap px-3 text-left text-small font-semibold text-fg-secondary', c.align === 'right' && 'text-right', c.className)}>
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => setSort(active && sort!.direction === 'asc' ? { key: c.key, direction: 'desc' } : { key: c.key, direction: 'asc' })}
                      className="inline-flex items-center gap-1 rounded-sm hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      {c.header}
                      {active ? sort!.direction === 'asc' ? <ArrowUp size={14} aria-hidden /> : <ArrowDown size={14} aria-hidden /> : <ArrowUpDown size={14} aria-hidden className="opacity-60" />}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn('h-11 border-b border-border-subtle last:border-b-0', onRowClick && 'cursor-pointer hover:bg-elevated', rowClassName?.(row))}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn('px-3 py-2 align-middle', c.align === 'right' && 'text-right', c.className)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
