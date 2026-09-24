import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type {
  AgentInfo,
  AskMessage,
  AskThread,
  AskThreadDetail,
  Approval,
  Artifact,
  ChairmanAction,
  ChairmanActionInput,
  ChairmanMessage,
  ChairmanOverview,
  CreateTaskInput,
  Directive,
  Execution,
  LogLine,
  OverviewCounts,
  Page,
  PromptTemplate,
  Repository,
  RepositoryAutomationStatus,
  ServiceHealth,
  SkillCatalogView,
  Settings,
  TaskChanges,
  TaskDetail,
  TaskEvent,
  TaskSummary,
  TestRun,
  UpdateRepositoryInput,
  WorkflowIssue,
  WorkflowProfile,
} from '@acc/shared';
import { useApi, useRuntime } from '../app/runtime';
import { keys } from './keys';

export interface Overview {
  counts: OverviewCounts;
  active: TaskSummary[];
  attention: TaskSummary[];
  recent: TaskSummary[];
  simulatedAgents: boolean;
}

export function useHealth() {
  const api = useApi();
  return useQuery({ queryKey: keys.health, queryFn: ({ signal }) => api.get<ServiceHealth>('/api/health', signal), refetchInterval: 30_000 });
}

export function useOverview() {
  const api = useApi();
  return useQuery({ queryKey: keys.overview, queryFn: ({ signal }) => api.get<Overview>('/api/overview', signal) });
}

export function useTasks(filters: { status?: string; repositoryId?: string; q?: string; limit?: number }) {
  const api = useApi();
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') params.set(k, String(v));
  const normalized = Object.fromEntries(params.entries());
  return useQuery({
    queryKey: keys.tasks(normalized),
    queryFn: ({ signal }) => api.get<Page<TaskSummary>>(`/api/tasks?${params.toString()}`, signal),
    placeholderData: keepPreviousData,
  });
}

export function useTask(id: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: keys.task(id ?? ''), queryFn: ({ signal }) => api.get<TaskDetail>(`/api/tasks/${id}`, signal), enabled: Boolean(id) });
}

export function useTaskEvents(id: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.taskEvents(id), queryFn: ({ signal }) => api.get<TaskEvent[]>(`/api/tasks/${id}/events?limit=2000`, signal) });
}

export function useTaskExecutions(id: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.taskExecutions(id), queryFn: ({ signal }) => api.get<Execution[]>(`/api/tasks/${id}/executions`, signal) });
}

export function useTaskTests(id: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.taskTests(id), queryFn: ({ signal }) => api.get<TestRun[]>(`/api/tasks/${id}/tests`, signal) });
}

export function useTaskArtifacts(id: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.taskArtifacts(id), queryFn: ({ signal }) => api.get<Artifact[]>(`/api/tasks/${id}/artifacts`, signal) });
}

export function useTaskDirectives(id: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.taskDirectives(id), queryFn: ({ signal }) => api.get<Directive[]>(`/api/tasks/${id}/directives`, signal) });
}

export function useTaskApprovals(id: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.taskApprovals(id), queryFn: ({ signal }) => api.get<Approval[]>(`/api/tasks/${id}/approvals`, signal) });
}

/** The task's Chairman: state, contract, chat, decisions, actions and checkpoints in one snapshot, kept live over the WebSocket. */
export function useChairman(id: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: keys.chairman(id), queryFn: ({ signal }) => api.get<ChairmanOverview>(`/api/tasks/${id}/chairman`, signal), enabled });
}

/** Send a chat message. The client id makes a retried or double-submitted send idempotent. */
export function useChairmanMessage(taskId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: ({ text, clientMessageId }: { text: string; clientMessageId: string }) => api.post<ChairmanMessage>(`/api/tasks/${taskId}/chairman/messages`, { text, clientMessageId }),
  });
}

// ----- Ask (docs/systems/ask.md) --------------------------------------------------------

