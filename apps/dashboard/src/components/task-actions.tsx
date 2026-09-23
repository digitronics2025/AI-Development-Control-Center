import { FileText, Pause, Play, RotateCcw, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button, useFeedback } from '@acc/ui';
import type { TaskSummary } from '@acc/shared';
import { errorMessage } from '../api/client';
import { useTaskCommand } from '../api/hooks';
import { useConnection } from '../app/runtime';

export type PrimaryActionKind = 'pause' | 'resume' | 'review-approval' | 'retry' | 'open-report' | 'start' | 'more-cycle' | 'open';

export interface PrimaryAction {
  kind: PrimaryActionKind;
  label: string;
  icon: LucideIcon;
}

/**
 * design.md §2.2 / §7.3: exactly one obvious primary action per task state.
 * Running → Pause, Paused → Resume, Waiting approval → Review Approval,
 * Failed → Retry Stage, Completed → Open Report.
 */
export function primaryActionFor(task: Pick<TaskSummary, 'status' | 'blocker'>): PrimaryAction | null {
  switch (task.status) {
    case 'RUNNING':
      return { kind: 'pause', label: 'Pause', icon: Pause };
    case 'QUEUED':
      return { kind: 'pause', label: 'Pause', icon: Pause };
    case 'PAUSED':
    case 'INTERRUPTED':
    case 'WAITING_FOR_USAGE_RESET':
      return { kind: 'resume', label: 'Resume', icon: Play };
    case 'WAITING_FOR_USER':
      if (task.blocker?.kind === 'approval') return { kind: 'review-approval', label: 'Review Approval', icon: ShieldCheck };
      if (task.blocker?.kind === 'fix_limit') return { kind: 'more-cycle', label: 'Allow one more fix cycle', icon: RotateCcw };
      return { kind: 'retry', label: 'Retry Stage', icon: RotateCcw };
    case 'FAILED':
      return { kind: 'retry', label: 'Retry Stage', icon: RotateCcw };
    case 'COMPLETED':
      return { kind: 'open-report', label: 'Open Report', icon: FileText };
    case 'DRAFT':
      return { kind: 'start', label: 'Start Task', icon: Play };
    case 'CANCELLED':
      return null;
  }
}

export function TaskPrimaryAction({ task, size = 'default', onOpenReport }: { task: TaskSummary; size?: 'compact' | 'default'; onOpenReport?: () => void }) {
  const action = primaryActionFor(task);
  const command = useTaskCommand(task.id);
  const navigate = useNavigate();
  const { toast } = useFeedback();
  const connection = useConnection();
  if (!action) return null;

  const run = () => {
    switch (action.kind) {
      case 'review-approval':
        navigate(`/approvals?task=${task.id}`);
        return;
      case 'open-report':
        if (onOpenReport) onOpenReport();
        else navigate(`/tasks/${task.id}?tab=overview`);
        return;
      case 'open':
        navigate(`/tasks/${task.id}`);
        return;
      default: {
        const name = action.kind === 'more-cycle' ? 'resume' : action.kind;
        command.mutate(
          { command: name as 'pause' | 'resume' | 'retry' | 'start' },
          {
            onSuccess: () => toast(action.kind === 'pause' ? 'Pause requested' : action.kind === 'retry' ? 'Retry requested' : action.kind === 'start' ? 'Task started' : 'Resume requested'),
            onError: (error) => toast(errorMessage(error), 'info'),
          },
        );
      }
    }
  };

  const needsConnection = !['review-approval', 'open-report', 'open'].includes(action.kind);
  return (
    <Button
      variant="primary"
      size={size}
      icon={action.icon}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
      loading={command.isPending}
      disabled={needsConnection && !connection.online}
      disabledReason="Reconnect to the orchestrator first"
    >
      {action.label}
    </Button>
  );
}
