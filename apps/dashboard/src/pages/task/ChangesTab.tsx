import { ExternalLink, FileCode, FileDiff, GitBranch } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Banner, Button, DiffViewer, EmptyState, Skeleton, cn, shortSha } from '@acc/ui';
import type { ChangedFile, TaskDetail } from '@acc/shared';
import { useRepositories, useTaskChanges, useTaskDiff } from '../../api/hooks';
import { useRuntime } from '../../app/runtime';

const ORIGIN_LABEL: Record<ChangedFile['origin'], string> = {
  task: 'Task change',
  preexisting: 'Your change (before the task)',
  both: 'Task change on top of your work',
};

const STATUS_LETTER: Record<ChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'A' };

/**
 * Changes tab (design.md §7.3): baseline and task branch, file list with
 * additions/deletions, a lazily-loaded diff per file, and a clear warning
 * when pre-existing work is involved.
 */
export function ChangesTab({ task }: { task: TaskDetail }) {
  const changes = useTaskChanges(task.id);
  const [selected, setSelected] = useState<string | null>(null);
  const diff = useTaskDiff(task.id, selected);
  const { host, postToHost } = useRuntime();
  const repositories = useRepositories();
  const repo = repositories.data?.find((r) => r.id === task.repositoryId);
  const files = useMemo(() => changes.data?.files ?? [], [changes.data]);

  useEffect(() => {
    if (!selected && files.length) setSelected((files.find((f) => f.origin !== 'preexisting') ?? files[0]!).path);
  }, [files, selected]);

  if (changes.isLoading) return <Skeleton className="h-64" />;
  if (!task.git.baselineCommit && !task.git.baselineBranch) {
    return (
      <EmptyState
        icon={GitBranch}
        title="No changes tracked yet"
        description="A Git baseline is recorded before the first stage that can edit files. Investigation and planning never change the repository."
      />
    );
  }
  const data = changes.data!;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-fg-secondary">
        <span className="inline-flex items-center gap-1.5">
          <GitBranch size={16} aria-hidden />
          Baseline <code className="font-mono text-code text-fg">{data.baselineBranch ?? 'detached'}</code> @ <code className="font-mono text-code text-fg">{shortSha(data.baselineCommit)}</code>
        </span>
        <span>
          Task branch <code className="font-mono text-code text-fg">{data.taskBranch ?? 'none — working on the current branch'}</code>
        </span>
        {data.currentBranch && data.taskBranch && data.currentBranch !== data.taskBranch ? (
          <span className="text-fg">Repository is now on {data.currentBranch}</span>
        ) : null}
        <span className="tabular">
          {data.totals.files} file{data.totals.files === 1 ? '' : 's'} · <span className="text-fg">+{data.totals.additions}</span> <span className="text-fg">−{data.totals.deletions}</span>
        </span>
      </div>
      {data.preexistingWarning ? (
        <Banner tone="warning" title="This repository had uncommitted work before the task started">
          Those files are marked “Your change”. The task never overwrites them; files marked “Task change on top of your work” mix both and need your review before committing.
        </Banner>
      ) : null}
      {files.length === 0 ? (
        <EmptyState icon={FileDiff} title="No changes" description="The working tree matches the baseline." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
          <ul aria-label="Changed files" className="flex max-h-[60vh] flex-col overflow-y-auto rounded-lg border border-border-subtle bg-surface p-1">
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  aria-current={selected === file.path ? 'true' : undefined}
                  onClick={() => setSelected(file.path)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11',
                    selected === file.path ? 'bg-accent-muted' : 'hover:bg-elevated',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span aria-label={file.status} className="w-3 shrink-0 font-mono text-small font-semibold text-fg-secondary">
                      {STATUS_LETTER[file.status]}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-code text-fg" title={file.path}>
                      {file.path}
                    </span>
                    <span className="tabular shrink-0 text-small text-fg-secondary">
                      {file.additions !== null ? `+${file.additions}` : ''} {file.deletions !== null ? `−${file.deletions}` : ''}
                    </span>
                  </span>
                  <span className="pl-5">
                    <Badge className={cn(file.origin !== 'task' && 'border-warning')}>{ORIGIN_LABEL[file.origin]}</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-w-0 flex-col gap-2">
            {selected ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="min-w-0 truncate font-mono text-code text-fg">{selected}</h3>
                {host === 'vscode' && postToHost ? (
                  <div className="flex flex-wrap gap-2">
                    {repo && files.find((f) => f.path === selected)?.status !== 'deleted' ? (
                      <Button size="compact" icon={FileCode} onClick={() => postToHost({ type: 'openFile', repositoryPath: repo.path, path: selected })}>
                        Open file
                      </Button>
                    ) : null}
                    <Button size="compact" icon={ExternalLink} onClick={() => postToHost({ type: 'openDiff', taskId: task.id, path: selected })}>
                      Open diff in editor
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {diff.isLoading ? <Skeleton className="h-64" /> : diff.data ? <DiffViewer diff={diff.data.diff} truncated={diff.data.truncated} /> : null}
          </div>
        </div>
      )}
    </div>
  );
}
