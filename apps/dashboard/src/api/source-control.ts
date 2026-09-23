import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CommitDetails,
  CommitMessageSuggestion,
  GitOperation,
  HistoryPage,
  SourceControlDiff,
  SourceControlDiffMode,
  SourceControlOperationResult,
  SourceControlSnapshot,
  StagedReviewStarted,
  TaskSummary,
} from '@acc/shared';
import { useApi } from '../app/runtime';
import { keys } from './keys';

/** While the page is visible the snapshot refreshes on a short interval (plan §3.5); hidden, it stops. */
const STATUS_REFRESH_MS = 3_000;

const url = (repositoryId: string, rest = '') => `/api/repositories/${encodeURIComponent(repositoryId)}/source-control${rest}`;

export function useSourceControl(repositoryId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sourceControl(repositoryId ?? ''),
    queryFn: ({ signal }) => api.get<SourceControlSnapshot>(url(repositoryId!), signal),
    enabled: Boolean(repositoryId),
    refetchInterval: STATUS_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: 1_000,
  });
}

/** Diffs load lazily, one file at a time, never as part of the status refresh. */
export function useSourceControlDiff(repositoryId: string, path: string | null, mode: SourceControlDiffMode, version: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...keys.sourceControlDiff(repositoryId, path, mode), version ?? ''],
    queryFn: ({ signal }) => api.get<SourceControlDiff>(url(repositoryId, `/diff?path=${encodeURIComponent(path!)}&mode=${mode}`), signal),
    enabled: Boolean(path),
    staleTime: 60_000,
    retry: false,
  });
}

export function useSourceControlHistory(repositoryId: string, enabled: boolean) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.sourceControlHistory(repositoryId),
    queryFn: ({ pageParam, signal }) => api.get<HistoryPage>(url(repositoryId, `/history?limit=60${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`), signal),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    staleTime: 15_000,
  });
}

export function useCommitDetails(repositoryId: string, sha: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sourceControlCommit(repositoryId, sha ?? ''),
    queryFn: ({ signal }) => api.get<CommitDetails>(url(repositoryId, `/commits/${sha}`), signal),
    enabled: Boolean(sha),
    staleTime: Infinity,
  });
}

export function useCommitDiff(repositoryId: string, sha: string | null, path: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sourceControlCommitDiff(repositoryId, sha ?? '', path),
    queryFn: ({ signal }) => api.get<SourceControlDiff>(url(repositoryId, `/commits/${sha}/diff?path=${encodeURIComponent(path!)}`), signal),
    enabled: Boolean(sha && path),
    staleTime: Infinity,
  });
}

export function useGitOperations(repositoryId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sourceControlOperations(repositoryId),
    queryFn: ({ signal }) => api.get<GitOperation[]>(url(repositoryId, '/operations'), signal),
    enabled,
  });
}

export interface LatestReview {
  task: TaskSummary | null;
  review: string | null;
  verdict: 'PASS' | 'FAIL' | null;
}

export function useLatestReview(repositoryId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sourceControlReview(repositoryId),
    queryFn: ({ signal }) => api.get<LatestReview>(url(repositoryId, '/review'), signal),
    refetchInterval: (query) => (query.state.data?.task && ['QUEUED', 'RUNNING'].includes(query.state.data.task.status) ? 3_000 : false),
  });
}

/** A fresh idempotency key per user action; a retry of the same request reuses it. */
function newKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Mutations wait for the orchestrator's confirmation (design.md §9.5) and
 * then install the snapshot it returned, so the page shows Git's real state.
 */
export function useSourceControlActions(repositoryId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const install = (result: SourceControlOperationResult) => {
    qc.setQueryData(keys.sourceControl(repositoryId), result.snapshot);
    void qc.invalidateQueries({ queryKey: keys.sourceControlOperations(repositoryId) });
    if (['commit', 'sync', 'publish', 'fetch'].includes(result.operation.kind)) void qc.invalidateQueries({ queryKey: keys.sourceControlHistory(repositoryId) });
  };
  const useAction = <V extends Record<string, unknown>>(path: string) =>
    useMutation({
      mutationFn: (body: V) => api.post<SourceControlOperationResult>(url(repositoryId, path), { idempotencyKey: newKey(), ...body }),
      onSuccess: install,
      onError: () => void qc.invalidateQueries({ queryKey: keys.sourceControl(repositoryId) }),
    });
  return {
    stage: useAction<{ expectedVersion: string; paths?: string[]; all?: true; confirmMixed?: string[] }>('/stage'),
    unstage: useAction<{ expectedVersion: string; paths?: string[]; all?: true }>('/unstage'),
    commit: useAction<{ expectedVersion: string; message: string }>('/commit'),
    fetch: useAction<{ expectedVersion?: string }>('/fetch'),
    sync: useAction<{ expectedVersion: string }>('/sync'),
    publish: useAction<{ expectedVersion: string; remote: string }>('/publish'),
    refresh: useMutation({
      mutationFn: () => api.post<SourceControlSnapshot>(url(repositoryId, '/refresh')),
      onSuccess: (snapshot) => qc.setQueryData(keys.sourceControl(repositoryId), snapshot),
    }),
    suggest: useMutation({ mutationFn: (body: { expectedVersion: string }) => api.post<CommitMessageSuggestion>(url(repositoryId, '/suggest-message'), body) }),
    review: useMutation({
      mutationFn: (body: { expectedVersion: string; purpose?: string }) => api.post<StagedReviewStarted>(url(repositoryId, '/review-staged'), body),
      onSuccess: () => void qc.invalidateQueries({ queryKey: keys.sourceControlReview(repositoryId) }),
    }),
  };
}
