import { useEffect, useRef, useState } from 'react';
import { KeyRound, ShieldCheck, ShieldX, Unplug } from 'lucide-react';
import { Badge, Banner, EmptyState, KeyValueList, Panel } from '@acc/ui';
import type { VaultBridgeStatus } from '@acc/shared';
import { ApiError, authHeaders } from '../api/client';
import { useApi } from '../app/runtime';

/**
 * The popup MyVault opens to reach this orchestrator (docs/systems/credential-broker.md,
 * "MyVault bridge"). It is a relay and nothing more: it passes sealed
 * envelopes between the MyVault window that opened it and the local API,
 * and never holds a key, a value or a payload beyond the call in flight.
 *
 * It talks only to `window.opener`, and only when that window's origin is
 * one the operator trusted under Tools → Credentials; it never adds a trusted
 * origin itself, so a page that opens it cannot talk its way in.
 */

const PROTOCOL = 'mvcc-bridge-v1';
/** A little above the orchestrator's 512 KiB body limit for one envelope. */
const MAX_MESSAGE_CHARS = 600_000;

type Phase =
  | { kind: 'no-opener' }
  | { kind: 'waiting' }
  | { kind: 'untrusted'; origin: string }
  | { kind: 'connected'; origin: string; code: string }
  | { kind: 'closed'; reason: string }
  | { kind: 'error'; message: string };

type Incoming = { v: string; type: 'hello'; vaultId: string; publicKey: string } | { v: string; type: 'request'; id: number; envelope: unknown } | { v: string; type: 'close' };

function isIncoming(data: unknown): data is Incoming {
  const d = data as { v?: unknown; type?: unknown } | null;
  return Boolean(d && typeof d === 'object' && d.v === PROTOCOL && (d.type === 'hello' || d.type === 'request' || d.type === 'close'));
}

function tooLarge(data: unknown): boolean {
  try {
    return JSON.stringify(data).length > MAX_MESSAGE_CHARS;
  } catch {
    return true;
  }
}