export function useAskThreads(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: keys.askThreads, queryFn: ({ signal }) => api.get<AskThread[]>('/api/ask/threads', signal), enabled });
}

/** One conversation with its messages, kept live over the WebSocket. */
export function useAskThread(id: string | null) {
  const api = useApi();
  return useQuery({ queryKey: keys.askThread(id ?? ''), queryFn: ({ signal }) => api.get<AskThreadDetail>(`/api/ask/threads/${id}`, signal), enabled: Boolean(id) });
}

export function useCreateAskThread() {
  const api = useApi();
  return useMutation({ mutationFn: (input: { repositoryId?: string | null; agentId?: string; model?: string; effort?: string }) => api.post<AskThread>('/api/ask/threads', input) });
}

export function useUpdateAskThread(id: string) {
  const api = useApi();
  return useMutation({ mutationFn: (patch: Partial<Pick<AskThread, 'title' | 'repositoryId' | 'agentId' | 'model' | 'effort'>>) => api.patch<AskThread>(`/api/ask/threads/${id}`, patch) });
}

export function useDeleteAskThread() {
  const api = useApi();
  return useMutation({ mutationFn: (id: string) => api.del<void>(`/api/ask/threads/${id}`) });
}

/** Ask a question. The client id makes a retried or double-submitted send idempotent. */
export function useAskMessage() {
  const api = useApi();
  return useMutation({
    mutationFn: ({ threadId, text, clientMessageId }: { threadId: string; text: string; clientMessageId: string }) =>
      api.post<AskMessage>(`/api/ask/threads/${threadId}/messages`, { text, clientMessageId }),
  });
}

export function useAskCancel() {
  const api = useApi();
  return useMutation({ mutationFn: (threadId: string) => api.post<AskThreadDetail>(`/api/ask/threads/${threadId}/cancel`, {}) });
}

/** Direct Chairman controls (e.g. removing a directive) through the same gateway as chat. */
export function useChairmanAction(taskId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, idempotencyKey }: { action: ChairmanActionInput; idempotencyKey: string }) => api.post<ChairmanAction>(`/api/tasks/${taskId}/chairman/actions`, { action, idempotencyKey }),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.taskDirectives(taskId) }),
  });
}

export function useTaskChanges(id: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: keys.taskChanges(id), queryFn: ({ signal }) => api.get<TaskChanges>(`/api/tasks/${id}/changes`, signal), enabled });
}

/** Diffs are loaded lazily per file (design.md §21). */
export function useTaskDiff(id: string, path: string | null, repositoryId: string | null = null) {
  const api = useApi();
  const query = new URLSearchParams({ ...(path ? { path } : {}), ...(repositoryId ? { repositoryId } : {}) }).toString();
  return useQuery({
    queryKey: keys.taskDiff(id, path, repositoryId),
    queryFn: ({ signal }) => api.get<{ diff: string; truncated: boolean }>(`/api/tasks/${id}/diff${query ? `?${query}` : ''}`, signal),
    enabled: path !== null,
    staleTime: 5_000,
  });
}

/** Loads an execution's log and keeps it live over the WebSocket while mounted. */
export function useExecutionLogs(executionId: string | null) {
  const api = useApi();
  const { realtime } = useRuntime();
  useEffect(() => (executionId ? realtime.subscribeLogs(executionId) : undefined), [executionId, realtime]);
  return useQuery({
    queryKey: keys.logs(executionId ?? ''),
    queryFn: async ({ signal }) => {
      const all: LogLine[] = [];
      let after = -1;
      // Bounded paging: at most 20k lines are held in the browser.
      for (let page = 0; page < 4; page++) {
        const batch = await api.get<LogLine[]>(`/api/executions/${executionId}/logs?after=${after}&limit=5000`, signal);
        all.push(...batch);
        if (batch.length < 5000) break;
        after = batch.at(-1)!.seq;
      }
      return all;
    },
    enabled: Boolean(executionId),
    staleTime: Infinity,
  });
}

