// Subpath imports keep Zod and the schemas out of the extension host bundle.
import { ROLE_ACTIVITY, TASK_STATUS_LABEL } from '@acc/shared/labels';
import type { Role, TaskSummary } from '@acc/shared';

export interface StatusView {
  text: string;
  tooltip: string;
  /** Task the status item opens, or null for the overview. */
  taskId: string | null;
  severity: 'idle' | 'active' | 'attention' | 'error' | 'done';
}

/** "Claude Code (simulated)" → "Claude" — the status bar has little room. */
export function shortAgentName(name: string): string {
  return name.replace(/\(.*?\)/g, '').trim().split(/\s+/)[0] ?? name;
}

const RECENT_MS = 10 * 60 * 1000;

/**
 * Status bar text (PLAN §25): "AI: Idle", "AI: Codex Investigating",
 * "AI: Claude Implementing", "AI: Tests Running", "AI: Waiting Approval",
 * "AI: Failed", "AI: Complete". Precedence: anything needing the user,
 * then running work, then a recent outcome, then idle.
 */
export function deriveStatus(
  tasks: TaskSummary[],
  agentName: (id: string) => string,
  roleOf: (task: TaskSummary) => Role | null,
  now = Date.now(),
): StatusView {
  const byUpdate = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const approval = byUpdate.find((t) => t.status === 'WAITING_FOR_USER' && t.blocker?.kind === 'approval');
  if (approval) {
    return { text: 'AI: Waiting Approval', tooltip: `${approval.id} ${approval.title}\n${approval.blocker?.message ?? ''}`, taskId: approval.id, severity: 'attention' };
  }
  const blocked = byUpdate.find((t) => ['WAITING_FOR_USER', 'WAITING_FOR_USAGE_RESET', 'INTERRUPTED'].includes(t.status));
  const running = byUpdate.find((t) => t.status === 'RUNNING');
  if (running) {
    const role = roleOf(running);
    let text: string;
    if (role === 'tester' || (!running.currentAssignment && running.currentStageName)) text = 'AI: Tests Running';
    else if (running.currentAssignment && role) text = `AI: ${shortAgentName(agentName(running.currentAssignment.agentId))} ${ROLE_ACTIVITY[role]}`;
    else text = 'AI: Running';
    const extra = blocked ? `\nAlso waiting: ${blocked.id} (${TASK_STATUS_LABEL[blocked.status]})` : '';
    return { text, tooltip: `${running.id} ${running.title}\nStage: ${running.currentStageName ?? '—'}${extra}`, taskId: running.id, severity: 'active' };
  }
  if (blocked) {
    return { text: `AI: ${TASK_STATUS_LABEL[blocked.status]}`, tooltip: `${blocked.id} ${blocked.title}\n${blocked.blocker?.message ?? ''}`, taskId: blocked.id, severity: 'attention' };
  }
  const recent = byUpdate.find((t) => now - new Date(t.updatedAt).getTime() < RECENT_MS && ['FAILED', 'COMPLETED'].includes(t.status));
  if (recent?.status === 'FAILED') {
    return { text: 'AI: Failed', tooltip: `${recent.id} ${recent.title}\n${recent.blocker?.message ?? ''}`, taskId: recent.id, severity: 'error' };
  }
  if (recent?.status === 'COMPLETED') {
    return {
      text: 'AI: Complete',
      tooltip: `${recent.id} ${recent.title}\n${recent.finalStatus === 'READY' ? 'Ready' : 'Needs your attention'}`,
      taskId: recent.id,
      severity: 'done',
    };
  }
  return { text: 'AI: Idle', tooltip: 'No task is running. Click to open the Control Center.', taskId: null, severity: 'idle' };
}
