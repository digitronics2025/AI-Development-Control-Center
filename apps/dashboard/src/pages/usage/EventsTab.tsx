import { Search } from 'lucide-react';
import { useState } from 'react';
import { Button, DataTable, EmptyState, IconButton, Input, Select, Skeleton, StatusChip, USAGE_EVENT_STATUS_VISUAL, formatDateTime, formatDuration, type Column } from '@acc/ui';
import { ATTEMPT_REASON_LABEL, COST_SOURCES, COST_SOURCE_LABEL, ROLES, USAGE_EVENT_STATUSES, type UsageEvent } from '@acc/shared';
import { useUsageEvents } from '../../api/usage';
import { EventDrawer } from './EventDrawer';
import { Cost, Tokens, type UsageState } from './common';

/** Attempt columns; the primary cell is the keyboard-reachable way to open an attempt. */
export const eventColumns = (onOpen: (id: string) => void): Column<UsageEvent>[] => [
  {
    key: 'time',
    header: 'Time',
    primary: true,
    cell: (e) => (
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation();
          onOpen(e.id);
        }}
        className="whitespace-nowrap rounded-sm text-left font-semibold text-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
      >
        {formatDateTime(e.startedAt)}
        <span className="sr-only">, open attempt details</span>
      </button>
    ),
  },
  {
    key: 'where',
    header: 'Task · stage',
    cell: (e) => (
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-fg">{e.taskId ? `${e.taskId}${e.taskTitle ? ` · ${e.taskTitle}` : ''}` : (e.projectName ?? '—')}</span>
        <span className="text-small text-fg-secondary">
          {e.workflowStep ?? e.origin}
          {e.agentRole ? ` · ${e.agentRole}` : ''}
        </span>
      </div>
    ),
    className: 'max-w-[280px]',
  },
  {
    key: 'agent',
    header: 'Agent · model',
    cell: (e) => (
      <span className="text-small text-fg-secondary">
        {e.agentId} · {e.providerModelId ?? e.model}
      </span>
    ),
  },
  { key: 'tokens', header: 'Tokens', align: 'right', cell: (e) => <Tokens count={e.tokens.total} /> },
  { key: 'cost', header: 'Cost', align: 'right', cell: (e) => <Cost nanos={e.displayCostNanos} source={e.costSource} /> },
  { key: 'duration', header: 'Time taken', align: 'right', cell: (e) => <span className="tabular">{formatDuration(e.durationMs)}</span> },
  {
    key: 'status',
    header: 'Result',
    cell: (e) => (
      <span className="flex flex-col items-start gap-0.5">
        <StatusChip visual={USAGE_EVENT_STATUS_VISUAL[e.status]} size="compact" />
        {e.attemptReason !== 'initial' ? <span className="text-small text-fg-secondary">{ATTEMPT_REASON_LABEL[e.attemptReason]}</span> : null}
      </span>
    ),
  },
];

/** Server-paginated attempt explorer (design.md §7.10). */
export function EventsTab({ state }: { state: UsageState }) {
  const events = useUsageEvents(state.query);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState(state.filters.q ?? '');
  const items = events.data?.pages.flatMap((p) => p.items) ?? [];
  const total = events.data?.pages[0]?.total ?? 0;
  const pick = (key: 'role' | 'status' | 'costSource') => (v: string) => state.update({ [key]: v === 'all' ? null : v });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <form
          role="search"
          className="flex min-w-[220px] flex-1 items-center gap-2 sm:max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            state.update({ q: search.trim() || null });
          }}
        >
          <label htmlFor="usage-search" className="sr-only">
            Search attempts
          </label>
          <Input id="usage-search" type="search" placeholder="Task, task ID, run ID or request ID" value={search} onChange={(e) => setSearch(e.target.value)} />
          <IconButton type="submit" icon={Search} label="Search" variant="secondary" />
        </form>
        <div className="w-full sm:w-44">
          <Select aria-label="Role" value={state.filters.role ?? 'all'} onValueChange={pick('role')} options={[{ value: 'all', label: 'All roles' }, ...[...ROLES, 'chairman', 'committer'].map((r) => ({ value: r, label: r }))]} />
        </div>
        <div className="w-full sm:w-44">
          <Select aria-label="Result" value={state.filters.status ?? 'all'} onValueChange={pick('status')} options={[{ value: 'all', label: 'All results' }, ...USAGE_EVENT_STATUSES.map((s) => ({ value: s, label: USAGE_EVENT_STATUS_VISUAL[s].label }))]} />
        </div>
        <div className="w-full sm:w-44">
          <Select aria-label="Cost source" value={state.filters.costSource ?? 'all'} onValueChange={pick('costSource')} options={[{ value: 'all', label: 'Any cost source' }, ...COST_SOURCES.map((s) => ({ value: s, label: COST_SOURCE_LABEL[s] }))]} />
        </div>
        {Object.keys(state.filters).length ? (
          <Button
            onClick={() => {
              setSearch('');
              state.update({ q: null, role: null, status: null, costSource: null, provider: null, model: null, agentId: null, projectId: null, taskType: null });
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      <p className="text-small text-fg-secondary" aria-live="polite">
        {events.isLoading ? 'Loading attempts…' : `${total.toLocaleString()} attempt${total === 1 ? '' : 's'} match`}
      </p>
      {events.isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <DataTable
          caption="Provider attempts"
          columns={eventColumns(setSelected)}
          rows={items}
          rowKey={(e) => e.id}
          onRowClick={(e) => setSelected(e.id)}
          empty={<EmptyState title="No attempts match" description="Change the range or the filters." />}
        />
      )}
      {events.hasNextPage ? (
        <div className="flex justify-center">
          <Button onClick={() => void events.fetchNextPage()} loading={events.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      ) : null}
      <EventDrawer eventId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
