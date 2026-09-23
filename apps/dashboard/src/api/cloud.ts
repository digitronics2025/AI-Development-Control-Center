import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CloudCommandView, CloudNodeView, CloudPairingToken, CloudSession } from '@acc/shared';
import { useApi, useRuntime } from '../app/runtime';
import { keys } from './keys';

/** Cloud dashboard only (docs/systems/cloud-control.md): the control plane's own API under /api/cloud. */

export function useCloudSession() {
  const { api, mode } = useRuntime();
  return useQuery({ queryKey: keys.cloudSession, queryFn: ({ signal }) => api.get<CloudSession>('/api/cloud/session', signal), enabled: mode === 'cloud', staleTime: 5 * 60_000 });
}

export function usePairingTokens() {
  const { api, mode } = useRuntime();
  return useQuery({ queryKey: keys.cloudPairingTokens, queryFn: ({ signal }) => api.get<CloudPairingToken[]>('/api/cloud/pairing-tokens', signal), enabled: mode === 'cloud' });
}

export function useCloudCommands(limit = 25) {
  const { api, mode } = useRuntime();
  return useQuery({ queryKey: [...keys.cloudCommands, limit], queryFn: ({ signal }) => api.get<CloudCommandView[]>(`/api/cloud/commands?limit=${limit}`, signal), enabled: mode === 'cloud' });
}

export function useNodeMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const settleNode = (node: CloudNodeView) =>
    qc.setQueryData<CloudNodeView[]>(keys.cloudNodes, (old) => old?.map((n) => (n.id === node.id ? node : n)));
  return {
    createPairingCode: useMutation({
      mutationFn: (label: string) => api.post<{ id: string; label: string; token: string; expiresAt: string }>('/api/cloud/pairing-tokens', { label }),
      onSuccess: () => void qc.invalidateQueries({ queryKey: keys.cloudPairingTokens }),
    }),
    cancelPairingCode: useMutation({
      mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/cloud/pairing-tokens/${id}`),
      onSuccess: () => void qc.invalidateQueries({ queryKey: keys.cloudPairingTokens }),
    }),
    revoke: useMutation({ mutationFn: (id: string) => api.post<CloudNodeView>(`/api/cloud/nodes/${id}/revoke`), onSuccess: settleNode }),
    rotate: useMutation({ mutationFn: (id: string) => api.post<{ ok: boolean }>(`/api/cloud/nodes/${id}/rotate`) }),
  };
}
