import { Bot, ExternalLink, GitCommitHorizontal, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Badge, Button, CommitGraphCell, DiffViewer, Drawer, EmptyState, KeyValueList, RelativeTime, Skeleton, cn, formatDateTime, shortSha, useBreakpoint } from '@acc/ui';
import { layoutGraph, type CommitRef, type HistoryCommit } from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useCommitDetails, useCommitDiff, useSourceControlHistory } from '../../api/source-control';
import { useRuntime } from '../../app/runtime';
import { STATUS_LETTER, STATUS_NAME } from './labels';

/** Rows share one height so graph lanes join from row to row. */
const ROW_HEIGHT = 56;

function RefBadge({ refName }: { refName: CommitRef }) {
  if (refName.kind === 'head') return null;
  return (
    <Badge className={cn(refName.kind === 'branch' && 'border-accent text-fg', refName.kind === 'tag' && 'border-border-strong')}>
      {refName.kind === 'tag' ? <Tag size={12} aria-hidden /> : null}
      <span className="sr-only">{refName.kind === 'tag' ? 'tag ' : refName.kind === 'remote' ? 'remote branch ' : 'branch '}</span>
      {refName.name}
    </Badge>
  );
}

function Attribution({ commit }: { commit: HistoryCommit }) {
  const a = commit.attribution;
  if (!a) return null;
  if (a.kind === 'task') {
    return (
      <Link to={`/tasks/${a.taskId}`} className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-accent px-1.5 text-small font-semibold text-fg hover:bg-elevated focus-visible:outline-2 focus-visible:outline-focus" title={a.taskTitle}>
        <Bot size={12} aria-hidden />
        {a.taskId}
      </Link>
    );
  }
  return <Badge title="Committed from Source Control">Source Control</Badge>;
}

