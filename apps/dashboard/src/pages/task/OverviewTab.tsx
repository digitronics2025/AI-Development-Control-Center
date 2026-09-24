import { CheckCircle2, FileText, XCircle } from 'lucide-react';
import { useMemo } from 'react';
import {
  Banner,
  Button,
  KeyValueList,
  Panel,
  RelativeTime,
  Skeleton,
  StageStatusChip,
  StatusChip,
  cn,
  durationBetween,
  formatDuration,
  shortSha,
  useNow,
} from '@acc/ui';
import { MODE_LABEL, ROLE_LABEL, type Artifact, type TaskDetail } from '@acc/shared';
import { useArtifactContent, useTaskArtifacts, useTaskDirectives } from '../../api/hooks';
import { AssignmentText } from '../../components/agents';
import { Markdown } from '../../components/markdown';

function FinalReport({ artifact }: { artifact: Artifact }) {
  const content = useArtifactContent(artifact.id);
  return (
    <Panel title="Completion report" description={`Created ${new Date(artifact.createdAt).toLocaleString()}`}>
      {content.isLoading ? <Skeleton className="h-48" /> : content.data ? <Markdown>{content.data.content}</Markdown> : <p className="text-fg-secondary">The report could not be loaded.</p>}
    </Panel>
  );
}

/**
 * Overview tab (design.md §7.3): current stage, latest event, stage output
 * summaries, directives, review state and — when complete — the final report.
 */
