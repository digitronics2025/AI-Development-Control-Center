import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, CircleAlert, CloudDownload, CloudOff, FolderGit2, FolderOpen, FolderPlus, GitFork, Globe, Lock, Plus, RefreshCw, TriangleAlert, Unlink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  RelativeTime,
  SegmentedControl,
  Skeleton,
  StatusChip,
  useFeedback,
  type Column,
  type SegmentOption,
} from '@acc/ui';
import { isCloneFolderName, parseCloneUrl, type Repository, type RepositoryDownloadSkip, type RepositoryAutomationStatus, type RepositorySyncResult, type Settings } from '@acc/shared';
import { errorMessage } from '../api/client';
import { useCloneDefaults, useRepositories, useRepositoryAutomation, useRepositoryMutations, useRunRepositoryAutomation, useSettings, useWorkflows } from '../api/hooks';
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
export function RemoteState({ repo, sync }: { repo: Repository; sync?: RepositorySyncResult }) {
  const { upstream, ahead, behind } = repo.status;
  if (!repo.status.isGitRepo) return <span className="text-fg-secondary">—</span>;
  // The last background check knows what status alone cannot: whether the remote still answers.
  if (sync?.outcome === 'remote-gone') {
    return (
      <span title={sync.message}>
        <StatusChip size="compact" visual={{ label: 'Remote deleted', tone: 'neutral', icon: Unlink }} />
      </span>
    );
  }
  if (sync?.outcome === 'failed') {
    return (
      <span title={sync.message}>
        <StatusChip size="compact" visual={{ label: 'Unreachable', tone: 'warning', icon: CircleAlert }} />
      </span>
    );
  }
  if (!upstream || ahead === null || behind === null) return <StatusChip size="compact" visual={{ label: 'No upstream', tone: 'neutral', icon: CloudOff }} />;
  if (ahead > 0 && behind > 0) return <StatusChip size="compact" visual={{ label: `Diverged (${ahead} up, ${behind} down)`, tone: 'warning', icon: GitFork }} />;
  if (behind > 0) return <StatusChip size="compact" visual={{ label: `${plural(behind, 'commit')} to download`, tone: 'info', icon: ArrowDownToLine }} />;
  if (ahead > 0) return <StatusChip size="compact" visual={{ label: `${plural(ahead, 'commit')} to upload`, tone: 'info', icon: ArrowUpFromLine }} />;
  return <StatusChip size="compact" visual={{ label: 'Up to date', tone: 'success', icon: CheckCircle2 }} />;
}

const SKIP_LABEL: Record<RepositoryDownloadSkip, string> = {
  archived: 'archived',
  fork: 'a fork',
  'too-large': 'too large',
  'folder-taken': 'a folder with that name is already used',
};

