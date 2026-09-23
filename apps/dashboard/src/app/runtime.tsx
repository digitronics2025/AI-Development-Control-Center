import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useFeedback } from '@acc/ui';
import { TASK_STATUS_LABEL, type TaskStatus } from '@acc/shared';
import { createApi, type Api } from '../api/client';
import { RealtimeClient, type ConnectionState } from '../api/realtime';
import { CacheSync } from '../api/sync';

/** Messages the WebView sends to the VS Code extension host. */
export type HostMessage =
  | { type: 'openFile'; repositoryPath: string; path: string }
  | { type: 'openDiff'; taskId: string; path: string }
  | { type: 'openArtifact'; artifactId: string; name: string }
  | { type: 'openExternal'; url: string }
  | { type: 'pickRepositoryFolder'; requestId: string };

export interface RuntimeConfig {
  baseUrl: string;
  token: string;
  host: 'web' | 'vscode';
  /** Present only inside VS Code: sends a message to the extension host. */
  postToHost?: (message: HostMessage) => void;
  /** Present only inside VS Code: resolves a folder picked with the native dialog. */
  pickFolder?: () => Promise<string | null>;
}

interface RuntimeValue extends RuntimeConfig {
  api: Api;
  realtime: RealtimeClient;
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

export function useConnection(): ConnectionState & { reconnect: () => void; online: boolean } {
  const { realtime } = useRuntime();
  const state = useSyncExternalStore(realtime.subscribe, realtime.getState, realtime.getState);
  return { ...state, reconnect: realtime.reconnectNow, online: state.status === 'open' };
}

function wsUrl(baseUrl: string, token: string): string {
  const base = baseUrl || window.location.origin;
  const url = new URL('/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

export function RuntimeProvider({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  const qc = useQueryClient();
  const { announce } = useFeedback();
  const value = useMemo(() => {
    const api = createApi({ baseUrl: config.baseUrl, token: config.token });
    const sync = new CacheSync(qc, (taskId, title, status) =>
      announce(`${taskId} ${title}: ${TASK_STATUS_LABEL[status as TaskStatus] ?? status}`),
    );
    const realtime = new RealtimeClient(wsUrl(config.baseUrl, config.token), sync.apply, (isReconnect) => {
      // Reconcile with the orchestrator: it is the source of truth.
      if (isReconnect) void qc.invalidateQueries();
    });
    return { ...config, api, realtime };
  }, [config, qc, announce]);

  useEffect(() => {
    value.realtime.start();
    return () => value.realtime.stop();
  }, [value.realtime]);

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}
