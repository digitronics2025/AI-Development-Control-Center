import { KeyRound, Plus, RefreshCw, Server, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  FieldGroup,
  IconButton,
  Input,
  KeyValueList,
  PageHeader,
  PermissionBadge,
  RelativeTime,
  SegmentedControl,
  Select,
  Skeleton,
  StatusChip,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Textarea,
  Tooltip,
  useFeedback,
  type Column,
} from '@acc/ui';
import {
  POLICY_MODE_DESCRIPTION,
  POLICY_MODE_LABEL,
  POLICY_MODES,
  type ExecutionSettings,
  type McpServerView,
  type PermissionLevel,
  type PolicyMode,
  type TaskProcess,
  type TerminalSession,
  type ToolView,
} from '@acc/shared';
import { errorMessage } from '../api/client';
import { useRepositories, useSettings, useUpdateSettings } from '../api/hooks';
import { useCredentials, useMcpMutations, useMcpServers, useProcesses, useStopProcess, useTerminals, useToolMutations, useTools } from '../api/tools';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useConnection, useRuntime } from '../app/runtime';
import { TerminalDrawer } from '../components/terminal';
import { CredentialsTab } from './tools/CredentialsTab';
import { ConnectedAppsTab } from './tools/ConnectedAppsTab';
import { LIVE_PROCESS, PROCESS_VISUAL, TOOL_HEALTH_VISUAL } from '../components/tools';

const TABS = ['overview', 'processes', 'terminals', 'mcp', 'credentials', 'apps', 'policy'] as const;
type TabKey = (typeof TABS)[number];

const CATEGORY_LABEL: Record<string, string> = {
  shell: 'Shell',
  filesystem: 'Files',
  git: 'Git',
  github: 'GitHub',
  runtime: 'Runtime',
  browser: 'Browser',
  http: 'HTTP',
  network: 'Network',
  windows: 'Windows',
  cloudflare: 'Cloudflare',
  database: 'Database',
  docker: 'Docker',
  android: 'Android',
  editor: 'Editor',
  process: 'Processes',
  terminal: 'Terminal',
  checkpoint: 'Checkpoints',
  verification: 'Verification',
  environment: 'Environment',
  mcp: 'MCP',
  system: 'System',
};

function ToolDrawer({ tool, onClose }: { tool: ToolView | null; onClose: () => void }) {
  const mutations = useToolMutations();
  const connection = useConnection();
  if (!tool) return null;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={tool.name}
      description={tool.description}
      width={520}
      footer={
        <>
          {tool.auth.required ? (
            <Button icon={KeyRound} onClick={() => mutations.check.mutate({ id: tool.id, auth: true })} loading={mutations.check.isPending && mutations.check.variables?.auth} disabled={!connection.online}>
              Check sign-in
            </Button>
          ) : null}
          <Button icon={RefreshCw} onClick={() => mutations.check.mutate({ id: tool.id })} loading={mutations.check.isPending && !mutations.check.variables?.auth} disabled={!connection.online}>
            Check
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <KeyValueList
          items={[
            { label: 'Status', value: <StatusChip visual={TOOL_HEALTH_VISUAL[tool.state]} size="compact" /> },
            { label: 'Version', value: tool.version ?? '—' },
            { label: 'Location', value: tool.path ? <code className="font-mono text-code wrap-anywhere">{tool.path}</code> : tool.builtin ? 'Built in' : '—' },
            { label: 'Note', value: tool.message ?? '—', hidden: !tool.message },
            { label: 'Account', value: tool.auth.required ? `${tool.auth.state === 'ok' ? 'Signed in' : tool.auth.state === 'missing' ? 'Not signed in' : 'Not checked'}${tool.auth.message ? ` · ${tool.auth.message}` : ''}` : 'Not needed' },
            { label: 'Checked', value: <RelativeTime iso={tool.checkedAt} /> },
            { label: 'Used', value: tool.uses ? `${tool.uses} time(s), last ${tool.lastUsedAt ? new Date(tool.lastUsedAt).toLocaleString() : ''}` : 'Never' },
          ]}
        />
        <section aria-labelledby="tool-capabilities" className="flex flex-col gap-2">
          <h3 id="tool-capabilities" className="text-h3 text-fg">
            Capabilities ({tool.capabilities.length})
          </h3>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
            {tool.capabilities.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <code className="font-mono text-code text-fg">{c.id}</code>
                  <span className="text-small text-fg-secondary">{c.title}</span>
                </span>
                <PermissionBadge level={c.level} />
              </li>
            ))}
            {tool.capabilities.length === 0 ? <li className="px-3 py-2 text-body text-fg-secondary">Detected for other tools to use; it offers no capability of its own.</li> : null}
          </ul>
        </section>
      </div>
    </Drawer>
  );
}

