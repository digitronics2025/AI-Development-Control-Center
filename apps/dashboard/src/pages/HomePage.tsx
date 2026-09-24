import { Bot, CheckCircle2, FolderGit2, GitBranch, ListChecks, Plus, Server, ShieldCheck, XCircle } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  RelativeTime,
  SectionHeading,
  Skeleton,
  TaskStatusChip,
  cn,
  type Column,
} from '@acc/ui';
import type { AgentInfo, TaskSummary } from '@acc/shared';
import { useAgents, useApprovals, useHealth, useOverview, useRepositories } from '../api/hooks';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useConnection } from '../app/runtime';
import { ActiveTaskRow, repositoryLabel, repositoryNames } from '../components/task-row';

function Metric({ label, value, tone }: { label: string; value: number | undefined; tone?: 'warning' | 'danger' }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-small text-fg-secondary">{label}</dt>
      <dd className={cn('tabular text-h2 text-fg', value && tone === 'danger' && 'text-danger', value && tone === 'warning' && 'text-warning')}>{value ?? '—'}</dd>
    </div>
  );
}

function HealthRow({ icon: Icon, name, ok, detail, action }: { icon: typeof Server; name: string; ok: boolean | null; detail: React.ReactNode; action?: React.ReactNode }) {
  const StateIcon = ok === null ? null : ok ? CheckCircle2 : XCircle;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Icon size={18} className="mt-0.5 shrink-0 text-fg-secondary" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 text-body font-semibold text-fg">
          {name}
          {StateIcon ? <StateIcon size={14} className={ok ? 'text-success' : 'text-danger'} aria-hidden /> : null}
          <span className="sr-only">{ok ? 'healthy' : 'needs attention'}</span>
        </span>
        <span className="text-small text-fg-secondary wrap-anywhere">{detail}</span>
      </div>
      {action}
    </li>
  );
}

function agentOk(agent: AgentInfo): boolean {
  return agent.health.state === 'connected' && !agent.capacityBlock;
}

/** Sign-in state, or why a signed-in agent cannot run right now. */
function agentDetail(agent: AgentInfo): React.ReactNode {
  const block = agent.capacityBlock;
  if (!block || agent.health.state !== 'connected') return agent.health.message;
  return (
    <>
      Can't run now — {block.detail ?? `${block.label} exhausted`} · reported <RelativeTime iso={block.capturedAt} />. Stages assigned to it will pause; reroute them or wait.
    </>
  );
}

const recentColumns: Column<TaskSummary>[] = [
  {
    key: 'title',
    header: 'Task',
    primary: true,
    cell: (t) => (
      <div className="flex min-w-0 flex-col">
        <Link to={`/tasks/${t.id}`} className="truncate rounded-sm font-semibold text-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus">
          {t.title}
        </Link>
        <span className="tabular font-mono text-small text-fg-secondary">{t.id}</span>
      </div>
    ),
  },
  { key: 'repo', header: 'Repository', cell: (t) => <span className="text-fg-secondary" title={repositoryNames(t)}>{repositoryLabel(t)}</span> },
  { key: 'status', header: 'Status', cell: (t) => <TaskStatusChip status={t.status} size="compact" /> },
  { key: 'updated', header: 'Updated', cell: (t) => <RelativeTime iso={t.updatedAt} className="text-fg-secondary" />, sortValue: (t) => t.updatedAt },
];

