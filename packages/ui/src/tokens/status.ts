import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Ban,
  HelpCircle,
  Info,
  Brain,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  Clock,
  CloudOff,
  Cloud,
  Link2Off,
  ArrowUpCircle,
  Eye,
  FlaskConical,
  FilePen,
  Hourglass,
  ListOrdered,
  Minus,
  PauseCircle,
  PlugZap,
  ShieldQuestion,
  SkipForward,
  Square,
  TrendingDown,
  TrendingUp,
  UserRound,
  Undo2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  CHAIRMAN_HEALTH_LABEL,
  CHAIRMAN_STATUS_LABEL,
  STAGE_STATUS_LABEL,
  STRATEGY_OUTCOME_LABEL,
  TASK_STATUS_LABEL,
  type ChairmanActionStatus,
  type ChairmanHealth,
  type ChairmanStatus,
  type ChairmanStrategyOutcomeStatus,
  type BudgetState,
  type CapacityStatus,
  type HealthState,
  type StageStatus,
  type TaskStatus,
  type UsageAnomaly,
  type UsageEventStatus,
  type NodeStatus,
  type RemoteLinkState,
  FINDING_STATUS_LABEL,
  IMPROVEMENT_STATUS_LABEL,
  type FindingStatus,
  type ImprovementStatus,
  type ReviewStatus,
} from '@acc/shared';

/** Semantic tone → token classes. Status is never conveyed by color alone (design.md §4.2). */
export type Tone = 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export const TONE_CLASSES: Record<Tone, { icon: string; tint: string; border: string; text: string }> = {
  accent: { icon: 'text-accent', tint: 'bg-accent-muted', border: 'border-accent', text: 'text-accent' },
  info: { icon: 'text-info', tint: 'bg-info-muted', border: 'border-info', text: 'text-info' },
  success: { icon: 'text-success', tint: 'bg-success-muted', border: 'border-success', text: 'text-success' },
  warning: { icon: 'text-warning', tint: 'bg-warning-muted', border: 'border-warning', text: 'text-warning' },
  danger: { icon: 'text-danger', tint: 'bg-danger-muted', border: 'border-danger', text: 'text-danger' },
  neutral: { icon: 'text-fg-secondary', tint: 'bg-muted', border: 'border-border-strong', text: 'text-fg-secondary' },
};

export interface StatusVisual {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  /** A subtle activity indicator is allowed only for actively running work (design.md §10). */
  active?: boolean;
}

/** design.md §4.2 "Status mapping". */
export const TASK_STATUS_VISUAL: Record<TaskStatus, StatusVisual> = {
  RUNNING: { label: TASK_STATUS_LABEL.RUNNING, tone: 'accent', icon: Activity, active: true },
  COMPLETED: { label: TASK_STATUS_LABEL.COMPLETED, tone: 'success', icon: CheckCircle2 },
  PAUSED: { label: TASK_STATUS_LABEL.PAUSED, tone: 'warning', icon: PauseCircle },
  WAITING_FOR_USER: { label: TASK_STATUS_LABEL.WAITING_FOR_USER, tone: 'warning', icon: UserRound },
  WAITING_FOR_USAGE_RESET: { label: TASK_STATUS_LABEL.WAITING_FOR_USAGE_RESET, tone: 'warning', icon: Clock },
  FAILED: { label: TASK_STATUS_LABEL.FAILED, tone: 'danger', icon: XCircle },
  CANCELLED: { label: TASK_STATUS_LABEL.CANCELLED, tone: 'neutral', icon: Square },
  INTERRUPTED: { label: TASK_STATUS_LABEL.INTERRUPTED, tone: 'warning', icon: PlugZap },
  DRAFT: { label: TASK_STATUS_LABEL.DRAFT, tone: 'neutral', icon: FilePen },
  QUEUED: { label: TASK_STATUS_LABEL.QUEUED, tone: 'info', icon: ListOrdered },
};

