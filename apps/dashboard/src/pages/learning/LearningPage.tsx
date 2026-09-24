import { Lightbulb, ListChecks, RefreshCw, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FINDING_STATUS_VISUAL,
  IMPROVEMENT_STATUS_VISUAL,
  PageHeader,
  REVIEW_STATUS_VISUAL,
  RelativeTime,
  Skeleton,
  StatTile,
  StatusChip,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  useFeedback,
} from '@acc/ui';
import {
  FINDING_KIND_LABEL,
  IMPROVEMENT_KIND_LABEL,
  INSTALLABLE_TOOLS,
  type LearningFinding,
  type LearningImprovement,
  type LearningOverview,
  type LearningProposal,
} from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useRepositories } from '../../api/hooks';
import { keys } from '../../api/keys';
import { useLearning, useLearningMutations } from '../../api/learning';
import { useBreadcrumb } from '../../app/breadcrumbs';

const TABS = ['improvements', 'findings', 'reviews', 'activity'] as const;
type TabKey = (typeof TABS)[number];

/** What a finding proposes, in words. */
export function proposalText(p: LearningProposal | null): string | null {
  if (!p) return null;
  switch (p.type) {
    case 'ADD_LESSON':
      return `Lesson: ${p.text}`;
    case 'USE_SKILL':
      return `Use the /${p.skill} skill when ${p.when}`;
    case 'AUTHOR_SKILL':
      return `Write a skill "${p.name}": ${p.description}`;
    case 'INSTALL_TOOL':
      return `Install ${INSTALLABLE_TOOLS.find((t) => t.id === p.toolId)?.name ?? p.toolId}`;
  }
}

function useScopeLabel() {
  const repositories = useRepositories();
  return (scope: 'repository' | 'global', repositoryId: string | null) =>
    scope === 'global' ? 'Every repository' : (repositories.data?.find((r) => r.id === repositoryId)?.name ?? 'One repository');
}

function trialText(i: LearningImprovement): string {
  const back = `came back ${i.trial.recurrences === 0 ? 'no times' : i.trial.recurrences === 1 ? 'once' : `${i.trial.recurrences} times`}`;
  return i.status === 'trial' ? `Tried on ${i.trial.seen} of ${i.trial.target} tasks · ${back}` : `Tried on ${i.trial.seen} task${i.trial.seen === 1 ? '' : 's'} · ${back}`;
}

