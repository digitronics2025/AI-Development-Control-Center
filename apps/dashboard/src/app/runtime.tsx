import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useFeedback } from '@acc/ui';
import { TASK_STATUS_LABEL, type ClientMessage, type CloudNodeView, type RelayedServerMessage, type TaskStatus } from '@acc/shared';
import { createApi, type Api } from '../api/client';
import { keys } from '../api/keys';
import { RealtimeClient, type ConnectionState } from '../api/realtime';
import { SessionWatch, type SessionState } from '../api/session';
import { CacheSync } from '../api/sync';
import { NodeSelection, pickNode } from './mode';

/** Messages the WebView sends to the VS Code extension host. */
export type HostMessage =
  | { type: 'openFile'; repositoryPath: string; path: string }
  | { type: 'openDiff'; taskId: string; path: string; repositoryId?: string }
  | { type: 'openSourceControlDiff'; repositoryId: string; path: string; mode: 'staged' | 'unstaged' }
  | { type: 'openCommitDiff'; repositoryId: string; sha: string; path: string }
  | { type: 'revealRepository'; repositoryPath: string }
  | { type: 'openArtifact'; artifactId: string; name: string }
  | { type: 'openExternal'; url: string }
  | { type: 'pickRepositoryFolder'; requestId: string };

/**
 * Where the dashboard runs (design.md §13, docs/systems/cloud-control.md):
 * - `local`: served by the orchestrator (or inside VS Code) with its token;
 * - `cloud`: served by the cloud control plane behind Cloudflare Access, with
 *   no token at all, talking to one selected execution node at a time.
 */
export type RuntimeMode = 'local' | 'cloud';

export interface RuntimeConfig {
  baseUrl: string;
  mode: RuntimeMode;
  /** Local mode only. */
  token?: string;
  host: 'web' | 'vscode';
  /** Present only inside VS Code: sends a message to the extension host. */
  postToHost?: (message: HostMessage) => void;
  /** Present only inside VS Code: resolves a folder picked with the native dialog. */
  pickFolder?: () => Promise<string | null>;
}

export { detectMode, NodeSelection, pickNode } from './mode';

interface RuntimeValue extends RuntimeConfig {
  api: Api;
  realtime: RealtimeClient;
  /** Cloud mode only. */
  nodes: NodeSelection | null;
  /** Cloud mode only: whether the Access sign-in still holds. */
  session: SessionWatch | null;
}

const RuntimeContext = createContext<RuntimeValue | null>(null);

export function useRuntime(): RuntimeValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error('useRuntime must be used inside <RuntimeProvider>');
  return value;
}

export function useApi(): Api {
  return useRuntime().api;
}

/** Cloud mode: the paired nodes, kept current by `remote.node` realtime messages. */
export function useCloudNodes() {
  const { api, mode } = useRuntime();
  return useQuery({ queryKey: keys.cloudNodes, queryFn: ({ signal }) => api.get<CloudNodeView[]>('/api/cloud/nodes', signal), enabled: mode === 'cloud' });
}

export function useSelectedNode(): { node: CloudNodeView | null; nodeId: string | null; select: (id: string) => void } {
  const { nodes } = useRuntime();
  const list = useCloudNodes();
  const noop = useMemo(() => new NodeSelection(null), []);
  const store = nodes ?? noop;
  const nodeId = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { nodeId, node: list.data?.find((n) => n.id === nodeId) ?? null, select: (id) => store.select(id) };
}

const neverExpires = { get: (): SessionState => 'ok', subscribe: () => () => {} };

