import { AlertTriangle, CheckCircle2, Info, OctagonAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { Tooltip } from '../primitives/tooltip.js';
import { TONE_CLASSES, type Tone } from '../tokens/status.js';

/** Page title row with one obvious primary action (design.md §2.2). */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-x-6 gap-y-3', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? <div className="text-small text-fg-secondary">{eyebrow}</div> : null}
        <h1 className="text-h1 text-fg wrap-anywhere">{title}</h1>
        {description ? <div className="text-body text-fg-secondary">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * design.md §5.2 panel types. `surface` groups content, `inspector` holds
 * contextual controls, `danger` isolates high-risk actions.
 */
export function Panel({
  title,
  description,
  actions,
  children,
  variant = 'surface',
  className,
  bodyClassName,
  as: As = 'section',
  headingLevel = 2,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  variant?: 'surface' | 'inspector' | 'danger' | 'plain';
  className?: string;
  bodyClassName?: string;
  as?: 'section' | 'div' | 'aside';
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <As
      className={cn(
        'flex min-w-0 flex-col rounded-lg',
        variant === 'surface' && 'border border-border-subtle bg-surface',
        variant === 'inspector' && 'border border-border-subtle bg-surface',
        variant === 'danger' && 'border border-danger bg-surface',
        className,
      )}
    >
      {title || actions ? (
        <div className={cn('flex flex-wrap items-start justify-between gap-2', variant !== 'plain' && 'border-b border-border-subtle px-4 py-3')}>
          <div className="flex min-w-0 flex-col gap-0.5">
            {title ? <Heading className="text-h3 text-fg">{title}</Heading> : null}
            {description ? <p className="text-small text-fg-secondary">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn(variant !== 'plain' && 'p-4', bodyClassName)}>{children}</div>
    </As>
  );
}

const BANNER_ICON: Record<Exclude<Tone, 'accent' | 'neutral'>, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: OctagonAlert,
};

/**
 * Persistent inline message for things that need attention: disconnection,
 * blockers, approvals (design.md §8.6 — never toast-only).
 */
export function Banner({
  tone,
  title,
  children,
  actions,
  className,
  role,
}: {
  tone: 'info' | 'success' | 'warning' | 'danger';
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: 'alert' | 'status';
}) {
  const Icon = BANNER_ICON[tone];
  const t = TONE_CLASSES[tone];
  return (
    <div role={role} className={cn('flex flex-wrap items-start gap-3 rounded-lg border-l-4 px-4 py-3', t.tint, t.border, className)}>
      <Icon size={18} className={cn('mt-0.5 shrink-0', t.icon)} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-body font-semibold text-fg">{title}</div>
        {children ? <div className="text-body text-fg wrap-anywhere">{children}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Compact text + one clear next action (design.md §8.10). */
export function EmptyState({ icon: Icon, title, description, action, className }: { icon?: LucideIcon; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-start gap-2 rounded-lg border border-dashed border-border-subtle px-5 py-6', className)}>
      {Icon ? <Icon size={24} className="text-fg-secondary" aria-hidden /> : null}
      <h3 className="text-h3 text-fg">{title}</h3>
      {description ? <p className="max-w-prose text-body text-fg-secondary">{description}</p> : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

export function KeyValueList({ items, className }: { items: Array<{ label: string; value: ReactNode; hidden?: boolean }>; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(96px,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-body', className)}>
      {items
        .filter((item) => !item.hidden)
        .map((item) => (
          <div key={item.label} className="contents">
            <dt className="text-fg-secondary">{item.label}</dt>
            <dd className="min-w-0 text-fg wrap-anywhere">{item.value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Recent timestamps are relative with the absolute time in a tooltip (design.md §12). */
export function RelativeTime({ iso, now, className }: { iso: string | null | undefined; now?: number; className?: string }) {
  if (!iso) return <span className={className}>—</span>;
  return (
    <Tooltip content={formatDateTime(iso)}>
      <time dateTime={iso} tabIndex={0} className={cn('tabular focus-visible:outline-2 focus-visible:outline-focus', className)}>
        {formatRelative(iso, now)}
      </time>
    </Tooltip>
  );
}

export function SectionHeading({ children, actions, id }: { children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id={id} className="text-h2 text-fg">
        {children}
      </h2>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