export function useArtifactContent(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.artifactContent(id ?? ''),
    queryFn: ({ signal }) => api.get<{ artifact: Artifact; content: string; truncated: boolean }>(`/api/artifacts/${id}/content`, signal),
    enabled: Boolean(id),
    staleTime: Infinity,
  });
}

export function useApprovals(status: 'pending' | 'all') {
  const api = useApi();
  return useQuery({ queryKey: keys.approvals(status), queryFn: ({ signal }) => api.get<Approval[]>(`/api/approvals?status=${status}`, signal) });
}

export function useAgents() {
  const api = useApi();
  return useQuery({ queryKey: keys.agents, queryFn: ({ signal }) => api.get<AgentInfo[]>('/api/agents', signal) });
}

/** Skills for the New Task slash picker; reused for a minute like the orchestrator's own list. */
export function useSkills(repositoryId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.skills(repositoryId ?? ''),
    queryFn: ({ signal }) => api.get<SkillCatalogView>(`/api/skills?repositoryId=${encodeURIComponent(repositoryId ?? '')}`, signal),
    enabled: Boolean(repositoryId),
    staleTime: 60_000,
  });
}

export function useRepositories() {
  const api = useApi();
  return useQuery({ queryKey: keys.repositories, queryFn: ({ signal }) => api.get<Repository[]>('/api/repositories', signal) });
}

/** Discovery and background sync state; kept current by `repositoryAutomation` WebSocket messages. */
export function useRepositoryAutomation() {
  const api = useApi();
  return useQuery({
    queryKey: keys.repositoryAutomation,
    queryFn: ({ signal }) => api.get<RepositoryAutomationStatus>('/api/repository-automation', signal),
    // While a run is in progress, also poll: a missed end-of-run message must not leave "Checking now…" on screen.
    refetchInterval: (query) => (query.state.data?.running ? 5_000 : false),
  });
}

export function useRunRepositoryAutomation() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RepositoryAutomationStatus>('/api/repository-automation/run'),
    onSuccess: (status) => qc.setQueryData(keys.repositoryAutomation, status),
  });
}

export function useRepository(id: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: keys.repository(id ?? ''), queryFn: ({ signal }) => api.get<Repository>(`/api/repositories/${id}`, signal), enabled: Boolean(id) });
}

export function useWorkflows() {
  const api = useApi();
  return useQuery({ queryKey: keys.workflows, queryFn: ({ signal }) => api.get<WorkflowProfile[]>('/api/workflows', signal) });
}

export function useSettings() {
  const api = useApi();
  return useQuery({ queryKey: keys.settings, queryFn: ({ signal }) => api.get<Settings>('/api/settings', signal) });
}

export function usePrompts() {
  const api = useApi();
  return useQuery({ queryKey: keys.prompts, queryFn: ({ signal }) => api.get<PromptTemplate[]>('/api/prompts', signal) });
}

// ---------------------------------------------------------------------------
// Mutations. None are optimistic for state the orchestrator owns
// (design.md §9.5): the UI waits for the response and the realtime update.
// ---------------------------------------------------------------------------

export function useTaskCommand(taskId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ command, body }: { command: 'start' | 'pause' | 'resume' | 'cancel' | 'retry' | 'reroute' | 'assignments' | 'directives'; body?: unknown }) =>
      api.post<unknown>(`/api/tasks/${taskId}/${command}`, body ?? {}),
    onSuccess: (data, { command }) => {
      if (command !== 'directives' && data && typeof data === 'object' && 'stages' in data) qc.setQueryData(keys.task(taskId), data);
      void qc.invalidateQueries({ queryKey: keys.task(taskId) });
      if (command === 'directives') void qc.invalidateQueries({ queryKey: keys.taskDirectives(taskId) });
    },
  });
}

