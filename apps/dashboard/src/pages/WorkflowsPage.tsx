import { ArrowDown, ArrowUp, Copy, Lock, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Panel,
  PermissionBadge,
  Select,
  Skeleton,
  cn,
  useBreakpoint,
  useFeedback,
} from '@acc/ui';
import {
  COMMAND_KINDS,
  COMMAND_KIND_LABEL,
  COMPLETE,
  PERMISSION_LEVEL_INFO,
  ROLES,
  ROLE_LABEL,
  STAGE_KINDS,
  validateWorkflow,
  type CommandKind,
  type PermissionLevel,
  type StageDefinition,
  type WorkflowIssue,
  type WorkflowProfile,
} from '@acc/shared';
import { errorMessage } from '../api/client';
import { useSettings, useWorkflowMutations, useWorkflows } from '../api/hooks';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useConnection } from '../app/runtime';
import { AssignmentPicker } from '../components/assignment-picker';
import { useAgentNames } from '../components/agents';

const KIND_LABEL: Record<(typeof STAGE_KINDS)[number], string> = { agent: 'Agent', tests: 'Tests (system)', command: 'Command (system)', git: 'Git checkpoint (system)', verify: 'App verification (system)', release: 'Release (system, Level 5)' };

function issuesFor(issues: WorkflowIssue[], index: number | null, field?: string) {
  return issues.filter((i) => i.stageIndex === index && (field === undefined || i.field === field || i.field.startsWith(`${field}.`)));
}

function StageInspector({
  stage,
  index,
  stages,
  issues,
  readOnly,
  onChange,
}: {
  stage: StageDefinition;
  index: number;
  stages: StageDefinition[];
  issues: WorkflowIssue[];
  readOnly: boolean;
  onChange: (next: StageDefinition) => void;
}) {
  const settings = useSettings();
  const names = useAgentNames();
  const err = (field: string) => issuesFor(issues, index, field)[0]?.message ?? null;
  const targets = [...stages.filter((s) => s.key !== stage.key).map((s) => ({ value: s.key, label: s.name, description: s.key })), { value: COMPLETE, label: 'Complete', description: 'Finish the task' }];
  const set = <K extends keyof StageDefinition>(key: K, value: StageDefinition[K]) => onChange({ ...stage, [key]: value });
  const roleDefault = settings.data?.roleDefaults[stage.role];
  return (
    <fieldset disabled={readOnly} className="flex flex-col gap-4">
      <legend className="sr-only">Stage {stage.name}</legend>
      <Field label="Name" error={err('name')}>
        <Input value={stage.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="Key" error={err('key')} helper="Used in transitions and branch names. Lowercase letters, digits and dashes.">
        <Input value={stage.key} onChange={(e) => set('key', e.target.value)} className="font-mono" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Role">
          <Select value={stage.role} onValueChange={(v) => set('role', v as StageDefinition['role'])} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} disabled={readOnly} />
        </Field>
        <Field label="Runs as" error={err('kind')}>
          <Select value={stage.kind} onValueChange={(v) => set('kind', v as StageDefinition['kind'])} options={STAGE_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} disabled={readOnly} />
        </Field>
      </div>
      {stage.kind === 'agent' ? (
        <Field label="Agent, model and effort" error={err('agentId')} helper="Pinning is optional; by default the role's assignment applies (global → repository → task).">
          <AssignmentPicker
            label={stage.name}
            disabled={readOnly}
            value={{ agentId: stage.agentId, model: stage.model, effort: stage.effort }}
            inheritLabel={`Role default (${names(roleDefault?.agentId)})`}
            onChange={(v) => onChange({ ...stage, agentId: v.agentId, model: v.agentId ? v.model : undefined, effort: v.agentId ? v.effort : undefined })}
          />
        </Field>
      ) : (
        <Field label="Commands to run" error={err('commandKinds')} helper={stage.kind === 'tests' ? 'Defaults to lint, typecheck, unit tests and build when none are chosen.' : 'Repository commands of these kinds run in this stage.'}>
          <div className="grid grid-cols-2 gap-2">
            {COMMAND_KINDS.map((k) => (
              <Checkbox
                key={k}
                disabled={readOnly || stage.kind === 'git'}
                checked={stage.commandKinds?.includes(k) ?? false}
                onCheckedChange={(checked) => {
                  const current = new Set<CommandKind>(stage.commandKinds ?? []);
                  if (checked) current.add(k);
                  else current.delete(k);
                  set('commandKinds', current.size ? [...current] : undefined);
                }}
                label={COMMAND_KIND_LABEL[k]}
              />
            ))}
          </div>
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Timeout (seconds)" error={err('timeoutSec')}>
          <Input inputMode="numeric" value={String(stage.timeoutSec)} onChange={(e) => set('timeoutSec', Number(e.target.value.replace(/\D/g, '')) || 0)} />
        </Field>
        <Field label="Attempts on failure" error={err('retry')} helper="Automatic retries for crashes and timeouts.">
          <Select value={String(stage.retry.maxAttempts)} onValueChange={(v) => set('retry', { maxAttempts: Number(v) })} options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: n === 1 ? '1 (no retry)' : String(n) }))} disabled={readOnly} />
        </Field>
      </div>
      <Field label="Permission level" error={err('permissionLevel')}>
        <Select
          value={String(stage.permissionLevel)}
          onValueChange={(v) => set('permissionLevel', Number(v) as PermissionLevel)}
          disabled={readOnly}
          options={([1, 2, 3, 4, 5] as const).map((l) => ({ value: String(l), label: `Level ${l} — ${PERMISSION_LEVEL_INFO[l].name}`, description: PERMISSION_LEVEL_INFO[l].description }))}
        />
      </Field>
      <Checkbox checked={stage.requiresApproval} onCheckedChange={(v) => set('requiresApproval', v)} disabled={readOnly} label="Always require approval" description="Wait for a human before this stage starts, whatever the auto-approve level." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Next transition" error={err('next')}>
          <Select value={stage.next} onValueChange={(v) => set('next', v)} options={targets} disabled={readOnly} />
        </Field>
        <Field label="On failure" error={err('onFail')} helper="Needs a verdict, tests or Git stage. Counts as a fix cycle.">
          <Select value={stage.onFail ?? '__none__'} onValueChange={(v) => set('onFail', v === '__none__' ? undefined : v)} options={[{ value: '__none__', label: 'Stop the task' }, ...targets.filter((t) => t.value !== COMPLETE)]} disabled={readOnly} />
        </Field>
      </div>
      {stage.kind === 'agent' ? (
        <Checkbox checked={stage.verdict} onCheckedChange={(v) => set('verdict', v)} disabled={readOnly} label="Stage returns a verdict" description='The agent must end with "VERDICT: PASS" or "VERDICT: FAIL"; FAIL takes the failure transition.' />
      ) : null}
      {stage.kind === 'command' ? <Checkbox checked={stage.optional} onCheckedChange={(v) => set('optional', v)} disabled={readOnly} label="Skip when no command is configured" /> : null}
    </fieldset>
  );
}

