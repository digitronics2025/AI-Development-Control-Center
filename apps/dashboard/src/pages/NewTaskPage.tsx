import { FolderGit2, Paperclip, Play, Plus, Save, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Banner,
  Button,
  Checkbox,
  Combobox,
  Disclosure,
  EmptyState,
  Field,
  FieldGroup,
  Input,
  Kbd,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  SlashTextarea,
  Switch,
  formatBytes,
  useFeedback,
  useHotkey,
} from '@acc/ui';
import {
  MAX_LINKED_REPOSITORIES,
  MODE_HELP,
  PERMISSION_LEVEL_INFO,
  POLICY_MODE_DESCRIPTION,
  POLICY_MODE_LABEL,
  POLICY_MODES,
  ROLE_LABEL,
  resolveAssignment,
  type PolicyMode,
  type PartialAssignment,
  type PermissionLevel,
  type Role,
  type TaskMode,
} from '@acc/shared';
import { ApiError, errorMessage } from '../api/client';
import { useCreateTask, useRepositories, useSettings, useWorkflows } from '../api/hooks';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useConnection, useRuntime, useSelectedNode } from '../app/runtime';
import { AssignmentPicker } from '../components/assignment-picker';
import { useAgentNames } from '../components/agents';
import { RequestedSkills, useSkillPicker } from '../components/skill-picker';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface Attachment {
  name: string;
  size: number;
  contentBase64: string;
}

