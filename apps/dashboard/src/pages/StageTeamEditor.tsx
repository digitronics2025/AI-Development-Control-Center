import { Plus, Trash2 } from 'lucide-react';
import { useId } from 'react';
import { Button, Field, IconButton, Input, Select, Switch } from '@acc/ui';
import { MAX_TEAM_WORKERS, type StageDefinition, type StageTeam, type StageTeamWorker, type WorkflowIssue } from '@acc/shared';
import { AssignmentPicker } from '../components/assignment-picker';

type ExecutionMode = 'single' | StageTeam['mode'];

const MODE_OPTIONS: Array<{ value: ExecutionMode; label: string; description: string }> = [
  { value: 'single', label: 'Single agent', description: 'One agent runs the stage.' },
  { value: 'fixed', label: 'Fixed team', description: 'The workers below run side by side. Read-only (Level 1) stages only.' },
  { value: 'adaptive', label: 'Adaptive team', description: 'Work units come from the plan; runs as one agent when they cannot run safely in parallel.' },
  { value: 'variants', label: 'Competing variants', description: 'Each worker does the whole stage its own way; a judge keeps one. Not for review stages.' },
];

/** "Fixed team of 3" / "Adaptive team, up to 3" / "3 competing variants" — the stage list's one-line summary. */
export function teamLabel(team: StageTeam | undefined): string | null {
  if (!team) return null;
  if (team.mode === 'variants') return `${team.workers?.length ?? 0} competing variants`;
  return team.mode === 'fixed' ? `Fixed team of ${team.workers?.length ?? 0}` : `Adaptive team, up to ${team.maxWorkers}`;
}

function newWorker(existing: StageTeamWorker[], primary: boolean): StageTeamWorker {
  let n = existing.length + 1;
  while (existing.some((w) => w.key === `worker-${n}`)) n++;
  return { key: `worker-${n}`, focus: '', primary };
}

/**
 * Stage Team settings of an agent stage (docs/plans/STAGE_TEAMS_PLAN.md §3.14):
 * single agent, a fixed team of 2–4 configured workers, or an adaptive team
 * sized from the plan. Validation comes from the shared workflow rules.
 */
