import { ListChecks, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Button,
  DataTable,
  EmptyState,
  IconButton,
  Input,
  PageHeader,
  RelativeTime,
  SegmentedControl,
  Select,
  Skeleton,
  StageRail,
  ReleaseStateChip,
  TaskStatusChip,
  type Column,
} from '@acc/ui';
import type { TaskSummary } from '@acc/shared';
import { useRepositories, useTasks } from '../api/hooks';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useConnection } from '../app/runtime';
import { AssignmentText } from '../components/agents';
import { railFromSummary, repositoryLabel, repositoryNames } from '../components/task-row';

const FILTERS = {
  all: undefined,
  active: 'RUNNING,QUEUED,PAUSED',
  waiting: 'WAITING_FOR_USER,WAITING_FOR_USAGE_RESET,INTERRUPTED',
  failed: 'FAILED',
  completed: 'COMPLETED',
  drafts: 'DRAFT',
} as const;
type FilterKey = keyof typeof FILTERS;

const columns: Column<TaskSummary>[] = [
  {
    key: 'task',
    header: 'Task',
    primary: true,
    sortValue: (t) => t.title.toLowerCase(),
    cell: (t) => (
      <div className="flex min-w-0 flex-col">
        <Link to={`/tasks/${t.id}`} onClick={(e) => e.stopPropagation()} className="truncate rounded-sm font-semibold text-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus">
          {t.title}
        </Link>
        <span className="tabular font-mono text-small text-fg-secondary">{t.id}</span>
      </div>
    ),
    className: 'max-w-[360px]',
  },
  { key: 'repo', header: 'Repository', sortValue: (t) => t.repositoryName, cell: (t) => <span className="text-fg-secondary" title={repositoryNames(t)}>{repositoryLabel(t)}</span> },
  {
    key: 'status',
    header: 'Status',
    sortValue: (t) => t.status,
    cell: (t) => (
      <span className="flex flex-wrap items-center gap-1">
        <TaskStatusChip status={t.status} size="compact" />
        {t.releaseState ? <ReleaseStateChip state={t.releaseState} size="compact" /> : null}
      </span>
    ),
  },
  {
    key: 'stage',
    header: 'Stage',
    cell: (t) => (
      <div className="flex w-40 flex-col gap-1">
        <span className="truncate text-fg">{t.currentStageName ?? '—'}</span>
        <StageRail stages={railFromSummary(t)} currentKey={t.stageProgress.currentIndex !== null ? String(t.stageProgress.currentIndex) : null} />
      </div>
    ),
  },
  { key: 'agent', header: 'Agent', hideStacked: false, cell: (t) => <AssignmentText assignment={t.currentAssignment} className="text-small text-fg-secondary" /> },
  { key: 'updated', header: 'Updated', sortValue: (t) => t.updatedAt, cell: (t) => <RelativeTime iso={t.updatedAt} className="whitespace-nowrap text-fg-secondary" />, align: 'right' },
];

export function TasksPage() {
  useBreadcrumb([{ label: 'Tasks' }]);
  const navigate = useNavigate();
  const connection = useConnection();
  const [params, setParams] = useSearchParams();
  const filter = (params.get('filter') as FilterKey | null) ?? 'all';
  const repositoryId = params.get('repo') ?? '';
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [limit, setLimit] = useState(50);
  const repositories = useRepositories();
  const tasks = useTasks({ status: FILTERS[filter], repositoryId: repositoryId || undefined, q: params.get('q') ?? undefined, limit });

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
    setLimit(50);
  };

  const items = tasks.data?.items ?? [];

  return (
    <div className="flex flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader title="Tasks" description="Every task on this machine, newest activity first." />
      <div className="flex flex-wrap items-end gap-3">
        <SegmentedControl<FilterKey>
          label="Filter by state"
          value={filter}
          onValueChange={(v) => update({ filter: v === 'all' ? null : v })}
          className="overflow-x-auto"
          options={[
            { value: 'all', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'waiting', label: 'Waiting' },
            { value: 'failed', label: 'Failed' },
            { value: 'completed', label: 'Completed' },
            { value: 'drafts', label: 'Drafts' },
          ]}
        />
        <form
          role="search"
          className="flex min-w-[220px] flex-1 items-center gap-2 sm:max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: query.trim() || null });
          }}
        >
          <label htmlFor="task-search" className="sr-only">
            Search tasks
          </label>
          <Input id="task-search" type="search" placeholder="Search by title or ID" value={query} onChange={(e) => setQuery(e.target.value)} />
          <IconButton type="submit" icon={Search} label="Search" variant="secondary" />
        </form>
        <div className="w-full sm:w-56">
          <Select
            aria-label="Repository"
            value={repositoryId || 'all'}
            onValueChange={(v) => update({ repo: v === 'all' ? null : v })}
            options={[{ value: 'all', label: 'All repositories' }, ...(repositories.data ?? []).map((r) => ({ value: r.id, label: r.name }))]}
          />
        </div>
      </div>

      {tasks.isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : (
        <DataTable
          caption="Tasks"
          columns={columns}
          rows={items}
          rowKey={(t) => t.id}
          onRowClick={(t) => navigate(`/tasks/${t.id}`)}
          empty={
            <EmptyState
              icon={ListChecks}
              title={filter === 'all' && !params.get('q') ? 'No tasks yet' : 'No tasks match these filters'}
              description={filter === 'all' && !params.get('q') ? 'Create your first task to start an AI development workflow.' : 'Change the filters or search to see more tasks.'}
              action={
                filter === 'all' && !params.get('q') ? (
                  <Button variant="primary" icon={Plus} onClick={() => navigate('/tasks/new')} disabled={!connection.online}>
                    New Task
                  </Button>
                ) : (
                  <Button onClick={() => { setQuery(''); update({ filter: null, q: null, repo: null }); }}>Clear filters</Button>
                )
              }
            />
          }
        />
      )}
      {tasks.data?.nextCursor ? (
        <div className="flex justify-center">
          <Button onClick={() => setLimit((l) => l + 50)} loading={tasks.isFetching}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
