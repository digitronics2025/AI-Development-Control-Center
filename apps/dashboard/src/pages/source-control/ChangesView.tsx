import { CheckCircle2, ExternalLink, FileCode, FileDiff, Minus, Plus, ShieldAlert, Sparkles, SearchCheck, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Badge,
  Banner,
  Button,
  DiffViewer,
  Disclosure,
  EmptyState,
  Field,
  IconButton,
  RelativeTime,
  SegmentedControl,
  Skeleton,
  StatusChip,
  TaskStatusChip,
  Textarea,
  cn,
  useFeedback,
} from '@acc/ui';
import type { GitOperation, RepositoryChangedPath, SourceControlDiffMode, SourceControlSnapshot } from '@acc/shared';
import { ApiError, errorMessage } from '../../api/client';
import { useGitOperations, useLatestReview, useSourceControlActions, useSourceControlDiff } from '../../api/source-control';
import { useConnection, useRuntime } from '../../app/runtime';
import { Markdown } from '../../components/markdown';
import { MixedConfirmDialog } from './dialogs';
import { ATTRIBUTION_LABEL, OPERATION_LABEL, STATUS_LETTER, STATUS_NAME, splitPath } from './labels';

type Group = 'conflicts' | 'staged' | 'unstaged';

interface Selection {
  path: string;
  mode: SourceControlDiffMode;
}

interface Notice {
  tone: 'success' | 'warning' | 'danger' | 'info';
  title: string;
  body?: string;
  findings?: Array<{ path: string; reason: string }>;
}

const DRAFT_KEY = (repositoryId: string) => `acc.sourceControl.draft.${repositoryId}`;

function readDraft(repositoryId: string): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY(repositoryId)) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(repositoryId: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(DRAFT_KEY(repositoryId), value);
    else window.localStorage.removeItem(DRAFT_KEY(repositoryId));
  } catch {
    /* storage unavailable: the draft simply is not remembered */
  }
}

/** Turn an API failure into a persistent notice (design.md §8.6: failures needing action are never toast-only). */
function failureNotice(title: string, error: unknown): Notice {
  const details = error instanceof ApiError ? (error.details as { findings?: Notice['findings'] } | undefined) : undefined;
  if (error instanceof ApiError && error.code === 'GIT_STATE_CHANGED') {
    return { tone: 'warning', title: 'The repository changed since you looked', body: 'The view has been refreshed. Review what changed, then try again.' };
  }
  return { tone: 'danger', title, body: errorMessage(error), findings: details?.findings };
}

function Stats({ stats }: { stats: RepositoryChangedPath['stagedStats'] }) {
  if (!stats) return null;
  if (stats.additions === null) return <span className="text-small text-fg-secondary">binary</span>;
  return (
    <span className="tabular shrink-0 text-small text-fg-secondary">
      +{stats.additions} −{stats.deletions}
    </span>
  );
}