async function readAsBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** design.md §7.2 — fast for normal use, powerful when needed. */
export function NewTaskPage() {
  useBreadcrumb([{ label: 'Tasks', to: '/tasks' }, { label: 'New Task' }]);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const repositories = useRepositories();
  const workflows = useWorkflows();
  const settings = useSettings();
  const createTask = useCreateTask();
  const connection = useConnection();
  const { mode: runtimeMode } = useRuntime();
  const cloud = runtimeMode === 'cloud';
  const { node, nodeId } = useSelectedNode();
  const [runOn, setRunOn] = useState<'shown' | 'auto'>('shown');
  const [queue, setQueue] = useState(false);
  // Cloud: a task may be queued for an offline node, but only when asked to.
  const canSend = connection.online || (cloud && connection.linkOpen && queue && node !== null);
  const { toast } = useFeedback();
  const agentName = useAgentNames();

  const [repositoryId, setRepositoryId] = useState<string | undefined>(params.get('repo') ?? undefined);
  const [description, setDescription] = useState('');
  const [workflowId, setWorkflowId] = useState<string | undefined>();
  const [mode, setMode] = useState<TaskMode | undefined>();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [title, setTitle] = useState('');
  const [roleOverrides, setRoleOverrides] = useState<Partial<Record<Role, PartialAssignment>>>({});
  const [autoApprove, setAutoApprove] = useState<PermissionLevel | undefined>();
  const [maxFixCycles, setMaxFixCycles] = useState<string>('');
  const [policyMode, setPolicyMode] = useState<PolicyMode | undefined>();
  const [worktree, setWorktree] = useState<boolean | undefined>();
  /** Other repositories the task also works in (docs/plans/MULTI_REPO_TASKS_PLAN.md). */
  const [linkedIds, setLinkedIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const repo = repositories.data?.find((r) => r.id === repositoryId);
  const linkedRepos = linkedIds.map((id) => repositories.data?.find((r) => r.id === id)).filter((r) => r !== undefined);
  const across = linkedRepos.length > 0;
  // Across repositories the task takes the most restrictive of their defaults, as the orchestrator does.
  const selectedRepos = [repo, ...linkedRepos].filter((r) => r !== undefined);
  const defaultAutoApprove = (selectedRepos.length ? Math.min(...selectedRepos.map((r) => r.autoApproveUpToLevel ?? settings.data?.autoApproveUpToLevel ?? 3)) : (settings.data?.autoApproveUpToLevel ?? 3)) as PermissionLevel;
  const defaultPolicy: PolicyMode = selectedRepos.length
    ? POLICY_MODES[Math.min(...selectedRepos.map((r) => POLICY_MODES.indexOf(r.policyMode ?? settings.data?.execution.policyMode ?? 'autopilot')))]!
    : (settings.data?.execution.policyMode ?? 'autopilot');
  const skillPicker = useSkillPicker(repositoryId, description);
  const effectiveWorkflowId = workflowId ?? repo?.defaultWorkflowId ?? settings.data?.defaultWorkflowId ?? 'normal-development';
  const effectiveMode = mode ?? settings.data?.defaultMode ?? 'discuss';
  const workflow = workflows.data?.find((w) => w.id === effectiveWorkflowId);

  useEffect(() => {
    if (!repositoryId && repositories.data?.length === 1) setRepositoryId(repositories.data[0]!.id);
  }, [repositories.data, repositoryId]);

  const roles = useMemo(() => {
    const seen = new Set<Role>();
    for (const s of workflow?.stages ?? []) if (s.kind === 'agent') seen.add(s.role);
    return [...seen];
  }, [workflow]);

  const validate = () => {
    const next: Record<string, string> = {};
    if (!repositoryId) next.repository = 'Choose the repository this task works in.';
    if (!description.trim()) next.description = 'Describe what the task should achieve.';
    if (maxFixCycles && (!/^\d+$/.test(maxFixCycles) || Number(maxFixCycles) > 10)) next.maxFixCycles = 'Use a whole number from 0 to 10.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = (start: boolean) => {
    setServerError(null);
    if (!validate()) return;
    const cleanRoles = Object.fromEntries(Object.entries(roleOverrides).filter(([, v]) => v?.agentId));
    createTask.mutate(
      {
        title: title.trim() || undefined,
        description: description.trim(),
        repositoryId: repositoryId!,
        linkedRepositoryIds: across ? linkedIds : undefined,
        workflowId: effectiveWorkflowId,
        mode: effectiveMode,
        overrides: { roles: cleanRoles, stages: {} },
        autoApproveUpToLevel: autoApprove,
        maxFixCycles: maxFixCycles ? Number(maxFixCycles) : undefined,
        policyMode,
        worktree: across ? undefined : worktree,
        attachments: attachments.map(({ name, contentBase64 }) => ({ name, contentBase64 })),
        start,
        routing: cloud ? { ...(runOn === 'auto' && nodeId ? { 'x-acc-node': 'auto', 'x-acc-source-node': nodeId } : {}), ...(queue && !connection.online ? { 'x-acc-queue': '1' } : {}) } : undefined,
      },
      {
        onSuccess: (task) => {
          toast(start ? `${task.id} started` : `${task.id} saved as a draft`);
          navigate(`/tasks/${task.id}`);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'REMOTE_PENDING') {
            toast(`Queued: it starts when ${node?.label ?? 'the node'} is back`);
            navigate('/tasks');
            return;
          }
          setServerError(errorMessage(error));
        },
      },
    );
  };

  useHotkey('Enter', (e) => {
    e.preventDefault();
    submit(true);
  }, { mod: true, allowInInputs: true, enabled: canSend && !createTask.isPending });

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const next = [...attachments];
    for (const file of Array.from(files)) {
      if (next.length >= 10) {
        setErrors((e) => ({ ...e, attachments: 'Up to 10 files per task.' }));
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        setErrors((e) => ({ ...e, attachments: `${file.name} is larger than 10 MB.` }));
        continue;
      }
      next.push({ name: file.name, size: file.size, contentBase64: await readAsBase64(file) });
    }
    setAttachments(next);
  };

  if (repositories.isLoading || workflows.isLoading || settings.isLoading) {
    return (
      <div className="flex max-w-[760px] flex-col gap-4 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-9" />
        <Skeleton className="h-36" />
        <Skeleton className="h-9" />
      </div>
    );
  }

  if (repositories.data?.length === 0) {
    return (
      <div className="flex max-w-[760px] flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
        <PageHeader title="New Task" />
        <EmptyState
          icon={FolderGit2}
          title="Add a repository first"
          description="Tasks run inside a local repository. Register one, then come back to create the task."
          action={
            <Button variant="primary" icon={Plus} onClick={() => navigate('/repositories?add=1')}>
              Add repository
            </Button>
          }
        />
      </div>
    );
  }

  const defaultsFor = (role: Role) => {
    const def = workflow?.stages.find((s) => s.role === role && s.kind === 'agent');
    if (!def || !settings.data) return null;
    return resolveAssignment(def, { roleDefaults: settings.data.roleDefaults, repositoryOverrides: repo?.roleOverrides });
  };

  return (
    <div className="flex max-w-[760px] flex-col gap-6 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader title="New Task" description="Describe the outcome you want. The workflow handles investigation, planning, implementation, tests and review." />
      {serverError ? (
        <Banner tone="danger" role="alert" title="The task was not created">
          {serverError}
        </Banner>
      ) : null}
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit(true);
        }}
      >
        <Field label="Repository" error={errors.repository} helper={repo ? `${repo.path}${repo.status.dirty ? ` · ${repo.status.dirtyCount} uncommitted change(s) will be protected` : ''}` : undefined}>
          <Combobox
            value={repositoryId}
            onValueChange={(v) => {
              setRepositoryId(v);
              setLinkedIds((ids) => ids.filter((id) => id !== v));
              setErrors((e) => ({ ...e, repository: '' }));
            }}
            placeholder="Choose a repository"
            searchPlaceholder="Search repositories"
            options={(repositories.data ?? []).map((r) => ({ value: r.id, label: r.name, description: r.path }))}
            footer={
              <Link to="/repositories?add=1" className="flex items-center gap-2 rounded-md px-3 py-2 text-body text-fg-secondary hover:bg-muted hover:text-fg">
                <Plus size={16} aria-hidden /> Add a repository
              </Link>
            }
          />
        </Field>

        {!cloud && (repositories.data?.length ?? 0) > 1 ? (
          <div className="flex flex-col gap-2">
            <Field
              label="Also work in"
              optional
              helper={
                linkedIds.length >= MAX_LINKED_REPOSITORIES
                  ? `A task can work in at most ${MAX_LINKED_REPOSITORIES + 1} repositories.`
                  : across
                    ? 'Each repository gets its own isolated copy on a task branch, side by side; the agents change them together. Your folders are not touched.'
                    : 'Add other repositories this change spans, such as a client and its API.'
              }
            >
              <Combobox
                value={undefined}
                onValueChange={(v) => {
                  if (v && v !== repositoryId && !linkedIds.includes(v) && linkedIds.length < MAX_LINKED_REPOSITORIES) setLinkedIds((ids) => [...ids, v]);
                }}
                placeholder="Add a repository"
                searchPlaceholder="Search repositories"
                options={
                  linkedIds.length >= MAX_LINKED_REPOSITORIES
                    ? []
                    : (repositories.data ?? []).filter((r) => r.id !== repositoryId && !linkedIds.includes(r.id)).map((r) => ({ value: r.id, label: r.name, description: r.path }))
                }
              />
            </Field>
            {linkedRepos.length ? (
              <ul aria-label="Also work in" className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
                {linkedRepos.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 px-3 py-1.5">
                    <FolderGit2 size={14} className="text-fg-secondary" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-body text-fg" title={r.path}>
                      {r.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => setLinkedIds((ids) => ids.filter((id) => id !== r.id))}
                      aria-label={`Remove ${r.name}`}
                      className="rounded-sm p-1 text-fg-secondary hover:text-fg focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    >
                      <X size={14} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <Field
          label="Description"
          error={errors.description}
          helper={
            <>
              What should change, and how will you know it worked? Be specific about constraints.
              {skillPicker.available ? ' Type / to add a skill.' : null}
              <RequestedSkills names={skillPicker.requested} />
            </>
          }
        >
          <SlashTextarea
            value={description}
            onValueChange={(next) => {
              setDescription(next);
              if (errors.description) setErrors((x) => ({ ...x, description: '' }));
            }}
            {...skillPicker.textareaProps}
            placeholder="e.g. Add contact sync to the settings screen. Inspect the current architecture first and choose the safest approach."
          />
        </Field>

        <Field label="Workflow" helper={workflow ? `${workflow.stages.length} stages · up to ${workflow.maxFixCycles} fix cycles` : undefined}>
          <Select
            value={effectiveWorkflowId}
            onValueChange={setWorkflowId}
            options={(workflows.data ?? []).map((w) => ({ value: w.id, label: w.name, description: w.description || undefined }))}
          />
        </Field>

        <FieldGroup label="Mode" helper={MODE_HELP[effectiveMode]}>
          <SegmentedControl<TaskMode>
            label="Mode"
            value={effectiveMode}
            onValueChange={setMode}
            className="w-full sm:w-auto"
            options={[
              { value: 'discuss', label: 'Discuss First' },
              { value: 'autopilot', label: 'Autopilot' },
            ]}
          />
        </FieldGroup>

        <FieldGroup label="Attachments" helper={cloud ? 'Files are attached on the machine itself; tasks started from the cloud carry text only.' : 'Screenshots, logs or specs the investigator should read. Up to 10 files, 10 MB each.'}>
          <div className="flex flex-col gap-2">
            <div>
              <Button icon={Paperclip} onClick={() => fileInput.current?.click()} disabled={cloud} disabledReason="Attach files on the machine itself">
                Add files
              </Button>
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => void addFiles(e.target.files).then(() => (e.target.value = ''))} />
            </div>
            {attachments.length ? (
              <ul className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
                {attachments.map((a, i) => (
                  <li key={`${a.name}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
                    <Paperclip size={14} className="text-fg-secondary" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-body text-fg">{a.name}</span>
                    <span className="tabular text-small text-fg-secondary">{formatBytes(a.size)}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((all) => all.filter((_, j) => j !== i))}
                      aria-label={`Remove ${a.name}`}
                      className="rounded-sm p-1 text-fg-secondary hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <X size={14} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {errors.attachments ? <p className="text-small text-danger">{errors.attachments}</p> : null}
          </div>
        </FieldGroup>

        {cloud ? (
          <FieldGroup label="Run on" helper={runOn === 'auto' ? 'Any online node that has this repository and is not busy with it.' : 'The node shown in the top bar.'}>
            <div className="flex flex-col gap-3">
              <Select
                aria-label="Run on"
                value={runOn}
                onValueChange={(v) => setRunOn(v as 'shown' | 'auto')}
                options={[
                  { value: 'shown', label: node ? `${node.label} (shown)` : 'The node shown' },
                  { value: 'auto', label: 'Automatic', description: 'Pick an online node that has this repository' },
                ]}
              />
              {!connection.online && connection.linkOpen && node ? (
                <Checkbox checked={queue} onCheckedChange={setQueue} label="Run when the node is back" description={`${node.label} is offline. The task waits in the cloud for up to 24 hours and starts once the machine reconnects.`} />
              ) : null}
            </div>
          </FieldGroup>
        ) : null}

        <Disclosure title="Advanced options" description="Role overrides, agent, model, effort, permissions and retry limits">
          <div className="flex flex-col gap-5">
            <Field label="Title" optional helper="Derived from the description when left empty.">
              <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <FieldGroup label="Role overrides" helper="Only this task changes. Leave a role on its default to use repository and global settings.">
              <div className="flex flex-col gap-3">
                {roles.map((role) => {
                  const d = defaultsFor(role);
                  return (
                    <div key={role} className="flex flex-col gap-1.5">
                      <span className="text-small font-semibold text-fg-secondary">{ROLE_LABEL[role]}</span>
                      <AssignmentPicker
                        label={ROLE_LABEL[role]}
                        value={roleOverrides[role] ?? {}}
                        onChange={(v) => setRoleOverrides((all) => ({ ...all, [role]: v }))}
                        inheritLabel={d ? `Default (${agentName(d.agentId)})` : 'Default'}
                      />
                    </div>
                  );
                })}
              </div>
            </FieldGroup>
            <Field label="Auto-approve up to" helper="Stages above this permission level wait for your approval. Dangerous commands always do.">
              <Select
                value={String(autoApprove ?? defaultAutoApprove)}
                onValueChange={(v) => setAutoApprove(Number(v) as PermissionLevel)}
                options={([1, 2, 3, 4, 5] as const).map((l) => ({ value: String(l), label: `Level ${l} — ${PERMISSION_LEVEL_INFO[l].name}`, description: PERMISSION_LEVEL_INFO[l].description }))}
              />
            </Field>
            <Field label="Maximum fix cycles" error={errors.maxFixCycles} helper={`After this many review/fix loops the task waits for you. Workflow default: ${workflow?.maxFixCycles ?? 3}.`}>
              <Input inputMode="numeric" value={maxFixCycles} placeholder={String(workflow?.maxFixCycles ?? 3)} onChange={(e) => setMaxFixCycles(e.target.value)} className="w-28" />
            </Field>
            <Field label="Execution policy" helper={POLICY_MODE_DESCRIPTION[policyMode ?? defaultPolicy]}>
              <Select
                value={policyMode ?? defaultPolicy}
                onValueChange={(v) => setPolicyMode(v as PolicyMode)}
                options={POLICY_MODES.map((m) => ({ value: m, label: POLICY_MODE_LABEL[m] }))}
              />
            </Field>
            <div className="flex items-start justify-between gap-4">
              <span className="flex flex-col">
                <span className="text-body font-semibold text-fg">Isolate in a worktree</span>
                <span className="text-small text-fg-secondary">
                  {across
                    ? 'Always on for a task across repositories: each works in its own copy; your folders are not touched.'
                    : 'The task works in its own copy on its own branch; your working tree is never touched. Merge the branch afterwards.'}
                </span>
              </span>
              <Switch aria-label="Isolate in a worktree" checked={across || (worktree ?? repo?.gitMode === 'worktree')} onCheckedChange={setWorktree} disabled={across} />
            </div>
          </div>
        </Disclosure>

        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle bg-canvas px-4 py-3 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
          <span className="mr-auto hidden text-small text-fg-secondary sm:inline">
            <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> to start
          </span>
          <Button icon={Save} onClick={() => submit(false)} disabled={!canSend || createTask.isPending} disabledReason={cloud ? 'The node must be online, or tick Run when the node is back' : 'Reconnect to the orchestrator first'}>
            Save Draft
          </Button>
          <Button type="submit" variant="primary" icon={Play} loading={createTask.isPending} disabled={!canSend} disabledReason={cloud ? 'The node must be online, or tick Run when the node is back' : 'Reconnect to the orchestrator first'}>
            Start Task
          </Button>
        </div>
      </form>
    </div>
  );
}
