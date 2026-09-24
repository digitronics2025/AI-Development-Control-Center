import { ExternalLink, FileCode, FileDiff, GitBranch } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Badge, Banner, Button, DiffViewer, EmptyState, Skeleton, cn, shortSha } from '@acc/ui';
import type { ChangedFile, TaskChanges, TaskDetail } from '@acc/shared';
import { useRepositories, useTaskChanges, useTaskDiff } from '../../api/hooks';
import { useRuntime } from '../../app/runtime';

const ORIGIN_LABEL: Record<ChangedFile['origin'], string> = {
  task: 'Task change',
  preexisting: 'Your change (before the task)',
  both: 'Task change on top of your work',
};

const STATUS_LETTER: Record<ChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'A' };

/** One repository's changes; a task across repositories has one group per repository. */
interface Group {
  repositoryId: string;
  name: string | null;
  folder: string | null;
  changes: TaskChanges;
}

interface Selection {
  repositoryId: string;
  path: string;
}

/**
 * Changes tab (design.md §7.3): baseline and task branch, file list with
 * additions/deletions, a lazily-loaded diff per file, and a clear warning
 * when pre-existing work is involved. A task across repositories shows each
 * repository's branch and files under its own heading.
 */
export function ChangesTab({ task }: { task: TaskDetail }) {
  const changes = useTaskChanges(task.id);
  const [selected, setSelected] = useState<Selection | null>(null);
  const multi = (changes.data?.repositories?.length ?? 0) > 1;
  const diff = useTaskDiff(task.id, selected?.path ?? null, multi && selected ? selected.repositoryId : null);
  const { host, postToHost } = useRuntime();
  const repositories = useRepositories();
  const groups = useMemo<Group[]>(() => {
    const data = changes.data;
    if (!data) return [];
    if (data.repositories && data.repositories.length > 1) {
      return data.repositories.map((r) => ({ repositoryId: r.repositoryId ?? task.repositoryId, name: r.repositoryName ?? null, folder: r.folder ?? null, changes: r }));
    }
    return [{ repositoryId: task.repositoryId, name: null, folder: null, changes: data }];
  }, [changes.data, task.repositoryId]);
  const files = useMemo(() => groups.flatMap((g) => g.changes.files.map((file) => ({ file, repositoryId: g.repositoryId }))), [groups]);

  useEffect(() => {
    if (!selected && files.length) {
      const first = files.find((f) => f.file.origin !== 'preexisting') ?? files[0]!;
      setSelected({ repositoryId: first.repositoryId, path: first.file.path });
    }
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
  const isSelected = (repositoryId: string, path: string) => selected?.repositoryId === repositoryId && selected.path === path;
  const selectedFile = selected ? files.find((f) => isSelected(f.repositoryId, f.file.path))?.file : undefined;
  const selectedRepo = repositories.data?.find((r) => r.id === (selected?.repositoryId ?? task.repositoryId));
  const selectedGroup = groups.find((g) => g.repositoryId === selected?.repositoryId);
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.repositoryId} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-fg-secondary">
          {g.name ? (
            <span className="font-semibold text-fg">
              {g.name} <span className="font-mono text-code font-normal text-fg-secondary">{g.folder}/</span>
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            <GitBranch size={16} aria-hidden />
            Baseline <code className="font-mono text-code text-fg">{g.changes.baselineBranch ?? 'detached'}</code> @ <code className="font-mono text-code text-fg">{shortSha(g.changes.baselineCommit)}</code>
          </span>
          <span>
            Task branch <code className="font-mono text-code text-fg">{g.changes.taskBranch ?? 'none — working on the current branch'}</code>
          </span>
          {g.changes.currentBranch && g.changes.taskBranch && g.changes.currentBranch !== g.changes.taskBranch ? (
            <span className="text-fg">Repository is now on {g.changes.currentBranch}</span>
          ) : null}
          <span className="tabular">
            {g.changes.totals.files} file{g.changes.totals.files === 1 ? '' : 's'} · <span className="text-fg">+{g.changes.totals.additions}</span> <span className="text-fg">−{g.changes.totals.deletions}</span>
          </span>
        </div>
      ))}
      {groups.some((g) => g.changes.preexistingWarning) ? (
        <Banner tone="warning" title="This repository had uncommitted work before the task started">
          Those files are marked “Your change”. The task never overwrites them; files marked “Task change on top of your work” mix both and need your review before committing.
        </Banner>
      ) : null}
      {files.length === 0 ? (
        <EmptyState icon={FileDiff} title="No changes" description={multi ? 'Every repository matches its baseline.' : 'The working tree matches the baseline.'} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
          <ul aria-label="Changed files" className="flex max-h-[60vh] flex-col overflow-y-auto rounded-lg border border-border-subtle bg-surface p-1">
            {groups.map((g) => (
              <Fragment key={g.repositoryId}>
                {g.name && g.changes.files.length ? (
                  <li className="px-2.5 pb-1 pt-2 text-small font-semibold text-fg-secondary">
                    {g.name}
                  </li>
                ) : null}
                {g.changes.files.map((file) => (
                  <li key={`${g.repositoryId}:${file.path}`}>
                    <button
                      type="button"
                      aria-current={isSelected(g.repositoryId, file.path) ? 'true' : undefined}
                      onClick={() => setSelected({ repositoryId: g.repositoryId, path: file.path })}
                      className={cn(
                        'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11',
                        isSelected(g.repositoryId, file.path) ? 'bg-accent-muted' : 'hover:bg-elevated',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span aria-label={file.status} className="w-3 shrink-0 font-mono text-small font-semibold text-fg-secondary">
                          {STATUS_LETTER[file.status]}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-code text-fg" title={g.folder ? `${g.folder}/${file.path}` : file.path}>
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
              </Fragment>
            ))}
          </ul>
          <div className="flex min-w-0 flex-col gap-2">
            {selected ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="min-w-0 truncate font-mono text-code text-fg">{selectedGroup?.folder ? `${selectedGroup.folder}/${selected.path}` : selected.path}</h3>
                {host === 'vscode' && postToHost ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedRepo && selectedFile?.status !== 'deleted' ? (
                      <Button size="compact" icon={FileCode} onClick={() => postToHost({ type: 'openFile', repositoryPath: selectedRepo.path, path: selected.path })}>
                        Open file
                      </Button>
                    ) : null}
                    <Button
                      size="compact"
                      icon={ExternalLink}
                      onClick={() => postToHost({ type: 'openDiff', taskId: task.id, path: selected.path, ...(multi ? { repositoryId: selected.repositoryId } : {}) })}
                    >
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
