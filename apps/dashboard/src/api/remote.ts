import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RemoteNodeStatus } from '@acc/shared';
import { useApi } from '../app/runtime';
import { keys } from './keys';

/** This machine's link to the cloud control plane (local mode only; docs/systems/remote-node.md). */
export function useRemoteStatus(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: keys.remoteStatus, queryFn: ({ signal }) => api.get<RemoteNodeStatus>('/api/remote', signal), enabled });
}

export function useRemoteMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const settle = (status: RemoteNodeStatus) => qc.setQueryData(keys.remoteStatus, status);
  return {
    pair: useMutation({ mutationFn: (input: { relayUrl: string; code: string; label: string }) => api.post<RemoteNodeStatus>('/api/remote/pair', input), onSuccess: settle }),
    unpair: useMutation({ mutationFn: () => api.post<RemoteNodeStatus>('/api/remote/unpair'), onSuccess: settle }),
    update: useMutation({
      mutationFn: (patch: Partial<Pick<RemoteNodeStatus, 'enabled' | 'remoteTerminals' | 'remoteTools'>>) => api.patch<RemoteNodeStatus>('/api/remote', patch),
      onSuccess: settle,
    }),
    rotate: useMutation({ mutationFn: () => api.post<RemoteNodeStatus>('/api/remote/rotate'), onSuccess: settle }),
    reconnect: useMutation({ mutationFn: () => api.post<RemoteNodeStatus>('/api/remote/reconnect'), onSuccess: settle }),
  };
}