function CommitDrawer({ repositoryId, sha, onClose }: { repositoryId: string; sha: string | null; onClose: () => void }) {
  const details = useCommitDetails(repositoryId, sha);
  const [file, setFile] = useState<string | null>(null);
  const diff = useCommitDiff(repositoryId, sha, file);
  const { host, postToHost } = useRuntime();
  const d = details.data;
  return (
    <Drawer
      open={Boolean(sha)}
      onOpenChange={(open) => {
        if (!open) {
          setFile(null);
          onClose();
        }
      }}
      width={640}
      title={d ? d.subject || '(no subject)' : 'Commit'}
      description={sha ? `Commit ${shortSha(sha)}` : undefined}
    >
      {details.isLoading ? (
        <Skeleton className="h-48" />
      ) : details.error ? (
        <p className="text-body text-fg-secondary">{errorMessage(details.error)}</p>
      ) : d ? (
        <div className="flex flex-col gap-4">
          <KeyValueList
            items={[
              { label: 'Commit', value: <code className="font-mono text-code">{d.sha}</code> },
              { label: 'Author', value: `${d.authorName} <${d.authorEmail}>` },
              { label: 'Authored', value: formatDateTime(d.authoredAt) },
              { label: 'Committer', value: `${d.committerName} <${d.committerEmail}>`, hidden: d.committerEmail === d.authorEmail },
              { label: 'Parents', value: d.parents.length ? d.parents.map((p) => shortSha(p)).join(', ') : 'none (first commit)' },
              { label: 'Made by', value: d.attribution ? (d.attribution.kind === 'task' ? <Link to={`/tasks/${d.attribution.taskId}`} className="underline underline-offset-2">{d.attribution.taskId}</Link> : 'Source Control') : 'Not recorded by the Control Center', hidden: false },
            ]}
          />
          {d.body && d.body !== d.subject ? <pre className="whitespace-pre-wrap rounded-md border border-border-subtle bg-canvas p-3 font-mono text-code text-fg wrap-anywhere">{d.body}</pre> : null}
          <section aria-labelledby="commit-files" className="flex flex-col gap-2">
            <h3 id="commit-files" className="text-h3 text-fg">
              Files ({d.files.length}
              {d.filesTruncated ? '+' : ''})
            </h3>
            <ul className="flex flex-col rounded-lg border border-border-subtle bg-surface p-1">
              {d.files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    aria-current={file === f.path ? 'true' : undefined}
                    onClick={() => setFile(f.path)}
                    className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11', file === f.path ? 'bg-accent-muted' : 'hover:bg-elevated')}
                  >
                    <span className="w-3 shrink-0 font-mono text-small font-semibold text-fg-secondary">
                      <span aria-hidden>{STATUS_LETTER[f.status]}</span>
                      <span className="sr-only">{STATUS_NAME[f.status]}</span>
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-code text-fg" title={f.originalPath ? `${f.originalPath} → ${f.path}` : f.path}>
                      {f.path}
                    </span>
                    <span className="tabular shrink-0 text-small text-fg-secondary">{f.additions === null ? 'binary' : `+${f.additions} −${f.deletions}`}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {file ? (
            <section aria-label={`Diff of ${file}`} className="flex flex-col gap-2">
              {host === 'vscode' && postToHost && sha ? (
                <div>
                  <Button size="compact" icon={ExternalLink} onClick={() => postToHost({ type: 'openCommitDiff', repositoryId, sha, path: file })}>
                    Open diff in editor
                  </Button>
                </div>
              ) : null}
              {diff.isLoading ? <Skeleton className="h-40" /> : diff.data?.binary ? <p className="text-body text-fg-secondary">Binary file — no text diff is shown.</p> : diff.data ? <DiffViewer diff={diff.data.diff} truncated={diff.data.truncated} /> : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

/** design.md §7.9 History: paginated, graph lanes for the loaded pages, details on demand. */
export function HistoryView({ repositoryId, active }: { repositoryId: string; active: boolean }) {
  const history = useSourceControlHistory(repositoryId, active);
  const [open, setOpen] = useState<string | null>(null);
  const { isMobile } = useBreakpoint();
  const commits = useMemo(() => history.data?.pages.flatMap((p) => p.items) ?? [], [history.data]);
  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const columns = useMemo(() => Math.max(1, ...rows.map((r) => r.width)), [rows]);

  if (history.isLoading) return <Skeleton className="h-72" />;
  if (history.error) return <p className="text-body text-fg-secondary">{errorMessage(history.error)}</p>;
  if (!commits.length) return <EmptyState icon={GitCommitHorizontal} title="No commits yet" description="The history appears after the first commit on this branch." />;

  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Commit history" className="flex flex-col rounded-lg border border-border-subtle bg-surface">
        {commits.map((c, i) => (
          <li key={c.sha} style={{ height: ROW_HEIGHT }} className="flex items-stretch border-b border-border-subtle last:border-b-0">
            <CommitGraphCell row={rows[i]!} height={ROW_HEIGHT - 1} maxLanes={isMobile ? 4 : 8} columns={columns} className="ml-2" />
            <button
              type="button"
              onClick={() => setOpen(c.sha)}
              className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-2 text-left hover:bg-elevated focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-body text-fg">{c.subject || '(no subject)'}</span>
                <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
                  {c.refs.slice(0, 4).map((r) => (
                    <RefBadge key={`${r.kind}:${r.name}`} refName={r} />
                  ))}
                  {c.refs.filter((r) => r.kind !== 'head').length > 4 ? <Badge>+{c.refs.length - 4}</Badge> : null}
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-2 text-small text-fg-secondary">
                <code className="shrink-0 font-mono">{shortSha(c.sha)}</code>
                <span className="min-w-0 truncate">{c.authorName}</span>
                <RelativeTime iso={c.authoredAt} className="shrink-0" />
                {c.parents.length > 1 ? <span className="shrink-0">merge</span> : null}
              </span>
            </button>
            {/* A sibling of the row button, not inside it: a link within a button is not reachable on its own (audit F-49). */}
            {c.attribution ? (
              <span className="flex shrink-0 items-center pr-2">
                <Attribution commit={c} />
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      {history.hasNextPage ? (
        <div>
          <Button loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : (
        <p className="text-small text-fg-secondary">End of history.</p>
      )}
      <CommitDrawer repositoryId={repositoryId} sha={open} onClose={() => setOpen(null)} />
    </div>
  );
}
