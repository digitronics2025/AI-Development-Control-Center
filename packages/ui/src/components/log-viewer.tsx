import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { LogLine } from '@acc/shared';
import { useAutoFollow } from '../hooks/index.js';
import { cn } from '../lib/cn.js';
import { formatLogTime } from '../lib/format.js';
import { Button, IconButton } from '../primitives/button.js';

const ROW_HEIGHT = 20;

/**
 * Developer log view (design.md §7.3, §9.3, §21): virtualized so large logs
 * stay fast; follows new output only while the reader is at the bottom and
 * offers "New output" instead of yanking the scroll position.
 */
export function LogViewer({
  lines,
  filter = '',
  showStreams = { stdout: true, stderr: true, system: true },
  height = 420,
  emptyText = 'No output yet.',
  ariaLabel = 'Execution output',
  onCopy,
}: {
  lines: LogLine[];
  filter?: string;
  showStreams?: { stdout: boolean; stderr: boolean; system: boolean };
  height?: number | string;
  emptyText?: string;
  ariaLabel?: string;
  onCopy?: (text: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { hasNewOutput, onScroll, notifyNewContent, jumpToLatest } = useAutoFollow();
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return lines.filter((l) => showStreams[l.stream] && (!q || l.text.toLowerCase().includes(q)));
  }, [lines, filter, showStreams]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  });

  const scrollToBottom = () => {
    if (visible.length) virtualizer.scrollToIndex(visible.length - 1, { align: 'end' });
  };

  const lastSeq = visible.at(-1)?.seq;
  useEffect(() => {
    notifyNewContent(scrollToBottom);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react only to new lines
  }, [lastSeq, visible.length]);

  const copy = () => {
    const text = visible.map((l) => `${formatLogTime(l.at)} ${l.stream.padEnd(6)} ${l.text}`).join('\n');
    void navigator.clipboard?.writeText(text).then(() => onCopy?.(text));
  };

  return (
    <div className="relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-canvas">
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-1.5">
        <span className="tabular text-small text-fg-secondary">
          {visible.length === lines.length ? `${lines.length} lines` : `${visible.length} of ${lines.length} lines`}
        </span>
        <IconButton icon={Copy} label="Copy visible output" size="compact" onClick={copy} disabled={!visible.length} />
      </div>
      <div
        ref={parentRef}
        role="log"
        aria-label={ariaLabel}
        aria-live="off"
        tabIndex={0}
        onScroll={(e) => onScroll(e.currentTarget)}
        style={{ height }}
        className="overflow-auto font-mono text-code focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      >
        {visible.length === 0 ? (
          <p className="p-3 font-sans text-body text-fg-secondary">{emptyText}</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: '100%' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const line = visible[item.index]!;
              return (
                <div
                  key={line.seq}
                  style={{ position: 'absolute', top: 0, left: 0, transform: `translateY(${item.start}px)`, height: ROW_HEIGHT }}
                  className={cn('flex min-w-full whitespace-pre pr-4', line.stream === 'stderr' && 'bg-danger-muted', line.stream === 'system' && 'text-fg-secondary')}
                >
                  <span className="tabular w-[104px] shrink-0 select-none pl-3 text-fg-secondary">{formatLogTime(line.at)}</span>
                  <span className={cn('w-12 shrink-0 select-none', line.stream === 'stderr' ? 'text-fg' : 'text-fg-secondary')}>
                    {line.stream === 'stderr' ? 'err' : line.stream === 'system' ? 'sys' : 'out'}
                  </span>
                  <span className="text-fg">{line.text || ' '}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {hasNewOutput ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button variant="primary" size="compact" icon={ArrowDown} className="pointer-events-auto shadow-float" onClick={() => jumpToLatest(scrollToBottom)}>
            New output
          </Button>
        </div>
      ) : null}
    </div>
  );
}
