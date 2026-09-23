import { Link, useNavigate } from 'react-router';
import { RelativeTime, StageRail, TaskStatusChip, cn, durationBetween, formatDuration, useNow } from '@acc/ui';
import { workflowHappyPath, type TaskDetail, type TaskSummary } from '@acc/shared';
import { AssignmentText } from './agents';
import { TaskPrimaryAction } from './task-actions';

/** Rail segments from a summary alone (no per-stage data needed for list rows). */
export function railFromSummary(task: TaskSummary) {
  const { total, completed, currentIndex } = task.stageProgress;
  return Array.from({ length: total }, (_, i) => {
    let status: 'SUCCESS' | 'RUNNING' | 'FAILED' | 'WAITING_APPROVAL' | 'PENDING' = 'PENDING';
    if (task.status === 'COMPLETED' || i < completed) status = 'SUCCESS';
    if (i === currentIndex && task.status !== 'COMPLETED') {
      status =
        task.status === 'RUNNING'
          ? 'RUNNING'
          : task.status === 'FAILED'
            ? 'FAILED'
            : ['WAITING_FOR_USER', 'WAITING_FOR_USAGE_RESET', 'PAUSED', 'INTERRUPTED'].includes(task.status)
              ? 'WAITING_APPROVAL'
              : 'PENDING';
    }
    return { key: String(i), name: i === currentIndex ? (task.currentStageName ?? `Stage ${i + 1}`) : `Stage ${i + 1}`, status };
  });
}

export function railFromDetail(task: TaskDetail) {
  const latest = new Map(task.stages.map((s) => [s.stageKey, s]));
  return workflowHappyPath(task.workflow).map((def) => {
    const inst = latest.get(def.key);
    return { key: def.key, name: def.name, status: inst?.status ?? ('PENDING' as const), verdict: inst?.verdict ?? null };
  });
}

/**
 * Active task row (design.md §7.1): ID, title, repository, status, current
 * stage, active agent, elapsed time, last meaningful event and the one
 * contextual action.
 */
export function ActiveTaskRow({ task }: { task: TaskSummary }) {
  const navigate = useNavigate();
  const running = task.status === 'RUNNING';
  const now = useNow(1000, running);
  const elapsed = durationBetween(task.startedAt ?? task.createdAt, task.finishedAt, now);
  return (
    <li
      className="grid cursor-pointer grid-cols-1 gap-3 px-4 py-3 hover:bg-elevated md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_auto] md:items-center"
      onClick={() => navigate(`/tasks/${task.id}`)}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TaskStatusChip status={task.status} size="compact" />
          <span className="tabular font-mono text-small text-fg-secondary">{task.id}</span>
        </div>
        <Link
          to={`/tasks/${task.id}`}
          onClick={(e) => e.stopPropagation()}
          className="truncate rounded-sm text-body font-semibold text-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus"
        >
          {task.title}
        </Link>
        <span className="truncate text-small text-fg-secondary">
          {task.repositoryName} · {task.workflowName}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate text-body text-fg">
            {task.currentStageName ?? '—'}
            {task.fixCycles > 0 ? <span className="text-small text-fg-secondary"> · fix cycle {task.fixCycles}</span> : null}
          </span>
          <span className="tabular shrink-0 text-small text-fg-secondary" aria-label={`Elapsed ${formatDuration(elapsed)}`}>
            {formatDuration(elapsed)}
          </span>
        </div>
        <StageRail stages={railFromSummary(task)} currentKey={task.stageProgress.currentIndex !== null ? String(task.stageProgress.currentIndex) : null} />
        <span className="truncate text-small text-fg-secondary">
          <AssignmentText assignment={task.currentAssignment} />
        </span>
        {task.blocker ? (
          <span className={cn('line-clamp-2 text-small text-fg')}>{task.blocker.message}</span>
        ) : task.lastEvent ? (
          <span className="truncate text-small text-fg-secondary">
            {task.lastEvent.message} · <RelativeTime iso={task.lastEvent.at} now={now} />
          </span>
        ) : null}
      </div>
      <div className="flex md:justify-end" onClick={(e) => e.stopPropagation()}>
        <TaskPrimaryAction task={task} size="compact" />
      </div>
    </li>
  );
}
