import { KeyRound, Link2, Link2Off, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Banner, Button, ConfirmDialog, Field, Input, KeyValueList, Panel, Skeleton, StatusChip, Switch, REMOTE_LINK_VISUAL, useFeedback } from '@acc/ui';
import { PAIRING_TOKEN_PREFIX } from '@acc/shared';
import { errorMessage } from '../api/client';
import { useRemoteMutations, useRemoteStatus } from '../api/remote';

function Row({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 max-w-prose flex-col">
        <span className="text-body font-semibold text-fg">{title}</span>
        <span className="text-small text-fg-secondary">{description}</span>
      </div>
      {children}
    </div>
  );
}

type Risky = 'remoteTerminals' | 'remoteTools' | null;

/**
 * Settings → Remote access (design.md §7.8). Pairs this machine with the
 * cloud control plane and holds the permissions only this machine may grant.
 * Changes apply immediately; they are not part of the Settings draft.
 */
export function RemoteAccessPanel() {
  const status = useRemoteStatus();
  const m = useRemoteMutations();
  const { toast } = useFeedback();
  const [relayUrl, setRelayUrl] = useState('');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('This PC');
  const [error, setError] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [risky, setRisky] = useState<Risky>(null);

  if (status.isLoading || !status.data) {
    return (
      <Panel title="Remote access" headingLevel={2}>
        {status.error ? <Banner tone="danger" title="Remote access status is unavailable">{errorMessage(status.error)}</Banner> : <Skeleton className="h-40" />}
      </Panel>
    );
  }
  const s = status.data;
  const run = (p: Promise<unknown>, done: string) =>
    p.then(
      () => {
        setError(null);
        toast(done);
      },
      (e: unknown) => setError(errorMessage(e)),
    );

  if (!s.paired) {
    const codeOk = code.trim().startsWith(PAIRING_TOKEN_PREFIX);
    return (
      <Panel
        title="Remote access"
        headingLevel={2}
        description="Use this machine from anywhere through your cloud control plane. The machine connects out to the cloud; nothing on it opens to the internet, and it keeps working when the cloud is away."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(m.pair.mutateAsync({ relayUrl: relayUrl.trim(), code: code.trim(), label: label.trim() }), 'Paired with the cloud');
          }}
        >
          {error ? (
            <Banner tone="danger" role="alert" title="Pairing did not work">
              {error}
            </Banner>
          ) : null}
          <Field label="Relay address" inline helper="The node address of your control plane, for example https://acc-relay.example.com.">
            <Input value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} placeholder="https://" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Pairing code" inline helper="Create one on the cloud dashboard's Nodes page. It works once and expires after 15 minutes.">
            <Input value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Name for this machine" inline helper="Shown in the cloud dashboard.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
          </Field>
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              icon={Link2}
              loading={m.pair.isPending}
              disabled={!relayUrl.trim() || !codeOk || !label.trim()}
              disabledReason="Enter the relay address, a pairing code and a name"
            >
              Pair this machine
            </Button>
          </div>
        </form>
      </Panel>
    );
  }

  const visual = REMOTE_LINK_VISUAL[s.state];
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Remote access" headingLevel={2} description="This machine is an execution node of your cloud control plane. Work always runs here; the cloud only relays your requests.">
        <div className="flex flex-col gap-4">
          {error ? (
            <Banner tone="danger" role="alert" title="That did not work">
              {error}
            </Banner>
          ) : null}
          {s.state === 'revoked' ? (
            <Banner tone="danger" title="The cloud revoked this machine">
              Nothing can be controlled remotely. Unpair, then pair again with a new code to restore access.
            </Banner>
          ) : s.lastError && s.state !== 'connected' ? (
            <Banner tone="warning" title="Not connected to the cloud">
              {s.lastError}
            </Banner>
          ) : null}
          <KeyValueList
            items={[
              { label: 'Status', value: <StatusChip visual={visual} size="compact" /> },
              { label: 'Name', value: s.label },
              { label: 'Relay', value: <code className="font-mono text-code wrap-anywhere">{s.relayUrl}</code> },
              { label: 'Node id', value: <code className="font-mono text-code wrap-anywhere">{s.nodeId}</code> },
              { label: 'Key', value: `Version ${s.keyVersion ?? 1}, sealed on this machine` },
              { label: 'Last connected', value: s.lastConnectedAt ? new Date(s.lastConnectedAt).toLocaleString() : 'Never' },
              { label: 'Waiting to sync', value: s.outboxDepth ? `${s.outboxDepth} update${s.outboxDepth === 1 ? '' : 's'}` : 'Nothing' },
            ]}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              icon={RefreshCw}
              onClick={() => void run(m.reconnect.mutateAsync(), 'Reconnecting')}
              loading={m.reconnect.isPending}
              disabled={!s.enabled || s.state === 'connected'}
              disabledReason={s.enabled ? 'Already connected' : 'Remote control is turned off'}
            >
              Reconnect
            </Button>
            <Button icon={KeyRound} onClick={() => void run(m.rotate.mutateAsync(), 'Key replaced')} loading={m.rotate.isPending} disabled={s.state !== 'connected'} disabledReason="Connect to the cloud first">
              Replace key
            </Button>
            <Button variant="destructive" icon={Link2Off} onClick={() => setConfirmUnpair(true)}>
              Unpair
            </Button>
          </div>
        </div>
      </Panel>
      <Panel
        title="What the cloud may do"
        headingLevel={2}
        description="Only this machine can change these. Approvals, dangerous-command confirmations and your Permissions level apply to remote requests exactly as to local ones."
      >
        <div className="flex flex-col divide-y divide-border-subtle">
          <Row title="Allow remote control" description="Tasks, Chairman chat, approvals and Source Control from the cloud dashboard. Off: the machine refuses every remote request.">
            <Switch aria-label="Allow remote control" checked={s.enabled} onCheckedChange={(v) => void run(m.update.mutateAsync({ enabled: v }), v ? 'Remote control on' : 'Remote control off')} />
          </Row>
          <Row
            title="Allow remote terminals"
            description="Open a shell on this machine from the cloud. Every line is checked like an agent's; dangerous commands are refused remotely. Terminals close after 10 idle minutes and 30 minutes at most."
          >
            <Switch
              aria-label="Allow remote terminals"
              checked={s.remoteTerminals}
              onCheckedChange={(v) => (v ? setRisky('remoteTerminals') : void run(m.update.mutateAsync({ remoteTerminals: false }), 'Remote terminals off'))}
            />
          </Row>
          <Row title="Allow remote tool calls" description="Run a Control Center tool from the cloud dashboard. Tools still follow the execution policy and ask for approval where it says so.">
            <Switch
              aria-label="Allow remote tool calls"
              checked={s.remoteTools}
              onCheckedChange={(v) => (v ? setRisky('remoteTools') : void run(m.update.mutateAsync({ remoteTools: false }), 'Remote tool calls off'))}
            />
          </Row>
        </div>
      </Panel>
      <ConfirmDialog
        open={confirmUnpair}
        onOpenChange={setConfirmUnpair}
        title="Unpair this machine?"
        description="The cloud can no longer reach it. Task history already in the cloud stays there until you revoke the node on the Nodes page. Local work is not affected."
        confirmLabel="Unpair"
        destructive
        onConfirm={() => {
          setConfirmUnpair(false);
          void run(m.unpair.mutateAsync(), 'Unpaired');
        }}
      />
      <ConfirmDialog
        open={risky !== null}
        onOpenChange={(open) => {
          if (!open) setRisky(null);
        }}
        title={risky === 'remoteTerminals' ? 'Allow remote terminals?' : 'Allow remote tool calls?'}
        description={
          risky === 'remoteTerminals'
            ? 'Anyone signed in to your cloud dashboard could then open a shell on this machine. Each terminal needs its own confirmation and closes on its own.'
            : 'Anyone signed in to your cloud dashboard could then run Control Center tools on this machine within your execution policy.'
        }
        confirmLabel="Allow"
        cancelLabel="Keep it off"
        confirmationPhrase={risky === 'remoteTerminals' ? 'REMOTE TERMINALS' : 'REMOTE TOOLS'}
        onConfirm={() => {
          const key = risky;
          setRisky(null);
          if (key) void run(m.update.mutateAsync({ [key]: true }), key === 'remoteTerminals' ? 'Remote terminals on' : 'Remote tool calls on');
        }}
      />
    </div>
  );
}
