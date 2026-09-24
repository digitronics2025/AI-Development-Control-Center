import { AlertTriangle, CheckCircle2, CircleDashed, CloudUpload, KeyRound, Link2Off, Plus, ShieldQuestion, Sparkles, Trash2, Vault, XCircle } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  KeyValueList,
  RelativeTime,
  Select,
  Skeleton,
  StatusChip,
  Switch,
  useFeedback,
  type Column,
  type StatusVisual,
} from '@acc/ui';
import { CREDENTIAL_KIND_ENV, CREDENTIAL_KINDS, type CredentialKind, type CredentialSource, type CredentialView, type Repository, type VaultLinkState, type VaultResolveAction } from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useRepositories } from '../../api/hooks';
import { useCredentialEvents, useCredentialMutations, useCredentials, useVaultBridgeStatus, useVaultOriginMutations } from '../../api/tools';
import { useConnection } from '../../app/runtime';

/**
 * Tools → Credentials (design.md §7.10; docs/systems/credential-broker.md):
 * the write-only broker, its MyVault links, generated secrets and the
 * repositories each credential may be used in. No value ever reaches this
 * page — not on save, not on generate, not from MyVault.
 */

const SOURCE_LABEL: Record<CredentialSource, string> = { manual: 'Added here', myvault: 'MyVault', generated: 'Generated' };

/** Icon + text, never color alone (design.md §4.2). */
const VAULT_VISUAL: Record<VaultLinkState, StatusVisual> = {
  synced: { label: 'Synced', tone: 'success', icon: CheckCircle2 },
  pending_push: { label: 'Pending MyVault', tone: 'warning', icon: CloudUpload },
  pending_pull: { label: 'Taking MyVault value', tone: 'info', icon: CircleDashed },
  conflict: { label: 'Conflict', tone: 'danger', icon: AlertTriangle },
  missing: { label: 'Missing in MyVault', tone: 'warning', icon: ShieldQuestion },
  detached: { label: 'Detached', tone: 'neutral', icon: Link2Off },
  error: { label: 'Sync error', tone: 'danger', icon: XCircle },
};

const RESOLVE_LABEL: Record<VaultResolveAction, string> = {
  'keep-control-center': 'Keep the Control Center value',
  'use-myvault': 'Use the MyVault value',
  'push-again': 'Save to MyVault again',
  detach: 'Stop following MyVault',
};

/** MyVault owns the value of an imported item until it is detached; the server enforces the same rule. */
const managedByMyVault = (c: CredentialView) => c.source === 'myvault' && c.vault?.state !== 'detached';

function resolveActions(c: CredentialView): VaultResolveAction[] {
  const state = c.vault?.state;
  if (!state) return [];
  const generated = c.source === 'generated';
  const out: VaultResolveAction[] = [];
  if (state === 'conflict') out.push(...(generated ? (['keep-control-center', 'use-myvault'] as const) : (['use-myvault'] as const)));
  if (generated && (state === 'missing' || state === 'detached' || state === 'error' || state === 'pending_push')) out.push('push-again');
  if (state !== 'detached') out.push('detach');
  return out;
}

function scopeText(c: CredentialView, repos: Repository[]): string {
  if (c.repositoryIds === null) return 'All repositories';
  if (c.repositoryIds.length === 0) return 'No repository yet';
  const names = c.repositoryIds.map((id) => repos.find((r) => r.id === id)?.name ?? 'removed repository');
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
}