export function StageTeamEditor({
  stage,
  issues,
  readOnly,
  onChange,
}: {
  stage: StageDefinition;
  /** This stage's issues only. */
  issues: WorkflowIssue[];
  readOnly: boolean;
  onChange: (team: StageTeam | undefined) => void;
}) {
  const id = useId();
  const team = stage.team;
  const mode: ExecutionMode = team?.mode ?? 'single';
  const workers = team?.workers ?? [];
  const first = (predicate: (field: string) => boolean) => issues.find((i) => predicate(i.field))?.message ?? null;
  const modeError = first((f) => f === 'team' || f === 'team.mode' || f === 'team.maxWorkers');
  const workersError = first((f) => f === 'team.workers');
  const workerError = (index: number, field: string) => first((f) => f === `team.workers.${index}.${field}`);

  const setMode = (next: ExecutionMode) => {
    if (next === 'single') return onChange(undefined);
    const maxWorkers = team?.maxWorkers ?? 3;
    if (next === 'adaptive') return onChange({ mode: 'adaptive', maxWorkers });
    // Variants have no primary reviewer; a fixed review team starts with one.
    const kept = next === 'variants' ? workers.map((w) => ({ ...w, primary: false })) : workers;
    const start = kept.length ? kept : [newWorker([], next === 'fixed' && stage.verdict)];
    const list = start.length >= 2 ? start : [...start, newWorker(start, false)];
    onChange(next === 'variants' ? { mode: 'variants', maxWorkers, workers: list, ...(team?.judge ? { judge: team.judge } : {}) } : { mode: 'fixed', maxWorkers, workers: list });
  };
  const setWorkers = (next: StageTeamWorker[]) => team && onChange({ ...team, workers: next });
  const setWorker = (index: number, patch: Partial<StageTeamWorker>) => setWorkers(workers.map((w, i) => (i === index ? { ...w, ...patch } : w)));

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border-subtle p-3">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
        <Field label="Execution" error={modeError} helper={MODE_OPTIONS.find((o) => o.value === mode)?.description}>
          <Select value={mode} onValueChange={(v) => setMode(v as ExecutionMode)} options={MODE_OPTIONS} disabled={readOnly} />
        </Field>
        {team ? (
          <Field label="Maximum workers">
            <Select
              value={String(team.maxWorkers)}
              onValueChange={(v) => onChange({ ...team, maxWorkers: Number(v) })}
              options={[2, 3, 4].filter((n) => n <= MAX_TEAM_WORKERS).map((n) => ({ value: String(n), label: String(n) }))}
              disabled={readOnly}
            />
          </Field>
        ) : null}
      </div>

      {team?.mode === 'fixed' || team?.mode === 'variants' ? (
        <div className="flex flex-col gap-3" role="group" aria-labelledby={`${id}-workers`}>
          <div className="flex items-center justify-between gap-2">
            <span id={`${id}-workers`} className="text-body font-semibold text-fg">
              {team.mode === 'variants' ? 'Variants' : 'Workers'}
            </span>
            {!readOnly ? (
              <Button size="compact" icon={Plus} disabled={workers.length >= MAX_TEAM_WORKERS} disabledReason={`A team has at most ${MAX_TEAM_WORKERS} workers`} onClick={() => setWorkers([...workers, newWorker(workers, false)])}>
                Add worker
              </Button>
            ) : null}
          </div>
          {workersError ? (
            <p role="alert" className="text-small text-danger">
              {workersError}
            </p>
          ) : null}
          <ol className="flex flex-col gap-3">
            {workers.map((w, index) => {
              const name = w.focus.trim() || `Worker ${index + 1}`;
              return (
                <li key={index} className="flex flex-col gap-3 rounded-md bg-canvas p-3">
                  <div className="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
                    <Field label="Key" error={workerError(index, 'key')}>
                      <Input value={w.key} onChange={(e) => setWorker(index, { key: e.target.value })} className="font-mono" spellCheck={false} />
                    </Field>
                    <Field label={team.mode === 'variants' ? 'Approach' : 'Focus'} error={workerError(index, 'focus')}>
                      <Input value={w.focus} onChange={(e) => setWorker(index, { focus: e.target.value })} placeholder={team.mode === 'variants' ? 'e.g. Bold type, full-bleed imagery' : 'e.g. Security and data handling'} />
                    </Field>
                  </div>
                  <AssignmentPicker
                    label={name}
                    disabled={readOnly}
                    value={{ agentId: w.agentId, model: w.model, effort: w.effort }}
                    inheritLabel="Stage's agent"
                    onChange={(v) => setWorker(index, { agentId: v.agentId, model: v.agentId ? v.model : undefined, effort: v.agentId ? v.effort : undefined })}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    {stage.verdict ? (
                      <label className="flex items-center gap-2 text-body text-fg">
                        <Switch
                          checked={w.primary}
                          disabled={readOnly}
                          aria-label={`${name}: primary reviewer`}
                          // Exactly one primary reviewer: choosing one clears the others.
                          onCheckedChange={(v) => setWorkers(workers.map((x, i) => ({ ...x, primary: i === index ? v : v ? false : x.primary })))}
                        />
                        Primary reviewer
                      </label>
                    ) : (
                      <span />
                    )}
                    {!readOnly ? (
                      <IconButton icon={Trash2} label={`Remove ${name}`} size="compact" disabled={workers.length <= 2} onClick={() => setWorkers(workers.filter((_, i) => i !== index))} />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {stage.verdict ? <p className="text-small text-fg-secondary">The primary reviewer covers the whole change; the others look at their focus.</p> : null}
          {team.mode === 'variants' ? (
            <div className="flex flex-col gap-2">
              <span className="text-body font-semibold text-fg">Judge</span>
              <AssignmentPicker
                label="Judge"
                disabled={readOnly}
                value={{ agentId: team.judge?.agentId, model: team.judge?.model, effort: team.judge?.effort }}
                inheritLabel="Stage's agent"
                onChange={(v) => {
                  const { judge: _previous, ...rest } = team;
                  onChange(v.agentId ? { ...rest, judge: { agentId: v.agentId, model: v.model, effort: v.effort } } : rest);
                }}
              />
              <p className="text-small text-fg-secondary">The judge reads every finished variant (report, changed files, diff) without changing anything and keeps one; only that one reaches the task.</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
