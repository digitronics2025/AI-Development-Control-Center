import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleAlert,
  CloudDownload,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  History,
  ListTree,
  Pause,
  RefreshCw,
  Split,
  UploadCloud,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Banner,
  Button,
  EmptyState,
  PageHeader,
  RelativeTime,
  Select,
  Skeleton,
  StatusChip,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  shortSha,
  useFeedback,
  type Tone,
} from '@acc/ui';
import type { SourceControlSnapshot } from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useRepositories, useTaskCommand } from '../../api/hooks';
import { useSourceControl, useSourceControlActions } from '../../api/source-control';
import { useBreadcrumb } from '../../app/breadcrumbs';
import { useConnection, useRuntime } from '../../app/runtime';
import { ChangesView } from './ChangesView';
import { PublishDialog, SyncDialog } from './dialogs';
import { HistoryView } from './HistoryView';

const TABS = ['changes', 'history'] as const;
type TabKey = (typeof TABS)[number];

const LAST_REPOSITORY = 'acc.sourceControl.repository';

function relationVisual(s: SourceControlSnapshot): { label: string; tone: Tone; icon: LucideIcon } {
  const b = s.branch;
  if (b.detached) return { label: 'Detached HEAD', tone: 'warning', icon: AlertTriangle };
  if (b.unborn) return { label: 'No commits yet', tone: 'neutral', icon: GitCommitHorizontal };
  if (!b.upstream) return { label: 'No upstream', tone: 'neutral', icon: CloudDownload };
  if (b.upstreamGone) return { label: 'Upstream gone', tone: 'warning', icon: AlertTriangle };
  switch (b.relation) {
    case 'synced':
      return { label: 'Up to date', tone: 'success', icon: CheckCircle2 };
    case 'ahead':
      return { label: `Ahead ${b.ahead}`, tone: 'info', icon: ArrowUp };
    case 'behind':
      return { label: `Behind ${b.behind}`, tone: 'info', icon: ArrowDown };
    case 'diverged':
      return { label: `Diverged · ${b.ahead} ahead, ${b.behind} behind`, tone: 'warning', icon: Split };
    default:
      return { label: 'Unknown', tone: 'neutral', icon: CircleAlert };
  }
}

function workingTreeVisual(s: SourceControlSnapshot): { label: string; tone: Tone; icon: LucideIcon } {
  if (s.totals.conflicted) return { label: `${s.totals.conflicted} conflicted`, tone: 'danger', icon: CircleAlert };
  if (s.state.clean) return { label: 'Clean', tone: 'success', icon: CheckCircle2 };
  const count = s.changes.length + (s.changesTruncated ? 1 : 0);
  return { label: `${s.changesTruncated ? `${count - 1}+` : count} change${count === 1 ? '' : 's'}`, tone: 'warning', icon: AlertTriangle };
}

