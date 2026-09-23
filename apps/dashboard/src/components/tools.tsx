import {
  Activity,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  Clock,
  KeyRound,
  PackageX,
  ShieldQuestion,
  Square,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import type { StatusVisual } from '@acc/ui';
import type { TaskProcessStatus, ToolExecutionStatus, ToolHealthState } from '@acc/shared';

/** Status visuals for the tool layer (design.md §7.3 Execution, §7.10 Tools). Icon + text, never color alone. */
export const TOOL_HEALTH_VISUAL: Record<ToolHealthState, StatusVisual> = {
  ready: { label: 'Ready', tone: 'success', icon: CheckCircle2 },
  // A missing optional tool is information, not a fault.
  missing: { label: 'Not installed', tone: 'neutral', icon: PackageX },
  auth_required: { label: 'Sign-in required', tone: 'warning', icon: KeyRound },
  error: { label: 'Check failed', tone: 'danger', icon: XCircle },
  unchecked: { label: 'Not checked', tone: 'neutral', icon: CircleHelp },
};

export const TOOL_EXECUTION_VISUAL: Record<ToolExecutionStatus, StatusVisual> = {
  running: { label: 'Running', tone: 'accent', icon: Activity, active: true },
  succeeded: { label: 'Succeeded', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  denied: { label: 'Refused', tone: 'warning', icon: Ban },
  needs_approval: { label: 'Needs approval', tone: 'warning', icon: ShieldQuestion },
  cancelled: { label: 'Stopped', tone: 'neutral', icon: Square },
  timed_out: { label: 'Timed out', tone: 'danger', icon: Clock },
};

export const PROCESS_VISUAL: Record<TaskProcessStatus, StatusVisual> = {
  starting: { label: 'Starting', tone: 'accent', icon: CircleDashed, active: true },
  running: { label: 'Running', tone: 'accent', icon: Activity, active: true },
  healthy: { label: 'Healthy', tone: 'success', icon: CheckCircle2 },
  unhealthy: { label: 'Not answering', tone: 'warning', icon: TriangleAlert },
  exited: { label: 'Exited', tone: 'neutral', icon: Square },
  stopped: { label: 'Stopped', tone: 'neutral', icon: Square },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
};

export const LIVE_PROCESS: readonly TaskProcessStatus[] = ['starting', 'running', 'healthy', 'unhealthy'];

export const RECOVERY_VISUAL: Record<'running' | 'succeeded' | 'failed', StatusVisual> = {
  running: { label: 'Repairing', tone: 'accent', icon: Activity, active: true },
  succeeded: { label: 'Repaired', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Repair failed', tone: 'danger', icon: XCircle },
};

export const ESCALATION_VISUAL: Record<'enabled' | 'denied' | 'approval', StatusVisual> = {
  enabled: { label: 'Enabled', tone: 'info', icon: CheckCircle2 },
  denied: { label: 'Refused', tone: 'warning', icon: Ban },
  approval: { label: 'Needs approval', tone: 'warning', icon: ShieldQuestion },
};

export const REPAIR_LABEL: Record<string, string> = {
  install_dependencies: 'Install dependencies',
  install_dependencies_unfrozen: 'Install dependencies (update lockfile)',
  free_port: 'Free the port',
  retry_after_backoff: 'Wait and retry',
  install_browser: 'Install the browser',
};
