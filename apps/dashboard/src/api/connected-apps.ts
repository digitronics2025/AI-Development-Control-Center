import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectedAppMode, ConnectedAppPairing, ConnectedAppsStatus, ConnectedAppTaskOrigin, ConnectedAppView } from '@acc/shared';
import { useApi, useRuntime } from '../app/runtime';
import { keys } from './keys';

/**
 * Connected apps (docs/systems/connected-apps.md). Local mode only: the cloud
 * can never reach these routes, so the cloud dashboard does not ask.
 */

export function useConnectedApps(refetchInterval: number | false = false) {
  const api = useApi();
  const { mode } = useRuntime();
  return useQuery({
    queryKey: keys.connectedApps,
    queryFn: ({ signal }) => api.get<ConnectedAppsStatus>('/api/connected-apps', signal),
    enabled: mode === 'local',
    refetchInterval,
  });
}

export function useConnectedAppMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.connectedAppsRoot });
  return {
    pair: useMutation({ mutationFn: () => api.post<ConnectedAppPairing>('/api/connected-apps/pairings', { kind: 'private-browser' }), onSuccess: refresh }),
    cancelPairing: useMutation({ mutationFn: () => api.del('/api/connected-apps/pairings'), onSuccess: refresh }),
    setMode: useMutation({ mutationFn: (input: { id: string; defaultMode: ConnectedAppMode }) => api.patch<ConnectedAppView>(`/api/connected-apps/${input.id}`, { defaultMode: input.defaultMode }), onSuccess: refresh }),
    revoke: useMutation({ mutationFn: (id: string) => api.post<ConnectedAppView>(`/api/connected-apps/${id}/revoke`), onSuccess: refresh }),
  };
}

/** The app a task came from, if a connected app created it. */
export function useTaskOrigin(taskId: string): ConnectedAppTaskOrigin | null {
  const api = useApi();
  const { mode } = useRuntime();
  const origins = useQuery({
    queryKey: keys.connectedAppOrigins,
    queryFn: ({ signal }) => api.get<ConnectedAppTaskOrigin[]>('/api/connected-apps/task-origins', signal),
    enabled: mode === 'local',
    staleTime: 30_000,
  });
  return origins.data?.find((o) => o.taskId === taskId) ?? null;
}