export function useCreateTask() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routing, ...input }: CreateTaskInput & { routing?: Record<string, string> }) => api.post<TaskDetail>('/api/tasks', input, routing),
    onSuccess: (task) => {
      qc.setQueryData(keys.task(task.id), task);
      void qc.invalidateQueries({ queryKey: keys.tasksRoot });
      void qc.invalidateQueries({ queryKey: keys.overview });
    },
  });
}

export function useResolveApproval() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, note, confirmation }: { id: string; decision: 'approve' | 'deny'; note?: string; confirmation?: string }) =>
      api.post<Approval>(`/api/approvals/${id}/${decision}`, { note, confirmation }),
    onSuccess: (approval) => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: keys.task(approval.taskId) });
    },
  });
}

export function useUpdateSettings() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Settings> & { confirmation?: string }) => api.patch<Settings>('/api/settings', patch),
    onSuccess: (settings) => qc.setQueryData(keys.settings, settings),
  });
}

export function useRepositoryMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.repositories });
  return {
    add: useMutation({ mutationFn: (input: { path: string; name?: string }) => api.post<Repository>('/api/repositories', input), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: UpdateRepositoryInput }) => api.patch<Repository>(`/api/repositories/${id}`, patch),
      onSuccess: (repo) => {
        qc.setQueryData(keys.repository(repo.id), repo);
        refresh();
      },
    }),
    redetect: useMutation({ mutationFn: (id: string) => api.post<Repository>(`/api/repositories/${id}/redetect`), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/repositories/${id}`), onSuccess: refresh }),
  };
}

export function useAgentMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (agents: AgentInfo[] | AgentInfo) => {
    if (Array.isArray(agents)) qc.setQueryData(keys.agents, agents);
    else void qc.invalidateQueries({ queryKey: keys.agents });
  };
  return {
    refreshAll: useMutation({ mutationFn: () => api.post<AgentInfo[]>('/api/agents/refresh'), onSuccess: set }),
    refreshOne: useMutation({ mutationFn: (id: string) => api.post<AgentInfo>(`/api/agents/${id}/refresh`), onSuccess: set }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => api.patch<AgentInfo>(`/api/agents/${id}`, patch),
      // Enabling an agent or its CLI customisations changes which skills it loads.
      onSuccess: (agent) => {
        set(agent);
        void qc.invalidateQueries({ queryKey: ['skills'] });
      },
    }),
    addModel: useMutation({
      mutationFn: ({ id, modelId, label }: { id: string; modelId: string; label?: string }) => api.post<AgentInfo>(`/api/agents/${id}/models`, { modelId, label }),
      onSuccess: set,
    }),
    removeModel: useMutation({
      mutationFn: ({ id, modelId }: { id: string; modelId: string }) => api.del(`/api/agents/${id}/models/${encodeURIComponent(modelId)}`),
      onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents }),
    }),
  };
}

export function useWorkflowMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.workflows });
  return {
    validate: useMutation({ mutationFn: (profile: unknown) => api.post<{ profile: WorkflowProfile | null; issues: WorkflowIssue[] }>('/api/workflows/validate', profile) }),
    save: useMutation({ mutationFn: ({ id, profile }: { id: string; profile: unknown }) => api.put<WorkflowProfile>(`/api/workflows/${id}`, profile), onSuccess: refresh }),
    duplicate: useMutation({ mutationFn: (id: string) => api.post<WorkflowProfile>(`/api/workflows/${id}/duplicate`), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/workflows/${id}`), onSuccess: refresh }),
  };
}

export function usePromptMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.prompts });
  return {
    save: useMutation({ mutationFn: ({ role, body }: { role: string; body: string }) => api.put<PromptTemplate>(`/api/prompts/${role}`, { body }), onSuccess: refresh }),
    reset: useMutation({ mutationFn: (role: string) => api.post<PromptTemplate>(`/api/prompts/${role}/reset`), onSuccess: refresh }),
  };
}
