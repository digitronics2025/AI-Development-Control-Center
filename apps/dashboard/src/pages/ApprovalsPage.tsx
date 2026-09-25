import { CheckCircle2, ShieldCheck, ShieldX, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  ConfirmDialog,
  Disclosure,
  EmptyState,
  Field,
  KeyValueList,
  PageHeader,
  PermissionBadge,
  RelativeTime,
  Skeleton,
  StatusChip,
  Textarea,
  cn,
  useFeedback,
} from '@acc/ui';
import type { Approval } from '@acc/shared';
import { errorMessage } from '../api/client';
import { useApprovals, useArtifactContent, useResolveApproval, useTaskArtifacts } from '../api/hooks';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useConnection } from '../app/runtime';
import { Markdown } from '../components/markdown';

/** Explicit, specific action labels — never "OK", "Continue" or "Yes" (design.md §7.4). */
function approveLabel(a: Approval): string {
  switch (a.kind) {
    case 'plan_review':
      return 'Approve plan';
    case 'skip_tests':
      return 'Continue without tests';
    case 'command':
      return a.environment === 'production' ? 'Approve production command' : 'Approve command once';
    case 'release':
      return 'Approve production release';
    case 'stage_permission': {
      const stage = (a.stageName ?? a.action.replace(/^Start /, '')).toLowerCase();
      if (a.environment === 'production') return `Approve production ${stage.replace(/^production /, '')}`;
      return `Approve ${stage}`;
    }
  }
}

function PlanPreview({ taskId }: { taskId: string }) {
  const artifacts = useTaskArtifacts(taskId);
  const plan = artifacts.data?.filter((a) => a.type === 'plan').at(-1);
  const content = useArtifactContent(plan?.id ?? null);
  if (artifacts.isLoading || content.isLoading) return <Skeleton className="h-32" />;
  if (!content.data) return <p className="text-body text-fg-secondary">The plan artifact is not available.</p>;
  return <Markdown>{content.data.content}</Markdown>;
}