/** Persistent state banners (design.md §7.9): never toasts for things that block Git actions. */
function StateBanners({ snapshot, repositoryId }: { snapshot: SourceControlSnapshot; repositoryId: string }) {
  const task = snapshot.state.activeTask;
  const command = useTaskCommand(task?.id ?? '');
  const { toast } = useFeedback();
  const banners = [];
  if (snapshot.error) {
    banners.push(
      <Banner key="error" tone={snapshot.error.code === 'GIT_FAILED' ? 'danger' : 'warning'} title={snapshot.error.code === 'NOT_A_REPOSITORY' ? 'Not a Git repository' : 'Source Control is unavailable here'} role="status">
        {snapshot.error.message}
      </Banner>,
    );
    return <>{banners}</>;
  }
  if (task?.writing) {
    banners.push(
      <Banner
        key="task"
        tone="warning"
        role="status"
        title={`${task.id} is editing this repository`}
        actions={
          <>
            <Link to={`/tasks/${task.id}`} className="text-body font-semibold text-fg underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus">
              Open task
            </Link>
            <Button size="compact" icon={Pause} loading={command.isPending} onClick={() => command.mutate({ command: 'pause' }, { onSuccess: () => toast('Pause requested') })}>
              Pause task
            </Button>
          </>
        }
      >
        {task.stageName ? `${task.stageName} is running. ` : ''}Status, diffs and history stay available; staging, committing and syncing wait until it stops.
      </Banner>,
    );
  } else if (task) {
    banners.push(
      <Banner key="task" tone="info" role="status" title={`${task.id} has uncommitted work here`} actions={<Link to={`/tasks/${task.id}`} className="text-body font-semibold text-fg underline underline-offset-2">Open task</Link>}>
        {task.title}. Files it changed carry a “Task change” badge.
      </Banner>,
    );
  }
  if (snapshot.state.operationInProgress || snapshot.state.indexLocked || (snapshot.state.mutationBlockedReason && !task?.writing)) {
    banners.push(
      <Banner key="blocked" tone="warning" role="status" title={snapshot.state.operationInProgress ? `A ${snapshot.state.operationInProgress} is in progress` : snapshot.state.conflicted ? 'Conflicts need resolving' : 'Git actions are paused'}>
        {snapshot.state.mutationBlockedReason}
      </Banner>,
    );
  }
  if (snapshot.branch.detached) {
    banners.push(
      <Banner key="detached" tone="warning" role="status" title="Detached HEAD">
        You are not on a branch, so commits, sync and publish are unavailable. Check out a branch in your editor or terminal.
      </Banner>,
    );
  }
  if (snapshot.lastFetch && !snapshot.lastFetch.ok) {
    banners.push(
      <Banner key="fetch" tone="warning" role="status" title="The last fetch failed">
        {snapshot.lastFetch.error ?? 'The remote could not be reached.'} Local state is unchanged.
      </Banner>,
    );
  }
  void repositoryId;
  return banners.length ? <div className="flex flex-col gap-2">{banners}</div> : null;
}

