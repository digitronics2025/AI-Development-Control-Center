import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CapabilityEscalation,
  CapabilityView,
  CredentialEventView,
  CredentialKind,
  CredentialView,
  McpServerInput,
  McpServerView,
  PolicyMode,
  RecoveryAttempt,
  TaskCheckpoint,
  TaskProcess,
  TerminalSession,
  ToolExecution,
  ToolView,
  VaultBridgeStatus,
  VaultResolveAction,
} from '@acc/shared';
import { useApi } from '../app/runtime';
import { keys } from './keys';

/** Everything the task Execution tab shows, in one request, patched live by `sync.ts`. */
export interface TaskExecutionView {
  executions: ToolExecution[];
  processes: TaskProcess[];
  terminals: TerminalSession[];
  recovery: RecoveryAttempt[];
  escalations: CapabilityEscalation[];
  checkpoints: TaskCheckpoint[];
  workdir: string | null;
  policyMode: PolicyMode;
}

export function useTools() {
  const api = useApi();
  return useQuery({ queryKey: keys.tools, queryFn: ({ signal }) => api.get<ToolView[]>('/api/tools', signal) });
}

export function useCapabilities(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: keys.capabilities, queryFn: ({ signal }) => api.get<CapabilityView[]>('/api/tools/capabilities', signal), enabled });
}

export function useToolMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (tool: ToolView) => qc.setQueryData<ToolView[]>(keys.tools, (old) => old?.map((t) => (t.id === tool.id ? tool : t)));
  return {
    check: useMutation({ mutationFn: ({ id, auth }: { id: string; auth?: boolean }) => api.post<ToolView>(`/api/tools/${id}/check`, { auth: Boolean(auth) }), onSuccess: set }),
    refresh: useMutation({ mutationFn: () => api.post<{ ok: boolean }>('/api/tools/refresh') }),
  };
}

export function useTaskExecution(taskId: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.taskExecution(taskId), queryFn: ({ signal }) => api.get<TaskExecutionView>(`/api/tasks/${taskId}/execution`, signal) });
}

export function useProcesses() {
  const api = useApi();
  return useQuery({ queryKey: keys.processes, queryFn: ({ signal }) => api.get<TaskProcess[]>('/api/processes', signal) });
}

export function useStopProcess() {
  const api = useApi();
  return useMutation({ mutationFn: (id: string) => api.post<TaskProcess>(`/api/processes/${id}/stop`) });
}

export function useTerminals() {
  const api = useApi();
  return useQuery({ queryKey: keys.terminals, queryFn: ({ signal }) => api.get<TerminalSession[]>('/api/terminals', signal) });
}

export function useTerminalMutations() {
  const api = useApi();
  const qc = useQueryClient();
  return {
    open: useMutation({
      // `confirmed`: the cloud needs an explicit confirmation to open a terminal on a node.
      mutationFn: ({ confirmed, ...input }: { repositoryId?: string; taskId?: string; cols?: number; rows?: number; confirmed?: boolean }) =>
        api.post<TerminalSession>('/api/terminals', input, confirmed ? { 'x-acc-confirm': 'open-terminal' } : undefined),
      onSuccess: (t) => qc.setQueryData<TerminalSession[]>(keys.terminals, (old) => (old ? [t, ...old.filter((x) => x.id !== t.id)] : old)),
    }),
    close: useMutation({ mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/terminals/${id}`) }),
  };
}

export function useMcpServers() {
  const api = useApi();
  return useQuery({ queryKey: keys.mcpServers, queryFn: ({ signal }) => api.get<McpServerView[]>('/api/mcp', signal) });
}

export function useMcpMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.mcpServers });
  return {
    create: useMutation({ mutationFn: (input: McpServerInput) => api.post<McpServerView>('/api/mcp', input), onSuccess: refresh }),
    check: useMutation({ mutationFn: (id: string) => api.post<McpServerView>(`/api/mcp/${id}/check`), onSuccess: refresh }),
    toggle: useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch<McpServerView>(`/api/mcp/${id}`, { enabled }), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/mcp/${id}`), onSuccess: refresh }),
  };
}

export function useCredentials() {
  const api = useApi();
  return useQuery({ queryKey: keys.credentials, queryFn: ({ signal }) => api.get<CredentialView[]>('/api/credentials', signal) });
}

export function useCredentialMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.credentials });
  return {
    create: useMutation({
      mutationFn: (input: { name: string; kind: string; envVar?: string | null; description?: string; repositoryIds?: string[] | null; value: string }) => api.post<CredentialView>('/api/credentials', input),
      onSuccess: refresh,
    }),
    replace: useMutation({ mutationFn: ({ id, value }: { id: string; value: string }) => api.patch<CredentialView>(`/api/credentials/${id}`, { value }), onSuccess: refresh }),
    /** null = every repository; [] = none. */
    scope: useMutation({ mutationFn: ({ id, repositoryIds }: { id: string; repositoryIds: string[] | null }) => api.patch<CredentialView>(`/api/credentials/${id}`, { repositoryIds }), onSuccess: refresh }),
    resolve: useMutation({ mutationFn: ({ id, action }: { id: string; action: VaultResolveAction }) => api.post<CredentialView>(`/api/credentials/${id}/vault-resolve`, { action }), onSuccess: refresh }),
    /** Through the real tool layer (`credential.generate`): the value is made and sealed in the orchestrator, never here. */
    generate: useMutation({
      mutationFn: async ({ repositoryId, input }: { repositoryId: string; input: { name: string; kind: CredentialKind; envVar: string | null; description: string; bytes: number; encoding: 'base64url' | 'hex' } }) => {
        const r = await api.post<{ result: { ok: boolean; summary: string; output?: { name: string; fingerprint: string; created: boolean } } }>('/api/tools/call', { repositoryId, capability: 'credential.generate', input });
        if (!r.result.ok) throw new Error(r.result.summary);
        return r.result.output!;
      },
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/credentials/${id}`), onSuccess: refresh }),
  };
}

/** Under the credentials prefix, so any credential refresh also refreshes the bridge status. */
const vaultBridgeKey = [...keys.credentials, 'vault-bridge'] as const;

export function useVaultBridgeStatus(refetchInterval: number | false = false) {
  const api = useApi();
  return useQuery({ queryKey: vaultBridgeKey, queryFn: ({ signal }) => api.get<VaultBridgeStatus>('/api/vault-bridge/status', signal), refetchInterval });
}

export function useVaultOriginMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (status: VaultBridgeStatus) => qc.setQueryData(vaultBridgeKey, status);
  return {
    trust: useMutation({ mutationFn: (origin: string) => api.post<VaultBridgeStatus>('/api/vault-bridge/origins', { origin }), onSuccess: set }),
    untrust: useMutation({ mutationFn: (origin: string) => api.post<VaultBridgeStatus>('/api/vault-bridge/origins/remove', { origin }), onSuccess: set }),
  };
}

export function useCredentialEvents(id: string | null) {
  const api = useApi();
  return useQuery({ queryKey: [...keys.credentials, id ?? '', 'events'], queryFn: ({ signal }) => api.get<CredentialEventView[]>(`/api/credentials/${id}/events`, signal), enabled: Boolean(id) });
}

export function useCheckpointMutations(taskId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.taskExecution(taskId) });
  return {
    create: useMutation({ mutationFn: (label: string) => api.post<TaskCheckpoint>(`/api/tasks/${taskId}/checkpoints`, { label }), onSuccess: refresh }),
    restore: useMutation({ mutationFn: (checkpointId: string) => api.post(`/api/tasks/${taskId}/restore`, { checkpointId }), onSuccess: refresh }),
  };
}