function ImprovementsTab({ data }: { data: LearningOverview }) {
  const scopeLabel = useScopeLabel();
  const { undo } = useLearningMutations();
  const { toast } = useFeedback();
  const [undoing, setUndoing] = useState<LearningImprovement | null>(null);
  if (!data.improvements.length) {
    return <EmptyState icon={Lightbulb} title="No improvements yet" description="When the same problem shows up in finished tasks, the Chairman changes how later tasks run: a lesson in their instructions, a skill, or a missing program. Each change is listed here." />;
  }
  const live = (i: LearningImprovement) => i.status === 'trial' || i.status === 'active';
  return (
    <>
      <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
        {data.improvements.map((i) => (
          <li key={i.id} className="flex flex-col gap-1.5 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body font-semibold text-fg wrap-anywhere">{i.title}</span>
                <span className="text-small text-fg-secondary">
                  {IMPROVEMENT_KIND_LABEL[i.kind]} · {scopeLabel(i.scope, i.repositoryId)} · <RelativeTime iso={i.createdAt} />
                </span>
              </div>
              <div className="flex items-center gap-2">
                <StatusChip visual={IMPROVEMENT_STATUS_VISUAL[i.status]} size="compact" />
                {live(i) ? (
                  <Button size="compact" onClick={() => setUndoing(i)}>
                    Undo
                  </Button>
                ) : null}
              </div>
            </div>
            <span className="text-small text-fg-secondary">{trialText(i)}</span>
            <span className="text-small text-fg-secondary wrap-anywhere">{i.reason}</span>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(undoing)}
        onOpenChange={(open) => !open && setUndoing(null)}
        title="Undo this improvement?"
        description={
          undoing?.kind === 'tool_installed'
            ? 'Later tasks stop counting on it. The program itself stays installed; remove it from Windows Settings → Apps if you do not want it. The Chairman will not make this change again on its own.'
            : undoing?.kind === 'skill_adopted' || undoing?.kind === 'skill_authored'
              ? 'The learned skill is deleted and later tasks no longer load it. The Chairman will not make this change again on its own.'
              : 'Later tasks no longer receive this lesson. The Chairman will not make this change again on its own.'
        }
        confirmLabel="Undo"
        busy={undo.isPending}
        onConfirm={() => {
          if (!undoing) return;
          undo.mutate(undoing.id, {
            onSuccess: () => {
              toast('Improvement undone', 'success');
              setUndoing(null);
            },
            onError: (e) => toast(errorMessage(e), 'info'),
          });
        }}
      />
    </>
  );
}

function FindingRow({ f }: { f: LearningFinding }) {
  const scopeLabel = useScopeLabel();
  const { act, dismiss } = useLearningMutations();
  const { toast } = useFeedback();
  const proposal = proposalText(f.proposal);
  const canAct = Boolean(f.proposal) && ['open', 'needs_you', 'failed'].includes(f.status);
  const canDismiss = ['open', 'needs_you', 'failed'].includes(f.status);
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-body font-semibold text-fg wrap-anywhere">{f.title}</span>
          <span className="text-small text-fg-secondary">
            {FINDING_KIND_LABEL[f.kind]} · {scopeLabel(f.scope, f.repositoryId)} · seen in {f.taskCount} task{f.taskCount === 1 ? '' : 's'} · last <RelativeTime iso={f.lastSeenAt} />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip visual={FINDING_STATUS_VISUAL[f.status]} size="compact" />
          {canAct ? (
            <Button
              size="compact"
              loading={act.isPending && act.variables === f.id}
              onClick={() =>
                act.mutate(f.id, {
                  onSuccess: () => toast('Done — it is now on trial', 'success'),
                  onError: (e) => toast(errorMessage(e), 'info'),
                })
              }
            >
              Do it now
            </Button>
          ) : null}
          {canDismiss ? (
            <Button size="compact" variant="ghost" onClick={() => dismiss.mutate(f.id, { onError: (e) => toast(errorMessage(e), 'info') })}>
              Dismiss
            </Button>
          ) : null}
        </div>
      </div>
      {f.statusReason ? <span className="text-small text-fg wrap-anywhere">{f.statusReason}</span> : null}
      {proposal ? <span className="text-small text-fg-secondary wrap-anywhere">Proposed: {proposal}</span> : null}
      <span className="text-small text-fg-secondary wrap-anywhere">{f.detail}</span>
    </li>
  );
}

function FindingsTab({ data }: { data: LearningOverview }) {
  if (!data.findings.length) {
    return <EmptyState icon={ListChecks} title="Nothing found yet" description="After each finished task the Chairman looks at what slowed it down. What it notices appears here, with how many tasks showed it." />;
  }
  const groups: Array<{ title: string; items: LearningFinding[] }> = [
    { title: 'Needs you', items: data.findings.filter((f) => f.status === 'needs_you') },
    { title: 'Watching', items: data.findings.filter((f) => f.status === 'open') },
    { title: 'Could not act', items: data.findings.filter((f) => f.status === 'failed') },
    { title: 'Acted on', items: data.findings.filter((f) => f.status === 'adopted') },
    { title: 'Dismissed', items: data.findings.filter((f) => f.status === 'dismissed') },
  ].filter((g) => g.items.length);
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.title} className="flex flex-col gap-2" aria-label={g.title}>
          <h2 className="text-h3 text-fg">
            {g.title} <span className="text-small font-normal text-fg-secondary tabular">({g.items.length})</span>
          </h2>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {g.items.map((f) => (
              <FindingRow key={f.id} f={f} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ReviewsTab({ data }: { data: LearningOverview }) {
  type Row = LearningOverview['reviews'][number];
  return (
    <DataTable<Row>
      caption="Task reviews, newest first"
      rows={data.reviews}
      rowKey={(r) => r.taskId}
      empty={<EmptyState icon={ScrollText} title="No tasks reviewed yet" description="Each task is reviewed once it completes. A task that ran without friction is recorded as a clean run and costs nothing." />}
      columns={[
        {
          key: 'task',
          header: 'Task',
          primary: true,
          cell: (r) => (
            <Link to={`/tasks/${encodeURIComponent(r.taskId)}`} className="text-accent underline-offset-2 hover:underline wrap-anywhere">
              {r.taskTitle ?? r.taskId}
            </Link>
          ),
        },
        { key: 'status', header: 'Result', cell: (r) => <StatusChip visual={REVIEW_STATUS_VISUAL[r.status]} size="compact" /> },
        { key: 'by', header: 'Reviewed by', cell: (r) => (r.reviewer === 'model' ? 'Chairman agent' : r.reviewer === 'rules' ? 'Rules' : '—') },
        { key: 'signals', header: 'Signals', align: 'right', cell: (r) => <span className="tabular">{r.signals.length}</span>, sortValue: (r) => r.signals.length },
        { key: 'findings', header: 'Findings', align: 'right', cell: (r) => <span className="tabular">{r.findingIds.length}</span>, sortValue: (r) => r.findingIds.length },
        { key: 'summary', header: 'Summary', hideStacked: true, cell: (r) => <span className="text-small text-fg-secondary wrap-anywhere">{r.error && r.status === 'failed' ? r.error : r.summary}</span> },
        { key: 'when', header: 'When', cell: (r) => <RelativeTime iso={r.finishedAt ?? r.createdAt} />, sortValue: (r) => r.finishedAt ?? r.createdAt },
      ]}
    />
  );
}

function ActivityTab({ data }: { data: LearningOverview }) {
  if (!data.log.length) return <EmptyState icon={ScrollText} title="No activity yet" description="Reviews, findings, changes and undos are logged here." />;
  return (
    <ol className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
      {data.log.map((e) => (
        <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5">
          <span className="min-w-0 text-body text-fg wrap-anywhere">{e.message}</span>
          <RelativeTime iso={e.at} className="text-small text-fg-secondary" />
        </li>
      ))}
    </ol>
  );
}

/** design.md §7.13 — Learning: what the Chairman learned from finished tasks and changed on its own. */
export function LearningPage() {
  useBreadcrumb([{ label: 'Learning' }]);
  const learning = useLearning();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabKey) : 'improvements';
  const data = learning.data;
  return (
    <div className="flex flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader
        title="Learning"
        description="After each finished task the Chairman looks at what slowed it down and improves how later tasks run. Every change is tried on the next tasks and kept only if the problem stops coming back."
        actions={
          <Button icon={RefreshCw} onClick={() => void qc.invalidateQueries({ queryKey: keys.learningRoot })}>
            Refresh
          </Button>
        }
      />
      {learning.isLoading || !data ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          {!data.settings.enabled ? (
            <Banner tone="info" title="Learning is turned off" actions={<Link to="/settings/chairman" className="text-body text-accent underline-offset-2 hover:underline">Open Chairman settings</Link>}>
              Finished tasks are not reviewed. Improvements already made stay in place until you undo them.
            </Banner>
          ) : data.settings.autonomy === 'propose' ? (
            <Banner tone="info" title="The Chairman proposes, you decide">
              Changes wait under Findings → Needs you until you choose Do it now.
            </Banner>
          ) : null}
          {data.settings.enabled && data.reviewerUnavailable ? (
            <Banner tone="info" title="Reviews use the rules only">
              {data.reviewerUnavailable} Missing programs are still found; lessons and skills need the Chairman agent.
            </Banner>
          ) : null}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Live improvements" value={data.counts.improvementsLive} detail="On trial or kept" />
            <StatTile label="Needs you" value={data.counts.needsYou} detail="Findings the Chairman left to you" />
            <StatTile label="Watching" value={data.counts.findingsOpen} detail="Waiting for more evidence" />
            <StatTile label="Tasks reviewed" value={data.counts.reviewed} detail={`${data.counts.actionsToday} of ${data.settings.maxActionsPerDay} changes made today`} />
          </div>
          <Tabs value={tab} onValueChange={(v) => setParams(v === 'improvements' ? {} : { tab: v }, { replace: true })}>
            <TabList label="Learning views" className="overflow-x-auto">
              <Tab value="improvements">Improvements</Tab>
              <Tab value="findings">Findings{data.counts.needsYou ? ` (${data.counts.needsYou} need you)` : ''}</Tab>
              <Tab value="reviews">Reviews</Tab>
              <Tab value="activity">Activity</Tab>
            </TabList>
            <TabPanel value="improvements">{tab === 'improvements' ? <ImprovementsTab data={data} /> : null}</TabPanel>
            <TabPanel value="findings">{tab === 'findings' ? <FindingsTab data={data} /> : null}</TabPanel>
            <TabPanel value="reviews">{tab === 'reviews' ? <ReviewsTab data={data} /> : null}</TabPanel>
            <TabPanel value="activity">{tab === 'activity' ? <ActivityTab data={data} /> : null}</TabPanel>
          </Tabs>
        </>
      )}
    </div>
  );
}

