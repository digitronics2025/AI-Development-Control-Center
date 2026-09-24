import { Ban, CheckCircle2, Link2, Unplug } from 'lucide-react';
import { useState } from 'react';
import {
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  RelativeTime,
  SegmentedControl,
  Skeleton,
  StatusChip,
  useFeedback,
  useNow,
  type Column,
  type StatusVisual,
} from '@acc/ui';
import { CONNECTED_APP_LABEL, type ConnectedAppMode, type ConnectedAppPairing, type ConnectedAppView } from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useConnectedAppMutations, useConnectedApps } from '../../api/connected-apps';
import { useConnection } from '../../app/runtime';

/**
 * Tools → Connected apps (design.md §7.11): local apps that may turn evidence
 * the operator approved into tasks — Private Browser today. Pairing shows a
 * one-time code and this Control Center's key; the app pins that key.
 */

const CONNECTED: StatusVisual = { label: 'Connected', tone: 'success', icon: CheckCircle2 };
const DISCONNECTED: StatusVisual = { label: 'Disconnected', tone: 'neutral', icon: Ban };

const MODE_OPTIONS: Array<{ value: ConnectedAppMode; label: string }> = [
  { value: 'discuss', label: 'Discuss First' },
  { value: 'autopilot', label: 'Autopilot' },
];

function PairDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const m = useConnectedAppMutations();
  const now = useNow(1000, open);
  const [offer, setOffer] = useState<ConnectedAppPairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = (next: boolean) => {
    if (!next) {
      // The code is shown once; closing withdraws it.
      if (offer) m.cancelPairing.mutate();
      setOffer(null);
      setError(null);
    }
    onOpenChange(next);
  };
  const secondsLeft = offer ? Math.max(0, Math.round((Date.parse(offer.expiresAt) - now) / 1000)) : 0;
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Pair Private Browser"
      description="Private Browser can then send page problems you approve there as tasks. It never gets any other access to this Control Center."
      footer={
        <Button variant="ghost" onClick={() => close(false)}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <Banner tone="danger" role="alert" title="No code">
            {error}
          </Banner>
        ) : null}
        {offer && secondsLeft > 0 ? (
          <>
            <section className="flex flex-col gap-1" aria-labelledby="pairing-code">
              <h3 id="pairing-code" className="text-h3">
                Pairing code
              </h3>
              <p className="tabular font-mono text-h2 tracking-widest text-fg" data-testid="pairing-code">
                {offer.code.slice(0, 4)} {offer.code.slice(4)}
              </p>
              <p className="tabular text-small text-fg-secondary">
                Works once · expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
              </p>
            </section>
            <ol className="list-decimal space-y-1 pl-5 text-body text-fg-secondary">
              <li>In Private Browser, open the Development workspace and the Developer panel.</li>
              <li>Under Control Center, choose Pair and type this code.</li>
              <li>Private Browser shows the key below. Continue only if it matches.</li>
            </ol>
          </>
        ) : (
          <div>
            <Button
              variant="primary"
              icon={Link2}
              loading={m.pair.isPending}
              onClick={() =>
                m.pair.mutate(undefined, {
                  onSuccess: (created) => {
                    setError(null);
                    setOffer(created);
                  },
                  onError: (e) => setError(errorMessage(e)),
                })
              }
            >
              {offer ? 'Make a new code' : 'Make a pairing code'}
            </Button>
          </div>
        )}
        <section className="flex flex-col gap-1" aria-labelledby="pair-key">
          <h3 id="pair-key" className="text-h3">
            This Control Center's key
          </h3>
          {offer ? (
            <p className="font-mono text-body wrap-anywhere" data-testid="pairing-fingerprint">
              {offer.identity.fingerprint}
            </p>
          ) : (
            <p className="text-small text-fg-secondary">Shown with the code. It is the same key MyVault checks.</p>
          )}
        </section>
      </div>
    </Dialog>
  );
}

