import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  FieldGroup,
  IconButton,
  Input,
  KeyValueList,
  PageHeader,
  Panel,
  RelativeTime,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  TaskStatusChip,
  useFeedback,
} from '@acc/ui';
import {
  COMMAND_KINDS,
  COMMAND_KIND_LABEL,
  PERMISSION_LEVEL_INFO,
  ROLES,
  ROLE_LABEL,
  type GitMode,
  type PermissionLevel,
  type RepositoryCommand,
  type RoleAssignments,
} from '@acc/shared';
import { errorMessage } from '../api/client';
import { useRepository, useRepositoryMutations, useSettings, useTasks, useWorkflows } from '../api/hooks';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useConnection } from '../app/runtime';
import { AssignmentPicker } from '../components/assignment-picker';
import { useAgentNames } from '../components/agents';
import { GitState } from './RepositoriesPage';

interface Draft {
  defaultWorkflowId: string | null;
  autoApproveUpToLevel: PermissionLevel | null;
  gitMode: GitMode;
  commands: RepositoryCommand[];
  roleOverrides: RoleAssignments;
}

/** design.md §7.7 — repository defaults, commands, permissions, Git behaviour and task history. */
export function RepositoryDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const repo = useRepository(id);
  const workflows = useWorkflows();
  const settings = useSettings();
  const history = useTasks({ repositoryId: id, limit: 20 });
  const mutations = useRepositoryMutations();
  const connection = useConnection();
  const { toast } = useFeedback();
  const agentName = useAgentNames();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  useBreadcrumb([{ label: 'Repositories', to: '/repositories' }, { label: repo.data?.name ?? id }]);

  useEffect(() => {
    if (repo.data) {
      setDraft({
        defaultWorkflowId: repo.data.defaultWorkflowId,
        autoApproveUpToLevel: repo.data.autoApproveUpToLevel,
        gitMode: repo.data.gitMode,
        commands: structuredClone(repo.data.commands),
        roleOverrides: structuredClone(repo.data.roleOverrides),
      });
    }
  }, [repo.data?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const original = useMemo(
    () =>
      repo.data
        ? JSON.stringify({ defaultWorkflowId: repo.data.defaultWorkflowId, autoApproveUpToLevel: repo.data.autoApproveUpToLevel, gitMode: repo.data.gitMode, commands: repo.data.commands, roleOverrides: repo.data.roleOverrides })
        : '',
    [repo.data],
  );
  const dirty = draft !== null && JSON.stringify(draft) !== original;
  const commandErrors = (draft?.commands ?? []).map((c) => (!c.name.trim() ? 'Name is required' : !c.command.trim() ? 'Command is required' : null));

  if (repo.isLoading || !draft) return <div className="p-6"><Skeleton className="h-96" /></div>;
  if (!repo.data) return <div className="p-6"><EmptyState title="Repository not found" /></div>;
  const r = repo.data;

  const save = () =>
    mutations.update.mutate(
      { id, patch: { ...draft, commands: draft.commands.map((c) => ({ ...c, name: c.name.trim(), command: c.command.trim() })) } },
      { onSuccess: () => toast('Repository settings saved'), onError: (e) => setError(errorMessage(e)) },
    );

  const setCommand = (index: number, patch: Partial<RepositoryCommand>) =>
    setDraft({ ...draft, commands: draft.commands.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  const addCommand = () => {
    let n = draft.commands.length + 1;
    while (draft.commands.some((c) => c.id === `command-${n}`)) n++;
    setDraft({ ...draft, commands: [...draft.commands, { id: `command-${n}`, name: '', command: '', kind: 'test', enabled: true, timeoutSec: 900 }] });
  };

  return (
    <div className="flex max-w-[1100px] flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader
        title={r.name}
        description={<code className="font-mono text-code wrap-anywhere">{r.path}</code>}
        actions={
          <>
            <Button icon={RefreshCw} onClick={() => mutations.redetect.mutate(id, { onSuccess: () => toast('Tooling re-detected') })} loading={mutations.redetect.isPending} disabled={!connection.online}>
              Re-detect tooling
            </Button>
            <Button variant="primary" icon={Save} onClick={save} loading={mutations.update.isPending} disabled={!dirty || commandErrors.some(Boolean) || !connection.online} disabledReason={!dirty ? 'No unsaved changes' : 'Fix the highlighted fields first'}>
              Save Changes
            </Button>
          </>
        }
      />
      {r.status.dirty ? (
        <Banner tone="warning" title={`${r.status.dirtyCount} uncommitted change${r.status.dirtyCount === 1 ? '' : 's'} in this working tree`}>
          Tasks record them as pre-existing work at their baseline and never overwrite them. Review or commit them before starting a task to keep diffs clean.
        </Banner>
      ) : null}
      {error ? <Banner tone="danger" role="alert" title="Not saved">{error}</Banner> : null}

      <Panel title="Status" headingLevel={3}>
        <KeyValueList
          items={[
            { label: 'Working tree', value: <GitState repo={r} /> },
            { label: 'Branch', value: <code className="font-mono text-code">{r.status.branch ?? '—'}</code> },
            { label: 'Tooling', value: <span className="flex flex-wrap gap-1">{r.tooling.map((t) => <Badge key={t}>{t}</Badge>)}</span> },
            { label: 'Checked', value: <RelativeTime iso={r.status.checkedAt} /> },
          ]}
        />
      </Panel>

      <Panel title="Defaults" headingLevel={3} description="Repository defaults override global settings; each task can still override them.">
        <div className="flex flex-col gap-4">
          <Field label="Default workflow" inline>
            <Select
              value={draft.defaultWorkflowId ?? '__global__'}
              onValueChange={(v) => setDraft({ ...draft, defaultWorkflowId: v === '__global__' ? null : v })}
              options={[{ value: '__global__', label: `Global default (${workflows.data?.find((w) => w.id === settings.data?.defaultWorkflowId)?.name ?? 'Normal Development'})` }, ...(workflows.data ?? []).map((w) => ({ value: w.id, label: w.name, description: w.description }))]}
            />
          </Field>
          <Field label="Auto-approve up to" inline helper="Stages above this level wait for approval.">
            <Select
              value={draft.autoApproveUpToLevel ? String(draft.autoApproveUpToLevel) : '__global__'}
              onValueChange={(v) => setDraft({ ...draft, autoApproveUpToLevel: v === '__global__' ? null : (Number(v) as PermissionLevel) })}
              options={[
                { value: '__global__', label: `Global default (Level ${settings.data?.autoApproveUpToLevel ?? 3})` },
                ...([1, 2, 3, 4, 5] as const).map((l) => ({ value: String(l), label: `Level ${l} — ${PERMISSION_LEVEL_INFO[l].name}`, description: PERMISSION_LEVEL_INFO[l].description })),
              ]}
            />
          </Field>
          <FieldGroup label="Git behaviour" inline helper={draft.gitMode === 'task-branch' ? 'Each task works on its own branch (ai/TASK-…). Your uncommitted work comes along untouched.' : 'Tasks work on whatever branch is checked out.'}>
            <SegmentedControl<GitMode>
              label="Git behaviour"
              value={draft.gitMode}
              onValueChange={(v) => setDraft({ ...draft, gitMode: v })}
              options={[
                { value: 'task-branch', label: 'Task branch' },
                { value: 'current-branch', label: 'Current branch' },
              ]}
            />
          </FieldGroup>
        </div>
      </Panel>

      <Panel
        title="Commands"
        headingLevel={3}
        description="Verification commands run by Test stages. Dangerous commands always require approval, including inside package scripts."
        actions={
          <Button size="compact" icon={Plus} onClick={addCommand}>
            Add command
          </Button>
        }
        bodyClassName="p-0"
      >
        {draft.commands.length === 0 ? (
          <p className="px-4 py-3 text-body text-fg-secondary">No commands. Tasks will ask for approval to continue without verification.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {draft.commands.map((c, i) => (
              <li key={c.id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_160px_96px_auto] md:items-end">
                <Field label="Name" error={commandErrors[i] === 'Name is required' ? commandErrors[i] : null}>
                  <Input value={c.name} onChange={(e) => setCommand(i, { name: e.target.value })} />
                </Field>
                <Field label="Command" error={commandErrors[i] === 'Command is required' ? commandErrors[i] : null}>
                  <Input value={c.command} onChange={(e) => setCommand(i, { command: e.target.value })} className="font-mono" spellCheck={false} />
                </Field>
                <Field label="Kind">
                  <Select value={c.kind} onValueChange={(v) => setCommand(i, { kind: v as RepositoryCommand['kind'] })} options={COMMAND_KINDS.map((k) => ({ value: k, label: COMMAND_KIND_LABEL[k] }))} />
                </Field>
                <Field label="Timeout (s)">
                  <Input inputMode="numeric" value={String(c.timeoutSec)} onChange={(e) => setCommand(i, { timeoutSec: Number(e.target.value.replace(/\D/g, '')) || 5 })} />
                </Field>
                <div className="flex items-center gap-3 md:pb-1.5">
                  <Switch aria-label={`${c.name || 'Command'} enabled`} checked={c.enabled} onCheckedChange={(v) => setCommand(i, { enabled: v })} />
                  <IconButton icon={Trash2} label={`Remove ${c.name || 'command'}`} size="compact" onClick={() => setDraft({ ...draft, commands: draft.commands.filter((_, j) => j !== i) })} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Role overrides" headingLevel={3} description="Agent, model and effort for this repository. Leave a role on its global default unless this codebase needs something else.">
        <div className="flex flex-col gap-3">
          {ROLES.filter((role) => role !== 'tester').map((role) => (
            <div key={role} className="grid gap-2 md:grid-cols-[160px_minmax(0,1fr)] md:items-center">
              <span className="text-body font-semibold text-fg">{ROLE_LABEL[role]}</span>
              <AssignmentPicker
                label={ROLE_LABEL[role]}
                value={draft.roleOverrides[role] ?? {}}
                inheritLabel={`Global default (${agentName(settings.data?.roleDefaults[role]?.agentId)})`}
                onChange={(v) => {
                  const next = { ...draft.roleOverrides };
                  if (v.agentId) next[role] = v;
                  else delete next[role];
                  setDraft({ ...draft, roleOverrides: next });
                }}
              />
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Task history" headingLevel={3} bodyClassName="p-0">
        {history.data?.items.length ? (
          <ul className="divide-y divide-border-subtle">
            {history.data.items.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <TaskStatusChip status={t.status} size="compact" />
                <Link to={`/tasks/${t.id}`} className="min-w-0 flex-1 truncate text-body text-fg hover:underline">
                  <span className="font-mono text-small text-fg-secondary">{t.id}</span> {t.title}
                </Link>
                <RelativeTime iso={t.updatedAt} className="text-small text-fg-secondary" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-body text-fg-secondary">No tasks have run in this repository yet.</p>
        )}
      </Panel>

      <Panel title="Remove repository" variant="danger" headingLevel={3} description="Unregisters the folder. Files on disk are not touched. Repositories with task history cannot be removed.">
        <Button variant="destructive" icon={Trash2} onClick={() => setRemoveOpen(true)} disabled={!connection.online}>
          Remove {r.name}…
        </Button>
      </Panel>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        destructive
        title={`Remove ${r.name}?`}
        description="The repository is unregistered from the Control Center. Nothing on disk is deleted."
        confirmLabel={`Remove ${r.name}`}
        busy={mutations.remove.isPending}
        onConfirm={() =>
          mutations.remove.mutate(id, {
            onSuccess: () => {
              toast(`${r.name} removed`, 'info');
              navigate('/repositories');
            },
            onError: (e) => {
              setRemoveOpen(false);
              setError(errorMessage(e));
            },
          })
        }
      />
    </div>
  );
}
