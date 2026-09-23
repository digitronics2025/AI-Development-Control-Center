import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/** Loading placeholders that match the final layout (design.md §9.1). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('animate-shimmer rounded-md bg-muted', className)} {...props} />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border-strong bg-surface px-1 font-mono text-small text-fg-secondary', className)}>
      {children}
    </kbd>
  );
}

/** Small neutral label (tooling, capabilities, counts). Not for status — use StatusChip. */
export function Badge({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-sm border border-border-subtle bg-surface px-1.5 text-small text-fg-secondary', className)}>
      {children}
    </span>
  );
}

/** The subtle activity indicator allowed for an actively running stage (design.md §10). */
export function ActivityDot({ className, label }: { className?: string; label?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <span className="absolute inset-0 animate-activity rounded-full bg-accent" />
    </span>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
