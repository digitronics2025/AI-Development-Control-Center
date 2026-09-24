import { Ban, CheckCircle2, CircleHelp, KeyRound, PackageX, Plus, RefreshCw, Settings2, Trash2, TriangleAlert, XCircle } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Button,
  Disclosure,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  KeyValueList,
  PageHeader,
  RelativeTime,
  Skeleton,
  StatusChip,
  Switch,
  useFeedback,
  type StatusVisual,
} from '@acc/ui';
import type { AgentCapabilities, AgentHealthState, AgentInfo } from '@acc/shared';
import { errorMessage } from '../api/client';
import { useAgentMutations, useAgents, useHealth } from '../api/hooks';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useConnection } from '../app/runtime';

export const AGENT_STATE_VISUAL: Record<AgentHealthState, StatusVisual> = {
  connected: { label: 'Connected', tone: 'success', icon: CheckCircle2 },
  not_installed: { label: 'Not installed', tone: 'danger', icon: PackageX },
  auth_required: { label: 'Sign-in required', tone: 'warning', icon: KeyRound },
  api_billing_blocked: { label: 'Blocked: API billing', tone: 'danger', icon: Ban },
  error: { label: 'Health check failed', tone: 'danger', icon: XCircle },
  disabled: { label: 'Disabled', tone: 'neutral', icon: TriangleAlert },
  unknown: { label: 'Not checked', tone: 'neutral', icon: CircleHelp },
};

const CAPABILITY_LABEL: Record<keyof AgentCapabilities, string> = {
  repositoryRead: 'Read',
  repositoryWrite: 'Write',
  commandExecution: 'Commands',
  images: 'Images',
  interactive: 'Interactive',
  nonInteractive: 'Non-interactive',
  modelSelection: 'Model selection',
  effortSelection: 'Effort selection',
};

function AgentSettingsDrawer({ agent, open, onOpenChange }: { agent: AgentInfo; open: boolean; onOpenChange: (open: boolean) => void }) {
  const mutations = useAgentMutations();
  const { toast } = useFeedback();
  const [path, setPath] = useState(agent.settings.executablePath ?? '');
  const [modelId, setModelId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Record<string, unknown>, message: string) =>
    mutations.update.mutate({ id: agent.id, patch }, { onSuccess: () => toast(message), onError: (e) => setError(errorMessage(e)) });
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={`${agent.name} settings`} description="Changes apply to the next run and trigger a new health check.">
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col">
            <span className="text-body font-semibold text-fg">Enabled</span>
            <span className="text-small text-fg-secondary">Disabled agents are never launched; stages assigned to them wait for a reroute.</span>
          </div>
          <Switch aria-label="Enabled" checked={agent.settings.enabled} onCheckedChange={(v) => update({ enabled: v }, v ? `${agent.name} enabled` : `${agent.name} disabled`)} />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col">
            <span className="text-body font-semibold text-fg">Load my CLI customisations</span>
            <span className="text-small text-fg-secondary">Your own hooks, skills and plugins. Personal MCP servers are never loaded into runs; add one under Tools → MCP servers to use it through the Control Center. Turn off for faster, isolated runs.</span>
          </div>
          <Switch aria-label="Load my CLI customisations" checked={agent.settings.loadUserConfig} onCheckedChange={(v) => update({ loadUserConfig: v }, 'Saved')} />
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            update({ executablePath: path.trim() || null }, 'Executable path saved');
          }}
        >
          <Field label="Executable path" optional helper="Leave empty to find it on PATH.">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={agent.detection.executablePath ?? ''} className="font-mono" />
          </Field>
          <div>
            <Button type="submit" size="compact">
              Save path
            </Button>
          </div>
        </form>
        <section aria-labelledby={`${agent.id}-models`} className="flex flex-col gap-2">
          <h3 id={`${agent.id}-models`} className="text-h3 text-fg">
            Models
          </h3>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
            {agent.models.map((m) => (
              <li key={m.modelId} className="flex items-center gap-2 px-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body text-fg">{m.label}</span>
                  <span className="truncate font-mono text-small text-fg-secondary">
                    {m.modelId} · {m.efforts.join(', ')}
                  </span>
                </span>
                <Badge>{m.source === 'discovered' ? 'From CLI' : m.source === 'builtin' ? 'Alias' : 'Added by you'}</Badge>
                {m.source === 'user' ? (
                  <IconButton icon={Trash2} label={`Remove ${m.modelId}`} size="compact" onClick={() => mutations.removeModel.mutate({ id: agent.id, modelId: m.modelId }, { onSuccess: () => toast('Model removed') })} />
                ) : null}
              </li>
            ))}
            {agent.models.length === 0 ? <li className="px-3 py-2 text-body text-fg-secondary">No models discovered. The CLI default model is used.</li> : null}
          </ul>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!modelId.trim()) return;
              mutations.addModel.mutate(
                { id: agent.id, modelId: modelId.trim() },
                {
                  onSuccess: () => {
                    toast(`${modelId.trim()} added`);
                    setModelId('');
                  },
                  onError: (err) => setError(errorMessage(err)),
                },
              );
            }}
          >
            <Field label="Add a model ID" className="flex-1">
              <Input value={modelId} onChange={(e) => setModelId(e.target.value)} className="font-mono" placeholder="e.g. claude-opus-5-5" />
            </Field>
            <Button type="submit" icon={Plus} loading={mutations.addModel.isPending}>
              Add
            </Button>
          </form>
        </section>
        {error ? <p role="alert" className="text-body text-danger">{error}</p> : null}
      </div>
    </Drawer>
  );
}