function OverviewTab() {
  const tools = useTools();
  const [selected, setSelected] = useState<string | null>(null);
  const columns: Column<ToolView>[] = [
    {
      key: 'name',
      header: 'Tool',
      primary: true,
      sortValue: (t) => t.name,
      cell: (t) => (
        <button type="button" className="text-left font-semibold text-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus" onClick={() => setSelected(t.id)}>
          {t.name}
        </button>
      ),
    },
    { key: 'category', header: 'Area', sortValue: (t) => t.category, cell: (t) => <span className="text-fg-secondary">{CATEGORY_LABEL[t.category] ?? t.category}</span> },
    { key: 'state', header: 'Status', sortValue: (t) => t.state, cell: (t) => <StatusChip visual={TOOL_HEALTH_VISUAL[t.state]} size="compact" /> },
    { key: 'version', header: 'Version', cell: (t) => <span className="tabular text-fg">{t.version ?? '—'}</span>, hideStacked: true },
    {
      key: 'path',
      header: 'Location',
      hideStacked: true,
      cell: (t) =>
        t.path ? (
          <Tooltip content={t.path}>
            <code tabIndex={0} className="block max-w-[280px] truncate font-mono text-small text-fg-secondary">
              {t.path}
            </code>
          </Tooltip>
        ) : (
          <span className="text-fg-secondary">{t.builtin ? 'Built in' : (t.message ?? '—')}</span>
        ),
    },
    { key: 'caps', header: 'Capabilities', align: 'right', sortValue: (t) => t.capabilities.length, cell: (t) => <span className="tabular">{t.capabilities.length}</span> },
    { key: 'checked', header: 'Checked', hideStacked: true, sortValue: (t) => t.checkedAt ?? '', cell: (t) => <RelativeTime iso={t.checkedAt} /> },
  ];
  if (tools.isLoading) return <Skeleton className="h-96" />;
  const rows = (tools.data ?? []).filter((t) => !t.unsupported);
  return (
    <>
      <DataTable caption="Tools on this machine" columns={columns} rows={rows} rowKey={(t) => t.id} onRowClick={(t) => setSelected(t.id)} initialSort={{ key: 'category', direction: 'asc' }} empty={<EmptyState title="No tools registered" />} />
      <ToolDrawer tool={rows.find((t) => t.id === selected) ?? null} onClose={() => setSelected(null)} />
    </>
  );
}

function ProcessesTab() {
  const processes = useProcesses();
  const stop = useStopProcess();
  const connection = useConnection();
  const [error, setError] = useState<string | null>(null);
  const columns: Column<TaskProcess>[] = [
    { key: 'name', header: 'Process', primary: true, sortValue: (p) => p.name, cell: (p) => <span className="font-semibold text-fg">{p.name}</span> },
    { key: 'task', header: 'Task', cell: (p) => (p.taskId ? <Link to={`/tasks/${p.taskId}?tab=execution`} className="text-accent underline-offset-2 hover:underline">{p.taskId}</Link> : <span className="text-fg-secondary">Operator</span>) },
    { key: 'url', header: 'Address', hideStacked: true, cell: (p) => <code className="font-mono text-small text-fg-secondary">{p.url ?? (p.port ? `:${p.port}` : '—')}</code> },
    { key: 'status', header: 'Status', sortValue: (p) => p.status, cell: (p) => <StatusChip visual={PROCESS_VISUAL[p.status]} size="compact" /> },
    { key: 'started', header: 'Started', hideStacked: true, sortValue: (p) => p.startedAt, cell: (p) => <RelativeTime iso={p.startedAt} /> },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (p) =>
        LIVE_PROCESS.includes(p.status) ? (
          <Button size="compact" icon={Square} disabled={!connection.online} onClick={() => stop.mutate(p.id, { onError: (e) => setError(errorMessage(e)) })}>
            Stop
          </Button>
        ) : (
          <span className="text-small text-fg-secondary">{p.stopReason ?? ''}</span>
        ),
    },
  ];
  if (processes.isLoading) return <Skeleton className="h-64" />;
  return (
    <div className="flex flex-col gap-3">
      {error ? <Banner tone="danger" role="alert" title="Could not stop the process">{error}</Banner> : null}
      <DataTable caption="Background processes" columns={columns} rows={processes.data ?? []} rowKey={(p) => p.id} initialSort={{ key: 'started', direction: 'desc' }} empty={<EmptyState icon={Server} title="No background processes" description="Dev servers and watchers tasks start appear here and stop when their task stops." />} />
    </div>
  );
}