function FileRow({
  entry,
  group,
  selected,
  checked,
  disabled,
  disabledReason,
  onSelect,
  onCheck,
  onAction,
}: {
  entry: RepositoryChangedPath;
  group: Group;
  selected: boolean;
  checked: boolean;
  disabled: boolean;
  disabledReason?: string;
  onSelect: () => void;
  onCheck: (checked: boolean) => void;
  onAction: () => void;
}) {
  const status = group === 'staged' ? entry.indexStatus : group === 'conflicts' ? 'unmerged' : entry.untracked ? 'untracked' : entry.worktreeStatus;
  const { dir, name } = splitPath(entry.path);
  const stats = group === 'staged' ? entry.stagedStats : entry.unstagedStats;
  return (
    <li className={cn('flex items-start gap-2 rounded-md px-1.5 py-1', selected ? 'bg-accent-muted' : 'hover:bg-elevated')}>
      {group !== 'conflicts' ? (
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onCheck(e.target.checked)}
          aria-label={`Select ${entry.path}`}
          className="mt-2.5 size-4 shrink-0 accent-(--accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:size-5"
        />
      ) : null}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-sm px-1 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="w-3 shrink-0 font-mono text-small font-semibold text-fg-secondary">
            <span aria-hidden>{STATUS_LETTER[status]}</span>
            <span className="sr-only">{STATUS_NAME[status]}</span>
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-code" title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}>
            <span className="text-fg">{name}</span>
            {dir ? <span className="text-fg-secondary"> {dir}</span> : null}
          </span>
          <Stats stats={stats} />
        </span>
        {entry.attribution || entry.sensitive || entry.originalPath ? (
          <span className="flex flex-wrap gap-1 pl-5">
            {entry.originalPath && group === 'staged' ? <Badge>from {entry.originalPath}</Badge> : null}
            {entry.attribution ? <Badge className={cn(entry.attribution === 'both' && 'border-warning', entry.attribution === 'preexisting' && 'border-border-strong')}>{ATTRIBUTION_LABEL[entry.attribution]}</Badge> : null}
            {entry.sensitive ? (
              <Badge className="border-danger text-fg" title={`Looks like ${entry.sensitive}`}>
                <ShieldAlert size={12} className="text-danger" aria-hidden />
                Sensitive
              </Badge>
            ) : null}
          </span>
        ) : null}
      </button>
      {group !== 'conflicts' ? (
        <IconButton
          icon={group === 'staged' ? Minus : Plus}
          label={`${group === 'staged' ? 'Unstage' : 'Stage'} ${entry.path}`}
          size="compact"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          onClick={onAction}
          className="mt-1"
        />
      ) : null}
    </li>
  );
}

function GroupHeader({ id, title, count, actions }: { id: string; title: string; count: number; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1.5 pb-1 pt-2">
      <h3 id={id} className="text-body font-semibold text-fg">
        {title} <span className="tabular font-normal text-fg-secondary">({count})</span>
      </h3>
      {actions ? <div className="flex flex-wrap gap-1.5">{actions}</div> : null}
    </div>
  );
}

