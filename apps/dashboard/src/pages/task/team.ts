import type { StageWorkUnit, TaskDetail } from '@acc/shared';

/** Work units of one stage instance, in their planned order. */
export function unitsOfStage(task: TaskDetail, stageId: string): StageWorkUnit[] {
  return (task.workUnits ?? []).filter((u) => u.stageId === stageId).sort((a, b) => a.ordinal - b.ordinal || a.createdAt.localeCompare(b.createdAt));
}

/**
 * The compact team line of the Stage Timeline (docs/plans/STAGE_TEAMS_PLAN.md
 * §3.13): "Team 2/3 running", "Team of 3 · done", "Team of 3 · 1 failed".
 * Counts only the workers; the integration, split and judge runs are not team members.
 */
export function teamSummary(units: readonly StageWorkUnit[]): string | null {
  const workers = units.filter((u) => u.kind === 'worker');
  if (!workers.length) return null;
  const total = workers.length;
  const running = workers.filter((u) => u.status === 'RUNNING').length;
  if (running) return `Team ${running}/${total} running`;
  const queued = workers.filter((u) => u.status === 'QUEUED').length;
  if (queued === total) return `Team of ${total} · waiting`;
  if (queued) return `Team of ${total} · ${total - queued} done, ${queued} waiting`;
  const failed = workers.filter((u) => u.status === 'FAILED').length;
  if (failed) return `Team of ${total} · ${failed} failed`;
  // Variants: every worker has finished while the judge compares them (the kept one's files are written without a unit).
  if (units.some((u) => u.kind === 'judge' && u.status === 'RUNNING')) return `Team of ${total} · judging`;
  const integrating = units.some((u) => u.kind === 'integration' && u.status === 'RUNNING');
  return integrating ? `Team of ${total} · integrating` : `Team of ${total} · done`;
}

/** The stage instance whose team the Execution tab shows: the running one, else the most recent that had units. */
export function currentTeamStage(task: TaskDetail): { stageId: string; stageName: string; units: StageWorkUnit[] } | null {
  const units = task.workUnits ?? [];
  if (!units.length) return null;
  const withUnits = new Set(units.map((u) => u.stageId));
  const stages = task.stages.filter((s) => withUnits.has(s.id));
  const pick = stages.find((s) => s.status === 'RUNNING' || s.status === 'STARTING') ?? stages.at(-1);
  // Units can arrive before their stage instance reaches the cache; fall back to the newest unit's stage.
  const stageId = pick?.id ?? units.at(-1)!.stageId;
  const stageName = pick?.name ?? task.workflow.stages.find((d) => d.key === units.at(-1)!.stageKey)?.name ?? 'Stage';
  return { stageId, stageName, units: unitsOfStage(task, stageId) };
}