/** design.md §7.9 — repository-level Git state, not a task view. */
export function SourceControlPage() {
  const { repositoryId: routeId } = useParams();
  const navigate = useNavigate();
  const repositories = useRepositories();
  const [params, setParams] = useSearchParams();
  const tab: TabKey = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabKey) : 'changes';
  const list = repositories.data ?? [];

  // Remember the last repository per viewer (a convenience only).
  let remembered: string | null = null;
  try {
    remembered = window.localStorage.getItem(LAST_REPOSITORY);
  } catch {
    /* storage unavailable */
  }
  const repositoryId = routeId ?? (list.find((r) => r.id === remembered)?.id ?? list[0]?.id);
  const repo = list.find((r) => r.id === repositoryId);

  useEffect(() => {
    if (!routeId && repositoryId) navigate(`/source-control/${repositoryId}${params.toString() ? `?${params}` : ''}`, { replace: true });
  }, [routeId, repositoryId, navigate, params]);
  useEffect(() => {
    try {
      if (repositoryId) window.localStorage.setItem(LAST_REPOSITORY, repositoryId);
    } catch {
      /* storage unavailable */
    }
  }, [repositoryId]);

  useBreadcrumb([{ label: 'Source Control', to: '/source-control' }, ...(repo ? [{ label: repo.name }] : [])]);

  const setTab = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === 'changes') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };

  const padding = 'flex flex-col gap-4 px-4 py-5 sm:px-5 md:px-6 xl:px-8';

  if (repositories.isLoading) {
    return (
      <div className={padding} aria-busy="true">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-16" />
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (!list.length) {
    return (
      <div className={padding}>
        <PageHeader title="Source Control" description="Staged and unstaged changes, history and sync for a registered repository." />
        <EmptyState
          icon={GitBranch}
          title="No repositories yet"
          description="Register a local repository to see its Git state here."
          action={
            <Button variant="primary" onClick={() => navigate('/repositories?add=1')}>
              Add repository
            </Button>
          }
        />
      </div>
    );
  }
  if (!repositoryId || (routeId && !repo)) {
    return (
      <div className={padding}>
        <PageHeader title="Source Control" />
        <EmptyState title="This repository is not registered" description="Choose a repository from the list." action={<Button onClick={() => navigate('/source-control')}>Show a registered repository</Button>} />
      </div>
    );
  }
  return <RepositorySourceControl key={repositoryId} repositoryId={repositoryId} repositoryName={repo?.name ?? ''} repositoryPath={repo?.path ?? ''} options={list.map((r) => ({ value: r.id, label: r.name, description: r.path }))} tab={tab} setTab={setTab} />;
}

function RepositorySourceControl({
  repositoryId,
  repositoryName,
  repositoryPath,
  options,
  tab,
  setTab,
}: {
  repositoryId: string;
  repositoryName: string;
  repositoryPath: string;
  options: Array<{ value: string; label: string; description: string }>;
  tab: TabKey;
  setTab: (tab: string) => void;
}) {
  const navigate = useNavigate();
  const query = useSourceControl(repositoryId);
  const actions = useSourceControlActions(repositoryId);
  const connection = useConnection();
  const { host, postToHost } = useRuntime();
  const { toast } = useFeedback();
  const [syncOpen, setSyncOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger' | 'info'; title: string; body?: string } | null>(null);
  const s = query.data;

  const offline = !connection.online ? 'Reconnect to the orchestrator first' : undefined;
  const blocked = s?.state.mutationBlockedReason ?? undefined;
  const busy = actions.fetch.isPending || actions.sync.isPending || actions.publish.isPending;

  const onFetch = () => {
    if (!s) return;
    actions.fetch.mutate(
      { expectedVersion: s.version },
      {
        onSuccess: (r) => toast(r.operation.message ?? 'Fetched'),
        onError: (e) => setNotice({ tone: 'danger', title: 'Fetch failed', body: errorMessage(e) }),
      },
    );
  };
  const onSync = () => {
    if (!s) return;
    actions.sync.mutate(
      { expectedVersion: s.version },
      {
        onSuccess: (r) => {
          setSyncOpen(false);
          const outcome = r.sync?.outcome;
          const stopped = outcome === 'diverged' || outcome === 'behind-dirty';
          setNotice(stopped ? { tone: 'warning', title: 'Sync stopped safely', body: r.operation.message ?? undefined } : null);
          if (!stopped) toast(r.operation.message ?? 'Synced');
        },
        onError: (e) => {
          setSyncOpen(false);
          setNotice({ tone: 'danger', title: 'Sync failed', body: errorMessage(e) });
        },
      },
    );
  };
  const onPublish = (remote: string) => {
    if (!s) return;
    actions.publish.mutate(
      { expectedVersion: s.version, remote },
      {
        onSuccess: (r) => {
          setPublishOpen(false);
          toast(r.operation.message ?? 'Published');
        },
        onError: (e) => {
          setPublishOpen(false);
          setNotice({ tone: 'danger', title: 'Publish failed', body: errorMessage(e) });
        },
      },
    );
  };

  const header = (
    <PageHeader
      title="Source Control"
      description="What changed, what the next commit contains, what happened in history, and whether the branch is in sync."
      actions={
        <>
          <div className="w-60 max-w-full">
            <Select aria-label="Repository" value={repositoryId} onValueChange={(id) => navigate(`/source-control/${id}${tab === 'history' ? '?tab=history' : ''}`)} options={options} />
          </div>
          <Button icon={RefreshCw} loading={actions.refresh.isPending} disabled={!connection.online} onClick={() => actions.refresh.mutate()}>
            Refresh
          </Button>
        </>
      }
    />
  );

  if (query.isLoading || !s) {
    return (
      <div className="flex flex-col gap-4 px-4 py-5 sm:px-5 md:px-6 xl:px-8" aria-busy={query.isLoading}>
        {header}
        {query.error ? <Banner tone="danger" title="Source Control could not be loaded">{errorMessage(query.error)}</Banner> : <Skeleton className="h-72" />}
      </div>
    );
  }

  const relation = relationVisual(s);
  const tree = workingTreeVisual(s);
  const canSync = !s.error && !s.branch.detached && !s.branch.unborn && Boolean(s.branch.upstream) && !s.branch.upstreamGone;
  const canPublish = !s.error && !s.branch.detached && !s.branch.unborn && (!s.branch.upstream || s.branch.upstreamGone) && s.remotes.length > 0;

  return (
    <div className="flex flex-col gap-4 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      {header}
      {!s.error ? (
        <section aria-label="Branch" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border border-border-subtle bg-surface px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-body text-fg-secondary">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-fg">
              <GitBranch size={16} aria-hidden className="shrink-0 text-fg-secondary" />
              <span className="truncate font-semibold">{s.branch.detached ? 'Detached HEAD' : (s.branch.name ?? '—')}</span>
              {s.branch.head ? (
                <>
                  <span aria-hidden>@</span>
                  <code className="font-mono text-code">{shortSha(s.branch.head)}</code>
                </>
              ) : null}
            </span>
            {s.branch.upstream ? (
              <span className="min-w-0 truncate">
                upstream <code className="font-mono text-code text-fg">{s.branch.upstream}</code>
              </span>
            ) : null}
            <StatusChip size="compact" visual={relation} />
            <StatusChip size="compact" visual={tree} />
            <span className="text-small">
              {s.lastFetch ? (
                <>
                  Last fetch <RelativeTime iso={s.lastFetch.at} />
                  {s.lastFetch.ok ? '' : ' (failed)'}
                </>
              ) : (
                'Not fetched here yet'
              )}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {host === 'vscode' && postToHost && repositoryPath ? (
              <Button size="compact" variant="ghost" icon={FolderOpen} onClick={() => postToHost({ type: 'revealRepository', repositoryPath })}>
                Reveal
              </Button>
            ) : null}
            <Button size="compact" icon={CloudDownload} loading={actions.fetch.isPending} disabled={Boolean(offline) || s.remotes.length === 0 || busy} disabledReason={offline ?? (s.remotes.length === 0 ? 'This repository has no remote' : undefined)} onClick={onFetch}>
              Fetch
            </Button>
            {canPublish ? (
              <Button size="compact" icon={UploadCloud} disabled={Boolean(offline ?? blocked) || busy} disabledReason={offline ?? blocked} onClick={() => setPublishOpen(true)}>
                Publish branch
              </Button>
            ) : (
              <Button
                size="compact"
                icon={RefreshCw}
                disabled={!canSync || Boolean(offline ?? blocked) || busy}
                disabledReason={offline ?? blocked ?? (!canSync ? 'Sync needs a branch with an upstream' : undefined)}
                onClick={() => setSyncOpen(true)}
              >
                Sync…
              </Button>
            )}
          </div>
        </section>
      ) : null}

      <StateBanners snapshot={s} repositoryId={repositoryId} />
      {notice ? (
        <Banner tone={notice.tone} title={notice.title} role="status" actions={<Button size="compact" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>}>
          {notice.body ? <span className="whitespace-pre-wrap">{notice.body}</span> : null}
        </Banner>
      ) : null}

      {!s.error ? (
        <Tabs value={tab} onValueChange={setTab}>
          <TabList label={`Source Control for ${repositoryName}`}>
            <Tab value="changes" icon={ListTree} count={s.changes.length || null}>
              Changes
            </Tab>
            <Tab value="history" icon={History}>
              History
            </Tab>
          </TabList>
          <TabPanel value="changes">
            <ChangesView repositoryId={repositoryId} repositoryPath={repositoryPath} snapshot={s} />
          </TabPanel>
          <TabPanel value="history">
            <HistoryView repositoryId={repositoryId} active={tab === 'history'} />
          </TabPanel>
        </Tabs>
      ) : null}

      {syncOpen ? <SyncDialog open={syncOpen} onOpenChange={setSyncOpen} snapshot={s} busy={actions.sync.isPending} onConfirm={onSync} /> : null}
      {publishOpen ? <PublishDialog open={publishOpen} onOpenChange={setPublishOpen} snapshot={s} busy={actions.publish.isPending} onConfirm={onPublish} /> : null}
    </div>
  );
}
