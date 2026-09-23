import type { GraphRow } from '@acc/shared';
import { cn } from '../lib/cn.js';

/** Lane colours cycle through semantic tokens; lanes carry no status, so colour is not meaning here. */
const LANE_STROKE = ['stroke-accent', 'stroke-success', 'stroke-warning', 'stroke-info', 'stroke-fg-secondary'];
const LANE_FILL = ['fill-accent', 'fill-success', 'fill-warning', 'fill-info', 'fill-fg-secondary'];
const LANE_WIDTH = 14;

/**
 * One row of the history graph (layout from `layoutGraph`). Purely visual
 * and hidden from assistive technology: the commit row itself carries the
 * subject, SHA, parents and refs as text. Rows must share one fixed height
 * so lane lines join across rows.
 */
export function CommitGraphCell({
  row,
  height,
  maxLanes = 8,
  columns,
  className,
}: {
  row: GraphRow;
  height: number;
  maxLanes?: number;
  /** Lanes to reserve; pass the page's widest row so subjects line up. */
  columns?: number;
  className?: string;
}) {
  const lanes = Math.min(Math.max(columns ?? row.width, 1), maxLanes);
  const x = (lane: number) => Math.min(lane, maxLanes - 1) * LANE_WIDTH + LANE_WIDTH / 2 + 2;
  const mid = height / 2;
  const stroke = (lane: number) => LANE_STROKE[lane % LANE_STROKE.length];
  return (
    <svg width={lanes * LANE_WIDTH + 4} height={height} aria-hidden focusable="false" className={cn('shrink-0 overflow-visible', className)}>
      {row.through.map((lane) => (
        <line key={`t${lane}`} x1={x(lane)} y1={0} x2={x(lane)} y2={height} strokeWidth={2} className={stroke(lane)} />
      ))}
      {row.incoming.map((lane) => (
        <path key={`i${lane}`} d={`M ${x(lane)} 0 C ${x(lane)} ${mid / 2} ${x(row.lane)} ${mid / 2} ${x(row.lane)} ${mid}`} fill="none" strokeWidth={2} className={stroke(lane)} />
      ))}
      {row.outgoing.map((edge) => (
        <path
          key={`o${edge.to}`}
          d={`M ${x(edge.from)} ${mid} C ${x(edge.from)} ${mid * 1.5} ${x(edge.to)} ${mid * 1.5} ${x(edge.to)} ${height}`}
          fill="none"
          strokeWidth={2}
          className={stroke(edge.to)}
        />
      ))}
      <circle cx={x(row.lane)} cy={mid} r={4.5} strokeWidth={2} className={cn(LANE_FILL[row.lane % LANE_FILL.length], 'stroke-surface')} />
    </svg>
  );
}
