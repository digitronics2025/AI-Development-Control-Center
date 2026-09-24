import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LearningFinding, LearningImprovement, LearningOverview, LearningReview } from '@acc/shared';
import { useApi } from '../app/runtime';
import { keys } from './keys';

/** Realtime `learning` messages refresh these; a slow fallback covers a missed message. */
const FALLBACK_REFRESH_MS = 60_000;

export function useLearning() {
  const api = useApi();
  return useQuery({
    queryKey: [...keys.learningRoot, 'overview'],
    queryFn: ({ signal }) => api.get<LearningOverview>('/api/learning', signal),
    refetchInterval: FALLBACK_REFRESH_MS,
  });
}

export function useTaskLearning(taskId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.learningTask(taskId),
    queryFn: ({ signal }) => api.get<{ review: LearningReview | null; findings: LearningFinding[] }>(`/api/learning/tasks/${encodeURIComponent(taskId)}`, signal),
    enabled,
  });
}

/** Never optimistic: the orchestrator's answer replaces the cache. */
export function useLearningMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.learningRoot });
  return {
    undo: useMutation({ mutationFn: (id: string) => api.post<LearningImprovement>(`/api/learning/improvements/${encodeURIComponent(id)}/revert`, {}), onSuccess: refresh }),
    dismiss: useMutation({ mutationFn: (id: string) => api.post<LearningFinding>(`/api/learning/findings/${encodeURIComponent(id)}/dismiss`, {}), onSuccess: refresh }),
    act: useMutation({
      mutationFn: (id: string) => api.post<{ finding: LearningFinding; improvement: LearningImprovement }>(`/api/learning/findings/${encodeURIComponent(id)}/act`, {}),
      onSettled: refresh,
    }),
    review: useMutation({ mutationFn: (taskId: string) => api.post<LearningReview>(`/api/learning/tasks/${encodeURIComponent(taskId)}/review`, {}), onSuccess: refresh }),
  };
}