/** design.md §7.1 — "What needs my attention now?" */
export function HomePage() {
  useBreadcrumb([{ label: 'Home' }]);
  const navigate = useNavigate();
  const overview = useOverview();
  const approvals = useApprovals('pending');
  const agents = useAgents();
  const repositories = useRepositories();
  const health = useHealth();
  const connection = useConnection();

  const data = overview.data;
  const disconnectedAgents = (agents.data ?? []).filter((a) => a.settings.enabled && !agentOk(a));
  const blocked = (data?.attention ?? []).filter((t) => !(t.blocker?.kind === 'approval'));
  const pendingApprovals = approvals.data ?? [];
  const noRepos = repositories.data?.length === 0;
  const noTasks = data && data.recent.length === 0;

  return (
    <div className="flex flex-col gap-6 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader title="Home" description="Running work, anything waiting for you, and service health." />

      {pendingApprovals.length > 0 || blocked.length > 0 || disconnectedAgents.length > 0 ? (
        <section aria-label="Needs attention" className="flex flex-col gap-2">
          {pendingApprovals.length > 0 ? (
            <Banner
              tone="warning"
              title={`${pendingApprovals.length} approval${pendingApprovals.length === 1 ? '' : 's'} waiting for you`}
              actions={
                <Button size="compact" variant="primary" icon={ShieldCheck} onClick={() => navigate('/approvals')}>
                  Review approvals
                </Button>
              }
            >
              {pendingApprovals.slice(0, 3).map((a) => `${a.taskId}: ${a.action}`).join(' · ')}
            </Banner>
          ) : null}
          {blocked.length > 0 ? (
            <Banner tone="warning" title={`${blocked.length} task${blocked.length === 1 ? '' : 's'} blocked`}>
              <ul className="flex flex-col gap-1">
                {blocked.slice(0, 4).map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks/${t.id}`} className="font-semibold underline-offset-2 hover:underline">
                      {t.id} {t.title}
                    </Link>
                    <span className="text-fg-secondary"> — {t.blocker?.message ?? t.status}</span>
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {disconnectedAgents.length > 0 ? (
            <Banner
              tone="danger"
              title={`${disconnectedAgents.map((a) => a.name).join(' and ')} unavailable`}
              actions={
                <Button size="compact" icon={Bot} onClick={() => navigate('/agents')}>
                  Open Agents
                </Button>
              }
            >
              {disconnectedAgents.map((a) => (
                <span key={a.id} className="block">
                  {disconnectedAgents.length > 1 ? `${a.name}: ` : null}
                  {agentDetail(a)}
                </span>
              ))}
            </Banner>
          ) : null}
        </section>
      ) : null}

      <dl aria-label="Summary" className="grid grid-cols-2 gap-4 rounded-lg border border-border-subtle bg-surface px-4 py-3 sm:grid-cols-4">
        <Metric label="Active" value={data?.counts.active} />
        {/* Tasks parked on an approval are already WAITING_FOR_USER, so approvals are not added again. */}
        <Metric label="Waiting for me" value={data?.counts.waitingForMe} tone="warning" />
        <Metric label="Failed" value={data?.counts.failed} tone="danger" />
        <Metric label="Completed today" value={data?.counts.completedToday} />
      </dl>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="active-heading" className="flex flex-col gap-3">
            <SectionHeading id="active-heading" actions={<Link to="/tasks" className="text-body text-fg-secondary hover:text-fg">All tasks</Link>}>
              Active Tasks
            </SectionHeading>
            {overview.isLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            ) : noRepos ? (
              <EmptyState
                icon={FolderGit2}
                title="Add a repository first"
                description="Tasks run inside a local Git repository. Register one to start your first AI development workflow."
                action={
                  <Button variant="primary" icon={Plus} onClick={() => navigate('/repositories?add=1')} disabled={!connection.online}>
                    Add repository
                  </Button>
                }
              />
            ) : noTasks ? (
              <EmptyState
                icon={ListChecks}
                title="No tasks yet"
                description="Create your first task to start an AI development workflow."
                action={
                  <Button variant="primary" icon={Plus} onClick={() => navigate('/tasks/new')} disabled={!connection.online}>
                    New Task
                  </Button>
                }
              />
            ) : (data?.active.length ?? 0) + (data?.attention.length ?? 0) === 0 ? (
              <p className="rounded-lg border border-border-subtle bg-surface px-4 py-3 text-body text-fg-secondary">Nothing is running. Recent tasks are below.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-surface">
                {[...(data?.attention ?? []), ...(data?.active ?? [])]
                  .filter((t, i, all) => all.findIndex((x) => x.id === t.id) === i)
                  .map((t) => (
                    <ActiveTaskRow key={t.id} task={t} />
                  ))}
              </ul>
            )}
          </section>

          {data && data.recent.length > 0 ? (
            <section aria-labelledby="recent-heading" className="flex flex-col gap-3">
              <SectionHeading id="recent-heading">Recent Tasks</SectionHeading>
              <DataTable caption="Recent tasks" columns={recentColumns} rows={data.recent} rowKey={(t) => t.id} onRowClick={(t) => navigate(`/tasks/${t.id}`)} />
            </section>
          ) : null}
        </div>

        <Panel title="System Health" as="aside" className="self-start">
          <ul className="-my-2 divide-y divide-border-subtle">
            <HealthRow
              icon={Server}
              name="Orchestrator"
              ok={connection.online}
              detail={connection.online ? `Connected${health.data ? ` · v${health.data.version} · ${health.data.billingMode === 'subscription' ? 'Subscription Only' : 'Explicit API Mode'}` : ''}` : 'Disconnected — showing last known state'}
            />
            {(agents.data ?? []).map((agent) => (
              <HealthRow
                key={agent.id}
                icon={Bot}
                name={agent.name}
                ok={agent.settings.enabled ? agentOk(agent) : null}
                detail={agentDetail(agent)}
                action={
                  agent.health.checkedAt ? (
                    <span className="shrink-0 text-small text-fg-secondary">
                      Checked <RelativeTime iso={agent.health.checkedAt} />
                    </span>
                  ) : undefined
                }
              />
            ))}
            <HealthRow
              icon={GitBranch}
              name="Git"
              ok={health.data ? health.data.git.found : null}
              detail={health.data ? (health.data.git.found ? `git ${health.data.git.version ?? ''} available for local execution` : 'Git was not found on PATH') : 'Checking…'}
            />
          </ul>
        </Panel>
      </div>
    </div>
  );
}
