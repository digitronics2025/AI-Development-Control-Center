import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, CircleAlert, CloudOff, FolderGit2, FolderOpen, GitFork, Plus, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  RelativeTime,
  Skeleton,
  StatusChip,
  useFeedback,
  type Column,
} from '@acc/ui';
import type { Repository, RepositoryAutomationStatus, Settings } from '@acc/shared';
import { errorMessage } from '../api/client';
import { useRepositories, useRepositoryAutomation, useRepositoryMutations, useRunRepositoryAutomation, useSettings, useWorkflows } from '../api/hooks';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useConnection, useRuntime } from '../app/runtime';

export function GitState({ repo }: { repo: Repository }) {
  if (!repo.status.available) return <StatusChip size="compact" visual={{ label: 'Folder missing', tone: 'danger', icon: CircleAlert }} />;
  if (!repo.status.isGitRepo) return <StatusChip size="compact" visual={{ label: 'Not a Git repository', tone: 'warning', icon: TriangleAlert }} />;
  if (repo.status.dirty) return <StatusChip size="compact" visual={{ label: `${repo.status.dirtyCount} uncommitted`, tone: 'warning', icon: TriangleAlert }} />;
  return <StatusChip size="compact" visual={{ label: 'Clean', tone: 'success', icon: CheckCircle2 }} />;
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Where the branch stands against its upstream, as of the last fetch. */
export function RemoteState({ repo }: { repo: Repository }) {
  const { upstream, ahead, behind } = repo.status;
  if (!repo.status.isGitRepo) return <span className="text-fg-secondary">—</span>;
  if (!upstream || ahead === null || behind === null) return <StatusChip size="compact" visual={{ label: 'No upstream', tone: 'neutral', icon: CloudOff }} />;
  if (ahead > 0 && behind > 0) return <StatusChip size="compact" visual={{ label: `Diverged (${ahead} up, ${behind} down)`, tone: 'warning', icon: GitFork }} />;
  if (behind > 0) return <StatusChip size="compact" visual={{ label: `${plural(behind, 'commit')} to download`, tone: 'info', icon: ArrowDownToLine }} />;
  if (ahead > 0) return <StatusChip size="compact" visual={{ label: `${plural(ahead, 'commit')} to upload`, tone: 'info', icon: ArrowUpFromLine }} />;
  return <StatusChip size="compact" visual={{ label: 'Up to date', tone: 'success', icon: CheckCircle2 }} />;
}

/** The one quiet line above the list: what automation does and what its last run changed. */
function AutomationSummary({ status, settings }: { status: RepositoryAutomationStatus | undefined; settings: Settings | undefined }) {
  if (!settings || !status) return null;
  const { discover, sync, intervalMinutes } = settings.repositoryAutomation;
  const settingsLink = (
    <Link to="/settings/repositories" className="text-fg underline">
      Settings → Repositories
    </Link>
  );
  if (!discover && !sync) return <p className="text-small text-fg-secondary">Automatic updates are off. Turn them on in {settingsLink}.</p>;
  const what = [discover ? 'new repositories are added' : null, sync ? 'new commits are downloaded' : null].filter(Boolean).join(' and ');
  const run = status.lastRun;
  const changes: string[] = [];
  if (run?.discovery?.added.length) changes.push(plural(run.discovery.added.length, 'new repository', 'new repositories'));
  if (run?.sync?.['fast-forwarded']) changes.push(`${plural(run.sync['fast-forwarded'], 'repository', 'repositories')} updated`);
  if (run?.sync?.failed) changes.push(`${plural(run.sync.failed, 'repository', 'repositories')} could not be reached`);
  return (
    <p className="text-small text-fg-secondary" aria-live="polite">
      Every {plural(intervalMinutes, 'minute')}, {what} automatically; uploads are never automatic.{' '}
      {status.running ? (
        'Checking now…'
      ) : run?.finishedAt ? (
        <>
          Last checked <RelativeTime iso={run.finishedAt} />
          {changes.length ? `: ${changes.join(', ')}.` : ', nothing new.'}
        </>
      ) : null}{' '}
      Change this in {settingsLink}.
    </p>
  );
}

export function AddRepositoryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { add } = useRepositoryMutations();
  const { pickFolder } = useRuntime();
  const { toast } = useFeedback();
  const navigate = useNavigate();
  const submit = () => {
    if (!path.trim()) {
      setError('Enter the folder path of a local repository.');
      return;
    }
    add.mutate(
      { path: path.trim(), name: name.trim() || undefined },
      {
        onSuccess: (repo) => {
          toast(`${repo.name} added`);
          onOpenChange(false);
          setPath('');
          setName('');
          navigate(`/repositories/${repo.id}`);
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setError(null);
        onOpenChange(next);
      }}
      title="Add repository"
      description="A local folder, normally a Git repository. Lint, test and build commands are detected from its files."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={add.isPending}>
            Add repository
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Folder path" error={error} helper="For example C:\\Users\\you\\code\\my-app">
          <div className="flex gap-2">
            <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" autoFocus spellCheck={false} />
            {pickFolder ? (
              <Button icon={FolderOpen} onClick={() => void pickFolder().then((p) => p && setPath(p))}>
                Browse…
              </Button>
            ) : null}
          </div>
        </Field>
        <Field label="Display name" optional helper="Defaults to the folder name.">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** design.md §7.7 — repository list. */
export function RepositoriesPage() {
  useBreadcrumb([{ label: 'Repositories' }]);
  const repositories = useRepositories();
  const workflows = useWorkflows();
  const automation = useRepositoryAutomation();
  const runAutomation = useRunRepositoryAutomation();
  const settings = useSettings();
  const automationOff = settings.data ? !settings.data.repositoryAutomation.discover && !settings.data.repositoryAutomation.sync : false;
  const navigate = useNavigate();
  const connection = useConnection();
  const [params, setParams] = useSearchParams();
  const [addOpen, setAddOpen] = useState(params.get('add') === '1');
  useEffect(() => {
    if (params.get('add') === '1') {
      const next = new URLSearchParams(params);
      next.delete('add');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  const workflowName = (id: string | null) => (id ? (workflows.data?.find((w) => w.id === id)?.name ?? id) : 'Global default');

  const columns: Column<Repository>[] = [
    {
      key: 'name',
      header: 'Name',
      primary: true,
      sortValue: (r) => r.name.toLowerCase(),
      cell: (r) => (
        <div className="flex min-w-0 flex-col">
          <Link to={`/repositories/${r.id}`} onClick={(e) => e.stopPropagation()} className="truncate rounded-sm font-semibold text-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus">
            {r.name}
          </Link>
          <span className="truncate font-mono text-small text-fg-secondary" title={r.path}>
            {r.path}
          </span>
        </div>
      ),
      className: 'max-w-[320px]',
    },
    {
      key: 'branch',
      header: 'Branch',
      // Task branches are long; keep the row one line tall and show the full name on hover.
      cell: (r) => (
        <code className="block max-w-[180px] truncate font-mono text-code text-fg" title={r.status.branch ?? undefined}>
          {r.status.branch ?? '—'}
        </code>
      ),
    },
    { key: 'git', header: 'Working tree', sortValue: (r) => (r.status.dirty ? 1 : 0), cell: (r) => <GitState repo={r} /> },
    { key: 'remote', header: 'Remote', sortValue: (r) => (r.status.behind ?? -1) * 1000 + (r.status.ahead ?? 0), cell: (r) => <RemoteState repo={r} /> },
    {
      key: 'tooling',
      header: 'Tooling',
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.tooling.filter((t) => t !== 'git').slice(0, 4).map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      ),
    },
    { key: 'workflow', header: 'Default workflow', cell: (r) => <span className="text-fg-secondary">{workflowName(r.defaultWorkflowId)}</span> },
    {
      key: 'last',
      header: 'Last task',
      cell: (r) =>
        r.lastTaskId ? (
          <Link to={`/tasks/${r.lastTaskId}`} onClick={(e) => e.stopPropagation()} className="font-mono text-small text-fg hover:underline">
            {r.lastTaskId}
          </Link>
        ) : (
          <span className="text-fg-secondary">—</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader
        title="Repositories"
        description="Local repositories tasks can work in. Uncommitted work is always protected."
        actions={
          <>
            <Button
              icon={RefreshCw}
              onClick={() => runAutomation.mutate()}
              loading={runAutomation.isPending || automation.data?.running}
              disabled={!connection.online || automationOff}
              disabledReason={automationOff ? 'Automatic updates are off in Settings → Repositories' : 'Reconnect to the orchestrator first'}
            >
              Check now
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setAddOpen(true)} disabled={!connection.online} disabledReason="Reconnect to the orchestrator first">
              Add repository
            </Button>
          </>
        }
      />
      <AutomationSummary status={automation.data} settings={settings.data} />
      {repositories.isLoading ? (
        <Skeleton className="h-48" />
      ) : (
        <DataTable
          caption="Repositories"
          columns={columns}
          rows={repositories.data ?? []}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/repositories/${r.id}`)}
          empty={
            <EmptyState
              icon={FolderGit2}
              title="No repositories yet"
              description="Add the local folder of a project you want AI agents to work on."
              action={
                <Button variant="primary" icon={Plus} onClick={() => setAddOpen(true)} disabled={!connection.online}>
                  Add repository
                </Button>
              }
            />
          }
        />
      )}
      <AddRepositoryDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
