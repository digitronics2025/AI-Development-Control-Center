import { Ban, Copy, Eye, KeyRound, Link2, X } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Panel,
  RelativeTime,
  Skeleton,
  StatusChip,
  NODE_STATUS_VISUAL,
  useFeedback,
  type Column,
} from '@acc/ui';
import type { CloudCommandView, CloudNodeView, CloudPairingToken } from '@acc/shared';
import { useCloudCommands, useCloudSession, useNodeMutations, usePairingTokens } from '../api/cloud';
import { errorMessage } from '../api/client';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useCloudNodes, useSelectedNode } from '../app/runtime';

function CopyField({ label, value }: { label: string; value: string }) {
  const { toast } = useFeedback();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-body font-semibold text-fg">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded-md border border-border-subtle bg-muted px-3 py-2 font-mono text-code text-fg wrap-anywhere">{value}</code>
        <Button
          icon={Copy}
          onClick={() =>
            void navigator.clipboard.writeText(value).then(
              () => toast(`${label} copied`),
              () => toast('Copy it by hand: the browser blocked the clipboard', 'info'),
            )
          }
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

function PairDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useCloudSession();
  const { createPairingCode } = useNodeMutations();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; expiresAt: string } | null>(null);
  const close = (next: boolean) => {
    if (!next) {
      // The code is shown once; closing forgets it.
      setCreated(null);
      setLabel('');
      setError(null);
    }
    onOpenChange(next);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Pair a node"
      description="A one-time code lets one machine join. Work, files and credentials stay on that machine."
      footer={
        created ? (
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={Link2}
              loading={createPairingCode.isPending}
              onClick={() =>
                createPairingCode.mutate(label.trim() || 'New node', {
                  onSuccess: (r) => setCreated({ token: r.token, expiresAt: r.expiresAt }),
                  onError: (e) => setError(errorMessage(e)),
                })
              }
            >
              Create pairing code
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-4">
          <CopyField label="Relay address" value={session.data?.relayUrl ?? ''} />
          <CopyField label="Pairing code" value={created.token} />
          <p className="text-small text-fg-secondary">
            Works once, until {new Date(created.expiresAt).toLocaleTimeString()}. On that machine open the Control Center, go to <strong>Settings → Remote access</strong>, paste the address and the code, then press <strong>Pair this machine</strong>.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {error ? (
            <Banner tone="danger" role="alert" title="No code was created">
              {error}
            </Banner>
          ) : null}
          <Field label="Name for the machine" helper="Only a reminder for you; the machine chooses its own name when it pairs.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Desk PC" />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

/** design.md §7.12 — the machines that run the work. Cloud dashboard only. */
export function NodesPage() {
  useBreadcrumb([{ label: 'Nodes' }]);
  const nodes = useCloudNodes();
  const tokens = usePairingTokens();
  const commands = useCloudCommands();
  const { nodeId: selected, select } = useSelectedNode();
  const m = useNodeMutations();
  const { toast } = useFeedback();
  const [pairOpen, setPairOpen] = useState(false);
  const [revoking, setRevoking] = useState<CloudNodeView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nodeColumns: Column<CloudNodeView>[] = [
    {
      key: 'name',
      header: 'Node',
      primary: true,
      sortValue: (n) => n.label,
      cell: (n) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 font-semibold text-fg">
            {n.label}
            {n.id === selected ? <Badge>Shown</Badge> : null}
          </span>
          <span className="truncate text-small text-fg-tertiary">{n.os ?? 'Unknown system'} · Control Center {n.appVersion ?? '?'}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (n) => (
        <span className="flex flex-wrap items-center gap-2">
          <StatusChip visual={NODE_STATUS_VISUAL[n.status]} size="compact" />
          {n.updateRequired ? <Badge title={`Protocol ${n.protocolVersion ?? '?'} is too old`}>Update required</Badge> : null}
        </span>
      ),
    },
    { key: 'seen', header: 'Last seen', sortValue: (n) => n.lastSeenAt ?? '', cell: (n) => (n.lastSeenAt ? <RelativeTime iso={n.lastSeenAt} /> : <span className="text-fg-tertiary">Never</span>) },
    { key: 'repos', header: 'Repositories', align: 'right', sortValue: (n) => n.repositories.length, cell: (n) => n.repositories.length },
    {
      key: 'agents',
      header: 'Agents',
      hideStacked: true,
      cell: (n) => (n.capabilities ? n.capabilities.agents.map((a) => `${a.name}: ${a.state}`).join(' · ') : <span className="text-fg-tertiary">Not reported yet</span>),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (n) =>
        n.status === 'revoked' ? (
          <span className="text-small text-fg-tertiary">Revoked {n.revokedAt ? new Date(n.revokedAt).toLocaleDateString() : ''}</span>
        ) : (
          <span className="flex flex-wrap gap-1.5">
            <Button size="compact" variant="ghost" icon={Eye} onClick={() => select(n.id)} disabled={n.id === selected} disabledReason="Already shown">
              Show
            </Button>
            <Button
              size="compact"
              variant="ghost"
              icon={KeyRound}
              disabled={n.status !== 'online'}
              disabledReason="The node must be online"
              onClick={() => m.rotate.mutate(n.id, { onSuccess: () => toast(`${n.label} is replacing its key`), onError: (e) => setError(errorMessage(e)) })}
            >
              Replace key
            </Button>
            <Button size="compact" variant="destructive" icon={Ban} onClick={() => setRevoking(n)}>
              Revoke
            </Button>
          </span>
        ),
    },
  ];

  const tokenColumns: Column<CloudPairingToken>[] = [
    { key: 'label', header: 'For', primary: true, cell: (t) => t.label },
    { key: 'by', header: 'Created by', cell: (t) => t.createdBy },
    { key: 'created', header: 'Created', cell: (t) => <RelativeTime iso={t.createdAt} /> },
    {
      key: 'state',
      header: 'State',
      cell: (t) => (t.usedAt ? 'Used' : t.revokedAt ? 'Cancelled' : Date.parse(t.expiresAt) < Date.now() ? 'Expired' : `Active until ${new Date(t.expiresAt).toLocaleTimeString()}`),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (t) =>
        !t.usedAt && !t.revokedAt && Date.parse(t.expiresAt) > Date.now() ? (
          <Button size="compact" variant="ghost" icon={X} onClick={() => m.cancelPairingCode.mutate(t.id)}>
            Cancel
          </Button>
        ) : null,
    },
  ];

  const commandColumns: Column<CloudCommandView>[] = [
    { key: 'op', header: 'Action', primary: true, cell: (c) => <code className="font-mono text-code">{c.op}</code> },
    { key: 'node', header: 'Node', cell: (c) => nodes.data?.find((n) => n.id === c.nodeId)?.label ?? c.nodeId },
    { key: 'status', header: 'Result', cell: (c) => (c.errorCode ? `${c.status} (${c.errorCode})` : c.httpStatus ? `${c.status} (${c.httpStatus})` : c.status) },
    { key: 'by', header: 'By', hideStacked: true, cell: (c) => c.createdBy },
    { key: 'when', header: 'When', sortValue: (c) => c.createdAt, cell: (c) => <RelativeTime iso={c.createdAt} /> },
  ];

  return (
    <div className="flex flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader
        title="Nodes"
        description="The machines that run your work. The cloud relays your requests; files, credentials and the work itself stay on each machine."
        actions={
          <Button variant="primary" icon={Link2} onClick={() => setPairOpen(true)}>
            Pair a node
          </Button>
        }
      />
      {error ? (
        <Banner tone="danger" role="alert" title="That did not work">
          {error}
        </Banner>
      ) : null}
      <Panel title="Paired nodes" headingLevel={2}>
        {nodes.isLoading ? (
          <Skeleton className="h-32" />
        ) : nodes.data?.length ? (
          <DataTable caption="Paired nodes" columns={nodeColumns} rows={nodes.data} rowKey={(n) => n.id} />
        ) : (
          <EmptyState title="No machine is paired yet" description="Pair the computer that runs your agents to start and follow tasks from anywhere." action={<Button icon={Link2} onClick={() => setPairOpen(true)}>Pair a node</Button>} />
        )}
      </Panel>
      <Panel title="Pairing codes" headingLevel={2} description="The codes themselves are never stored; only who created them and whether they were used.">
        {tokens.data?.length ? <DataTable caption="Pairing codes" columns={tokenColumns} rows={tokens.data} rowKey={(t) => t.id} /> : <p className="text-body text-fg-secondary">No pairing codes yet.</p>}
      </Panel>
      <Panel title="Recent remote actions" headingLevel={2} description="What the cloud asked machines to do, and what they answered.">
        {commands.data?.length ? <DataTable caption="Recent remote actions" columns={commandColumns} rows={commands.data} rowKey={(c) => c.id} /> : <p className="text-body text-fg-secondary">Nothing yet.</p>}
      </Panel>
      <PairDialog open={pairOpen} onOpenChange={setPairOpen} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke ${revoking?.label ?? 'this node'}?`}
        description="The machine is cut off at once: its connection closes, waiting actions are cancelled and it can never sign in again with its current key. Its history stays here. To use it again, pair it anew."
        confirmLabel="Revoke node"
        destructive
        confirmationPhrase="REVOKE"
        onConfirm={() => {
          const node = revoking;
          setRevoking(null);
          if (node) m.revoke.mutate(node.id, { onSuccess: () => toast(`${node.label} revoked`), onError: (e) => setError(errorMessage(e)) });
        }}
      />
    </div>
  );
}
