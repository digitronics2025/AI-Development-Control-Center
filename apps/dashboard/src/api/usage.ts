import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BudgetInput,
  BudgetStatus,
  BudgetUpdate,
  PricingInput,
  PricingVersion,
  ProviderSummary,
  RecalculationResult,
  ReconciliationResult,
  UsageAnomaly,
  UsageBreakdownRow,
  UsageEventDetail,
  UsageEventPage,
  UsageHealth,
  UsageLiveMeter,
  UsageOverview,
  UsageTaskLedger,
  UsageTaskPage,
} from '@acc/shared';
import { useApi } from '../app/runtime';
import { keys } from './keys';

/** Filters sent to every usage query (server-side filtering, design.md §7.10). */
export type UsageParams = Record<string, string | undefined>;

export function query(params: UsageParams, extra: Record<string, string | number | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...extra })) if (v !== undefined && v !== '') search.set(k, String(v));
  return search.toString();
}

/** Realtime `usage` messages refresh these; a slow fallback covers a missed message. */
const FALLBACK_REFRESH_MS = 60_000;

export function useUsageOverview(params: UsageParams) {
  const api = useApi();
  return useQuery({
    queryKey: keys.usage('overview', params),
    queryFn: ({ signal }) => api.get<UsageOverview>(`/api/usage/overview?${query(params)}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: FALLBACK_REFRESH_MS,
  });
}

export function useUsageBreakdown(dimension: 'provider' | 'model' | 'agent' | 'role' | 'project' | 'taskType' | 'effort', params: UsageParams) {
  const api = useApi();
  return useQuery({
    queryKey: keys.usage(`breakdown:${dimension}`, params),
    queryFn: ({ signal }) => api.get<UsageBreakdownRow[]>(`/api/usage/breakdown/${dimension}?${query(params)}`, signal),
    placeholderData: keepPreviousData,
  });
}

export function useUsageTasks(params: UsageParams, sort: string, offset: number) {
  const api = useApi();
  return useQuery({
    queryKey: keys.usage('tasks', { ...params, sort, offset }),
    queryFn: ({ signal }) => api.get<UsageTaskPage>(`/api/usage/tasks?${query(params, { sort, offset, limit: 50 })}`, signal),
    placeholderData: keepPreviousData,
  });
}

export function useUsageTaskLedger(taskId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.usage('task', { taskId }),
    queryFn: ({ signal }) => api.get<UsageTaskLedger>(`/api/usage/tasks/${encodeURIComponent(taskId!)}`, signal),
    enabled: Boolean(taskId),
    // A running task's ledger also polls lightly: realtime messages are the main path.
    refetchInterval: (q) => (q.state.data?.live ? 10_000 : false),
  });
}

export function useUsageLive(taskId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.usage('live', { taskId }),
    queryFn: ({ signal }) => api.get<UsageLiveMeter>(`/api/usage/tasks/${encodeURIComponent(taskId)}/live`, signal),
    enabled,
    refetchInterval: FALLBACK_REFRESH_MS,
  });
}

export function useUsageProviders(params: UsageParams) {
  const api = useApi();
  return useQuery({
    queryKey: keys.usage('providers', params),
    queryFn: ({ signal }) => api.get<ProviderSummary[]>(`/api/usage/providers?${query(params)}`, signal),
    placeholderData: keepPreviousData,
  });
}

export function useUsageEvents(params: UsageParams) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.usage('events', params),
    queryFn: ({ pageParam, signal }) => api.get<UsageEventPage>(`/api/usage/events?${query(params, { limit: 50, cursor: pageParam || undefined })}`, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useUsageEvent(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.usage('event', { id: id ?? '' }),
    queryFn: ({ signal }) => api.get<UsageEventDetail>(`/api/usage/events/${encodeURIComponent(id!)}`, signal),
    enabled: Boolean(id),
  });
}

export function useUsageAnomalies(params: UsageParams) {
  const api = useApi();
  return useQuery({
    queryKey: keys.usage('anomalies', params),
    queryFn: ({ signal }) => api.get<UsageAnomaly[]>(`/api/usage/anomalies?${query(params)}`, signal),
    placeholderData: keepPreviousData,
  });
}

export function useUsageHealth() {
  const api = useApi();
  return useQuery({ queryKey: keys.usage('health'), queryFn: ({ signal }) => api.get<UsageHealth>('/api/usage/health', signal) });
}

export function useBudgets() {
  const api = useApi();
  return useQuery({ queryKey: keys.usage('budgets'), queryFn: ({ signal }) => api.get<BudgetStatus[]>('/api/usage/budgets', signal) });
}

export function usePricing() {
  const api = useApi();
  return useQuery({ queryKey: keys.usage('pricing'), queryFn: ({ signal }) => api.get<PricingVersion[]>('/api/usage/pricing', signal) });
}

/** Mutations are never optimistic: the orchestrator's answer replaces the cache. */
export function useUsageMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.usageRoot });
  return {
    createBudget: useMutation({ mutationFn: (input: BudgetInput) => api.post<BudgetStatus>('/api/usage/budgets', input), onSuccess: refresh }),
    updateBudget: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: BudgetUpdate }) => api.patch<BudgetStatus>(`/api/usage/budgets/${id}`, patch), onSuccess: refresh }),
    deleteBudget: useMutation({ mutationFn: (id: string) => api.del(`/api/usage/budgets/${id}`), onSuccess: refresh }),
    addPricing: useMutation({ mutationFn: (input: PricingInput) => api.post<PricingVersion>('/api/usage/pricing', input), onSuccess: refresh }),
    recalculate: useMutation({ mutationFn: () => api.post<RecalculationResult>('/api/usage/recalculate', {}), onSuccess: refresh }),
    reconcile: useMutation({ mutationFn: () => api.post<ReconciliationResult>('/api/usage/reconcile', {}), onSuccess: refresh }),
    refreshCapacity: useMutation({ mutationFn: () => api.post<ProviderSummary[]>('/api/usage/capacity/refresh', {}), onSuccess: refresh }),
  };
}