/** Cloud mode: 'expired' once Cloudflare Access stopped accepting this page's sign-in. */
export function useSessionState(): SessionState {
  const { session } = useRuntime();
  const store = session ?? neverExpires;
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export interface Connection extends ConnectionState {
  reconnect: () => void;
  /** Actions may be sent: the realtime link is up and (cloud) the selected node is reachable. */
  online: boolean;
  mode: RuntimeMode;
  /** Cloud mode: the realtime link to the control plane itself is up. */
  linkOpen: boolean;
  node: CloudNodeView | null;
}

export function useConnection(): Connection {
  const { realtime, mode } = useRuntime();
  const state = useSyncExternalStore(realtime.subscribe, realtime.getState, realtime.getState);
  const { node } = useSelectedNode();
  const linkOpen = state.status === 'open';
  const nodeUsable = node !== null && (node.status === 'online' || node.status === 'degraded') && !node.updateRequired;
  return { ...state, reconnect: realtime.reconnectNow, mode, linkOpen, node, online: linkOpen && (mode === 'local' || nodeUsable) };
}

function wsUrl(baseUrl: string, token: string | null): string {
  const base = baseUrl || window.location.origin;
  const url = new URL('/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function applyCloudMessage(qc: QueryClient, message: RelayedServerMessage): void {
  if (message.type === 'remote.node') {
    const node = message.node;
    qc.setQueryData<CloudNodeView[]>(keys.cloudNodes, (old) => {
      if (!old) return old;
      const i = old.findIndex((n) => n.id === node.id);
      if (i === -1) return [...old, node];
      const next = old.slice();
      next[i] = node;
      return next;
    });
  } else if (message.type === 'remote.command') {
    void qc.invalidateQueries({ queryKey: keys.cloudCommands });
  }
}

/** Cloud mode: follow the node list, keep a usable node selected, refetch everything on a switch. */
function CloudNodeSync({ nodes }: { nodes: NodeSelection }) {
  const qc = useQueryClient();
  const list = useCloudNodes();
  useEffect(() => {
    if (!list.data) return;
    const next = pickNode(list.data, nodes.get());
    if (next !== nodes.get()) nodes.select(next);
  }, [list.data, nodes]);
  useEffect(
    () =>
      nodes.subscribe(() => {
        void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'cloud' });
      }),
    [nodes, qc],
  );
  return null;
}

export function RuntimeProvider({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  const qc = useQueryClient();
  const { announce } = useFeedback();
  const value = useMemo(() => {
    const nodes = config.mode === 'cloud' ? new NodeSelection() : null;
    const session = config.mode === 'cloud' ? new SessionWatch() : null;
    const api = createApi({
      baseUrl: config.baseUrl,
      auth: nodes ? { kind: 'cloud', node: nodes.get } : { kind: 'local', token: config.token ?? '' },
      onAuthSuspect: session?.check,
    });
    const sync = new CacheSync(qc, (taskId, title, status) => announce(`${taskId} ${title}: ${TASK_STATUS_LABEL[status as TaskStatus] ?? status}`));
    const routing = nodes
      ? {
          // Keep only what the selected node says; the cloud's own messages are handled apart.
          accept: (m: RelayedServerMessage) => !m.nodeId || m.nodeId === nodes.get(),
          decorate: (m: ClientMessage) => ({ ...m, nodeId: nodes.get() ?? undefined }),
          onCloudMessage: (m: RelayedServerMessage) => applyCloudMessage(qc, m),
          // One failed reconnect is a blip; a second may be Access refusing the upgrade.
          onLinkFailure: (attempts: number) => {
            if (attempts >= 2) session?.check();
          },
        }
      : null;
    const realtime = new RealtimeClient(
      wsUrl(config.baseUrl, config.mode === 'local' ? (config.token ?? '') : null),
      sync.apply,
      (isReconnect) => {
        // Reconcile with the source of truth after any gap.
        if (isReconnect) void qc.invalidateQueries();
      },
      routing,
    );
    return { ...config, api, realtime, nodes, session };
  }, [config, qc, announce]);

  useEffect(() => {
    value.realtime.start();
    return () => value.realtime.stop();
  }, [value.realtime]);

  return (
    <RuntimeContext.Provider value={value}>
      {value.nodes ? <CloudNodeSync nodes={value.nodes} /> : null}
      {children}
    </RuntimeContext.Provider>
  );
}
