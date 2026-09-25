import { Check, Circle, X } from 'lucide-react';
import {
  PERMISSION_LEVEL_INFO,
  type PermissionLevel,
  type StageDefinition,
  type StageInstance,
  type StageStatus,
  type ReleaseState,
  type TaskStatus,
} from '@acc/shared';
import { cn } from '../lib/cn.js';
import { formatDuration, durationBetween } from '../lib/format.js';
import { ActivityDot } from '../primitives/misc.js';
import { Tooltip } from '../primitives/tooltip.js';
import { RELEASE_STATE_VISUAL, STAGE_STATUS_VISUAL, TASK_STATUS_VISUAL, TONE_CLASSES, type StatusVisual } from '../tokens/status.js';

/**
 * [icon] Label — color lives in the icon and tint; the label stays in
 * primary text for contrast (design.md §4.2 contrast rules, §8.5).
 */
export function StatusChip({ visual, className, size = 'default' }: { visual: StatusVisual; className?: string; size?: 'compact' | 'default' }) {
  const tone = TONE_CLASSES[visual.tone];
  const Icon = visual.icon;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm font-semibold text-fg',
        tone.tint,
        size === 'compact' ? 'h-5 px-1.5 text-small' : 'h-6 px-2 text-small',
        className,
      )}
    >
      <Icon size={14} className={cn(tone.icon, visual.active && 'animate-activity')} aria-hidden />
      {visual.label}
    </span>
  );
}

export function TaskStatusChip({ status, className, size }: { status: TaskStatus; className?: string; size?: 'compact' | 'default' }) {
  return <StatusChip visual={TASK_STATUS_VISUAL[status]} className={className} size={size} />;
}

/** The badge of a task's release: Live, Sent — not confirmed, Release failed, Not released (design.md §7.3). */
export function ReleaseStateChip({ state, className, size }: { state: ReleaseState; className?: string; size?: 'compact' | 'default' }) {
  return <StatusChip visual={RELEASE_STATE_VISUAL[state]} className={className} size={size} />;
}

export function StageStatusChip({ status, className, size }: { status: StageStatus; className?: string; size?: 'compact' | 'default' }) {
  return <StatusChip visual={STAGE_STATUS_VISUAL[status]} className={className} size={size} />;
}

export function PermissionBadge({ level, className }: { level: PermissionLevel; className?: string }) {
  const info = PERMISSION_LEVEL_INFO[level];
  const tone = level >= 5 ? TONE_CLASSES.danger : level >= 4 ? TONE_CLASSES.warning : TONE_CLASSES.neutral;
  return (
    <Tooltip content={info.description}>
      <span tabIndex={0} className={cn('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 text-small font-semibold text-fg', tone.border, className)}>
        L{level} · {info.name}
      </span>
    </Tooltip>
  );
}

export interface RailStage {
  key: string;
  name: string;
  status: StageStatus | 'PENDING';
  verdict?: 'PASS' | 'FAIL' | null;
}

function railState(stage: RailStage): 'done' | 'current' | 'failed' | 'waiting' | 'future' {
  if (stage.status === 'SUCCESS' || stage.status === 'SKIPPED') return stage.verdict === 'FAIL' ? 'failed' : 'done';
  if (stage.status === 'RUNNING' || stage.status === 'STARTING') return 'current';
  if (stage.status === 'FAILED' || stage.status === 'CANCELLED') return 'failed';
  if (stage.status === 'PENDING' || stage.status === 'READY') return 'future';
  return 'waiting';
}

/**
 * Compact workflow progress rail for task rows (design.md §7.1) — segments,
 * not a decorative donut. Each segment has a text alternative.
 */
