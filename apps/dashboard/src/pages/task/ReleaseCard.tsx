import { CheckCircle2, CircleDashed, ExternalLink, RefreshCw, Rocket, XCircle } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button, KeyValueList, Panel, ReleaseStateChip, RelativeTime, cn, shortSha, useFeedback } from '@acc/ui';
import type { Repository, TaskDetail, TaskRelease } from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useReleaseCommands } from '../../api/hooks';
import { useConnection } from '../../app/runtime';

const IN_FLIGHT: ReadonlyArray<TaskRelease['state']> = ['publishing', 'proving'];

/**
 * Whether the Release button may be offered (RELEASE_STAGE_PLAN §3.6): a
 * completed task of a repository that releases by push, with a commit, not
 * already being released or live on that commit, and not across repositories.
 */
export function canRelease(task: TaskDetail, repo: Repository | undefined): boolean {
  if (task.status !== 'COMPLETED' || repo?.release?.method !== 'push') return false;
  if (!task.git.commits.length || (task.repositories?.length ?? 1) > 1) return false;
  const r = task.git.release;
  if (r && IN_FLIGHT.includes(r.state)) return false;
  return !(r?.state === 'live' && r.commit === task.git.commits.at(-1));
}

/** Header action: asks for the typed Release approval. Nothing is sent from here. */
export function ReleaseButton({ task, repo, compact = false }: { task: TaskDetail; repo: Repository | undefined; compact?: boolean }) {
  const { request } = useReleaseCommands(task.id);
  const connection = useConnection();
  const navigate = useNavigate();
  const { toast } = useFeedback();
  if (!canRelease(task, repo)) return null;
  return (
    <Button
      icon={Rocket}
      size={compact ? 'compact' : 'default'}
      loading={request.isPending}
      disabled={!connection.online}
      disabledReason="Reconnect to the orchestrator first"
      onClick={() =>
        request.mutate(undefined, {
          onSuccess: () => {
            toast('Release approval requested — type the task ID to approve');
            navigate(`/approvals?task=${task.id}`);
          },
          onError: (e) => toast(errorMessage(e), 'info'),
        })
      }
    >
      Release…
    </Button>
  );
}

function Check({ ok, pending, children }: { ok: boolean | null; pending?: boolean; children: React.ReactNode }) {
  const Icon = ok ? CheckCircle2 : pending || ok === null ? CircleDashed : XCircle;
  return (
    <li className="flex items-start gap-2 text-body text-fg">
      <Icon size={16} aria-hidden className={cn('mt-0.5 shrink-0', ok ? 'text-success' : pending || ok === null ? 'text-fg-secondary' : 'text-danger')} />
      <span className="min-w-0 wrap-anywhere">
        <span className="sr-only">{ok ? 'Passed: ' : pending || ok === null ? 'Pending: ' : 'Not passed: '}</span>
        {children}
      </span>
    </li>
  );
}

/**
 * Overview → Release (design.md §7.3): what was sent where, each proof with
 * its evidence, and Check again, which re-reads the proof and never sends.
 */
export function ReleaseCard({ task, repo }: { task: TaskDetail; repo: Repository | undefined }) {
  const release = task.git.release ?? null;
  const { checkAgain } = useReleaseCommands(task.id);
  const connection = useConnection();
  const { toast } = useFeedback();
  const configured = repo?.release?.method === 'push';
  if (!release && !(configured && task.status === 'COMPLETED' && task.git.commits.length)) return null;

  if (!release) {
    return (
      <Panel title="Release" headingLevel={3} actions={<ReleaseButton task={task} repo={repo} compact />}>
        <div className="flex flex-wrap items-center gap-2">
          <ReleaseStateChip state="refused" />
          <span className="text-body text-fg-secondary">Not released. Releasing sends this task's tested commit to your live site; it always asks you first.</span>
        </div>
      </Panel>
    );
  }

  const inFlight = IN_FLIGHT.includes(release.state);
  const e = release.evidence;
  const canCheck = Boolean(release.publishedAt) && !inFlight && release.state !== 'live';
  return (
    <Panel
      title="Release"
      headingLevel={3}
      description={release.via === 'button' ? 'Started with the Release button' : 'Started by the Release stage'}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {canCheck ? (
            <Button
              size="compact"
              icon={RefreshCw}
              loading={checkAgain.isPending}
              disabled={!connection.online}
              disabledReason="Reconnect to the orchestrator first"
              onClick={() => checkAgain.mutate(undefined, { onSuccess: () => toast('Checking again — nothing is sent'), onError: (err) => toast(errorMessage(err), 'info') })}
            >
              Check again
            </Button>
          ) : null}
          <ReleaseButton task={task} repo={repo} compact />
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="release-card">
        <div className="flex flex-wrap items-center gap-2">
          <ReleaseStateChip state={release.state} />
          {release.state === 'live' && release.target.liveUrl ? (
            <a href={release.target.liveUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-body text-fg underline">
              {release.target.liveUrl}
              <ExternalLink size={14} aria-hidden />
            </a>
          ) : null}
        </div>
        {release.reason ? <p className="text-body text-fg-secondary wrap-anywhere">{release.reason}</p> : null}
        <KeyValueList
          items={[
            { label: 'Commit', value: <code className="font-mono text-code">{shortSha(release.commit)}</code> },
            { label: 'Sent to', value: <code className="font-mono text-code">{release.target.remote}/{release.target.branch}</code> },
            { label: 'Requested', value: <RelativeTime iso={release.requestedAt} /> },
            ...(release.publishedAt ? [{ label: 'Sent', value: <RelativeTime iso={release.publishedAt} /> }] : []),
            ...(release.liveConfirmedAt ? [{ label: 'Live since', value: <RelativeTime iso={release.liveConfirmedAt} /> }] : []),
          ]}
        />
        <div className="flex flex-col gap-2">
          <h4 className="text-small font-semibold text-fg-secondary">Proof</h4>
          <ul className="flex flex-col gap-1.5">
            <Check ok={release.tree ? true : release.state === 'refused' ? false : null}>Only the version that passed this task's checks{release.tree ? ` (tree ${shortSha(release.tree)})` : ''}</Check>
            <Check ok={release.publishedAt ? true : release.state === 'refused' || release.state === 'failed' ? false : null} pending={release.state === 'publishing'}>
              {release.publishedAt ? `Sent to ${release.target.remote}/${release.target.branch}` : release.state === 'refused' ? 'Nothing was sent' : `Sending to ${release.target.remote}/${release.target.branch}`}
            </Check>
            {e.cloudflarePages ? (
              <Check ok={e.cloudflarePages.ok} pending={inFlight}>
                Cloudflare Pages {e.cloudflarePages.project}: {e.cloudflarePages.note}
                {e.cloudflarePages.candidate?.url ? (
                  <>
                    {' '}
                    <a href={e.cloudflarePages.candidate.url} target="_blank" rel="noreferrer" className="underline">
                      build
                    </a>
                  </>
                ) : null}
              </Check>
            ) : null}
            {e.versionUrl ? (
              <Check ok={e.versionUrl.ok} pending={inFlight}>
                {e.versionUrl.url}: {e.versionUrl.note}
              </Check>
            ) : null}
            {e.up ? (
              <Check ok={e.up.ok} pending={inFlight}>
                {e.up.url} answers: {e.up.note}
              </Check>
            ) : null}
          </ul>
          {e.checkedAt ? (
            <p className="text-small text-fg-secondary">
              Last checked <RelativeTime iso={e.checkedAt} />. Live is shown only when the host proves it serves this commit.
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