function AgentCard({ agent }: { agent: AgentInfo }) {
  const mutations = useAgentMutations();
  const connection = useConnection();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const caps = (Object.keys(CAPABILITY_LABEL) as Array<keyof AgentCapabilities>).filter((k) => agent.capabilities[k]);
  return (
    <li className="flex flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-h3 text-fg">{agent.name}</h2>
            <StatusChip visual={AGENT_STATE_VISUAL[agent.health.state]} size="compact" />
          </div>
          <p className="text-body text-fg wrap-anywhere">{agent.health.message}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="compact" icon={RefreshCw} loading={mutations.refreshOne.isPending} onClick={() => mutations.refreshOne.mutate(agent.id)} disabled={!connection.online}>
            Re-check
          </Button>
          <Button size="compact" icon={Settings2} onClick={() => setSettingsOpen(true)}>
            Settings
          </Button>
        </div>
      </div>
      <KeyValueList
        className="text-small"
        items={[
          {
            label: 'Executable',
            value: agent.detection.found ? (
              <span>
                Detected{agent.detection.version ? ` · v${agent.detection.version}` : ''} · <code className="font-mono text-code wrap-anywhere">{agent.detection.executablePath}</code>
              </span>
            ) : (
              agent.detection.error ?? 'Not found'
            ),
          },
          { label: 'Session', value: agent.health.billing === 'subscription' ? 'Subscription session available' : agent.health.billing === 'api' ? 'API key billing' : 'Unknown' },
          { label: 'Capabilities', value: caps.length ? caps.map((k) => CAPABILITY_LABEL[k]).join(' · ') : '—' },
          { label: 'Last check', value: <RelativeTime iso={agent.health.checkedAt} /> },
        ]}
      />
      <Disclosure title={`Models: ${agent.models.length}`}>
        {agent.models.length ? (
          <ul className="flex flex-wrap gap-2">
            {agent.models.map((m) => (
              <li key={m.modelId}>
                <Badge title={m.description ?? undefined}>{m.label}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-fg-secondary">No models listed; the CLI default is used.</p>
        )}
      </Disclosure>
      <AgentSettingsDrawer key={String(settingsOpen)} agent={agent} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </li>
  );
}

/** design.md §7.6 — compact operational list; logos never dominate. */
export function AgentsPage() {
  useBreadcrumb([{ label: 'Agents' }]);
  const agents = useAgents();
  const mutations = useAgentMutations();
  const health = useHealth();
  const connection = useConnection();
  return (
    <div className="flex max-w-[1100px] flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader
        title="Agents"
        description={`Coding agents the orchestrator can run. ${health.data?.billingMode === 'api' ? 'Explicit API Mode is on.' : 'Subscription Only: agents signed in with API keys are blocked.'}`}
        actions={
          <Button icon={RefreshCw} onClick={() => mutations.refreshAll.mutate()} loading={mutations.refreshAll.isPending} disabled={!connection.online}>
            Re-check all
          </Button>
        }
      />
      {agents.isLoading ? (
        <Skeleton className="h-64" />
      ) : agents.data?.length ? (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
          {agents.data.map((a) => (
            <AgentCard key={a.id} agent={a} />
          ))}
        </ul>
      ) : (
        <EmptyState title="No agents registered" />
      )}
    </div>
  );
}