function TerminalsTab() {
  const terminals = useTerminals();
  const repositories = useRepositories();
  const connection = useConnection();
  const [repositoryId, setRepositoryId] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const repoName = (id: string | undefined) => repositories.data?.find((r) => r.id === id)?.name ?? '';
  const columns: Column<TerminalSession>[] = [
    { key: 'shell', header: 'Shell', primary: true, cell: (t) => <span className="font-semibold text-fg">{t.shell}</span> },
    { key: 'cwd', header: 'Folder', cell: (t) => <code className="font-mono text-small text-fg-secondary wrap-anywhere">{t.cwd}</code> },
    { key: 'owner', header: 'Opened by', hideStacked: true, cell: (t) => (t.ownerKind === 'agent' ? `Agent (${t.taskId})` : t.taskId ? `You (${t.taskId})` : 'You') },
    { key: 'status', header: 'Status', cell: (t) => <Badge>{t.status === 'running' ? 'Running' : `Exited${t.exitCode !== null ? ` (${t.exitCode})` : ''}`}</Badge> },
    { key: 'started', header: 'Started', hideStacked: true, sortValue: (t) => t.startedAt, cell: (t) => <RelativeTime iso={t.startedAt} /> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Repository" className="min-w-[240px] flex-1 sm:max-w-sm">
          <Select value={repositoryId} onValueChange={setRepositoryId} placeholder="Choose a repository" options={(repositories.data ?? []).map((r) => ({ value: r.id, label: r.name }))} />
        </Field>
        <Button icon={SquareTerminal} variant="primary" disabled={!repositoryId || !connection.online} disabledReason={!repositoryId ? 'Choose a repository first' : 'Offline'} onClick={() => setOpen(true)}>
          New terminal
        </Button>
      </div>
      {terminals.isLoading ? <Skeleton className="h-40" /> : <DataTable caption="Terminals" columns={columns} rows={terminals.data ?? []} rowKey={(t) => t.id} initialSort={{ key: 'started', direction: 'desc' }} empty={<EmptyState icon={SquareTerminal} title="No terminals yet" description="Terminals run on this computer only and close when you close them." />} />}
      <TerminalDrawer open={open} onOpenChange={setOpen} repositoryId={repositoryId} title={`Terminal · ${repoName(repositoryId)}`} />
    </div>
  );
}

function McpTab() {
  const servers = useMcpServers();
  const mutations = useMcpMutations();
  const credentials = useCredentials();
  const connection = useConnection();
  const { toast } = useFeedback();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<McpServerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', transport: 'stdio' as 'stdio' | 'http', command: '', args: '', url: '', level: '2', envVar: '', credential: '' });
  const submit = () => {
    setError(null);
    mutations.create.mutate(
      {
        name: form.name.trim(),
        transport: form.transport,
        command: form.transport === 'stdio' ? form.command.trim() : null,
        args: form.transport === 'stdio' ? form.args.split('\n').map((a) => a.trim()).filter(Boolean) : [],
        url: form.transport === 'http' ? form.url.trim() : null,
        permissionLevel: Number(form.level) as PermissionLevel,
        envCredentials: form.envVar.trim() && form.credential ? { [form.envVar.trim()]: form.credential } : {},
      },
      {
        onSuccess: (s) => {
          toast(s.health?.ok ? `${s.name} connected: ${s.health.tools.length} tool(s)` : `${s.name} added`);
          setAdding(false);
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button icon={Plus} variant="primary" onClick={() => setAdding(true)} disabled={!connection.online}>
          Add server
        </Button>
      </div>
      {servers.isLoading ? (
        <Skeleton className="h-40" />
      ) : servers.data?.length ? (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
          {servers.data.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body font-semibold text-fg">{s.name}</span>
                <StatusChip visual={s.health?.ok ? TOOL_HEALTH_VISUAL.ready : s.health ? TOOL_HEALTH_VISUAL.error : TOOL_HEALTH_VISUAL.unchecked} size="compact" />
                <Badge>{s.transport === 'stdio' ? 'Local process' : 'HTTP'}</Badge>
                <PermissionBadge level={s.permissionLevel} />
                <span className="flex-1" />
                <Switch aria-label={`${s.name} enabled`} checked={s.enabled} onCheckedChange={(enabled) => mutations.toggle.mutate({ id: s.id, enabled })} disabled={!connection.online} />
                <Button size="compact" icon={RefreshCw} onClick={() => mutations.check.mutate(s.id)} loading={mutations.check.isPending && mutations.check.variables === s.id} disabled={!connection.online}>
                  Check
                </Button>
                <IconButton icon={Trash2} label={`Remove ${s.name}`} size="compact" onClick={() => setRemoving(s)} />
              </div>
              <code className="font-mono text-small text-fg-secondary wrap-anywhere">{s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url}</code>
              {s.health?.error ? <p className="text-small text-danger">{s.health.error}</p> : null}
              {s.health?.ok ? <p className="text-small text-fg-secondary">{s.health.tools.length} tool(s): {s.health.tools.slice(0, 12).map((t) => t.name).join(', ')}{s.health.tools.length > 12 ? '…' : ''}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={Server} title="No MCP servers" description="Add a server to give tasks its tools, routed and checked like every other capability." />
      )}
      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="Add an MCP server"
        description="Secrets go in Credentials; here you only name which credential fills which variable."
        size="wide"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} loading={mutations.create.isPending} disabled={!form.name.trim() || (form.transport === 'stdio' ? !form.command.trim() : !form.url.trim())}>
              Add server
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Banner tone="danger" role="alert" title="Not added">{error}</Banner> : null}
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Playwright" />
          </Field>
          <FieldGroup label="Connection">
            <SegmentedControl<'stdio' | 'http'> label="Connection" value={form.transport} onValueChange={(transport) => setForm({ ...form, transport })} options={[{ value: 'stdio', label: 'Local process' }, { value: 'http', label: 'HTTP' }]} />
          </FieldGroup>
          {form.transport === 'stdio' ? (
            <>
              <Field label="Command">
                <Input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} className="font-mono" placeholder="npx" spellCheck={false} />
              </Field>
              <Field label="Arguments" optional helper="One per line.">
                <Textarea value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} rows={3} spellCheck={false} className="font-mono" placeholder="@playwright/mcp@latest" />
              </Field>
            </>
          ) : (
            <Field label="URL">
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="font-mono" placeholder="https://…/mcp" />
            </Field>
          )}
          <Field label="Permission level" helper="Every tool of this server needs at least this level; tools the server marks destructive need Level 3.">
            <Select value={form.level} onValueChange={(level) => setForm({ ...form, level })} options={[1, 2, 3, 4].map((l) => ({ value: String(l), label: `Level ${l}` }))} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Variable" optional>
              <Input value={form.envVar} onChange={(e) => setForm({ ...form, envVar: e.target.value })} className="font-mono" placeholder="GITHUB_TOKEN" />
            </Field>
            <Field label="Filled from credential" optional>
              <Select value={form.credential || undefined} onValueChange={(credential) => setForm({ ...form, credential })} placeholder="None" options={(credentials.data ?? []).map((c) => ({ value: c.name, label: c.name }))} />
            </Field>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? 'server'}?`}
        description="Tasks lose its tools at once. Its credentials stay stored."
        confirmLabel="Remove server"
        destructive
        busy={mutations.remove.isPending}
        onConfirm={() => {
          if (removing) mutations.remove.mutate(removing.id, { onSuccess: () => setRemoving(null) });
        }}
      />
    </div>
  );
}

function PolicyTab() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const connection = useConnection();
  const { toast } = useFeedback();
  const [error, setError] = useState<string | null>(null);
  const execution = settings.data?.execution;
  if (!execution) return <Skeleton className="h-64" />;
  const save = (patch: Partial<ExecutionSettings>, message: string) => {
    setError(null);
    update.mutate({ execution: { ...execution, ...patch } }, { onSuccess: () => toast(message), onError: (e) => setError(errorMessage(e)) });
  };
  const toggles: Array<{ key: 'exposeToolsToAgents' | 'terminals' | 'autoRepair' | 'environmentDiscovery'; title: string; help: string }> = [
    { key: 'exposeToolsToAgents', title: 'Give agents the Control Center tools', help: 'Agent stages get browser checks, HTTP, ports, processes, databases and more over MCP, limited to their stage and profile.' },
    { key: 'autoRepair', title: 'Repair environment problems automatically', help: 'Missing dependencies, a port held by the task itself, network hiccups and locked files are fixed before a check runs again.' },
    { key: 'environmentDiscovery', title: 'Describe the environment before a task', help: 'Machine, toolchain and listening ports, given to the first stages.' },
    { key: 'terminals', title: 'Terminals', help: 'Interactive terminals in the dashboard and for agents. Available only while the Control Center listens on this computer alone.' },
  ];
  return (
    <div className="flex max-w-[900px] flex-col gap-5">
      {error ? <Banner tone="danger" role="alert" title="Not saved">{error}</Banner> : null}
      <FieldGroup label="Execution policy" helper={POLICY_MODE_DESCRIPTION[execution.policyMode]}>
        <SegmentedControl<PolicyMode>
          label="Execution policy"
          value={execution.policyMode}
          disabled={!connection.online}
          onValueChange={(policyMode) => save({ policyMode }, `Policy: ${POLICY_MODE_LABEL[policyMode]}`)}
          options={POLICY_MODES.map((m) => ({ value: m, label: m === 'autopilot' ? `${POLICY_MODE_LABEL[m]} (recommended)` : POLICY_MODE_LABEL[m] }))}
        />
      </FieldGroup>
      <p className="text-body text-fg-secondary">Production and destructive actions always wait for your typed confirmation, in every mode. Repositories can use a different policy (Repositories → a repository → Defaults).</p>
      <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
        {toggles.map((t) => (
          <li key={t.key} className="flex items-start justify-between gap-4 px-4 py-3">
            <span className="flex flex-col">
              <span className="text-body font-semibold text-fg">{t.title}</span>
              <span className="text-small text-fg-secondary">{t.help}</span>
            </span>
            <Switch aria-label={t.title} checked={execution[t.key]} disabled={!connection.online} onCheckedChange={(v) => save({ [t.key]: v } as Partial<ExecutionSettings>, 'Saved')} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** design.md §7.11 — what this machine can do, and what the Control Center may do on its own. */
export function ToolsPage() {
  const { tab: raw } = useParams();
  const navigate = useNavigate();
  const { mode } = useRuntime();
  // Connected apps exist on this machine only; the cloud dashboard has no such tab.
  const tab: TabKey = (TABS as readonly string[]).includes(raw ?? '') && !(raw === 'apps' && mode !== 'local') ? (raw as TabKey) : 'overview';
  useBreadcrumb([{ label: 'Tools', to: '/tools' }, ...(tab !== 'overview' ? [{ label: tab === 'mcp' ? 'MCP servers' : tab === 'apps' ? 'Connected apps' : tab[0]!.toUpperCase() + tab.slice(1) }] : [])]);
  const tools = useTools();
  const settings = useSettings();
  const mutations = useToolMutations();
  const connection = useConnection();
  const { toast } = useFeedback();
  const counts = useMemo(() => {
    const rows = (tools.data ?? []).filter((t) => !t.unsupported);
    return {
      total: rows.length,
      ready: rows.filter((t) => t.state === 'ready').length,
      auth: rows.filter((t) => t.state === 'auth_required').length,
      missing: rows.filter((t) => t.state === 'missing').length,
    };
  }, [tools.data]);
  return (
    <div className="flex flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader
        title="Tools"
        description={
          tools.data
            ? `${counts.ready} of ${counts.total} ready${counts.auth ? ` · ${counts.auth} need sign-in` : ''}${counts.missing ? ` · ${counts.missing} not installed` : ''}${settings.data ? ` · policy: ${POLICY_MODE_LABEL[settings.data.execution.policyMode]}` : ''}`
            : 'What the Control Center can use on this machine.'
        }
        actions={
          <Button icon={RefreshCw} onClick={() => mutations.refresh.mutate(undefined, { onSuccess: () => toast('Checking every tool') })} loading={mutations.refresh.isPending} disabled={!connection.online}>
            Check all
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(next) => navigate(next === 'overview' ? '/tools' : `/tools/${next}`)}>
        <TabList label="Tools sections">
          <Tab value="overview">Overview</Tab>
          <Tab value="processes">Processes</Tab>
          <Tab value="terminals">Terminals</Tab>
          <Tab value="mcp">MCP servers</Tab>
          <Tab value="credentials">Credentials</Tab>
          {mode === 'local' ? <Tab value="apps">Connected apps</Tab> : null}
          <Tab value="policy">Policy</Tab>
        </TabList>
        <TabPanel value="overview">
          <OverviewTab />
        </TabPanel>
        <TabPanel value="processes">
          <ProcessesTab />
        </TabPanel>
        <TabPanel value="terminals">
          <TerminalsTab />
        </TabPanel>
        <TabPanel value="mcp">
          <McpTab />
        </TabPanel>
        <TabPanel value="credentials">
          <CredentialsTab />
        </TabPanel>
        {mode === 'local' ? (
          <TabPanel value="apps">
            <ConnectedAppsTab />
          </TabPanel>
        ) : null}
        <TabPanel value="policy">
          <PolicyTab />
        </TabPanel>
      </Tabs>
    </div>
  );
}
