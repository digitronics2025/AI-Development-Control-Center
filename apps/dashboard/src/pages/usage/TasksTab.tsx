import { ListChecks } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, DataTable, EmptyState, RelativeTime, Select, Skeleton, TaskStatusChip, type Column } from '@acc/ui';
import { TASK_STATUSES, type TaskStatus, type UsageTaskRow } from '@acc/shared';
import { useUsageTasks } from '../../api/usage';
import { Tokens, costWithGaps, unpricedNote, type UsageState } from './common';

const columns: Column<UsageTaskRow>[] = [
  {
    key: 'task',
    header: 'Task',
    primary: true,
    cell: (t) => (
      <div className="flex min-w-0 flex-col">
        <Link to={`/usage/tasks/${t.taskId}`} onClick={(e) => e.stopPropagation()} className="truncate rounded-sm font-semibold text-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus">
          {t.taskTitle ?? t.taskId}
        </Link>
        <span className="tabular font-mono text-small text-fg-secondary">
          {t.taskId}
          {t.projectName ? ` · ${t.projectName}` : ''}
        </span>
      </div>
    ),
    className: 'max-w-[340px]',
  },
  {
    key: 'status',
    header: 'Status',
    cell: (t) => ((TASK_STATUSES as readonly string[]).includes(t.taskStatus ?? '') ? <TaskStatusChip status={t.taskStatus as TaskStatus} size="compact" /> : <span className="text-fg-secondary">—</span>),
  },
  { key: 'attempts', header: 'Attempts', align: 'right', cell: (t) => <span className="tabular">{t.totals.requests}</span> },
  { key: 'retries', header: 'Retries', align: 'right', cell: (t) => <span className="tabular">{t.retries}</span> },
  { key: 'failed', header: 'Failed', align: 'right', cell: (t) => <span className="tabular">{t.totals.failed}</span> },
  { key: 'tokens', header: 'Tokens', align: 'right', cell: (t) => <Tokens count={t.totals.totalTokens} /> },
  {
    key: 'cost',
    header: 'Cost',
    align: 'right',
    cell: (t) => (
      <span className="flex flex-col items-end">
        <span className="tabular">{costWithGaps(t.totals)}</span>
        {unpricedNote(t.totals) ? <span className="text-small text-fg-secondary">{unpricedNote(t.totals)}</span> : null}
      </span>
    ),
  },
  { key: 'models', header: 'Models', cell: (t) => <span className="text-small text-fg-secondary">{t.models.join(', ')}</span>, className: 'max-w-[220px]' },
  { key: 'last', header: 'Last run', align: 'right', cell: (t) => <RelativeTime iso={t.lastAt} className="whitespace-nowrap text-fg-secondary" /> },
];

export function TasksTab({ state }: { state: UsageState }) {
  const navigate = useNavigate();
  const [sort, setSort] = useState('cost');
  const [offset, setOffset] = useState(0);
  const tasks = useUsageTasks(state.query, sort, offset);
  const page = tasks.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-full sm:w-56">
          <Select
            aria-label="Sort tasks"
            value={sort}
            onValueChange={(v) => {
              setSort(v);
              setOffset(0);
            }}
            options={[
              { value: 'cost', label: 'Highest cost first' },
              { value: 'tokens', label: 'Most tokens first' },
              { value: 'requests', label: 'Most attempts first' },
              { value: 'recent', label: 'Most recent first' },
            ]}
          />
        </div>
        {page ? (
          <span className="text-small text-fg-secondary">
            {page.total ? `${page.offset + 1}–${page.offset + page.items.length} of ${page.total} tasks` : 'No tasks'}
          </span>
        ) : null}
      </div>
      {tasks.isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <DataTable
          caption="Task usage"
          columns={columns}
          rows={page?.items ?? []}
          rowKey={(t) => t.taskId}
          onRowClick={(t) => navigate(`/usage/tasks/${t.taskId}`)}
          empty={<EmptyState icon={ListChecks} title="No task used an agent in this range" description="Choose a longer range, or start a task." />}
        />
      )}
      {page && page.total > 50 ? (
        <div className="flex justify-center gap-2">
          <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
            Previous
          </Button>
          <Button disabled={offset + 50 >= page.total} onClick={() => setOffset(offset + 50)}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