export function StageRail({ stages, currentKey, className }: { stages: RailStage[]; currentKey?: string | null; className?: string }) {
  const done = stages.filter((s) => railState(s) === 'done').length;
  const current = stages.find((s) => s.key === currentKey);
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div role="img" aria-label={`${done} of ${stages.length} stages complete${current ? `, current: ${current.name}` : ''}`} className="flex h-1.5 w-full min-w-24 gap-0.5">
        {stages.map((stage) => {
          const state = railState(stage);
          return (
            <span
              key={stage.key}
              className={cn(
                'h-full flex-1 rounded-full',
                state === 'done' && 'bg-success',
                state === 'current' && 'animate-activity bg-accent',
                state === 'failed' && 'bg-danger',
                state === 'waiting' && 'bg-warning',
                state === 'future' && 'bg-muted',
                stage.key === currentKey && state !== 'current' && 'outline-1 outline-offset-1 outline-border-strong',
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

export interface TimelineStage {
  def: Pick<StageDefinition, 'key' | 'name' | 'role' | 'kind'>;
  instance: StageInstance | null;
  /** Assigned agent display name (for future stages, the planned one). */
  agentName: string | null;
  isCurrent: boolean;
  /** Number of times this stage ran (fix cycles). */
  runs: number;
}

function TimelineIcon({ state }: { state: ReturnType<typeof railState> }) {
  if (state === 'done') return <Check size={14} aria-hidden className="text-success" />;
  if (state === 'failed') return <X size={14} aria-hidden className="text-danger" />;
  if (state === 'current') return <ActivityDot />;
  if (state === 'waiting') return <Circle size={10} aria-hidden className="fill-warning text-warning" />;
  return <Circle size={10} aria-hidden className="text-fg-tertiary" />;
}

/**
 * Stage timeline (design.md §7.3): horizontal stepper on wide screens, a
 * compact vertical list on narrow ones. Completed stages are quieter, the
 * current stage strongest, future stages visible but subdued; a failed stage
 * shows its reason inline.
 */
export function StageTimeline({ stages, now = Date.now(), orientation }: { stages: TimelineStage[]; now?: number; orientation: 'horizontal' | 'vertical' }) {
  return (
    <ol
      aria-label="Workflow stages"
      // The horizontal stepper can overflow; it must be scrollable from the keyboard.
      tabIndex={orientation === 'horizontal' ? 0 : undefined}
      className={cn(
        orientation === 'horizontal' ? 'flex items-stretch gap-0 overflow-x-auto rounded-md pb-1 focus-visible:outline-2 focus-visible:outline-focus' : 'flex flex-col gap-0',
      )}
    >
      {stages.map((stage, index) => {
        const inst = stage.instance;
        const state = railState({ key: stage.def.key, name: stage.def.name, status: inst?.status ?? 'PENDING', verdict: inst?.verdict });
        const duration = inst ? durationBetween(inst.startedAt, inst.finishedAt, now) : null;
        const label = inst ? STAGE_STATUS_VISUAL[inst.status].label : 'Not started';
        const failedReason = state === 'failed' ? (inst?.verdict === 'FAIL' ? 'Changes requested' : inst?.errorMessage) : null;
        const last = index === stages.length - 1;
        return (
          <li
            key={stage.def.key}
            aria-current={stage.isCurrent ? 'step' : undefined}
            className={cn(
              'relative flex min-w-0',
              orientation === 'horizontal' ? 'min-w-[120px] flex-1 flex-col gap-1 pr-3' : 'gap-3 pb-3',
            )}
          >
            <div className={cn('flex items-center', orientation === 'horizontal' ? 'gap-2' : 'flex-col')}>
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full border',
                  stage.isCurrent ? 'border-accent bg-accent-muted' : 'border-border-subtle bg-surface',
                  state === 'failed' && 'border-danger bg-danger-muted',
                )}
              >
                <TimelineIcon state={state} />
              </span>
              {!last ? (
                <span aria-hidden className={cn(orientation === 'horizontal' ? 'h-px flex-1 bg-border-subtle' : 'mt-1 w-px flex-1 bg-border-subtle', state === 'done' && 'bg-success')} />
              ) : null}
            </div>
            <div className={cn('flex min-w-0 flex-col', orientation === 'vertical' && 'pb-1')}>
              <span className={cn('truncate text-body', stage.isCurrent ? 'font-semibold text-fg' : state === 'future' ? 'text-fg-secondary' : 'text-fg')}>
                {stage.def.name}
                {stage.runs > 1 ? <span className="ml-1 text-small font-normal text-fg-secondary">×{stage.runs}</span> : null}
              </span>
              <span className="truncate text-small text-fg-secondary" title={stage.def.kind === 'agent' ? (stage.agentName ?? undefined) : undefined}>
                <span className="sr-only">{label}. </span>
                {stage.def.kind === 'agent' ? (stage.agentName ?? '—') : 'System'}
              </span>
              {duration !== null && state !== 'future' ? <span className="tabular text-small text-fg-secondary">{formatDuration(duration)}</span> : null}
              {failedReason ? <span className="line-clamp-2 text-small text-danger">{failedReason}</span> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
