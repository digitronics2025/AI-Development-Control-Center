import { Link } from 'react-router';
import { KeyValueList, Meter, Panel, StatusChip, BUDGET_STATE_VISUAL, formatDuration } from '@acc/ui';
import { formatTokens, formatUsd, type TaskDetail } from '@acc/shared';
import { useUsageLive } from '../../api/usage';

/**
 * Live run meter (design.md §7.10): spend, tokens, attempts and budget for
 * this task, refreshed by the realtime `usage` message as each attempt ends.
 */
export function UsagePanel({ task }: { task: TaskDetail }) {
  const live = useUsageLive(task.id, true);
  const data = live.data;
  const t = data?.totals;
  const budget = data?.budgets.filter((b) => b.enabled).sort((a, b) => b.usedRatio - a.usedRatio)[0];
  return (
    <Panel title="Usage" variant="inspector" headingLevel={3} actions={<Link to={`/usage/tasks/${task.id}`} className="rounded-sm text-small text-fg underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus">Open cost ledger</Link>}>
      {!t ? (
        <p className="text-body text-fg-secondary">Loading…</p>
      ) : t.requests === 0 ? (
        <p className="text-body text-fg-secondary">No agent attempt recorded yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <KeyValueList
            items={[
              { label: 'Spend', value: t.unknownCostRequests === t.requests ? 'Unknown' : `${formatUsd(t.costNanos)}${t.unknownCostRequests ? ` · ${t.unknownCostRequests} not priced` : ''}` },
              { label: 'Tokens', value: formatTokens(t.totalTokens) },
              { label: 'Attempts', value: `${t.requests}${data!.retries ? ` · ${data!.retries} retries` : ''}${t.failed ? ` · ${t.failed} failed` : ''}` },
              { label: 'Agent time', value: formatDuration(t.durationMs) },
              { label: 'Now', value: data!.currentStage ? `${data!.currentStage}${data!.currentAgentId ? ` · ${data!.currentAgentId}` : ''}` : '—', hidden: !data!.currentStage },
            ]}
          />
          {budget ? (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center justify-between gap-2 text-small">
                <span className="text-fg-secondary">{budget.scopeLabel}</span>
                <StatusChip visual={BUDGET_STATE_VISUAL[budget.state]} size="compact" />
              </div>
              <Meter ratio={budget.usedRatio} warning={budget.warningThreshold} critical={budget.criticalThreshold} />
              <span className="tabular text-small text-fg-secondary">{formatUsd(budget.remainingNanos)} left of {formatUsd(budget.amountNanos)}</span>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
