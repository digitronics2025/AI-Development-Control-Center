import {
  Activity,
  AlertOctagon,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  Clock,
  FilePen,
  Hourglass,
  ListOrdered,
  PauseCircle,
  PlugZap,
  ShieldQuestion,
  SkipForward,
  Square,
  UserRound,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { STAGE_STATUS_LABEL, TASK_STATUS_LABEL, type StageStatus, type TaskStatus } from '@acc/shared';

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
