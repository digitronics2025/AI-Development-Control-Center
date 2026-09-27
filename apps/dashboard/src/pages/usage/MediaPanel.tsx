import { Link } from 'react-router';
import { Panel, Skeleton, formatDateTime } from '@acc/ui';
import { formatUsd, type MediaSpendStatus } from '@acc/shared';
import { useMediaSpend } from '../../api/usage';

const STATUS_LABEL: Record<MediaSpendStatus, string> = { reserved: 'Running', charged: 'Charged', unknown: 'Outcome unknown', released: 'Not charged' };

/** Paid image and video generation (docs/systems/design-agent.md): estimates, not the vendor's bill. */
export function MediaPanel() {
  const media = useMediaSpend(30);
  return (
    <Panel title="Paid media generation" description="Estimates the spend gate reserved in the last 30 days; the vendor's bill is the truth">
      {media.isLoading ? (
        <Skeleton className="h-24" />
      ) : !media.data ? (
        <p className="text-body text-fg-secondary">Media spend could not be loaded.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-body text-fg">
            <span className="tabular font-semibold">{formatUsd(media.data.spentNanos)}</span>
            <span className="text-fg-secondary">
              {' '}
              · paid generation {media.data.allowPaidGeneration ? 'on' : 'off'} · {formatUsd(media.data.taskBudgetNanos)} per task ·{' '}
              <Link to="/settings/media" className="rounded-sm underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus">
                Settings
              </Link>
            </span>
          </p>
          {media.data.events.length ? (
            <ul className="flex flex-col divide-y divide-border-subtle">
              {media.data.events.slice(0, 8).map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-body">
                  <span className="min-w-0">
                    <span className="font-mono text-small text-fg-secondary">{e.taskId ?? 'no task'}</span> <span className="text-fg">{e.capability}</span>{' '}
                    <span className="text-small text-fg-secondary">
                      {e.model} · {formatDateTime(e.createdAt)}
                    </span>
                  </span>
                  <span className="tabular text-fg">
                    {formatUsd(e.estimatedNanos)} <span className="text-small text-fg-secondary">· {STATUS_LABEL[e.status]}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body text-fg-secondary">No paid media calls in this period.</p>
          )}
        </div>
      )}
    </Panel>
  );
}