function ReviewPanel({ repositoryId, stagedPaths, onOpen }: { repositoryId: string; stagedPaths: string[]; onOpen: (path: string) => void }) {
  const latest = useLatestReview(repositoryId);
  const data = latest.data;
  if (!data?.task) return null;
  const running = ['QUEUED', 'RUNNING'].includes(data.task.status);
  const mentioned = data.review ? stagedPaths.filter((p) => data.review!.includes(p)) : [];
  return (
    <Disclosure
      defaultOpen
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Latest staged review
          <TaskStatusChip size="compact" status={data.task.status} />
          {data.verdict === 'PASS' ? <StatusChip size="compact" visual={{ label: 'Passed', tone: 'success', icon: CheckCircle2 }} /> : null}
          {data.verdict === 'FAIL' ? <StatusChip size="compact" visual={{ label: 'Changes requested', tone: 'warning', icon: XCircle }} /> : null}
        </span>
      }
      description={`${data.task.id} · started ${new Date(data.task.createdAt).toLocaleString()}`}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3 text-body">
          <Link to={`/tasks/${data.task.id}`} className="font-semibold text-fg underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus">
            Open review task
          </Link>
          <span className="text-fg-secondary">To fix findings, start a new task from the review — the review itself never edits files.</span>
        </div>
        {running ? <p className="text-body text-fg-secondary">The reviewer is working. Its findings appear here when it finishes.</p> : null}
        {data.review ? <Markdown>{data.review}</Markdown> : !running ? <p className="text-body text-fg-secondary">No review output was recorded.</p> : null}
        {mentioned.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-small text-fg-secondary">Files mentioned:</span>
            {mentioned.map((p) => (
              <Button key={p} size="compact" variant="ghost" icon={FileDiff} onClick={() => onOpen(p)}>
                {p}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </Disclosure>
  );
}

function OperationsPanel({ repositoryId }: { repositoryId: string }) {
  const [open, setOpen] = useState(false);
  const ops = useGitOperations(repositoryId, open);
  const tone = (o: GitOperation) => (o.status === 'succeeded' ? 'success' : o.status === 'failed' ? 'danger' : 'warning');
  return (
    <Disclosure open={open} onOpenChange={setOpen} title="Recent Git operations" description="The audit trail of actions taken here, including failures and anything recovered after a restart.">
      {ops.isLoading ? (
        <Skeleton className="h-24" />
      ) : ops.data?.length ? (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {ops.data.map((o) => (
            <li key={o.id} className="flex flex-col gap-1 py-2">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-fg">{OPERATION_LABEL[o.kind] ?? o.kind}</span>
                <StatusChip size="compact" visual={{ label: o.status, tone: tone(o), icon: o.status === 'succeeded' ? CheckCircle2 : XCircle }} />
                <RelativeTime iso={o.finishedAt ?? o.startedAt} className="text-small text-fg-secondary" />
                {o.commitSha ? <code className="font-mono text-code text-fg-secondary">{o.commitSha.slice(0, 10)}</code> : null}
              </span>
              {o.message || o.errorSummary ? <span className="whitespace-pre-wrap text-small text-fg-secondary wrap-anywhere">{o.status === 'succeeded' ? o.message : (o.errorSummary ?? o.message)}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body text-fg-secondary">No Git operations yet.</p>
      )}
    </Disclosure>
  );
}

/** design.md §7.9 Changes: file groups, lazy diff, commit composer. */
export function ChangesView({ repositoryId, repositoryPath, snapshot }: { repositoryId: string; repositoryPath: string; snapshot: SourceControlSnapshot }) {
  const actions = useSourceControlActions(repositoryId);
  const connection = useConnection();
  const { host, postToHost } = useRuntime();
  const { toast } = useFeedback();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState(() => readDraft(repositoryId));
  const [notice, setNotice] = useState<Notice | null>(null);
  const [mixed, setMixed] = useState<string[] | null>(null);

  const conflicts = useMemo(() => snapshot.changes.filter((c) => c.conflicted), [snapshot.changes]);
  const staged = useMemo(() => snapshot.changes.filter((c) => c.staged && !c.conflicted), [snapshot.changes]);
  const unstaged = useMemo(() => snapshot.changes.filter((c) => (c.unstaged || c.untracked) && !c.conflicted), [snapshot.changes]);

  // Keep a valid selection: the first staged file, else the first changed file.
  useEffect(() => {
    const valid =
      selection &&
      snapshot.changes.some((c) => c.path === selection.path && (selection.mode === 'staged' ? c.staged : c.unstaged || c.untracked || c.conflicted));
    if (valid) return;
    const first = conflicts[0] ?? unstaged[0];
    setSelection(staged[0] ? { path: staged[0].path, mode: 'staged' } : first ? { path: first.path, mode: 'unstaged' } : null);
  }, [snapshot.changes, selection, staged, unstaged, conflicts]);

  // Drop checks for rows that no longer exist.
  useEffect(() => {
    setChecked((old) => {
      const valid = new Set([...staged.map((c) => `staged:${c.path}`), ...unstaged.map((c) => `unstaged:${c.path}`)]);
      const next = new Set([...old].filter((k) => valid.has(k)));
      return next.size === old.size ? old : next;
    });
  }, [staged, unstaged]);

  useEffect(() => writeDraft(repositoryId, message), [repositoryId, message]);

  const diff = useSourceControlDiff(repositoryId, selection?.path ?? null, selection?.mode ?? 'unstaged', snapshot.version);
  const selectedEntry = snapshot.changes.find((c) => c.path === selection?.path);

  const offline = !connection.online ? 'Reconnect to the orchestrator first' : undefined;
  const blocked = offline ?? snapshot.state.mutationBlockedReason ?? undefined;
  const pending = actions.stage.isPending || actions.unstage.isPending || actions.commit.isPending;
  const checkedIn = (group: 'staged' | 'unstaged') => [...checked].filter((k) => k.startsWith(`${group}:`)).map((k) => k.slice(group.length + 1));
  const toggle = (group: 'staged' | 'unstaged', path: string, on: boolean) =>
    setChecked((old) => {
      const next = new Set(old);
      if (on) next.add(`${group}:${path}`);
      else next.delete(`${group}:${path}`);
      return next;
    });

  const stage = (body: { paths?: string[]; all?: true; confirmMixed?: string[] }) =>
    actions.stage.mutate(
      { expectedVersion: snapshot.version, ...body },
      {
        onSuccess: (r) => {
          setMixed(null);
          setChecked(new Set());
          if (r.skipped?.length) setNotice({ tone: 'warning', title: `${r.skipped.length} file${r.skipped.length === 1 ? ' was' : 's were'} left unstaged`, findings: r.skipped });
          else setNotice(null);
        },
        onError: (e) => {
          if (e instanceof ApiError && e.code === 'MIXED_CHANGES_UNCONFIRMED') {
            setMixed(((e.details as { paths?: string[] } | undefined)?.paths ?? []).slice());
            return;
          }
          setMixed(null);
          setNotice(failureNotice('Staging failed', e));
        },
      },
    );
  const unstage = (body: { paths?: string[]; all?: true }) =>
    actions.unstage.mutate(
      { expectedVersion: snapshot.version, ...body },
      {
        onSuccess: () => {
          setChecked(new Set());
          setNotice(null);
        },
        onError: (e) => setNotice(failureNotice('Unstaging failed', e)),
      },
    );

  const commitReason =
    blocked ?? (snapshot.branch.detached ? 'Check out a branch to commit' : staged.length === 0 ? 'Stage the files to commit first' : !message.trim() ? 'Write a commit message' : undefined);
  const commit = () =>
    actions.commit.mutate(
      { expectedVersion: snapshot.version, message },
      {
        onSuccess: (r) => {
          setMessage('');
          setNotice(null);
          toast(r.operation.message ?? 'Committed');
        },
        onError: (e) => setNotice(failureNotice('The commit did not happen', e)),
      },
    );
  const suggest = () =>
    actions.suggest.mutate(
      { expectedVersion: snapshot.version },
      {
        onSuccess: (s) => setMessage(s.body ? `${s.subject}\n\n${s.body}` : s.subject),
        onError: (e) => setNotice({ tone: 'info', title: 'No message was suggested', body: `${errorMessage(e)} You can still write the message yourself.` }),
      },
    );
  const review = () =>
    actions.review.mutate(
      { expectedVersion: snapshot.version },
      {
        onSuccess: (r) => toast(`Review started as ${r.taskId}`),
        onError: (e) => setNotice(failureNotice('The review could not start', e)),
      },
    );

  const rowProps = (entry: RepositoryChangedPath, group: Group) => ({
    entry,
    group,
    selected: selection?.path === entry.path && (group === 'staged' ? selection.mode === 'staged' : selection.mode === 'unstaged'),
    checked: group !== 'conflicts' && checked.has(`${group}:${entry.path}`),
    disabled: Boolean(blocked) || pending,
    disabledReason: blocked,
    onSelect: () => setSelection({ path: entry.path, mode: group === 'staged' ? 'staged' : 'unstaged' }),
    onCheck: (on: boolean) => group !== 'conflicts' && toggle(group, entry.path, on),
    onAction: () => (group === 'staged' ? unstage({ paths: [entry.path] }) : stage({ paths: [entry.path] })),
  });

  const stageSelected = checkedIn('unstaged');
  const unstageSelected = checkedIn('staged');
  const bothSides = selectedEntry ? selectedEntry.staged && (selectedEntry.unstaged || selectedEntry.untracked) : false;

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <Banner
          tone={notice.tone}
          title={notice.title}
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          actions={
            <Button size="compact" variant="ghost" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          }
        >
          {notice.body ? <span className="block whitespace-pre-wrap">{notice.body}</span> : null}
          {notice.findings?.length ? (
            <ul className="mt-1 flex flex-col gap-0.5">
              {notice.findings.map((f) => (
                <li key={f.path}>
                  <code className="font-mono text-code">{f.path}</code> — {f.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}

      {snapshot.state.clean ? (
        <EmptyState icon={CheckCircle2} title="Nothing to commit" description="The working tree matches HEAD. Changes you or a task make appear here within a few seconds." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(260px,380px)_minmax(0,1fr)]">
          <div className="flex max-h-[70vh] min-w-0 flex-col overflow-y-auto rounded-lg border border-border-subtle bg-surface p-1.5">
            {snapshot.changesTruncated ? <p className="px-1.5 py-1 text-small text-fg-secondary">More changes exist than are listed. Commit or clean up in batches.</p> : null}
            {conflicts.length ? (
              <section aria-labelledby="sc-conflicts">
                <GroupHeader id="sc-conflicts" title="Conflicts" count={conflicts.length} />
                <ul className="flex flex-col" aria-labelledby="sc-conflicts">
                  {conflicts.map((c) => (
                    <FileRow key={`c:${c.path}`} {...rowProps(c, 'conflicts')} />
                  ))}
                </ul>
              </section>
            ) : null}
            <section aria-labelledby="sc-staged">
              <GroupHeader
                id="sc-staged"
                title="Staged"
                count={staged.length}
                actions={
                  staged.length ? (
                    <>
                      {unstageSelected.length ? (
                        <Button size="compact" variant="ghost" disabled={Boolean(blocked) || pending} disabledReason={blocked} onClick={() => unstage({ paths: unstageSelected })}>
                          Unstage selected ({unstageSelected.length})
                        </Button>
                      ) : null}
                      <Button size="compact" variant="ghost" icon={Minus} disabled={Boolean(blocked) || pending} disabledReason={blocked} onClick={() => unstage({ all: true })}>
                        Unstage all
                      </Button>
                    </>
                  ) : null
                }
              />
              {staged.length ? (
                <ul className="flex flex-col" aria-labelledby="sc-staged">
                  {staged.map((c) => (
                    <FileRow key={`s:${c.path}`} {...rowProps(c, 'staged')} />
                  ))}
                </ul>
              ) : (
                <p className="px-1.5 pb-2 text-small text-fg-secondary">Nothing staged yet.</p>
              )}
            </section>
            <section aria-labelledby="sc-unstaged">
              <GroupHeader
                id="sc-unstaged"
                title="Changes"
                count={unstaged.length}
                actions={
                  unstaged.length ? (
                    <>
                      {stageSelected.length ? (
                        <Button size="compact" variant="ghost" disabled={Boolean(blocked) || pending} disabledReason={blocked} onClick={() => stage({ paths: stageSelected })}>
                          Stage selected ({stageSelected.length})
                        </Button>
                      ) : null}
                      <Button size="compact" variant="ghost" icon={Plus} disabled={Boolean(blocked) || pending} disabledReason={blocked} onClick={() => stage({ all: true })}>
                        Stage all
                      </Button>
                    </>
                  ) : null
                }
              />
              {unstaged.length ? (
                <ul className="flex flex-col" aria-labelledby="sc-unstaged">
                  {unstaged.map((c) => (
                    <FileRow key={`u:${c.path}`} {...rowProps(c, 'unstaged')} />
                  ))}
                </ul>
              ) : (
                <p className="px-1.5 pb-2 text-small text-fg-secondary">No unstaged changes.</p>
              )}
            </section>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            {selection ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="min-w-0 truncate font-mono text-code text-fg" title={selection.path}>
                  {selection.path}
                </h3>
                <div className="flex flex-wrap items-center gap-2">
                  {bothSides ? (
                    <SegmentedControl
                      size="compact"
                      label="Diff side"
                      value={selection.mode}
                      onValueChange={(mode) => setSelection({ path: selection.path, mode })}
                      options={[
                        { value: 'staged', label: 'Staged' },
                        { value: 'unstaged', label: 'Unstaged' },
                      ]}
                    />
                  ) : (
                    <span className="text-small text-fg-secondary">{selection.mode === 'staged' ? 'Staged' : selectedEntry?.untracked ? 'Untracked' : 'Unstaged'}</span>
                  )}
                  {host === 'vscode' && postToHost ? (
                    <>
                      {selectedEntry?.worktreeStatus !== 'deleted' ? (
                        <Button size="compact" icon={FileCode} onClick={() => postToHost({ type: 'openFile', repositoryPath, path: selection.path })}>
                          Open file
                        </Button>
                      ) : null}
                      <Button size="compact" icon={ExternalLink} onClick={() => postToHost({ type: 'openSourceControlDiff', repositoryId, path: selection.path, mode: selection.mode })}>
                        Open diff in editor
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
            {selectedEntry?.sensitive ? (
              <Banner tone="warning" title="This file looks like secret material">
                It looks like {selectedEntry.sensitive}. Commits and pushes are blocked while it is staged.
              </Banner>
            ) : null}
            {!selection ? null : diff.isLoading ? (
              <Skeleton className="h-64" />
            ) : diff.error ? (
              <p className="text-body text-fg-secondary">{errorMessage(diff.error)}</p>
            ) : diff.data?.binary ? (
              <p className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-body text-fg-secondary">Binary file — no text diff is shown.</p>
            ) : diff.data ? (
              <DiffViewer diff={diff.data.diff} truncated={diff.data.truncated} />
            ) : null}
          </div>
        </div>
      )}

      <section aria-labelledby="sc-commit" className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-4">
        <h2 id="sc-commit" className="text-h3 text-fg">
          Commit
        </h2>
        <Field
          label="Commit message"
          helper={
            staged.length
              ? `${staged.length} staged file${staged.length === 1 ? '' : 's'} will be committed on ${snapshot.branch.name ?? 'this HEAD'}. Git hooks run as usual.`
              : 'Stage files first; only staged changes are committed.'
          }
        >
          <Textarea className="min-h-24" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Summarise the change in one line" spellCheck />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              icon={Sparkles}
              loading={actions.suggest.isPending}
              disabled={Boolean(offline) || staged.length === 0}
              disabledReason={offline ?? (staged.length === 0 ? 'Stage files first' : undefined)}
              onClick={suggest}
            >
              Suggest message
            </Button>
            <Button icon={SearchCheck} loading={actions.review.isPending} disabled={Boolean(offline) || staged.length === 0} disabledReason={offline ?? (staged.length === 0 ? 'Stage files first' : undefined)} onClick={review}>
              Review staged
            </Button>
          </div>
          <Button variant="primary" loading={actions.commit.isPending} disabled={Boolean(commitReason) || pending} disabledReason={commitReason} onClick={commit}>
            Commit {staged.length || ''} file{staged.length === 1 ? '' : 's'}
          </Button>
        </div>
      </section>

      <ReviewPanel repositoryId={repositoryId} stagedPaths={staged.map((c) => c.path)} onOpen={(path) => setSelection({ path, mode: 'staged' })} />
      <OperationsPanel repositoryId={repositoryId} />

      {mixed ? <MixedConfirmDialog open onOpenChange={(open) => !open && setMixed(null)} paths={mixed} busy={actions.stage.isPending} onConfirm={() => stage({ all: true, confirmMixed: mixed })} /> : null}
    </div>
  );
}
