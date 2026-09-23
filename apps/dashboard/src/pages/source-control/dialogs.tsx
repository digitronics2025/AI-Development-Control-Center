import { useState } from 'react';
import { Button, Dialog, Field, Select } from '@acc/ui';
import type { SourceControlSnapshot } from '@acc/shared';
import { syncPlan } from './labels';

/** Sync states its plan before anything runs (design.md §7.9). */
export function SyncDialog({
  open,
  onOpenChange,
  snapshot,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: SourceControlSnapshot;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Sync ${snapshot.branch.name ?? ''} with ${snapshot.branch.upstream ?? ''}`}
      description="Based on the last fetch. Sync fetches first and then does only what is safe: it never merges, rebases or force-pushes."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep as is
          </Button>
          <Button variant="primary" loading={busy} onClick={onConfirm}>
            Sync now
          </Button>
        </>
      }
    >
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-body text-fg">
        {syncPlan(snapshot).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </Dialog>
  );
}

export function PublishDialog({
  open,
  onOpenChange,
  snapshot,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: SourceControlSnapshot;
  busy: boolean;
  onConfirm: (remote: string) => void;
}) {
  const [remote, setRemote] = useState(snapshot.remotes.includes('origin') ? 'origin' : (snapshot.remotes[0] ?? ''));
  const branch = snapshot.branch.name ?? '';
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Publish ${branch}`}
      description="Pushes this branch to the remote and sets it as the upstream. Commits are checked for secrets first."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep it local
          </Button>
          <Button variant="primary" loading={busy} disabled={!remote} onClick={() => onConfirm(remote)}>
            Publish to {remote || 'remote'}/{branch}
          </Button>
        </>
      }
    >
      <Field label="Remote">
        <Select value={remote} onValueChange={setRemote} options={snapshot.remotes.map((r) => ({ value: r, label: r }))} />
      </Field>
    </Dialog>
  );
}

/** Stage All never silently includes files that mix the user's work with task changes. */
export function MixedConfirmDialog({
  open,
  onOpenChange,
  paths,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: string[];
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Include files that mix your work with task changes?"
      description="These files held your uncommitted work before a task edited them too. Staging them commits both together."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Leave them unstaged
          </Button>
          <Button variant="primary" loading={busy} onClick={onConfirm}>
            Stage all including these {paths.length}
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-1">
        {paths.map((p) => (
          <li key={p} className="font-mono text-code text-fg wrap-anywhere">
            {p}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