export function VaultBridgePage() {
  const api = useApi();
  const [phase, setPhase] = useState<Phase>(() => (window.opener ? { kind: 'waiting' } : { kind: 'no-opener' }));
  const [relayed, setRelayed] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [identity, setIdentity] = useState<string | null>(null);
  const session = useRef<{ id: string; origin: string } | null>(null);

  useEffect(() => {
    document.title = 'MyVault bridge · Control Center';
    const opener = window.opener as Window | null;
    if (!opener) return;
    // Null until the trusted list is known: nothing is judged before that.
    let trusted: string[] | null = null;
    let alive = true;

    const post = (origin: string, message: Record<string, unknown>) => opener.postMessage({ v: PROTOCOL, ...message }, origin);
    // keepalive: MyVault closes this window right after saying so, and a lock
    // does it mid-sync; the close must outlive the page or the session would
    // linger until it expires.
    const closeSession = () => {
      const current = session.current;
      session.current = null;
      if (!current) return;
      void fetch(`${api.config.baseUrl}/api/vault-bridge/sessions/${current.id}`, { method: 'DELETE', headers: authHeaders(api.config.auth, 'DELETE'), credentials: 'same-origin', keepalive: true }).catch(() => undefined);
    };
    const end = (reason: string) => {
      closeSession();
      if (alive) setPhase({ kind: 'closed', reason });
    };

    const onMessage = async (event: MessageEvent) => {
      // Exact window and exact origin: anything else is ignored without a reply.
      if (event.source !== opener || !isIncoming(event.data) || trusted === null) return;
      if (!trusted.includes(event.origin)) {
        setPhase({ kind: 'untrusted', origin: event.origin });
        return;
      }
      if (tooLarge(event.data)) {
        post(event.origin, { type: 'error', id: null, code: 'TOO_LARGE', message: 'The message is too large' });
        return;
      }
      const data = event.data;
      if (data.type === 'hello') {
        try {
          const opened = await api.post<{ sessionId: string; publicKey: string; code: string; identityKey: string; signature: string }>('/api/vault-bridge/sessions', { origin: event.origin, vaultId: data.vaultId, publicKey: data.publicKey });
          session.current = { id: opened.sessionId, origin: event.origin };
          // The signature is the orchestrator's, over MyVault's key and ours: this page passes it on and could not make one.
          post(event.origin, { type: 'accept', sessionId: opened.sessionId, publicKey: opened.publicKey, code: opened.code, identityKey: opened.identityKey, signature: opened.signature });
          setPhase({ kind: 'connected', origin: event.origin, code: opened.code });
        } catch (error) {
          const code = error instanceof ApiError ? error.code : 'UNREACHABLE';
          post(event.origin, { type: 'error', id: null, code, message: 'The Control Center refused the connection' });
          setPhase({ kind: 'error', message: error instanceof Error ? error.message : 'The connection was refused.' });
        }
        return;
      }
      const current = session.current;
      if (!current || current.origin !== event.origin) return;
      if (data.type === 'close') {
        end('MyVault disconnected.');
        return;
      }
      try {
        const reply = await api.post<{ replies: unknown[]; closed: boolean }>(`/api/vault-bridge/sessions/${current.id}/messages`, { envelope: data.envelope });
        post(event.origin, { type: 'response', id: data.id, envelopes: reply.replies, closed: reply.closed });
        setRelayed((n) => n + 1);
        if (reply.closed) end('The sync finished and the connection closed.');
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'UNREACHABLE';
        post(event.origin, { type: 'error', id: data.id, code, message: 'The Control Center rejected the message and closed the connection' });
        // The server has usually closed it already; if the request never arrived, it has not.
        closeSession();
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : 'The message was rejected.' });
      }
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('pagehide', closeSession);

    // "Ready" goes to each trusted origin only; the browser drops it for any other opener.
    api
      .get<VaultBridgeStatus>('/api/vault-bridge/status')
      .then((status) => {
        // An unmounted page (a reload, React's development double mount) must not invite a second handshake.
        if (!alive) return;
        const origins = status.origins.map((o) => o.origin);
        trusted = origins;
        setIdentity(status.identity?.fingerprint ?? null);
        setLoaded(true);
        for (const origin of origins) post(origin, { type: 'ready' });
      })
      .catch(() => setPhase({ kind: 'error', message: 'The Control Center is not reachable.' }));

    return () => {
      alive = false;
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', closeSession);
    };
  }, [api]);

  return (
    <main aria-busy={!loaded} className="mx-auto flex min-h-dvh max-w-xl flex-col gap-4 bg-canvas px-4 py-6 text-fg">
      <header className="flex items-center gap-2">
        <KeyRound size={20} aria-hidden className="text-fg-secondary" />
        <h1 className="text-h2">MyVault bridge</h1>
      </header>
      {phase.kind === 'no-opener' ? (
        <EmptyState icon={Unplug} title="Open this from MyVault" description="In MyVault, go to Settings → AI Development Control Center and choose Connect and sync. This window then opens by itself." />
      ) : null}
      {phase.kind === 'waiting' ? (
        <Banner tone="info" title="Waiting for MyVault">
          If nothing happens, add the MyVault address under Tools → Credentials → Connect MyVault in the Control Center, then connect again from MyVault.
        </Banner>
      ) : null}
      {phase.kind === 'untrusted' ? (
        <Banner tone="danger" title="This address is not trusted" role="alert">
          <span className="wrap-anywhere">{phase.origin}</span> tried to connect. Nothing was shared. Only addresses added under Tools → Credentials → Connect MyVault can connect.
        </Banner>
      ) : null}
      {phase.kind === 'connected' ? (
        <Panel title="Connected" description="Values travel sealed between MyVault and the Control Center; this window only passes them along.">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} aria-hidden className="text-success" />
              <span className="text-body">Session code</span>
              <Badge className="font-mono text-body">{phase.code}</Badge>
            </div>
            <p className="text-small text-fg-secondary">MyVault shows the same code. If it does not, close both windows.</p>
            <KeyValueList
              items={[
                { label: 'MyVault', value: phase.origin },
                { label: 'Control Center key', value: identity ?? 'Unavailable' },
                { label: 'Messages relayed', value: String(relayed) },
              ]}
            />
          </div>
        </Panel>
      ) : null}
      {phase.kind === 'closed' ? (
        <Banner tone="success" title="Done">
          {phase.reason} You can close this window.
        </Banner>
      ) : null}
      {phase.kind === 'error' ? (
        <Banner tone="danger" title="The bridge stopped" role="alert">
          <span className="inline-flex items-center gap-1">
            <ShieldX size={14} aria-hidden /> {phase.message}
          </span>{' '}
          Anything already confirmed stays saved; connect again from MyVault to finish the rest.
        </Banner>
      ) : null}
    </main>
  );
}