/** The one quiet line above the list: what automation does and what its last run changed. */
function AutomationSummary({ status, settings }: { status: RepositoryAutomationStatus | undefined; settings: Settings | undefined }) {
  if (!settings || !status) return null;
  const { discover, sync, intervalMinutes, githubAccounts } = settings.repositoryAutomation;
  const settingsLink = (
    <Link to="/settings/repositories" className="text-fg underline">
      Settings → Repositories
    </Link>
  );
  if (!discover && !sync) return <p className="text-small text-fg-secondary">Automatic updates are off. Turn them on in {settingsLink}.</p>;
  const fromGitHub = discover && githubAccounts.length ? ` (also downloaded from GitHub: ${githubAccounts.join(', ')})` : '';
  const what = [discover ? `new repositories are added${fromGitHub}` : null, sync ? 'new commits are downloaded' : null].filter(Boolean).join(' and ');
  const run = status.lastRun;
  const changes: string[] = [];
  if (run?.discovery?.added.length) changes.push(plural(run.discovery.added.length, 'new repository', 'new repositories'));
  if (run?.downloads?.downloaded.length) changes.push(`downloaded ${run.downloads.downloaded.map((d) => d.name).join(', ')} from GitHub`);
  // Named with a short label (the full reason is in the run report), so a skipped repository is never a mystery.
  if (run?.downloads?.skipped.length) changes.push(`not downloaded from GitHub: ${run.downloads.skipped.map((s) => `${s.remote.replace(/^github\.com\//, '')} (${SKIP_LABEL[s.kind]})`).join('; ')}`);
  if (run?.downloads?.errors.length) changes.push(`GitHub could not be checked for ${run.downloads.errors.map((e) => e.subject).join(', ')}`);
  if (run?.sync?.['fast-forwarded']) changes.push(`${plural(run.sync['fast-forwarded'], 'repository', 'repositories')} updated`);
  if (run?.sync?.failed) changes.push(`${plural(run.sync.failed, 'repository', 'repositories')} could not be reached`);
  if (run?.sync?.['remote-gone']) changes.push(`${plural(run.sync['remote-gone'], 'repository', 'repositories')} whose online copy was deleted`);
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

type AddSource = 'local' | 'online' | 'new';

const ADD_SOURCES: SegmentOption<AddSource>[] = [
  { value: 'local', label: 'On this computer', icon: FolderOpen },
  { value: 'online', label: 'From GitHub', icon: CloudDownload },
  { value: 'new', label: 'Create new', icon: FolderPlus },
];

const VISIBILITIES: SegmentOption<'private' | 'public'>[] = [
  { value: 'private', label: 'Private', icon: Lock },
  { value: 'public', label: 'Public', icon: Globe },
];

const DESCRIPTIONS: Record<AddSource, string> = {
  local: 'A local folder, normally a Git repository. Lint, test and build commands are detected from its files.',
  online: 'A repository that is only online, such as one you just created on GitHub. A copy is downloaded into a new folder and added.',
  new: 'A brand-new repository with a README. It is made on this computer, and on GitHub too if you choose.',
};

const SUBMIT_LABEL: Record<AddSource, string> = { local: 'Add repository', online: 'Download and add', new: 'Create repository' };

export function AddRepositoryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [source, setSource] = useState<AddSource>('local');
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [parentFolder, setParentFolder] = useState('');
  const [name, setName] = useState('');
  const [newName, setNewName] = useState('');
  const [description, setDescription] = useState('');
  const [onGitHub, setOnGitHub] = useState(true);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [error, setError] = useState<string | null>(null);
  const { add, clone, create } = useRepositoryMutations();
  const defaults = useCloneDefaults(open && source !== 'local');
  const { pickFolder } = useRuntime();
  const { toast } = useFeedback();
  const navigate = useNavigate();
  const parsed = parseCloneUrl(url);
  // Without its trailing separator, so the preview never shows a doubled one.
  const cloneParent = (parentFolder.trim() || defaults.data?.parentFolder || '').replace(/[\\/]+$/, '');
  const inParent = (folder: string) => `${cloneParent}${cloneParent.includes('/') ? '/' : '\\'}${folder}`;
  const done = (repo: Repository, verb: string) => {
    toast(`${repo.name} ${verb}`);
    onOpenChange(false);
    setPath('');
    setUrl('');
    setParentFolder('');
    setName('');
    setNewName('');
    setDescription('');
    navigate(`/repositories/${repo.id}`);
  };
  const submit = () => {
    if (source === 'new') {
      if (!isCloneFolderName(newName.trim())) {
        setError('Use letters, digits, dot, dash and underscore only, for example my-app.');
        return;
      }
      create.mutate(
        { name: newName.trim(), parentFolder: parentFolder.trim() || undefined, github: onGitHub, visibility, description: description.trim() },
        {
          onSuccess: ({ repository, github }) => {
            if (github && !github.ok) toast(`${repository.name} was created on this computer, but not on GitHub: ${github.message}`, 'info');
            done(repository, github?.ok ? 'created here and on GitHub' : 'created');
          },
          onError: (e) => setError(errorMessage(e)),
        },
      );
      return;
    }
    if (source === 'online') {
      if (!parsed) {
        setError('Enter a GitHub "owner/name", or an https://, ssh:// or git@ address.');
        return;
      }
      clone.mutate(
        { url: url.trim(), parentFolder: parentFolder.trim() || undefined, name: name.trim() || undefined },
        { onSuccess: (repo) => done(repo, 'downloaded and added'), onError: (e) => setError(errorMessage(e)) },
      );
      return;
    }
    if (!path.trim()) {
      setError('Enter the folder path of a local repository.');
      return;
    }
    add.mutate({ path: path.trim(), name: name.trim() || undefined }, { onSuccess: (repo) => done(repo, 'added'), onError: (e) => setError(errorMessage(e)) });
  };
  const pending = add.isPending || clone.isPending || create.isPending;
  const parentField = (
    <Field
      label="Save in folder"
      optional
      helper={defaults.data ? `Defaults to ${defaults.data.parentFolder}. A new folder is created inside it.` : 'A new folder is created inside it.'}
      addon={
        pickFolder ? (
          <Button icon={FolderOpen} onClick={() => void pickFolder().then((p) => p && setParentFolder(p))}>
            Browse…
          </Button>
        ) : null
      }
    >
      <Input value={parentFolder} onChange={(e) => setParentFolder(e.target.value)} className="font-mono" spellCheck={false} placeholder={defaults.data?.parentFolder} />
    </Field>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setError(null);
        onOpenChange(next);
      }}
      title="Add repository"
      description={DESCRIPTIONS[source]}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending}>
            {SUBMIT_LABEL[source]}
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
        <SegmentedControl
          label="Where the repository is"
          value={source}
          onValueChange={(next) => {
            setError(null);
            setSource(next);
          }}
          options={ADD_SOURCES}
          disabled={pending}
        />
        {source === 'local' && (
          <Field
            label="Folder path"
            error={error}
            helper={'For example C:\\Users\\you\\code\\my-app'}
            addon={
              pickFolder ? (
                <Button icon={FolderOpen} onClick={() => void pickFolder().then((p) => p && setPath(p))}>
                  Browse…
                </Button>
              ) : null
            }
          >
            <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" autoFocus spellCheck={false} />
          </Field>
        )}
        {source === 'online' && (
          <>
            <Field
              label="Repository address"
              error={error}
              helper={parsed && cloneParent ? `Will be saved in ${inParent(parsed.folderName)}` : 'For example owner/my-app, or the address from GitHub’s green Code button.'}
            >
              <Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono" autoFocus spellCheck={false} placeholder="owner/my-app" />
            </Field>
            {parentField}
          </>
        )}
        {source === 'new' && (
          <>
            <Field
              label="Name"
              error={error}
              helper={isCloneFolderName(newName.trim()) && cloneParent ? `Will be created in ${inParent(newName.trim())}` : 'Letters, digits, dot, dash and underscore, for example my-app.'}
            >
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} className="font-mono" autoFocus spellCheck={false} placeholder="my-app" />
            </Field>
            <Field label="Description" optional helper="Goes into the README, and on GitHub under the name.">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={350} />
            </Field>
            {parentField}
            <Checkbox
              checked={onGitHub}
              onCheckedChange={setOnGitHub}
              label="Also create it on GitHub"
              description="Made under the account the GitHub CLI is signed in to, and the first commit is uploaded. Leave this off to keep it on this computer only."
              disabled={pending}
            />
            {onGitHub && <SegmentedControl label="Who can see it on GitHub" value={visibility} onValueChange={setVisibility} options={VISIBILITIES} size="compact" disabled={pending} />}
          </>
        )}
        {source !== 'new' && (
          <Field label="Display name" optional helper="Defaults to the folder name.">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
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
  const syncResults = new Map((automation.data?.results ?? []).map((r) => [r.repositoryId, r]));
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
    { key: 'remote', header: 'Remote', sortValue: (r) => (r.status.behind ?? -1) * 1000 + (r.status.ahead ?? 0), cell: (r) => <RemoteState repo={r} sync={syncResults.get(r.id)} /> },
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
