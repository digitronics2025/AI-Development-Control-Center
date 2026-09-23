import { Monitor, Moon, RotateCcw, Save, Sun, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, useParams } from 'react-router';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Field,
  FieldGroup,
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
  MODE_HELP,
  PERMISSION_LEVEL_INFO,
  ROLES,
  ROLE_LABEL,
  type PermissionLevel,
  type Role,
  type Settings,
  type TaskMode,
  type ThemePreference,
} from '@acc/shared';
import { errorMessage } from '../api/client';
import { useHealth, usePromptMutations, usePrompts, useSettings, useUpdateSettings, useWorkflows } from '../api/hooks';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useConnection, useRuntime } from '../app/runtime';
import { AssignmentPicker } from '../components/assignment-picker';

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'agents', label: 'Agents & Models' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'billing', label: 'Billing' },
  { id: 'notifications', label: 'Notifications' },
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
  return (
    <div className="flex flex-col gap-3">
      <Field label="Role">
        <Select value={role} onValueChange={(v) => setRole(v as Role)} options={available.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
      </Field>
      {current ? (
        <p className="text-small text-fg-secondary">
          Version {current.version} · {current.builtin ? 'built-in' : 'edited by you'} · tasks record the version each role used. Placeholders such as {'{{request}}'} and {'{{plan}}'} are filled per stage.
        </p>
      ) : null}
      <Field label="Template">
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[320px] font-mono text-code" spellCheck={false} />
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        <Button icon={RotateCcw} onClick={() => mutations.reset.mutate(role, { onSuccess: () => toast('Built-in template restored as a new version') })} loading={mutations.reset.isPending}>
          Restore built-in
        </Button>
        <Button
          variant="primary"
          icon={Save}
          disabled={!body.trim() || body === current?.body}
          disabledReason="No unsaved changes"
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
  const active: SectionId = (SECTIONS.find((s) => s.id === section)?.id ?? 'general') as SectionId;
  useBreadcrumb([{ label: 'Settings', to: '/settings' }, { label: SECTIONS.find((s) => s.id === active)!.label }]);
  const settings = useSettings();
  const update = useUpdateSettings();
  const workflows = useWorkflows();
  const health = useHealth();
  const connection = useConnection();
  const { host } = useRuntime();
  const { toast } = useFeedback();
  const [draft, setDraft] = useState<Settings | null>(null);
  const [apiConfirmOpen, setApiConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  useEffect(() => {
    if (settings.data) setDraft(structuredClone(settings.data));
  }, [settings.data]);
  const dirty = useMemo(() => Boolean(draft && settings.data && JSON.stringify(draft) !== JSON.stringify(settings.data)), [draft, settings.data]);

  if (settings.isLoading || !draft) return <div className="p-6"><Skeleton className="h-96" /></div>;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft({ ...draft, [key]: value });

  const save = (patch: Partial<Settings> = draft) =>
    update.mutate(patch, {
      onSuccess: () => {
        toast('Settings saved');
        setError(null);
      },
      onError: (e) => setError(errorMessage(e)),
    });

  const content: Record<SectionId, ReactNode> = {
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
          confirmationPhrase="API BILLING"
          onConfirm={() => {
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
                { label: 'Address', value: <code className="font-mono text-code">{health.data.host}:{health.data.port}</code> },
                { label: 'Started', value: new Date(health.data.startedAt).toLocaleString() },
                { label: 'Data folder', value: <code className="font-mono text-code wrap-anywhere">{health.data.dataDir}</code> },
                { label: 'API token', value: 'Stored in the data folder as auth-token (readable only by you).' },
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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[200px_minmax(0,900px)]">
        <nav aria-label="Settings sections" className="min-w-0">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {SECTIONS.map((s) => (
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
