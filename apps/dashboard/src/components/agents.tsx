import { useMemo } from 'react';
import type { AgentInfo, ResolvedAssignment } from '@acc/shared';
import { useAgents } from '../api/hooks';

/** Agent id → display name, from the live registry. */
export function useAgentNames(): (id: string | null | undefined) => string {
  const agents = useAgents();
  const map = useMemo(() => new Map((agents.data ?? []).map((a: AgentInfo) => [a.id, a.name])), [agents.data]);
  return (id) => (id ? (map.get(id) ?? id) : '—');
}

export function modelLabel(agents: AgentInfo[] | undefined, agentId: string, modelId: string): string {
  if (modelId === 'default') return 'CLI default';
  return agents?.find((a) => a.id === agentId)?.models.find((m) => m.modelId === modelId)?.label ?? modelId;
}

/** "Claude Code · Sonnet · High" */
export function AssignmentText({ assignment, className }: { assignment: ResolvedAssignment | null; className?: string }) {
  const agents = useAgents();
  const names = useAgentNames();
  if (!assignment) return <span className={className}>System</span>;
  const effort = assignment.effort === 'default' ? 'default effort' : assignment.effort;
  return (
    <span className={className}>
      {names(assignment.agentId)} · {modelLabel(agents.data, assignment.agentId, assignment.model)} · {effort}
    </span>
  );
}
