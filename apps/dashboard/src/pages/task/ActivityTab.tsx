import { Fragment, useMemo } from 'react';
import { Checkbox, EmptyState, Skeleton, formatDateTime, formatTime, useLocalPreference } from '@acc/ui';
import type { EventType, TaskEvent } from '@acc/shared';
import { useSettings, useTaskEvents } from '../../api/hooks';

/** Low-level events hidden from the human-readable timeline by default (design.md §7.3 Activity). */
const TECHNICAL: ReadonlySet<EventType> = new Set(['AGENT_STARTED', 'COMMAND_STARTED', 'COMMAND_FINISHED', 'TEST_STARTED', 'STAGE_STARTED', 'ARTIFACT_CREATED']);

const TONE: Partial<Record<EventType, string>> = {
  TASK_FAILED: 'text-danger',
  STAGE_FAILED: 'text-danger',
  TEST_FAILED: 'text-danger',
  REVIEW_FAILED: 'text-danger',
  TASK_COMPLETED: 'text-success',
  TEST_PASSED: 'text-success',
  REVIEW_PASSED: 'text-success',
  APPROVAL_REQUESTED: 'text-warning',
  TASK_WAITING: 'text-warning',
  TASK_INTERRUPTED: 'text-warning',
};

function dayKey(iso: string) {
  return new Date(iso).toDateString();
}

export function EventTimeline({ events, showTechnical }: { events: TaskEvent[]; showTechnical: boolean }) {
  const visible = useMemo(() => events.filter((e) => showTechnical || !TECHNICAL.has(e.type)), [events, showTechnical]);
  if (!visible.length) return <p className="text-body text-fg-secondary">No activity yet.</p>;
  let lastDay = '';
  return (
    <ol className="flex flex-col">
      {visible.map((event) => {
        const day = dayKey(event.at);
        const newDay = day !== lastDay;
        lastDay = day;
        return (
          <Fragment key={event.id}>
            {newDay ? (
              <li aria-hidden className="pb-1 pt-3 text-small font-semibold text-fg-secondary first:pt-0">
                {new Date(event.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </li>
            ) : null}
            <li className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 border-l border-border-subtle py-1.5 pl-3">
              <time dateTime={event.at} title={formatDateTime(event.at)} className="tabular text-small text-fg-secondary">
                {formatTime(event.at)}
              </time>
              <span className="text-body text-fg wrap-anywhere">
                {TONE[event.type] ? <span aria-hidden className={`mr-1.5 inline-block size-1.5 -translate-y-0.5 rounded-full bg-current ${TONE[event.type]}`} /> : null}
                {event.message}
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** Human-readable event timeline; raw payloads belong in developer logs. */
export function ActivityTab({ taskId }: { taskId: string }) {
  const events = useTaskEvents(taskId);
  const settings = useSettings();
  const [storedTechnical, setShowTechnical] = useLocalPreference<boolean | null>('activity-technical', null);
  const showTechnical = storedTechnical ?? Boolean(settings.data?.developerMode);
  if (events.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-3/4" />
        ))}
      </div>
    );
  }
  if (!events.data?.length) return <EmptyState title="No activity yet" description="Events appear here as the task runs." />;
  return (
    <div className="flex flex-col gap-3">
      <Checkbox checked={showTechnical} onCheckedChange={setShowTechnical} label="Show technical events" description="Agent launches, individual commands and stage starts." />
      <EventTimeline events={events.data} showTechnical={showTechnical} />
    </div>
  );
}