function ScopeEditor({ credential, repos, onSaved }: { credential: CredentialView; repos: Repository[]; onSaved: () => void }) {
  const mutations = useCredentialMutations();
  const { toast } = useFeedback();
  const [all, setAll] = useState(credential.repositoryIds === null);
  const [chosen, setChosen] = useState<string[]>(credential.repositoryIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    mutations.scope.mutate(
      { id: credential.id, repositoryIds: all ? null : chosen },
      { onSuccess: () => { toast('Repository access saved'); onSaved(); }, onError: (e) => setError(errorMessage(e)) },
    );
  return (
    <div className="flex flex-col gap-3">
      {error ? <Banner tone="danger" role="alert" title="Not saved">{error}</Banner> : null}
      <label className="flex items-center justify-between gap-3 text-body">
        <span>Every repository</span>
        <Switch checked={all} onCheckedChange={setAll} aria-label="Every repository" />
      </label>
      {!all ? (
        <div className="flex flex-col gap-2">
          {repos.length === 0 ? <p className="text-small text-fg-secondary">Add a repository first.</p> : null}
          {repos.map((r) => (
            <Checkbox key={r.id} label={r.name} checked={chosen.includes(r.id)} onCheckedChange={(on) => setChosen((c) => (on ? [...c, r.id] : c.filter((x) => x !== r.id)))} />
          ))}
        </div>
      ) : null}
      <div>
        <Button onClick={save} loading={mutations.scope.isPending}>
          Save access
        </Button>
      </div>
    </div>
  );
}

function CredentialDrawer({ credential, repos, onClose, onReplace, onDelete }: { credential: CredentialView | null; repos: Repository[]; onClose: () => void; onReplace: (c: CredentialView) => void; onDelete: (c: CredentialView) => void }) {
  const mutations = useCredentialMutations();
  const events = useCredentialEvents(credential?.id ?? null);
  const { toast } = useFeedback();
  const connection = useConnection();
  const [error, setError] = useState<string | null>(null);
  if (!credential) return null;
  const c = credential;
  const resolve = (action: VaultResolveAction) =>
    mutations.resolve.mutate({ id: c.id, action }, { onSuccess: () => toast(RESOLVE_LABEL[action]), onError: (e) => setError(errorMessage(e)) });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={c.name} description={SOURCE_LABEL[c.source]} width={480}>
      <div className="flex flex-col gap-5">
        {error ? <Banner tone="danger" role="alert" title="Not done">{error}</Banner> : null}
        {c.vault?.lastError ? <Banner tone={c.vault.state === 'conflict' ? 'danger' : 'warning'} title={VAULT_VISUAL[c.vault.state].label}>{c.vault.lastError}</Banner> : null}
        <KeyValueList
          items={[
            { label: 'Kind', value: c.kind },
            { label: 'Given to tools as', value: <code className="font-mono text-small">{c.envVar ?? CREDENTIAL_KIND_ENV[c.kind] ?? 'header / by name'}</code> },
            { label: 'Fingerprint', value: <code className="font-mono text-small">{c.fingerprint}</code> },
            { label: 'MyVault', value: c.vault ? <StatusChip visual={VAULT_VISUAL[c.vault.state]} size="compact" /> : 'Not linked', hidden: !c.vault },
            { label: 'MyVault address', value: c.vault?.origin ?? '—', hidden: !c.vault },
            { label: 'Last synced', value: c.vault?.lastSyncedAt ? <RelativeTime iso={c.vault.lastSyncedAt} /> : 'Never', hidden: !c.vault },
            { label: 'Last used', value: c.lastUsedAt ? <RelativeTime iso={c.lastUsedAt} /> : 'Never' },
          ]}
        />
        {resolveActions(c).length ? (
          <section className="flex flex-col gap-2" aria-labelledby="vault-actions">
            <h3 id="vault-actions" className="text-h3">MyVault</h3>
            <div className="flex flex-wrap gap-2">
              {resolveActions(c).map((action) => (
                <Button key={action} size="compact" variant={action === 'detach' ? 'ghost' : 'secondary'} onClick={() => resolve(action)} disabled={!connection.online || mutations.resolve.isPending}>
                  {RESOLVE_LABEL[action]}
                </Button>
              ))}
            </div>
            <p className="text-small text-fg-secondary">Nothing is deleted on either side. A choice takes effect the next time MyVault connects.</p>
          </section>
        ) : null}
        <section className="flex flex-col gap-2" aria-labelledby="repo-access">
          <h3 id="repo-access" className="text-h3">Repository access</h3>
          <p className="text-small text-fg-secondary">Only these repositories&apos; tools and tasks may use it.</p>
          <ScopeEditor key={`${c.id}-${JSON.stringify(c.repositoryIds)}`} credential={c} repos={repos} onSaved={() => undefined} />
        </section>
        <section className="flex flex-col gap-2" aria-labelledby="value-actions">
          <h3 id="value-actions" className="text-h3">Value</h3>
          {managedByMyVault(c) ? (
            <p className="text-body text-fg-secondary">Managed by MyVault. Change it there and connect; it updates here.</p>
          ) : (
            <div>
              <Button size="compact" onClick={() => onReplace(c)} disabled={!connection.online}>
                Replace value
              </Button>
            </div>
          )}
        </section>
        <section className="flex flex-col gap-2" aria-labelledby="history">
          <h3 id="history" className="text-h3">History</h3>
          {events.isLoading ? <Skeleton className="h-16" /> : null}
          <ul className="flex flex-col gap-1 text-small">
            {(events.data ?? []).slice(0, 12).map((e) => (
              <li key={e.id} className="flex items-baseline justify-between gap-3">
                <span className="text-fg">
                  {e.operation.replace(/_/g, ' ')}
                  {e.status !== 'ok' ? <span className="text-fg-secondary"> · {e.status}</span> : null}
                  {e.detail ? <span className="block text-fg-secondary">{e.detail}</span> : null}
                </span>
                <RelativeTime iso={e.createdAt} />
              </li>
            ))}
          </ul>
        </section>
        <div>
          <Button variant="destructive" size="compact" icon={Trash2} onClick={() => onDelete(c)} disabled={!connection.online}>
            Delete here
          </Button>
          {c.vault ? <p className="pt-1 text-small text-fg-secondary">The MyVault item is kept.</p> : null}
        </div>
      </div>
    </Drawer>
  );
}

function ConnectMyVaultDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const status = useVaultBridgeStatus(open ? 3000 : false);
  const origins = useVaultOriginMutations();
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trust = () =>
    origins.trust.mutate(address, {
      onSuccess: () => {
        setError(null);
        setAddress('');
        // Open the address just entered (the server accepted it, so it parses); connecting starts there, while it is unlocked.
        window.open(new URL(address.trim()).origin, '_blank', 'noopener');
      },
      onError: (e) => setError(errorMessage(e)),
    });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect MyVault"
      description="Only items you mark in MyVault are shared, and only while MyVault is unlocked on this computer."
      footer={
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger" role="alert" title="Not added">{error}</Banner> : null}
        <Field label="MyVault address" helper="The address you open MyVault at. Trusting it lets that page connect here.">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://vault.example.com" inputMode="url" />
        </Field>
        <div>
          <Button variant="primary" onClick={trust} disabled={!address.trim()} loading={origins.trust.isPending}>
            Trust and open MyVault
          </Button>
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-body text-fg-secondary">
          <li>In MyVault, unlock the vault.</li>
          <li>Open Settings → AI Development Control Center and choose Connect and sync.</li>
          <li>The first time, MyVault shows this Control Center's key. Trust it only if it matches the key below.</li>
          <li>Check that both windows show the same session code.</li>
        </ol>
        <section className="flex flex-col gap-1" aria-labelledby="control-center-key">
          <h3 id="control-center-key" className="text-h3">This Control Center's key</h3>
          {status.data ? (
            status.data.identity ? (
              <p className="font-mono text-body wrap-anywhere" data-testid="identity-fingerprint">{status.data.identity.fingerprint}</p>
            ) : (
              <Banner tone="danger" role="alert" title="Key unavailable">
                The Control Center could not open its key, so MyVault cannot connect. This happens when its data came from another computer; resetting the key is a manual step for now (see the credential broker notes).
              </Banner>
            )
          ) : null}
          <p className="text-small text-fg-secondary">MyVault remembers this key and refuses a Control Center that answers here with a different one.</p>
        </section>
        {status.data?.origins.length ? (
          <section className="flex flex-col gap-2" aria-labelledby="trusted-origins">
            <h3 id="trusted-origins" className="text-h3">Trusted</h3>
            <ul className="flex flex-col gap-2">
              {status.data.origins.map((o) => {
                const live = status.data?.sessions.find((s) => s.origin === o.origin);
                return (
                  <li key={o.origin} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 wrap-anywhere text-body">
                      {o.origin}
                      <span className="block text-small text-fg-secondary">{live ? `Connected · code ${live.code}` : o.lastConnectedAt ? <>Last connected <RelativeTime iso={o.lastConnectedAt} /></> : 'Never connected'}</span>
                    </span>
                    <IconButton icon={Trash2} label={`Stop trusting ${o.origin}`} size="compact" onClick={() => origins.untrust.mutate(o.origin)} />
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}

function GenerateDialog({ open, onOpenChange, repos }: { open: boolean; onOpenChange: (open: boolean) => void; repos: Repository[] }) {
  const mutations = useCredentialMutations();
  const { toast } = useFeedback();
  const [form, setForm] = useState({ name: '', repositoryId: '', kind: 'other' as CredentialKind, envVar: '', size: '32-base64url' });
  const [error, setError] = useState<string | null>(null);
  const valid = /^[\w.-]+$/.test(form.name.trim()) && form.repositoryId;
  const generate = () => {
    const [bytes, encoding] = form.size.split('-') as [string, 'base64url' | 'hex'];
    mutations.generate.mutate(
      { repositoryId: form.repositoryId, input: { name: form.name.trim(), kind: form.kind, envVar: form.envVar.trim() || null, description: '', bytes: Number(bytes), encoding } },
      {
        onSuccess: (out) => {
          toast(out.created ? `Generated ${out.name} (${out.fingerprint})` : `${out.name} already exists; it was not regenerated`);
          setForm({ ...form, name: '', envVar: '' });
          setError(null);
          onOpenChange(false);
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate a secret"
      description="Made and encrypted inside the Control Center. It is never shown; tools use it by name. It must reach MyVault before its first deployment."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={generate} disabled={!valid} loading={mutations.generate.isPending}>
            Generate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <Banner tone="danger" role="alert" title="Not generated">{error}</Banner> : null}
        <Field label="Name" helper="Letters, digits, dot, dash and underscore.">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="SESSION_SECRET" className="font-mono" />
        </Field>
        <Field label="Repository" helper="Only this repository may use it until you widen access.">
          <Select value={form.repositoryId || undefined} onValueChange={(repositoryId) => setForm({ ...form, repositoryId })} placeholder="Choose a repository" options={repos.map((r) => ({ value: r.id, label: r.name }))} aria-label="Repository" />
        </Field>
        <Field label="Strength">
          <Select
            value={form.size}
            onValueChange={(size) => setForm({ ...form, size })}
            aria-label="Strength"
            options={[
              { value: '32-base64url', label: '32 random bytes (recommended)', description: '43 characters, letters, digits, - and _' },
              { value: '64-base64url', label: '64 random bytes', description: '86 characters' },
              { value: '32-hex', label: '32 random bytes as hex', description: '64 characters 0-9 a-f' },
            ]}
          />
        </Field>
        <Field label="Kind">
          <Select
            value={form.kind}
            onValueChange={(kind) => setForm({ ...form, kind: kind as CredentialKind })}
            options={[
              { value: 'other', label: 'other', description: 'Used by name, or as the variable you name' },
              { value: 'http', label: 'http', description: 'Sent as an HTTP header by name' },
            ]}
            aria-label="Kind"
          />
        </Field>
        <Field label="Environment variable" optional>
          <Input value={form.envVar} onChange={(e) => setForm({ ...form, envVar: e.target.value })} className="font-mono" />
        </Field>
      </div>
    </Dialog>
  );
}

export function CredentialsTab() {
  const credentials = useCredentials();
  const repositories = useRepositories();
  const status = useVaultBridgeStatus();
  const mutations = useCredentialMutations();
  const connection = useConnection();
  const { toast } = useFeedback();
  const repos = repositories.data ?? [];
  const [editing, setEditing] = useState<CredentialView | 'new' | null>(null);
  const [removing, setRemoving] = useState<CredentialView | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', kind: 'cloudflare' as CredentialKind, envVar: '', description: '', value: '' });
  const managed = credentials.data?.find((c) => c.id === managing) ?? null;
  const startNew = () => {
    setForm({ name: '', kind: 'cloudflare', envVar: '', description: '', value: '' });
    setError(null);
    setEditing('new');
  };
  const save = () => {
    setError(null);
    const done = { onSuccess: () => { toast(editing === 'new' ? 'Credential stored' : 'Value replaced'); setEditing(null); }, onError: (e: unknown) => setError(errorMessage(e)) };
    if (editing === 'new') mutations.create.mutate({ name: form.name.trim(), kind: form.kind, envVar: form.envVar.trim() || null, description: form.description.trim(), value: form.value }, done);
    else if (editing) mutations.replace.mutate({ id: editing.id, value: form.value }, done);
  };
  const columns: Column<CredentialView>[] = [
    { key: 'name', header: 'Name', primary: true, sortValue: (c) => c.name, cell: (c) => <span className="font-semibold text-fg">{c.name}</span> },
    { key: 'kind', header: 'Kind', cell: (c) => <Badge>{c.kind}</Badge> },
    { key: 'source', header: 'Source', sortValue: (c) => c.source, cell: (c) => <span className="text-body text-fg-secondary">{SOURCE_LABEL[c.source]}</span> },
    {
      key: 'scope',
      header: 'Repositories',
      cell: (c) => <span className={c.repositoryIds?.length === 0 ? 'text-body text-warning' : 'text-body text-fg-secondary'}>{scopeText(c, repos)}</span>,
    },
    { key: 'vault', header: 'MyVault', cell: (c) => (c.vault ? <StatusChip visual={VAULT_VISUAL[c.vault.state]} size="compact" /> : <span className="text-fg-secondary">—</span>) },
    { key: 'used', header: 'Last used', hideStacked: true, sortValue: (c) => c.lastUsedAt ?? '', cell: (c) => (c.lastUsedAt ? <RelativeTime iso={c.lastUsedAt} /> : <span className="text-fg-secondary">Never</span>) },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (c) => (
        <span className="inline-flex gap-1">
          <Button size="compact" onClick={() => setManaging(c.id)}>
            Manage
          </Button>
          {managedByMyVault(c) ? null : (
            <Button size="compact" variant="ghost" onClick={() => { setForm({ ...form, value: '' }); setError(null); setEditing(c); }} disabled={!connection.online}>
              Replace value
            </Button>
          )}
        </span>
      ),
    },
  ];
  const s = status.data;
  const disconnected = s ? s.sessions.length === 0 : false;
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="info" title="Values are write-only">
        Stored encrypted with a key only your Windows account can unlock. Tools receive a value only for the one call that needs it; agents, logs and reports never see it.
      </Banner>
      {s && s.pendingPush > 0 && disconnected ? (
        <Banner
          tone="warning"
          title={`${s.pendingPush} generated ${s.pendingPush === 1 ? 'secret waits' : 'secrets wait'} for MyVault`}
          actions={
            <Button size="compact" icon={Vault} onClick={() => setConnecting(true)}>
              Connect MyVault to finish sync
            </Button>
          }
        >
          They stay encrypted here and cannot be deployed until MyVault has saved them. Nothing will be regenerated.
        </Banner>
      ) : null}
      {s && s.conflicts > 0 ? (
        <Banner tone="danger" title={`${s.conflicts} ${s.conflicts === 1 ? 'credential differs' : 'credentials differ'} from MyVault`}>
          Open Manage on the row marked Conflict and choose which value to keep. Neither side is changed until you do.
        </Banner>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button icon={Plus} variant="primary" onClick={startNew} disabled={!connection.online}>
          Add credential
        </Button>
        <Button icon={Sparkles} onClick={() => setGenerating(true)} disabled={!connection.online}>
          Generate secret
        </Button>
        <Button icon={Vault} onClick={() => setConnecting(true)} disabled={!connection.online}>
          Connect MyVault
        </Button>
      </div>
      {credentials.isLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <DataTable
          caption="Credentials"
          columns={columns}
          rows={credentials.data ?? []}
          rowKey={(c) => c.id}
          empty={<EmptyState icon={KeyRound} title="No credentials stored" description="Add a Cloudflare, GitHub or database credential, generate a secret, or connect MyVault — tools use them without them ever reaching an agent." />}
        />
      )}
      <CredentialDrawer credential={managed} repos={repos} onClose={() => setManaging(null)} onReplace={(c) => { setForm({ ...form, value: '' }); setError(null); setEditing(c); }} onDelete={(c) => setRemoving(c)} />
      <ConnectMyVaultDialog open={connecting} onOpenChange={setConnecting} />
      <GenerateDialog open={generating} onOpenChange={setGenerating} repos={repos} />
      <Dialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === 'new' ? 'Add a credential' : `Replace the value of ${editing?.name ?? ''}`}
        description="The value is not shown again after you save it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={mutations.create.isPending || mutations.replace.isPending} disabled={!form.value || (editing === 'new' && !/^[\w.-]+$/.test(form.name.trim()))}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Banner tone="danger" role="alert" title="Not saved">{error}</Banner> : null}
          {editing !== 'new' && editing?.source === 'generated' ? <Banner tone="warning" title="MyVault will be updated">The new value must reach MyVault again before it can be deployed.</Banner> : null}
          {editing === 'new' ? (
            <>
              <Field label="Name" helper="Letters, digits, dot, dash and underscore.">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="cloudflare-api" />
              </Field>
              <Field label="Kind">
                <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v as CredentialKind })} options={CREDENTIAL_KINDS.map((k) => ({ value: k, label: k, description: CREDENTIAL_KIND_ENV[k] ? `Given as ${CREDENTIAL_KIND_ENV[k]}` : 'Used by name (e.g. an HTTP header)' }))} />
              </Field>
              <Field label="Environment variable" optional helper={`Default: ${CREDENTIAL_KIND_ENV[form.kind] ?? 'none'}`}>
                <Input value={form.envVar} onChange={(e) => setForm({ ...form, envVar: e.target.value })} className="font-mono" />
              </Field>
              <Field label="Description" optional>
                <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
            </>
          ) : null}
          <Field label="Value">
            <Input type="password" autoComplete="off" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} className="font-mono" spellCheck={false} />
          </Field>
        </div>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete ${removing?.name ?? 'credential'}?`}
        description={removing?.vault ? 'Only the copy here is deleted; the MyVault item stays. Tools that use it will ask for sign-in again.' : 'Tools that use it will ask for sign-in again. The value cannot be recovered.'}
        confirmLabel="Delete credential"
        destructive
        busy={mutations.remove.isPending}
        onConfirm={() => {
          if (removing)
            mutations.remove.mutate(removing.id, {
              onSuccess: () => {
                setRemoving(null);
                setManaging(null);
              },
            });
        }}
      />
    </div>
  );
}