export const STAGE_STATUS_VISUAL: Record<StageStatus, StatusVisual> = {
  PENDING: { label: STAGE_STATUS_LABEL.PENDING, tone: 'neutral', icon: CircleDashed },
  READY: { label: STAGE_STATUS_LABEL.READY, tone: 'neutral', icon: CircleDashed },
  STARTING: { label: STAGE_STATUS_LABEL.STARTING, tone: 'accent', icon: CircleDot, active: true },
  RUNNING: { label: STAGE_STATUS_LABEL.RUNNING, tone: 'accent', icon: CircleDot, active: true },
  SUCCESS: { label: STAGE_STATUS_LABEL.SUCCESS, tone: 'success', icon: CheckCircle2 },
  FAILED: { label: STAGE_STATUS_LABEL.FAILED, tone: 'danger', icon: XCircle },
  RETRYING: { label: STAGE_STATUS_LABEL.RETRYING, tone: 'warning', icon: Hourglass },
  WAITING_APPROVAL: { label: STAGE_STATUS_LABEL.WAITING_APPROVAL, tone: 'warning', icon: ShieldQuestion },
  PAUSED: { label: STAGE_STATUS_LABEL.PAUSED, tone: 'warning', icon: PauseCircle },
  CANCELLED: { label: STAGE_STATUS_LABEL.CANCELLED, tone: 'neutral', icon: Square },
  INTERRUPTED: { label: STAGE_STATUS_LABEL.INTERRUPTED, tone: 'warning', icon: PlugZap },
  SKIPPED: { label: STAGE_STATUS_LABEL.SKIPPED, tone: 'neutral', icon: SkipForward },
};

export const FAILURE_ICON = AlertOctagon;

/** Chairman supervisor state (design.md §7.3.1). */
export const CHAIRMAN_STATUS_VISUAL: Record<ChairmanStatus, StatusVisual> = {
  off: { label: CHAIRMAN_STATUS_LABEL.off, tone: 'neutral', icon: CircleDashed },
  idle: { label: CHAIRMAN_STATUS_LABEL.idle, tone: 'neutral', icon: CircleDot },
  supervising: { label: CHAIRMAN_STATUS_LABEL.supervising, tone: 'accent', icon: Eye },
  evaluating: { label: CHAIRMAN_STATUS_LABEL.evaluating, tone: 'accent', icon: Brain, active: true },
  degraded: { label: CHAIRMAN_STATUS_LABEL.degraded, tone: 'warning', icon: Eye },
};

export const CHAIRMAN_HEALTH_VISUAL: Record<ChairmanHealth, StatusVisual> = {
  PROGRESSING: { label: CHAIRMAN_HEALTH_LABEL.PROGRESSING, tone: 'success', icon: TrendingUp },
  STABLE: { label: CHAIRMAN_HEALTH_LABEL.STABLE, tone: 'info', icon: Minus },
  STALLED: { label: CHAIRMAN_HEALTH_LABEL.STALLED, tone: 'warning', icon: Hourglass },
  REGRESSING: { label: CHAIRMAN_HEALTH_LABEL.REGRESSING, tone: 'danger', icon: TrendingDown },
  UNKNOWN: { label: CHAIRMAN_HEALTH_LABEL.UNKNOWN, tone: 'neutral', icon: CircleDashed },
};