function newStage(existing: StageDefinition[]): StageDefinition {
  let n = existing.length + 1;
  while (existing.some((s) => s.key === `stage-${n}`)) n++;
  return {
    key: `stage-${n}`,
    name: `Stage ${n}`,
    role: 'implementer',
    kind: 'agent',
    permissionLevel: 1,
    timeoutSec: 1800,
    retry: { maxAttempts: 1 },
    requiresApproval: false,
    next: COMPLETE,
    verdict: false,
    optional: false,
  };
}

/** design.md §7.5 — structured stage sequence editor. */
export function WorkflowsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const workflows = useWorkflows();
  const mutations = useWorkflowMutations();
  const connection = useConnection();
  const { toast } = useFeedback();
  const { isWide, isCompactUp } = useBreakpoint();
  const list = workflows.data ?? [];
  const selected = list.find((w) => w.id === id) ?? list[0];
  const [draft, setDraft] = useState<WorkflowProfile | null>(null);
  const [stageIndex, setStageIndex] = useState<number | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  useBreadcrumb([{ label: 'Workflows', to: '/workflows' }, ...(selected ? [{ label: selected.name }] : [])]);

  useEffect(() => {
    setDraft(selected ? structuredClone(selected) : null);
    setStageIndex(null);
    setServerError(null);
  }, [selected?.id, selected?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const { issues } = useMemo(() => (draft ? validateWorkflow(draft) : { issues: [] as WorkflowIssue[] }), [draft]);
  const dirty = Boolean(draft && selected && JSON.stringify(draft) !== JSON.stringify(selected));
  const readOnly = Boolean(selected?.builtin);
  const names = useAgentNames();
  const settings = useSettings();

  if (workflows.isLoading) return <div className="p-6"><Skeleton className="h-96" /></div>;
  if (!selected || !draft) return <div className="p-6"><EmptyState title="No workflows" description="Built-in workflows load from the workflows folder when the orchestrator starts." /></div>;

  const updateStage = (index: number, next: StageDefinition) => {
    const prevKey = draft.stages[index]!.key;
    const stages = draft.stages.map((s, i) => (i === index ? next : s)).map((s) =>
      // Keep transitions pointing at a renamed key.
      prevKey !== next.key ? { ...s, next: s.next === prevKey ? next.key : s.next, onFail: s.onFail === prevKey ? next.key : s.onFail } : s,
    );
    setDraft({ ...draft, stages });
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= draft.stages.length) return;
    const stages = draft.stages.slice();
    [stages[index], stages[target]] = [stages[target]!, stages[index]!];
    setDraft({ ...draft, stages });
    setStageIndex(target);
  };

  const save = () =>
    mutations.save.mutate(
      { id: draft.id, profile: draft },
      { onSuccess: () => toast(`${draft.name} saved`), onError: (e) => setServerError(errorMessage(e)) },
    );

  const duplicate = () =>
    mutations.duplicate.mutate(selected.id, {
      onSuccess: (copy) => {
        toast(`Created ${copy.name}`);
        navigate(`/workflows/${copy.id}`);
      },
      onError: (e) => setServerError(errorMessage(e)),
    });

  const stage = stageIndex !== null ? draft.stages[stageIndex] : null;
  const inspector = stage ? (
    <StageInspector stage={stage} index={stageIndex!} stages={draft.stages} issues={issues} readOnly={readOnly} onChange={(next) => updateStage(stageIndex!, next)} />
  ) : null;

  return (
    <div className="flex flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader
        title={`Workflow: ${selected.name}`}
        description={selected.description || undefined}
        eyebrow={
          <span className="inline-flex items-center gap-2">
            {selected.builtin ? (
              <Badge>
                <Lock size={12} aria-hidden /> Built-in · read-only
              </Badge>
            ) : (
              <Badge>Custom · v{selected.version}</Badge>
            )}
          </span>
        }
        actions={
          <>
            <Button icon={Copy} onClick={duplicate} loading={mutations.duplicate.isPending} disabled={!connection.online} variant={readOnly ? 'primary' : 'secondary'}>
              Duplicate
            </Button>
            {!readOnly ? (
              <Button variant="primary" icon={Save} onClick={save} loading={mutations.save.isPending} disabled={!dirty || issues.length > 0 || !connection.online} disabledReason={issues.length ? 'Fix the validation errors first' : !dirty ? 'No unsaved changes' : 'Reconnect first'}>
                Save
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="workflow-picker" className="text-body font-semibold text-fg">
          Profile
        </label>
        <div className="w-72 max-w-full">
          <Select id="workflow-picker" value={selected.id} onValueChange={(v) => navigate(`/workflows/${v}`)} options={list.map((w) => ({ value: w.id, label: w.name, description: w.builtin ? 'Built-in' : 'Custom' }))} />
        </div>
      </div>

      {readOnly ? (
        <Banner tone="info" title="Built-in workflows are read-only">
          Duplicate this workflow to change stages, transitions or assignments. Existing tasks keep the version they started with.
        </Banner>
      ) : null}
      {serverError ? <Banner tone="danger" role="alert" title="Not saved">{serverError}</Banner> : null}
      {issues.length > 0 ? (
        <Banner tone="danger" role="alert" title={`${issues.length} validation error${issues.length === 1 ? '' : 's'} — saving is blocked`}>
          <ul className="list-disc pl-5">
            {issues.slice(0, 6).map((i, n) => (
              <li key={n}>
                {i.stageIndex !== null ? `${draft.stages[i.stageIndex]?.name ?? `Stage ${i.stageIndex + 1}`} · ` : ''}
                {i.message}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <div className={cn('grid gap-5', isWide && stage ? 'grid-cols-[minmax(0,1fr)_400px]' : 'grid-cols-1')}>
        <div className="flex min-w-0 flex-col gap-4">
          {!readOnly ? (
            <Panel title="Profile" headingLevel={3}>
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px]">
                <Field label="Name" error={issuesFor(issues, null, 'name')[0]?.message}>
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </Field>
                <Field label="Description">
                  <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </Field>
                <Field label="Max fix cycles">
                  <Select value={String(draft.maxFixCycles)} onValueChange={(v) => setDraft({ ...draft, maxFixCycles: Number(v) })} options={[0, 1, 2, 3, 4, 5, 6, 8, 10].map((n) => ({ value: String(n), label: String(n) }))} />
                </Field>
              </div>
            </Panel>
          ) : null}

          <section aria-labelledby="stages-heading" className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h2 id="stages-heading" className="text-h2 text-fg">
                Stages
              </h2>
              {!readOnly ? (
                <Button size="compact" icon={Plus} onClick={() => {
                  setDraft({ ...draft, stages: [...draft.stages, newStage(draft.stages)] });
                  setStageIndex(draft.stages.length);
                }}>
                  Add stage
                </Button>
              ) : null}
            </div>
            <ol className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
              {draft.stages.map((s, index) => {
                const stageIssues = issuesFor(issues, index);
                const agent = s.kind === 'agent' ? names(s.agentId ?? settings.data?.roleDefaults[s.role]?.agentId) + (s.agentId ? '' : ' (role default)') : 'System';
                return (
                  <li key={`${s.key}-${index}`} className={cn('flex items-center gap-2 px-2', stageIndex === index && 'bg-accent-muted')}>
                    <button
                      type="button"
                      onClick={() => setStageIndex(index)}
                      aria-current={stageIndex === index ? 'true' : undefined}
                      className="grid min-h-11 min-w-0 flex-1 grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1fr)] items-center gap-3 rounded-md px-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-focus md:grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)_96px_minmax(0,1fr)]"
                    >
                      <span className="tabular text-small text-fg-secondary">{index + 1}.</span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-body font-semibold text-fg">{s.name}</span>
                        {stageIssues.length ? <span className="truncate text-small text-danger">{stageIssues[0]!.message}</span> : null}
                      </span>
                      <span className="truncate text-body text-fg-secondary">{ROLE_LABEL[s.role]}</span>
                      <span className="hidden truncate text-body text-fg md:block">{agent}</span>
                      <span className="hidden text-body text-fg-secondary md:block">{s.kind === 'agent' ? (s.effort ?? 'default') : '—'}</span>
                      <span className="hidden md:block">
                        <PermissionBadge level={s.permissionLevel} />
                      </span>
                    </button>
                    {!readOnly ? (
                      <div className="flex shrink-0 items-center">
                        <IconButton icon={ArrowUp} label={`Move ${s.name} up`} size="compact" disabled={index === 0} onClick={() => move(index, -1)} />
                        <IconButton icon={ArrowDown} label={`Move ${s.name} down`} size="compact" disabled={index === draft.stages.length - 1} onClick={() => move(index, 1)} />
                        <IconButton
                          icon={Trash2}
                          label={`Remove ${s.name}`}
                          size="compact"
                          disabled={draft.stages.length === 1}
                          onClick={() => {
                            setDraft({ ...draft, stages: draft.stages.filter((_, i) => i !== index) });
                            setStageIndex(null);
                          }}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            <p className="text-small text-fg-secondary">Order is for reading; transitions decide what runs next. Loops are only allowed through “On failure”, bounded by the fix-cycle limit.</p>
          </section>

          {!readOnly ? (
            <Panel title="Delete workflow" variant="danger" headingLevel={3} description="Tasks that already used it keep their own copy.">
              <Button variant="destructive" icon={Trash2} onClick={() => setDeleteOpen(true)} disabled={!connection.online}>
                Delete {selected.name}…
              </Button>
            </Panel>
          ) : null}
        </div>

        {stage && isWide ? (
          <Panel title={`Stage: ${stage.name}`} variant="inspector" as="aside" className="self-start" headingLevel={3}>
            {inspector}
          </Panel>
        ) : null}
      </div>

      {!isWide ? (
        <Drawer open={stage !== null && stage !== undefined} onOpenChange={(open) => !open && setStageIndex(null)} title={stage ? `Stage: ${stage.name}` : 'Stage'} width={isCompactUp ? 440 : 400}>
          {inspector ?? <span />}
        </Drawer>
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        destructive
        title={`Delete ${selected.name}?`}
        description="The profile is removed. Repositories and settings that used it fall back to Normal Development."
        confirmLabel={`Delete ${selected.name}`}
        busy={mutations.remove.isPending}
        onConfirm={() =>
          mutations.remove.mutate(selected.id, {
            onSuccess: () => {
              toast(`${selected.name} deleted`, 'info');
              setDeleteOpen(false);
              navigate('/workflows');
            },
            onError: (e) => setServerError(errorMessage(e)),
          })
        }
      />
    </div>
  );
}
