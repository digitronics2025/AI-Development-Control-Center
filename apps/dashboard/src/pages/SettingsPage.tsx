import { Monitor, Moon, RotateCcw, Save, Sun, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useParams } from 'react-router';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Disclosure,
  Field,
  FieldGroup,
  Input,
  KeyValueList,
  PageHeader,
  Panel,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  Textarea,
  cn,
  useFeedback,
} from '@acc/ui';
import {
  API_BILLING_CONFIRMATION,
  MODE_HELP,
  PERMISSION_LEVEL_INFO,
  PROMPT_PLACEHOLDERS,
  ROLES,
  ROLE_LABEL,
  unknownPlaceholders,
  type ChairmanSettings,
  type LearningSettings,
  type PermissionLevel,
  type RepositoryAutomationSettings,
  type Role,
  type Settings,
  type TaskMode,
  type ThemePreference,
} from '@acc/shared';
import { errorMessage } from '../api/client';
import { useHealth, usePromptMutations, usePrompts, useSettings, useUpdateSettings, useWorkflows } from '../api/hooks';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useConnection, useRuntime } from '../app/runtime';
import { AskSettingsPanel } from '../components/ask-settings';
import { AssignmentPicker } from '../components/assignment-picker';
import { RemoteAccessPanel } from '../components/remote-access';

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'agents', label: 'Agents & Models' },
  { id: 'chairman', label: 'Chairman' },
  { id: 'ask', label: 'Ask' },
  { id: 'learning', label: 'Learning' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'billing', label: 'Billing' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'remote', label: 'Remote access' },
  { id: 'advanced', label: 'Advanced' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 max-w-prose flex-col">
        <span className="text-body font-semibold text-fg">{title}</span>
        {description ? <span className="text-small text-fg-secondary">{description}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A bounded whole-number field; invalid input keeps the last valid value. */
function LimitField({ label, helper, value, min, max, onChange }: { label: string; helper: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const n = Number(text);
  const invalid = !Number.isInteger(n) || n < min || n > max;
  return (
    <Field label={label} inline helper={helper} error={invalid ? `Enter a whole number from ${min} to ${max}.` : null}>
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        className="w-28"
        onChange={(e) => {
          setText(e.target.value);
          const next = Number(e.target.value);
          if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
        }}
      />
    </Field>
  );
}

const ABSOLUTE_PATH = /^([A-Za-z]:[\\/]|[\\/])/;
const MAX_FOLDERS = 20;
const folderLines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** One full folder path per line; invalid text keeps the last valid list. */
function FolderListField({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const joined = value.join('\n');
  const [text, setText] = useState(joined);
  // Follow outside changes (Discard, a save from elsewhere) without fighting the user's own blank lines.
  useEffect(() => setText((current) => (folderLines(current).join('\n') === joined ? current : joined)), [joined]);
  const lines = folderLines(text);
  const invalid = lines.find((l) => !ABSOLUTE_PATH.test(l));
  return (
    <Field
      label="Search folders"
      helper="One full folder path per line. Leave empty to search your user folder."
      error={invalid ? `"${invalid}" is not a full folder path, for example C:\\Users\\you\\code.` : lines.length > MAX_FOLDERS ? `Use at most ${MAX_FOLDERS} folders.` : null}
    >
      <Textarea
        value={text}
        rows={3}
        className="font-mono text-code"
        spellCheck={false}
        placeholder="Your user folder"
        onChange={(e) => {
          setText(e.target.value);
          const next = folderLines(e.target.value);
          if (next.length <= MAX_FOLDERS && next.every((l) => ABSOLUTE_PATH.test(l))) onChange(next);
        }}
      />
    </Field>
  );
}

function PromptTemplates() {
  const prompts = usePrompts();
  const mutations = usePromptMutations();
  const { toast } = useFeedback();
  const [role, setRole] = useState<Role>('implementer');
  const current = prompts.data?.find((p) => p.role === role);
  const [body, setBody] = useState('');
  useEffect(() => setBody(current?.body ?? ''), [current?.role, current?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (prompts.isLoading) return <Skeleton className="h-64" />;
  const available = ROLES.filter((r) => prompts.data?.some((p) => p.role === r));
  // A placeholder the orchestrator never fills would render as "(none)" in every prompt; refuse it here as the API does.
  const unknown = unknownPlaceholders(body);
  return (
    <div className="flex flex-col gap-3">
      <Field label="Role">
        <Select value={role} onValueChange={(v) => setRole(v as Role)} options={available.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
      </Field>
      {current ? (
        <p className="text-small text-fg-secondary">
          Version {current.version} · {current.builtin ? 'built-in' : 'edited by you'} · tasks record the version each role used. A placeholder such as {'{{request}}'} is filled per stage; an empty one reads
          "(none)".
        </p>
      ) : null}
      <Field label="Template" error={unknown.length ? `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((n) => `{{${n}}}`).join(', ')}. Use the names listed below.` : null}>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[320px] font-mono text-code" spellCheck={false} />
      </Field>
      <Disclosure title="Placeholders" description={`${Object.keys(PROMPT_PLACEHOLDERS).length} values the orchestrator fills for every stage`}>
        <dl className="grid gap-x-4 gap-y-1.5 px-4 pb-4 text-small md:grid-cols-[max-content_minmax(0,1fr)]">
          {Object.entries(PROMPT_PLACEHOLDERS).map(([name, description]) => (
            <div key={name} className="contents">
              <dt className="font-mono text-code text-fg">{`{{${name}}}`}</dt>
              <dd className="text-fg-secondary">{description}</dd>
            </div>
          ))}
        </dl>
      </Disclosure>
      <div className="flex flex-wrap justify-end gap-2">
        <Button icon={RotateCcw} onClick={() => mutations.reset.mutate(role, { onSuccess: () => toast('Built-in template restored as a new version') })} loading={mutations.reset.isPending}>
          Restore built-in
        </Button>
        <Button
          variant="primary"
          icon={Save}
          disabled={!body.trim() || body === current?.body || unknown.length > 0}
          disabledReason={unknown.length ? 'Fix the unknown placeholders first' : 'No unsaved changes'}
          loading={mutations.save.isPending}
          onClick={() => mutations.save.mutate({ role, body }, { onSuccess: () => toast(`${ROLE_LABEL[role]} template saved as a new version`), onError: (e) => toast(errorMessage(e), 'info') })}
        >
          Save template
        </Button>
      </div>
    </div>
  );
}

/** design.md §7.8 */
export function SettingsPage() {
  const { section = 'general' } = useParams();
  const activeRequested: SectionId = (SECTIONS.find((s) => s.id === section)?.id ?? 'general') as SectionId;
  useBreadcrumb([{ label: 'Settings', to: '/settings' }, { label: SECTIONS.find((s) => s.id === activeRequested)!.label }]);
  const settings = useSettings();
  const update = useUpdateSettings();
  const workflows = useWorkflows();
  const health = useHealth();
  const connection = useConnection();
  const { host, mode } = useRuntime();
  // Remote access belongs to the machine itself, and learning stays on it: neither is offered from the cloud dashboard.
  const localOnly = (id: SectionId) => id === 'remote' || id === 'learning' || id === 'ask';
  const sections = SECTIONS.filter((s) => !localOnly(s.id) || mode === 'local');
  const { toast } = useFeedback();
  const [draft, setDraft] = useState<Settings | null>(null);
  const [apiConfirmOpen, setApiConfirmOpen] = useState(false);
  // What the operator typed in the API-billing dialog; the server checks it (audit F-54).
  const billingPhrase = useRef<string | null>(null);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const seenServer = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  // A settings broadcast replaces the draft only when the operator has no unsaved edits;
  // otherwise it is announced, never silently applied over their work (audit F-26).
  const draftJson = draft ? JSON.stringify(draft) : null;
  useEffect(() => {
    if (!settings.data) return;
    const incoming = JSON.stringify(settings.data);
    if (incoming === seenServer.current) return;
    const previous = seenServer.current;
    seenServer.current = incoming;
    if (draftJson === null || draftJson === previous || draftJson === incoming) {
      setDraft(structuredClone(settings.data));
      setChangedElsewhere(false);
    } else setChangedElsewhere(true);
  }, [settings.data, draftJson]);
  const dirty = useMemo(() => Boolean(draft && settings.data && JSON.stringify(draft) !== JSON.stringify(settings.data)), [draft, settings.data]);

  const active: SectionId = localOnly(activeRequested) && mode !== 'local' ? 'general' : activeRequested;
  if (settings.isLoading || !draft) return <div className="p-6"><Skeleton className="h-96" /></div>;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft({ ...draft, [key]: value });
  const setAutomation = <K extends keyof RepositoryAutomationSettings>(key: K, value: RepositoryAutomationSettings[K]) =>
    setDraft({ ...draft, repositoryAutomation: { ...draft.repositoryAutomation, [key]: value } });
  const setChairman = <K extends keyof ChairmanSettings>(key: K, value: ChairmanSettings[K]) => setDraft({ ...draft, chairman: { ...draft.chairman, [key]: value } });
  const setLearning = <K extends keyof LearningSettings>(key: K, value: LearningSettings[K]) => setDraft({ ...draft, learning: { ...draft.learning, [key]: value } });

  const save = (patch: Partial<Settings> = draft) => {
    const toApi = patch.billingMode === 'api' && settings.data?.billingMode !== 'api';
    return update.mutate(toApi ? { ...patch, confirmation: billingPhrase.current ?? '' } : patch, {
      onSuccess: () => {
        toast('Settings saved');
        setError(null);
        setChangedElsewhere(false);
        billingPhrase.current = null;
      },
      onError: (e) => setError(errorMessage(e)),
    });
  };

  const content: Record<SectionId, ReactNode> = {
    ask: <AskSettingsPanel draft={draft} setDraft={setDraft} />,
    general: (
      <Panel title="General" headingLevel={2}>
        <div className="flex flex-col gap-4">
          <Field label="Default workflow" inline helper="Used for new tasks unless the repository sets its own.">
            <Select value={draft.defaultWorkflowId} onValueChange={(v) => set('defaultWorkflowId', v)} options={(workflows.data ?? []).map((w) => ({ value: w.id, label: w.name, description: w.description }))} />
          </Field>
          <FieldGroup label="Default mode" inline helper={MODE_HELP[draft.defaultMode]}>
            <SegmentedControl<TaskMode>
              label="Default mode"
              value={draft.defaultMode}
              onValueChange={(v) => set('defaultMode', v)}
              options={[
                { value: 'discuss', label: 'Discuss First' },
                { value: 'autopilot', label: 'Autopilot' },
              ]}
            />
          </FieldGroup>
        </div>
      </Panel>
    ),
    appearance: (
      <Panel title="Appearance" headingLevel={2}>
        {host === 'vscode' ? (
          <p className="text-body text-fg-secondary">Inside VS Code the Control Center follows your editor theme.</p>
        ) : (
          <FieldGroup label="Theme" inline helper="System follows your operating system's light or dark setting.">
            <SegmentedControl<ThemePreference>
              label="Theme"
              value={draft.theme}
              onValueChange={(v) => set('theme', v)}
              options={[
                { value: 'light', label: 'Light', icon: Sun },
                { value: 'dark', label: 'Dark', icon: Moon },
                { value: 'system', label: 'System', icon: Monitor },
              ]}
            />
          </FieldGroup>
        )}
      </Panel>
    ),
    agents: (
      <Panel title="Agents & Models" headingLevel={2} description="Global role defaults. Workflows may pin a stage; repositories and tasks can override these.">
        <div className="flex flex-col gap-3">
          {ROLES.filter((r) => r !== 'tester').map((role) => (
            <div key={role} className="grid gap-2 md:grid-cols-[160px_minmax(0,1fr)] md:items-center">
              <span className="text-body font-semibold text-fg">{ROLE_LABEL[role]}</span>
              <AssignmentPicker
                label={ROLE_LABEL[role]}
                value={draft.roleDefaults[role] ?? {}}
                onChange={(v) => set('roleDefaults', { ...draft.roleDefaults, [role]: v })}
              />
            </div>
          ))}
          <p className="text-small text-fg-secondary">
            Health, executables and custom model IDs are managed on the <Link to="/agents" className="text-fg underline">Agents</Link> page.
          </p>
        </div>
      </Panel>
    ),
    chairman: (
      <Panel
        title="Chairman"
        headingLevel={2}
        description="The supervisor of Autopilot tasks: it recovers from failures, answers in the task's Chairman chat and acts only through checked, logged actions."
      >
        <div className="flex flex-col divide-y divide-border-subtle">
          <Row title="Supervise new Autopilot tasks" description="Existing tasks keep the setting they were created with. Discuss First tasks are never supervised.">
            <Switch aria-label="Supervise new Autopilot tasks" checked={draft.chairman.enabled} onCheckedChange={(v) => setChairman('enabled', v)} />
          </Row>
          <Row title="Use a reasoning model" description="Off: the Chairman uses its rules only. On: a read-only agent interprets failures and chat, choosing only among safe options the rules allow.">
            <Switch aria-label="Use a reasoning model" checked={draft.chairman.useReasoning} onCheckedChange={(v) => setChairman('useReasoning', v)} />
          </Row>
          <div className="flex flex-col gap-2 py-3">
            <span className="text-body font-semibold text-fg">Chairman agent</span>
            <AssignmentPicker
              label="Chairman"
              disabled={!draft.chairman.useReasoning}
              value={{ agentId: draft.chairman.agentId, model: draft.chairman.model, effort: draft.chairman.effort }}
              onChange={(v) => setDraft({ ...draft, chairman: { ...draft.chairman, agentId: v.agentId ?? draft.chairman.agentId, model: v.model ?? 'default', effort: v.effort ?? 'default' } })}
            />
          </div>
          <div className="flex flex-col gap-3 py-3">
            <span className="text-body font-semibold text-fg">Limits per task</span>
            <LimitField label="Recovery cycles" helper="New strategies after the fix loop stops working. Resuming a paused task allows one more." min={0} max={20} value={draft.chairman.maxRecoveryCycles} onChange={(v) => setChairman('maxRecoveryCycles', v)} />
            <LimitField label="Work time (minutes)" helper="Agent and command time before the task pauses for you." min={10} max={10080} value={draft.chairman.maxTaskRuntimeMinutes} onChange={(v) => setChairman('maxTaskRuntimeMinutes', v)} />
            <LimitField label="Agent runs" helper="Subscriptions report no cost, so runs are the budget." min={5} max={1000} value={draft.chairman.maxAgentRuns} onChange={(v) => setChairman('maxAgentRuns', v)} />
            <LimitField label="Silent-worker limit (minutes)" helper="A running agent with no output for this long is stopped and recovered." min={2} max={1440} value={draft.chairman.stallMinutes} onChange={(v) => setChairman('stallMinutes', v)} />
          </div>
          <Row title="Resume after a restart" description="Supervised tasks interrupted by a restart continue automatically; nothing runs twice.">
            <Switch aria-label="Resume supervised tasks after a restart" checked={draft.chairman.resumeAfterRestart} onCheckedChange={(v) => setChairman('resumeAfterRestart', v)} />
          </Row>
        </div>
      </Panel>
    ),
    learning: (
      <Panel
        title="Learning"
        headingLevel={2}
        description={
          <>
            After each finished task the Chairman looks at what slowed it down and improves how later tasks run. Every change is tried on the next tasks and undone if the problem keeps coming back. See what it did on the <Link to="/learning" className="text-accent underline underline-offset-2">Learning page</Link>.
          </>
        }
      >
        <div className="flex flex-col divide-y divide-border-subtle">
          <Row title="Review finished tasks" description="A task that ran without friction is recorded as a clean run and costs nothing.">
            <Switch aria-label="Review finished tasks" checked={draft.learning.enabled} onCheckedChange={(v) => setLearning('enabled', v)} />
          </Row>
          <div className="flex flex-col gap-2 py-3">
            <span className="text-body font-semibold text-fg">When a change is worth making</span>
            <SegmentedControl<LearningSettings['autonomy']>
              label="When a change is worth making"
              value={draft.learning.autonomy}
              onValueChange={(v) => setLearning('autonomy', v)}
              options={[
                { value: 'act', label: 'Make it on its own' },
                { value: 'propose', label: 'Ask me first' },
              ]}
            />
            <span className="max-w-prose text-small text-fg-secondary">
              {draft.learning.autonomy === 'act'
                ? 'It acts once a problem shows up in two tasks (a missing program: at once). Programs come only from a reviewed list and follow the execution policy; under Safe it asks.'
                : 'Changes wait under Learning → Needs you until you choose Do it now.'}
            </span>
          </div>
          <Row title="Use the Chairman agent for reviews" description="Off: the rules still find missing programs, but lessons and skills need the agent. Uses the Chairman agent chosen above, read-only.">
            <Switch aria-label="Use the Chairman agent for reviews" checked={draft.learning.reviewWithModel} onCheckedChange={(v) => setLearning('reviewWithModel', v)} />
          </Row>
          <div className="flex flex-col gap-3 py-3">
            <LimitField label="Changes per day" helper="The most improvements the Chairman makes on its own in one day." min={0} max={20} value={draft.learning.maxActionsPerDay} onChange={(v) => setLearning('maxActionsPerDay', v)} />
            <LimitField label="Trial length (tasks)" helper="Later tasks each change is tried on before it is kept or undone." min={1} max={20} value={draft.learning.trialTasks} onChange={(v) => setLearning('trialTasks', v)} />
          </div>
        </div>
      </Panel>
    ),
    repositories: (
      <Panel title="Repositories" headingLevel={2} description="Keep the repository list complete and up to date without doing it by hand.">
        <div className="flex flex-col divide-y divide-border-subtle">
          <Row
            title="Add new repositories automatically"
            description="Looks for Git repositories in the search folders. Extra working copies of a repository (linked worktrees) and repositories you removed are skipped."
          >
            <Switch aria-label="Add new repositories automatically" checked={draft.repositoryAutomation.discover} onCheckedChange={(v) => setAutomation('discover', v)} />
          </Row>
          <div className="flex flex-col gap-3 py-3">
            <FolderListField value={draft.repositoryAutomation.roots} onChange={(v) => setAutomation('roots', v)} />
            <LimitField label="Folder depth" helper="How many folder levels below each search folder are looked at." min={1} max={4} value={draft.repositoryAutomation.maxDepth} onChange={(v) => setAutomation('maxDepth', v)} />
          </div>
          <Row
            title="Download new commits automatically"
            description="Fetches every repository and fast-forwards a branch that is only behind, has no uncommitted changes and no unfinished task. It never uploads, merges or rebases: use Sync in Source Control to upload."
          >
            <Switch aria-label="Download new commits automatically" checked={draft.repositoryAutomation.sync} onCheckedChange={(v) => setAutomation('sync', v)} />
          </Row>
          <div className="py-3">
            <LimitField label="Check every (minutes)" helper="Also runs when the Control Center starts." min={5} max={1440} value={draft.repositoryAutomation.intervalMinutes} onChange={(v) => setAutomation('intervalMinutes', v)} />
          </div>
          <div className="flex flex-col gap-2 py-3">
            <span className="text-body font-semibold text-fg">Never added automatically</span>
            {draft.repositoryAutomation.ignoredPaths.length ? (
              <ul className="flex flex-col gap-1">
                {draft.repositoryAutomation.ignoredPaths.map((p) => (
                  <li key={p} className="flex items-center justify-between gap-3">
                    <code className="min-w-0 font-mono text-code text-fg wrap-anywhere">{p}</code>
                    <Button size="compact" variant="ghost" onClick={() => setAutomation('ignoredPaths', draft.repositoryAutomation.ignoredPaths.filter((x) => x !== p))}>
                      Allow again
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-small text-fg-secondary">None. Removing a repository adds it here, so it is not found again.</p>
            )}
          </div>
        </div>
      </Panel>
    ),
    workflows: (
      <div className="flex flex-col gap-4">
        <Panel title="Workflow profiles" headingLevel={2}>
          <p className="text-body text-fg-secondary">
            Stages, transitions and per-stage assignments are edited on the <Link to="/workflows" className="text-fg underline">Workflows</Link> page.
          </p>
        </Panel>
        <Panel title="Prompt templates" headingLevel={2} description="What each role is told. Every save creates a new version.">
          <PromptTemplates />
        </Panel>
      </div>
    ),
    permissions: (
      <Panel title="Permissions" headingLevel={2} description="How far tasks may go without asking. Dangerous commands and production actions always ask.">
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Auto-approve up to</legend>
          {([1, 2, 3, 4, 5] as const).map((level) => (
            <label key={level} className={cn('flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5', draft.autoApproveUpToLevel === level ? 'border-accent bg-accent-muted' : 'border-border-subtle')}>
              <input
                type="radio"
                name="auto-approve"
                checked={draft.autoApproveUpToLevel === level}
                onChange={() => set('autoApproveUpToLevel', level as PermissionLevel)}
                className="mt-1 accent-(--accent)"
              />
              <span className="flex flex-col">
                <span className="text-body font-semibold text-fg">
                  Auto-approve up to Level {level} · {PERMISSION_LEVEL_INFO[level].name}
                  {level === 3 ? <Badge className="ml-2">Recommended</Badge> : null}
                </span>
                <span className="text-small text-fg-secondary">{PERMISSION_LEVEL_INFO[level].description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </Panel>
    ),
    billing: (
      <Panel title="Billing Mode" headingLevel={2} description="Who pays when an agent runs.">
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Billing Mode</legend>
          <label className={cn('flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3', draft.billingMode === 'subscription' ? 'border-accent bg-accent-muted' : 'border-border-subtle')}>
            <input type="radio" name="billing" checked={draft.billingMode === 'subscription'} onChange={() => set('billingMode', 'subscription')} className="mt-1 accent-(--accent)" />
            <span className="flex flex-col gap-0.5">
              <span className="text-body font-semibold text-fg">
                Subscription Only <Badge className="ml-2">Safe default</Badge>
              </span>
              <span className="text-small text-fg-secondary">
                Agents run on your signed-in Codex and Claude subscriptions. API keys are removed from their environment, agents signed in with API billing are blocked, and a usage limit pauses the task instead of switching to paid usage.
              </span>
            </span>
          </label>
          <label className={cn('flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3', draft.billingMode === 'api' ? 'border-warning bg-warning-muted' : 'border-border-subtle')}>
            <input
              type="radio"
              name="billing"
              checked={draft.billingMode === 'api'}
              onChange={() => setApiConfirmOpen(true)}
              className="mt-1 accent-(--accent)"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-body font-semibold text-fg">Explicit API Mode</span>
              <span className="text-small text-fg-secondary">Agents may use API keys from your environment and bill your API account. A persistent indicator shows while this is on.</span>
            </span>
          </label>
        </fieldset>
        <ConfirmDialog
          open={apiConfirmOpen}
          onOpenChange={setApiConfirmOpen}
          title="Switch to Explicit API Mode?"
          description="Agents will be allowed to use API keys present in the orchestrator's environment, which bills your API account per token. Subscription Only stays the recommended mode."
          confirmLabel="Allow API billing"
          cancelLabel="Keep Subscription Only"
          confirmationPhrase={API_BILLING_CONFIRMATION}
          onConfirm={(typed) => {
            billingPhrase.current = typed;
            set('billingMode', 'api');
            setApiConfirmOpen(false);
          }}
        />
      </Panel>
    ),
    notifications: (
      <Panel title="Notifications" headingLevel={2} description={host === 'vscode' ? 'Shown as VS Code notifications.' : 'Shown as desktop notifications while this page is in the background.'}>
        <div className="divide-y divide-border-subtle">
          <Row title="Approvals waiting" description="A task stopped for your decision.">
            <Switch aria-label="Notify about approvals" checked={draft.notifications.approvals} onCheckedChange={(v) => set('notifications', { ...draft.notifications, approvals: v })} />
          </Row>
          <Row title="Failures" description="A task failed or is blocked.">
            <Switch aria-label="Notify about failures" checked={draft.notifications.failures} onCheckedChange={(v) => set('notifications', { ...draft.notifications, failures: v })} />
          </Row>
          <Row title="Completions" description="A task finished.">
            <Switch aria-label="Notify about completions" checked={draft.notifications.completions} onCheckedChange={(v) => set('notifications', { ...draft.notifications, completions: v })} />
          </Row>
          {host === 'web' ? (
            <Row title="Browser permission" description={notificationPermission === 'granted' ? 'Allowed.' : notificationPermission === 'denied' ? 'Blocked in the browser settings.' : notificationPermission === 'unsupported' ? 'Not supported by this browser.' : 'Not asked yet.'}>
              {notificationPermission === 'default' ? (
                <Button size="compact" onClick={() => void Notification.requestPermission().then(setNotificationPermission)}>
                  Allow notifications
                </Button>
              ) : (
                <span />
              )}
            </Row>
          ) : null}
        </div>
      </Panel>
    ),
    remote: <RemoteAccessPanel />,
    advanced: (
      <div className="flex flex-col gap-4">
        <Panel title="Advanced" headingLevel={2}>
          <Row title="Developer mode" description="Open task logs in Developer view by default and show technical events in Activity.">
            <Switch aria-label="Developer mode" checked={draft.developerMode} onCheckedChange={(v) => set('developerMode', v)} />
          </Row>
        </Panel>
        <Panel title="Service" headingLevel={2}>
          {health.data ? (
            <KeyValueList
              items={[
                { label: 'Version', value: health.data.version },
                { label: 'Address', value: <code className="font-mono text-code">{health.data.host}:{health.data.port}</code>, hidden: !health.data.host },
                { label: 'Started', value: new Date(health.data.startedAt).toLocaleString() },
                { label: 'Data folder', value: <code className="font-mono text-code wrap-anywhere">{health.data.dataDir}</code>, hidden: !health.data.dataDir },
                { label: 'API token', value: 'Stored in the data folder as auth-token (readable only by you).', hidden: mode !== 'local' },
                { label: 'Agents', value: health.data.simulatedAgents ? 'Simulated (testing)' : 'Real CLIs' },
              ]}
            />
          ) : (
            <Skeleton className="h-24" />
          )}
        </Panel>
      </div>
    ),
  };

  return (
    <div className="flex flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader title="Settings" description="Global defaults. Repositories and tasks can override most of them." />
      {error ? <Banner tone="danger" role="alert" title="Settings were not saved">{error}</Banner> : null}
      {changedElsewhere && dirty ? (
        <Banner
          tone="warning"
          role="status"
          title="Settings were changed elsewhere"
          actions={
            <>
              <Button variant="ghost" onClick={() => setChangedElsewhere(false)}>
                Keep my edits
              </Button>
              <Button
                onClick={() => {
                  setDraft(structuredClone(settings.data!));
                  setChangedElsewhere(false);
                }}
              >
                Load the new settings
              </Button>
            </>
          }
        >
          Another window saved settings while you were editing. Saving now replaces them with your version.
        </Banner>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[200px_minmax(0,900px)]">
        <nav aria-label="Settings sections" className="min-w-0">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {sections.map((s) => (
              <li key={s.id} className="shrink-0">
                <NavLink
                  to={`/settings/${s.id}`}
                  className={({ isActive }) =>
                    cn(
                      'flex h-9 items-center rounded-md px-3 text-body font-semibold focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:h-11',
                      isActive || (s.id === 'general' && !section) ? 'bg-accent-muted text-fg' : 'text-fg-secondary hover:bg-elevated hover:text-fg',
                    )
                  }
                >
                  {s.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-4 pb-20">
          {content[active]}
          {dirty ? (
            <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 rounded-lg border border-border-subtle bg-elevated px-4 py-3 shadow-float">
              <span className="mr-auto text-body text-fg">You have unsaved changes.</span>
              <Button icon={Undo2} variant="ghost" onClick={() => setDraft(structuredClone(settings.data!))}>
                Discard
              </Button>
              <Button variant="primary" icon={Save} onClick={() => save()} loading={update.isPending} disabled={!connection.online} disabledReason="Reconnect to the orchestrator first">
                Save Changes
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