export function ConnectedAppsTab() {
  const status = useConnectedApps();
  const m = useConnectedAppMutations();
  const connection = useConnection();
  const { toast } = useFeedback();
  const [pairOpen, setPairOpen] = useState(false);
  const [revoking, setRevoking] = useState<ConnectedAppView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const columns: Array<Column<ConnectedAppView>> = [
    {
      key: 'name',
      header: 'App',
      cell: (a) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-body font-semibold text-fg">{a.name}</span>
          <span className="text-small text-fg-secondary">{CONNECTED_APP_LABEL[a.kind]}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', cell: (a) => <StatusChip visual={a.revokedAt ? DISCONNECTED : CONNECTED} size="compact" /> },
    {
      key: 'mode',
      header: 'New tasks start in',
      cell: (a) =>
        a.revokedAt ? (
          <span className="text-fg-secondary">—</span>
        ) : (
          <SegmentedControl<ConnectedAppMode>
            label={`How tasks from ${a.name} start`}
            size="compact"
            value={a.defaultMode}
            options={MODE_OPTIONS}
            disabled={!connection.online || m.setMode.isPending}
            onValueChange={(defaultMode) => m.setMode.mutate({ id: a.id, defaultMode }, { onSuccess: () => toast(`Tasks from ${a.name} now start in ${defaultMode === 'discuss' ? 'Discuss First' : 'Autopilot'}`), onError: (e) => setError(errorMessage(e)) })}
          />
        ),
    },
    { key: 'tasks', header: 'Tasks', align: 'right', sortValue: (a) => a.taskCount, cell: (a) => <span className="tabular">{a.taskCount}</span> },
    { key: 'used', header: 'Last used', sortValue: (a) => a.lastUsedAt ?? '', cell: (a) => <RelativeTime iso={a.lastUsedAt} className="text-fg-secondary" />, hideStacked: true },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (a) =>
        a.revokedAt ? null : (
          <Button size="compact" variant="ghost" icon={Unplug} onClick={() => setRevoking(a)} disabled={!connection.online}>
            Disconnect
          </Button>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-body text-fg-secondary">
          Apps on this computer that can send you page problems as tasks. Each send is approved in the app first; the page it came from is attached as untrusted evidence, and the task follows this repository's usual policy.
        </p>
        <Button variant="primary" icon={Link2} onClick={() => setPairOpen(true)} disabled={!connection.online}>
          Pair Private Browser
        </Button>
      </div>
      {error ? (
        <Banner tone="danger" role="alert" title="Not changed">
          {error}
        </Banner>
      ) : null}
      {status.data && !status.data.identity ? (
        <Banner tone="danger" role="alert" title="Key unavailable">
          The Control Center could not open its key, so no app can pair. This happens when its data came from another computer.
        </Banner>
      ) : null}
      {status.isLoading ? (
        <Skeleton className="h-32" />
      ) : status.error ? (
        <Banner tone="danger" role="alert" title="Could not load connected apps">
          {errorMessage(status.error)}
        </Banner>
      ) : (
        <DataTable
          caption="Connected apps"
          columns={columns}
          rows={status.data?.apps ?? []}
          rowKey={(a) => a.id}
          initialSort={{ key: 'used', direction: 'desc' }}
          empty={<EmptyState icon={Link2} title="No apps paired" description="Pair Private Browser to send a problem you see on a page straight to a task." />}
        />
      )}
      <PairDialog open={pairOpen} onOpenChange={setPairOpen} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => !next && setRevoking(null)}
        title={`Disconnect ${revoking?.name ?? 'this app'}?`}
        description="It stops working at once and must be paired again. Tasks it already created stay."
        confirmLabel="Disconnect"
        destructive
        busy={m.revoke.isPending}
        onConfirm={() => {
          if (!revoking) return;
          m.revoke.mutate(revoking.id, {
            onSuccess: () => {
              toast(`${revoking.name} disconnected`);
              setRevoking(null);
            },
            onError: (e) => {
              setError(errorMessage(e));
              setRevoking(null);
            },
          });
        }}
      />
    </div>
  );
}