export function OverviewTab({ task, onOpenTab }: { task: TaskDetail; onOpenTab: (tab: string) => void }) {
  const running = task.status === 'RUNNING';
  const now = useNow(1000, running);
  const artifacts = useTaskArtifacts(task.id);
  const directives = useTaskDirectives(task.id);
  const finalReport = artifacts.data?.filter((a) => a.type === 'final-report').at(-1);
  const current = task.stages.find((s) => s.id === task.currentStageId && s.stageKey === task.currentStageKey) ?? null;

  const stages = task.stages;
  const outputs = useMemo(() => {
    const latest = new Map<string, (typeof stages)[number]>();
    for (const s of stages) if (s.status === 'SUCCESS' || s.status === 'SKIPPED' || s.status === 'FAILED') latest.set(s.stageKey, s);
    return [...latest.values()];
  }, [stages]);

  const reviews = task.stages.filter((s) => s.verdict !== null);
  const lastReview = reviews.at(-1);

  return (
    <div className="flex flex-col gap-4">
      {task.status === 'COMPLETED' && task.finalStatus === 'NEEDS_USER_ACTION' ? (
        <Banner tone="warning" title="Completed, but needs your attention">
          The completion report lists what could not be verified. The task is not marked ready.
        </Banner>
      ) : null}
      {finalReport ? <FinalReport artifact={finalReport} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Current stage" headingLevel={3}>
          {task.status === 'COMPLETED' ? (
            <p className="text-body text-fg">All stages finished {task.finishedAt ? <RelativeTime iso={task.finishedAt} now={now} /> : null}.</p>
          ) : (
            <KeyValueList
              items={[
                { label: 'Stage', value: task.currentStageName ?? '—' },
                { label: 'Status', value: current ? <StageStatusChip status={current.status} size="compact" /> : 'Not started' },
                { label: 'Assigned', value: <AssignmentText assignment={task.currentAssignment} /> },
                { label: 'Elapsed', value: current ? <span className="tabular">{formatDuration(durationBetween(current.startedAt, current.finishedAt, now))}</span> : '—', hidden: !current },
                { label: 'Attempt', value: current ? String(current.attempt) : '—', hidden: !current || current.attempt < 2 },
                { label: 'Next', value: (() => {
                  const def = task.workflow.stages.find((s) => s.key === task.currentStageKey);
                  const next = def ? task.workflow.stages.find((s) => s.key === def.next) : null;
                  return next ? next.name : def?.next === 'complete' ? 'Completion report' : '—';
                })() },
              ]}
            />
          )}
          {task.lastEvent ? (
            <p className="mt-3 border-t border-border-subtle pt-3 text-small text-fg-secondary">
              Latest: <span className="text-fg">{task.lastEvent.message}</span> · <RelativeTime iso={task.lastEvent.at} now={now} />
            </p>
          ) : null}
        </Panel>

        <Panel title="Review state" headingLevel={3}>
          <KeyValueList
            items={[
              {
                label: 'Last verdict',
                value: lastReview ? (
                  <StatusChip
                    size="compact"
                    visual={lastReview.verdict === 'PASS' ? { label: `${lastReview.name} passed`, tone: 'success', icon: CheckCircle2 } : { label: `${lastReview.name}: changes requested`, tone: 'danger', icon: XCircle }}
                  />
                ) : (
                  'No review yet'
                ),
              },
              { label: task.supervised ? 'Fix attempts' : 'Fix cycles', value: <span className="tabular">{task.fixCycles} of {task.maxFixCycles}{task.supervised ? ' in this strategy' : ''}</span> },
              { label: 'Recovery cycles', value: <span className="tabular">{task.recoveryCycle}</span>, hidden: !task.supervised },
              { label: 'Mode', value: MODE_LABEL[task.mode] },
              { label: 'Repositories', value: task.repositories.map((r) => (r.folder ? `${r.name} (${r.folder}/)` : r.name)).join(', '), hidden: task.repositories.length <= 1 },
              { label: 'Branch', value: task.git.taskBranch ? <code className="font-mono text-code">{task.git.taskBranch}</code> : task.git.baselineBranch ? `${task.git.baselineBranch} (no task branch)` : 'Not recorded yet' },
              { label: 'Baseline', value: task.git.baselineCommit ? <code className="font-mono text-code">{shortSha(task.git.baselineCommit)}</code> : '—', hidden: !task.git.baselineCommit },
              { label: 'Your changes', value: `${task.git.preexistingChanges.length} pre-existing file(s) protected`, hidden: task.git.preexistingChanges.length === 0 },
            ]}
          />
          <div className="mt-3 flex flex-wrap gap-2 border-t border-border-subtle pt-3">
            <Button size="compact" onClick={() => onOpenTab('changes')}>
              Open Git diff
            </Button>
            <Button size="compact" onClick={() => onOpenTab('tests')}>
              Open test output
            </Button>
          </div>
        </Panel>
      </div>

      <Panel title="Request" headingLevel={3}>
        <p className="whitespace-pre-wrap text-body text-fg wrap-anywhere">{task.description}</p>
        {task.attachments.length ? (
          <p className="mt-2 text-small text-fg-secondary">Attachments: {task.attachments.map((a) => a.name).join(', ')}</p>
        ) : null}
      </Panel>

      {outputs.length ? (
        <Panel title="Stage outputs" headingLevel={3} bodyClassName="p-0">
          <ul className="divide-y divide-border-subtle">
            {outputs.map((s) => (
              <li key={s.id} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body font-semibold text-fg">{s.name}</span>
                  <StageStatusChip status={s.status} size="compact" />
                  {s.verdict ? <span className="text-small text-fg-secondary">Verdict {s.verdict}</span> : null}
                  <span className="text-small text-fg-secondary">· {ROLE_LABEL[s.role]}</span>
                </div>
                <p className="text-body text-fg-secondary wrap-anywhere">{s.errorMessage ?? s.summary ?? 'No summary.'}</p>
              </li>
            ))}
          </ul>
          <div className="border-t border-border-subtle px-4 py-2">
            <Button size="compact" variant="ghost" icon={FileText} onClick={() => onOpenTab('artifacts')}>
              Open artifacts
            </Button>
          </div>
        </Panel>
      ) : null}

      <Panel title="Directives" headingLevel={3} description="Instructions you added while the task ran. They apply at the next safe boundary.">
        {directives.data?.length ? (
          <ul className="flex flex-col gap-2">
            {directives.data.map((d) => (
              <li key={d.id} className={cn('flex flex-col gap-0.5 rounded-md border border-border-subtle px-3 py-2', d.state !== 'active' && 'opacity-70')}>
                <span className={cn('text-body text-fg wrap-anywhere', d.state !== 'active' && 'line-through')}>{d.text}</span>
                <span className="text-small text-fg-secondary">
                  {d.state === 'removed'
                    ? 'Removed — later stages no longer receive it'
                    : d.state === 'superseded'
                      ? 'Replaced by a newer directive'
                      : d.kind === 'routing'
                        ? 'Routing — applied to the stage assignment'
                        : d.status === 'applied'
                          ? `Applied to ${task.workflow.stages.find((s) => s.key === d.appliedStageKey)?.name ?? d.appliedStageKey}${d.scope === 'CURRENT_TASK' ? ' and every later stage' : ''}`
                          : 'Queued — applies when the next agent stage starts'}{' '}
                  · <RelativeTime iso={d.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-fg-secondary">No directives. Add one from the task controls when you want to steer the next stage.</p>
        )}
      </Panel>
      {task.status === 'COMPLETED' && !finalReport && artifacts.isLoading ? <Skeleton className="h-40" /> : null}
    </div>
  );
}