export const CHAIRMAN_ACTION_STATUS_VISUAL: Record<ChairmanActionStatus, StatusVisual> = {
  running: { label: 'Running', tone: 'accent', icon: CircleDot, active: true },
  completed: { label: 'Completed', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  rejected: { label: 'Rejected', tone: 'warning', icon: AlertOctagon },
};

/** What a Chairman recovery strategy achieved (design.md §7.3.1 decision cards). */
export const STRATEGY_OUTCOME_VISUAL: Record<ChairmanStrategyOutcomeStatus, StatusVisual> = {
  RUNNING: { label: STRATEGY_OUTCOME_LABEL.RUNNING, tone: 'neutral', icon: Hourglass },
  SUCCEEDED: { label: STRATEGY_OUTCOME_LABEL.SUCCEEDED, tone: 'success', icon: CheckCircle2 },
  IMPROVED: { label: STRATEGY_OUTCOME_LABEL.IMPROVED, tone: 'success', icon: TrendingUp },
  FAILED: { label: STRATEGY_OUTCOME_LABEL.FAILED, tone: 'warning', icon: Minus },
  REGRESSED: { label: STRATEGY_OUTCOME_LABEL.REGRESSED, tone: 'danger', icon: TrendingDown },
  INCONCLUSIVE: { label: STRATEGY_OUTCOME_LABEL.INCONCLUSIVE, tone: 'neutral', icon: HelpCircle },
  SUPERSEDED: { label: STRATEGY_OUTCOME_LABEL.SUPERSEDED, tone: 'neutral', icon: SkipForward },
};

/** Usage & Costs (design.md §7.10): budget state, capacity, health, attempt outcome, anomaly severity. */
export const BUDGET_STATE_VISUAL: Record<BudgetState, StatusVisual> = {
  ok: { label: 'Within budget', tone: 'success', icon: CheckCircle2 },
  warning: { label: 'Warning', tone: 'warning', icon: AlertTriangle },
  critical: { label: 'Critical', tone: 'danger', icon: AlertOctagon },
  exceeded: { label: 'Exceeded', tone: 'danger', icon: XCircle },
};

export const CAPACITY_STATUS_VISUAL: Record<CapacityStatus, StatusVisual> = {
  ok: { label: 'Available', tone: 'success', icon: CheckCircle2 },
  warning: { label: 'Running low', tone: 'warning', icon: AlertTriangle },
  exhausted: { label: 'Exhausted', tone: 'danger', icon: Ban },
  unknown: { label: 'Unknown', tone: 'neutral', icon: HelpCircle },
};

export const HEALTH_STATE_VISUAL: Record<HealthState, StatusVisual> = {
  healthy: { label: 'Healthy', tone: 'success', icon: CheckCircle2 },
  partial: { label: 'Partial', tone: 'warning', icon: AlertTriangle },
  degraded: { label: 'Degraded', tone: 'danger', icon: AlertOctagon },
  unavailable: { label: 'Unavailable', tone: 'neutral', icon: Minus },
};

export const USAGE_EVENT_STATUS_VISUAL: Record<UsageEventStatus, StatusVisual> = {
  succeeded: { label: 'Succeeded', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Square },
  timed_out: { label: 'Timed out', tone: 'warning', icon: Clock },
  interrupted: { label: 'Interrupted', tone: 'warning', icon: PlugZap },
};

export const ANOMALY_SEVERITY_VISUAL: Record<UsageAnomaly['severity'], StatusVisual> = {
  info: { label: 'Info', tone: 'info', icon: Info },
  warning: { label: 'Warning', tone: 'warning', icon: AlertTriangle },
  critical: { label: 'Critical', tone: 'danger', icon: AlertOctagon },
};

/** An execution node as the cloud sees it (docs/systems/cloud-control.md). */
export const NODE_STATUS_VISUAL: Record<NodeStatus, StatusVisual> = {
  online: { label: 'Online', tone: 'success', icon: Cloud },
  degraded: { label: 'Degraded', tone: 'warning', icon: AlertTriangle },
  offline: { label: 'Offline', tone: 'neutral', icon: CloudOff },
  revoked: { label: 'Revoked', tone: 'danger', icon: Ban },
};

/** This machine's own link to the cloud (Settings → Remote access). */
export const REMOTE_LINK_VISUAL: Record<RemoteLinkState, StatusVisual> = {
  unpaired: { label: 'Not paired', tone: 'neutral', icon: Link2Off },
  disabled: { label: 'Turned off', tone: 'neutral', icon: Minus },
  connecting: { label: 'Connecting', tone: 'info', icon: Hourglass },
  connected: { label: 'Connected', tone: 'success', icon: Cloud },
  offline: { label: 'Cloud unreachable', tone: 'warning', icon: CloudOff },
  revoked: { label: 'Revoked', tone: 'danger', icon: Ban },
  'update-required': { label: 'Update required', tone: 'warning', icon: ArrowUpCircle },
};

/** The learning loop (design.md §7.13): improvements, findings and reviews. */
export const IMPROVEMENT_STATUS_VISUAL: Record<ImprovementStatus, StatusVisual> = {
  trial: { label: IMPROVEMENT_STATUS_LABEL.trial, tone: 'info', icon: FlaskConical },
  active: { label: IMPROVEMENT_STATUS_LABEL.active, tone: 'success', icon: CheckCircle2 },
  ineffective: { label: IMPROVEMENT_STATUS_LABEL.ineffective, tone: 'warning', icon: Undo2 },
  reverted: { label: IMPROVEMENT_STATUS_LABEL.reverted, tone: 'neutral', icon: Undo2 },
  failed: { label: IMPROVEMENT_STATUS_LABEL.failed, tone: 'danger', icon: XCircle },
};

export const FINDING_STATUS_VISUAL: Record<FindingStatus, StatusVisual> = {
  open: { label: FINDING_STATUS_LABEL.open, tone: 'neutral', icon: Eye },
  adopted: { label: FINDING_STATUS_LABEL.adopted, tone: 'success', icon: CheckCircle2 },
  needs_you: { label: FINDING_STATUS_LABEL.needs_you, tone: 'warning', icon: UserRound },
  dismissed: { label: FINDING_STATUS_LABEL.dismissed, tone: 'neutral', icon: Minus },
  failed: { label: FINDING_STATUS_LABEL.failed, tone: 'danger', icon: XCircle },
};

export const REVIEW_STATUS_VISUAL: Record<ReviewStatus, StatusVisual> = {
  pending: { label: 'Queued', tone: 'neutral', icon: Clock },
  running: { label: 'Reviewing', tone: 'accent', icon: CircleDot, active: true },
  done: { label: 'Reviewed', tone: 'success', icon: CheckCircle2 },
  skipped: { label: 'Clean run', tone: 'neutral', icon: SkipForward },
  failed: { label: 'Review failed', tone: 'danger', icon: XCircle },
};
