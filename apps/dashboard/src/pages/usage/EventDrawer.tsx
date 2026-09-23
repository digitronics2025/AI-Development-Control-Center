import { Link } from 'react-router';
import { Drawer, KeyValueList, Skeleton, StatusChip, USAGE_EVENT_STATUS_VISUAL, formatDateTime, formatDuration } from '@acc/ui';
import { ATTEMPT_REASON_LABEL, USAGE_BILLING_LABEL, USAGE_ORIGIN_LABEL, formatUsd } from '@acc/shared';
import { useUsageEvent } from '../../api/usage';
import { Cost, Tokens } from './common';

/** One attempt in full: per-model lines, pricing version, lineage and cost revisions (design.md §7.10). */
export function EventDrawer({ eventId, onClose }: { eventId: string | null; onClose: () => void }) {
  const event = useUsageEvent(eventId);
  const e = event.data;
  return (
    <Drawer open={Boolean(eventId)} onOpenChange={(open) => (!open ? onClose() : undefined)} title="Attempt" description={e ? `${e.agentId} · ${e.providerModelId ?? e.model}` : undefined} width={440}>
      {!e ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip visual={USAGE_EVENT_STATUS_VISUAL[e.status]} />
            <Cost nanos={e.displayCostNanos} source={e.costSource} />
          </div>
          <KeyValueList
            items={[
              { label: 'Task', value: e.taskId ? <Link className="underline underline-offset-2" to={`/usage/tasks/${e.taskId}`}>{`${e.taskId}${e.taskTitle ? ` · ${e.taskTitle}` : ''}`}</Link> : '—' },
              { label: 'Repository', value: e.projectName ?? e.projectId ?? '—' },
              { label: 'Asked by', value: `${USAGE_ORIGIN_LABEL[e.origin]}${e.workflowStep ? ` · ${e.workflowStep}` : ''}${e.agentRole ? ` (${e.agentRole})` : ''}` },
              { label: 'Model', value: `${e.model}${e.providerModelId && e.providerModelId !== e.model ? ` → ${e.providerModelId}` : ''}${e.effort ? ` · ${e.effort}` : ''}` },
              { label: 'Billing', value: `${e.provider} · ${USAGE_BILLING_LABEL[e.billing]}` },
              { label: 'Started', value: formatDateTime(e.startedAt) },
              { label: 'Duration', value: `${formatDuration(e.durationMs)}${e.apiDurationMs !== null ? ` (model time ${formatDuration(e.apiDurationMs)})` : ''}${e.turns !== null ? ` · ${e.turns} turns` : ''}` },
              { label: 'Attempt', value: `${ATTEMPT_REASON_LABEL[e.attemptReason]}${e.retryIndex ? ` · #${e.retryIndex + 1}` : ''}${e.fallbackFromModel ? ` · from ${e.fallbackFromModel} to ${e.fallbackToModel}` : ''}` },
              { label: 'Error', value: e.errorClass ?? '—', hidden: !e.errorClass },
              { label: 'Provider cost', value: e.providerCostNanos === null ? 'Not reported' : formatUsd(e.providerCostNanos) },
              { label: 'Calculated cost', value: e.calculatedCostNanos === null ? 'Not calculated' : formatUsd(e.calculatedCostNanos) },
              { label: 'Price version', value: e.pricingVersionId ?? '—' },
              { label: 'Provider request', value: <span className="font-mono text-small">{e.providerRequestId ?? '—'}</span> },
              { label: 'Execution', value: <span className="font-mono text-small">{e.executionId}</span> },
              { label: 'Prompt', value: e.promptChars !== null ? `${e.promptChars.toLocaleString()} characters · hash ${e.promptHash ?? '—'}` : '—' },
            ]}
          />
          <section className="flex flex-col gap-2">
            <h3 className="text-h3 text-fg">Usage by model</h3>
            {e.lines.length ? (
              <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
                {e.lines.map((l, i) => (
                  <li key={i} className="flex flex-col gap-1 px-3 py-2 text-body">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-small font-semibold text-fg">{l.model}</span>
                      <Cost nanos={l.providerCostNanos ?? l.calculatedCostNanos} />
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-small text-fg-secondary">
                      <span>
                        input <Tokens count={l.tokens.input} />
                      </span>
                      <span>
                        output <Tokens count={l.tokens.output} />
                      </span>
                      <span>
                        cache read <Tokens count={l.tokens.cacheRead} />
                      </span>
                      <span>
                        cache write <Tokens count={l.tokens.cacheWrite} />
                        {l.cacheWrite1h ? ` (1 h: ${l.cacheWrite1h.toLocaleString()})` : ''}
                      </span>
                      <span>
                        reasoning <Tokens count={l.tokens.reasoning} />
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body text-fg-secondary">The provider reported no usage for this attempt (it stopped before its summary). Its cost is unknown, not zero.</p>
            )}
          </section>
          {e.revisions.length ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-h3 text-fg">Cost revisions</h3>
              <ul className="flex flex-col gap-1 text-small text-fg-secondary">
                {e.revisions.map((r) => (
                  <li key={r.id}>
                    {formatDateTime(r.createdAt)}: {r.previousSource} → {r.newSource} ({r.calculatedCostNanos === null ? 'unknown' : formatUsd(r.calculatedCostNanos)}) — {r.reason}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