function ApprovalCard({ approval, highlighted }: { approval: Approval; highlighted: boolean }) {
  const resolve = useResolveApproval();
  const connection = useConnection();
  const { toast } = useFeedback();
  const [note, setNote] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const strong = Boolean(approval.confirmationPhrase);
  const label = approveLabel(approval);

  const decide = (decision: 'approve' | 'deny', confirmation?: string) =>
    resolve.mutate(
      { id: approval.id, decision, note: note.trim() || undefined, confirmation },
      {
        onSuccess: () => {
          toast(decision === 'approve' ? `${label}: done` : approval.kind === 'plan_review' ? 'Plan sent back with your notes' : 'Request denied', decision === 'approve' ? 'success' : 'info');
          setConfirmOpen(false);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );

  return (
    <article
      aria-labelledby={`approval-${approval.id}`}
      className={cn('flex flex-col gap-4 rounded-lg border bg-surface p-4', highlighted ? 'border-accent' : 'border-border-subtle', approval.risk === 'dangerous' && 'border-danger')}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`approval-${approval.id}`} className="text-h3 text-fg">
            {approval.action}
          </h2>
          <p className="text-small text-fg-secondary">
            <Link to={`/tasks/${approval.taskId}`} className="font-semibold text-fg hover:underline">
              {approval.taskId} · {approval.taskTitle}
            </Link>{' '}
            · requested by {approval.requestedBy} · <RelativeTime iso={approval.createdAt} />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PermissionBadge level={approval.permissionLevel} />
          {approval.risk !== 'normal' ? <Badge className={approval.risk === 'dangerous' ? 'border-danger text-fg' : 'border-warning text-fg'}>{approval.risk === 'dangerous' ? 'Dangerous' : 'Elevated risk'}</Badge> : null}
        </div>
      </header>

      <KeyValueList
        items={[
          { label: 'Stage', value: approval.stageName ?? '—' },
          { label: 'Why', value: approval.reason },
          { label: 'Repository', value: approval.repositoryName },
          { label: 'Environment', value: approval.environment, hidden: !approval.environment || approval.environment === approval.repositoryName },
          { label: 'Risk', value: approval.riskExplanation },
        ]}
      />

      {approval.command ? (
        <div className="flex flex-col gap-1">
          <span className="text-small font-semibold text-fg-secondary">Exact command</span>
          <pre className="overflow-x-auto rounded-md border border-border-subtle bg-canvas px-3 py-2 font-mono text-code text-fg">{approval.command}</pre>
        </div>
      ) : null}

      {approval.kind === 'plan_review' ? (
        <Disclosure title="Read the plan" description="Implementation starts only after you approve it." defaultOpen>
          <PlanPreview taskId={approval.taskId} />
        </Disclosure>
      ) : null}

      <Field label={approval.kind === 'plan_review' ? 'Notes for the planner' : 'Note'} optional helper={approval.kind === 'plan_review' ? 'Sent back to the planner if you request changes.' : 'Recorded with your decision.'}>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} className="min-h-16" />
      </Field>

      {error ? (
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle pt-3">
        <Button variant="secondary" icon={ShieldX} onClick={() => decide('deny')} loading={resolve.isPending && resolve.variables?.decision === 'deny'} disabled={!connection.online} disabledReason="Reconnect to the orchestrator first">
          {approval.kind === 'plan_review' ? 'Request changes' : 'Deny request'}
        </Button>
        <Button
          variant={strong ? 'destructive' : 'primary'}
          icon={ShieldCheck}
          onClick={() => (strong ? setConfirmOpen(true) : decide('approve'))}
          loading={!strong && resolve.isPending && resolve.variables?.decision === 'approve'}
          disabled={!connection.online}
          disabledReason="Reconnect to the orchestrator first"
        >
          {label}
        </Button>
      </div>

      {strong ? (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          destructive
          title={label}
          description={`${approval.action} — ${approval.riskExplanation}`}
          confirmLabel={label}
          cancelLabel="Go back"
          confirmationPhrase={approval.confirmationPhrase}
          busy={resolve.isPending}
          onConfirm={(typed) => decide('approve', typed)}
        >
          {approval.command ? <pre className="mb-3 overflow-x-auto rounded-md border border-border-subtle bg-canvas px-3 py-2 font-mono text-code text-fg">{approval.command}</pre> : null}
        </ConfirmDialog>
      ) : null}
    </article>
  );
}

/** design.md §7.4 — approvals can stop autopilot, so they have their own destination. */
export function ApprovalsPage() {
  useBreadcrumb([{ label: 'Approvals' }]);
  const [params] = useSearchParams();
  const highlight = params.get('task');
  const pending = useApprovals('pending');
  const all = useApprovals('all');
  const resolved = useMemo(() => (all.data ?? []).filter((a) => a.status !== 'pending').slice(0, 30), [all.data]);
  const ordered = useMemo(() => {
    const list = pending.data ?? [];
    return highlight ? [...list.filter((a) => a.taskId === highlight), ...list.filter((a) => a.taskId !== highlight)] : list;
  }, [pending.data, highlight]);

  return (
    <div className="flex max-w-[960px] flex-col gap-6 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader title="Approvals" description="Requests that stop a task until you decide. Nothing is approved automatically above your permission threshold." />
      {pending.isLoading ? (
        <Skeleton className="h-64" />
      ) : ordered.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="Nothing waiting for approval" description="Stages above a task's permission level, dangerous commands and plan reviews in Discuss First mode appear here." />
      ) : (
        <div className="flex flex-col gap-4">
          {ordered.map((a) => (
            <ApprovalCard key={a.id} approval={a} highlighted={a.taskId === highlight} />
          ))}
        </div>
      )}
      {resolved.length ? (
        <Disclosure title="Recent decisions" description={`${resolved.length} resolved`}>
          <ul className="flex flex-col divide-y divide-border-subtle">
            {resolved.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <StatusChip
                  size="compact"
                  visual={
                    a.status === 'approved'
                      ? { label: 'Approved', tone: 'success', icon: CheckCircle2 }
                      : a.status === 'denied'
                        ? { label: 'Denied', tone: 'danger', icon: XCircle }
                        : { label: 'Withdrawn', tone: 'neutral', icon: XCircle }
                  }
                />
                <span className="min-w-0 flex-1 text-body text-fg">
                  {a.action} · <Link to={`/tasks/${a.taskId}`} className="hover:underline">{a.taskId}</Link>
                  {a.note ? <span className="text-fg-secondary"> — {a.note}</span> : null}
                </span>
                <RelativeTime iso={a.resolvedAt} className="text-small text-fg-secondary" />
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}
