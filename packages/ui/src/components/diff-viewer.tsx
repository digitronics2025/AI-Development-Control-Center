import { useMemo, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';

interface DiffRow {
  kind: 'file' | 'hunk' | 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      rows.push({ kind: 'file', text: line.replace(/^diff --git a\/(.+?) b\/.+$/, '$1'), oldNo: null, newNo: null });
    } else if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      rows.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
    } else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('\\')) {
      rows.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (line.length || rows.length) {
      rows.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return rows;
}

const PAGE = 3000;

/** Unified diff with line numbers; additions and deletions marked by sign and tint, not color alone. */
export function DiffViewer({ diff, truncated, className }: { diff: string; truncated?: boolean; className?: string }) {
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [limit, setLimit] = useState(PAGE);
  if (!diff.trim()) return <p className="text-body text-fg-secondary">No changes in this file.</p>;
  return (
    <div className={cn('min-w-0 overflow-hidden rounded-lg border border-border-subtle bg-canvas', className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-code">
          <caption className="sr-only">Diff</caption>
          <tbody>
            {rows.slice(0, limit).map((row, i) => {
              if (row.kind === 'file') {
                return (
                  <tr key={i} className="border-y border-border-subtle bg-surface">
                    <th colSpan={4} scope="rowgroup" className="px-3 py-1.5 text-left font-sans text-body font-semibold text-fg">
                      {row.text}
                    </th>
                  </tr>
                );
              }
              if (row.kind === 'meta') return null;
              if (row.kind === 'hunk') {
                return (
                  <tr key={i} className="bg-info-muted">
                    <td colSpan={4} className="whitespace-pre px-3 text-fg-secondary">
                      {row.text}
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={i} className={cn(row.kind === 'add' && 'bg-success-muted', row.kind === 'del' && 'bg-danger-muted')}>
                  <td className="tabular w-12 select-none px-2 text-right align-top text-fg-secondary">{row.oldNo ?? ''}</td>
                  <td className="tabular w-12 select-none px-2 text-right align-top text-fg-secondary">{row.newNo ?? ''}</td>
                  <td className="w-5 select-none text-center align-top text-fg">
                    <span aria-hidden>{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
                    <span className="sr-only">{row.kind === 'add' ? 'added' : row.kind === 'del' ? 'removed' : ''}</span>
                  </td>
                  <td className="whitespace-pre pr-4 text-fg">{row.text || ' '}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > limit ? (
        <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-3 py-2">
          <span className="text-small text-fg-secondary">
            Showing {limit} of {rows.length} lines
          </span>
          <Button size="compact" onClick={() => setLimit((l) => l + PAGE)}>
            Show more
          </Button>
        </div>
      ) : null}
      {truncated ? <p className="border-t border-border-subtle px-3 py-2 text-small text-fg-secondary">The diff is larger than the display limit and was truncated.</p> : null}
    </div>
  );
}
