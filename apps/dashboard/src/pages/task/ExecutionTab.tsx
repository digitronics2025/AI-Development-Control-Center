import { History, Plus, Square, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  Panel,
  PermissionBadge,
  RelativeTime,
  Skeleton,
  StatusChip,
  formatDuration,
  useFeedback,
  type Column,
} from '@acc/ui';
import { POLICY_MODE_DESCRIPTION, POLICY_MODE_LABEL, TERMINAL_TASK_STATUSES, type TaskDetail, type ToolExecution } from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useCheckpointMutations, useStopProcess, useTaskExecution } from '../../api/tools';
import { useConnection } from '../../app/runtime';
import { TerminalDrawer } from '../../components/terminal';
import { ESCALATION_VISUAL, LIVE_PROCESS, PROCESS_VISUAL, RECOVERY_VISUAL, REPAIR_LABEL, TOOL_EXECUTION_VISUAL } from '../../components/tools';

const COLUMNS: Column<ToolExecution>[] = [
  { key: 'time', header: 'When', cell: (e) => <RelativeTime iso={e.startedAt} />, sortValue: (e) => e.startedAt, hideStacked: true },
  { key: 'capability', header: 'Capability', primary: true, cell: (e) => <code className="font-mono text-code text-fg wrap-anywhere">{e.capability}</code>, sortValue: (e) => e.capability },
  { key: 'provider', header: 'Tool', cell: (e) => <span className="text-fg-secondary">{e.providerId ?? '—'}</span>, hideStacked: true },
  { key: 'status', header: 'Result', cell: (e) => <StatusChip visual={TOOL_EXECUTION_VISUAL[e.status]} size="compact" /> },
  { key: 'summary', header: 'Summary', cell: (e) => <span className="text-fg wrap-anywhere">{e.summary ?? '—'}{e.durationMs !== null ? <span className="text-fg-secondary"> · {formatDuration(e.durationMs)}</span> : null}</span> },
  { key: 'level', header: 'Level', cell: (e) => <PermissionBadge level={e.permissionLevel} />, hideStacked: true },
];

/**
 * design.md §7.3 "Execution": what the Control Center actually ran for this
 * task — tool calls, background processes, repairs, escalations, checkpoints.
 */
export function ExecutionTab({ task }: { task: TaskDetail }) {
  const view = useTaskExecution(task.id);
  const stop = useStopProcess();
  const checkpoints = useCheckpointMutations(task.id);
  const connection = useConnection();
  const { toast } = useFeedback();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [rollback, setRollback] = useState<{ id: string; seq: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finished = TERMINAL_TASK_STATUSES.includes(task.status);

  if (view.isLoading) return <Skeleton className="h-96" />;
  if (!view.data) return <EmptyState title="Execution details are not available" />;
  const d = view.data;

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Banner tone="danger" role="alert" title="That did not work">
          {error}
        </Banner>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-body">
          <Badge title={POLICY_MODE_DESCRIPTION[d.policyMode]}>Policy: {POLICY_MODE_LABEL[d.policyMode]}</Badge>
          {task.git.isolated ? (
            <span className="min-w-0 text-fg-secondary wrap-anywhere">
              {d.workdir ? (
                <>
                  Isolated worktree <code className="font-mono text-code">{d.workdir}</code>
                </>
              ) : (
                <>Worked in an isolated worktree; the result is on {task.git.taskBranch ?? 'its branch'}</>
              )}
            </span>
          ) : null}
        </div>
        <Button icon={SquareTerminal} onClick={() => setTerminalOpen(true)} disabled={!connection.online || finished} disabledReason={finished ? 'The task has finished' : 'Offline'}>
          Open terminal
        </Button>
      </div>

      <Panel title="Background processes" headingLevel={3} description="Servers and watchers the task started. They are stopped when the task stops." bodyClassName="p-0">
        {d.processes.length ? (
          <ul className="divide-y divide-border-subtle">
            {d.processes.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body font-semibold text-fg">{p.name}</span>
                  <code className="truncate font-mono text-small text-fg-secondary" title={p.command}>
                    {p.command}
                  </code>
                </span>
                {p.url ? <code className="font-mono text-small text-fg-secondary">{p.url}</code> : null}
                <StatusChip visual={PROCESS_VISUAL[p.status]} size="compact" />
                {p.stopReason && !LIVE_PROCESS.includes(p.status) ? <span className="text-small text-fg-secondary">{p.stopReason}</span> : null}
                {LIVE_PROCESS.includes(p.status) ? (
                  <Button size="compact" icon={Square} onClick={() => stop.mutate(p.id, { onSuccess: () => toast(`${p.name} stopped`), onError: (e) => setError(errorMessage(e)) })} disabled={!connection.online}>
                    Stop
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-body text-fg-secondary">No background processes.</p>
        )}
      </Panel>

      {d.recovery.length ? (
        <Panel title="Automatic repairs" headingLevel={3} description="Environment problems fixed before the check ran again. Real test failures are never repaired here." bodyClassName="p-0">
          <ul className="divide-y divide-border-subtle">
            {d.recovery.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-2.5">
                <StatusChip visual={RECOVERY_VISUAL[r.status]} size="compact" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body text-fg">{REPAIR_LABEL[r.strategy] ?? r.strategy}</span>
                  <span className="text-small text-fg-secondary wrap-anywhere">{r.detail}</span>
                  {r.evidence ? <code className="font-mono text-small text-fg-secondary wrap-anywhere">{r.evidence}</code> : null}
                </span>
                <RelativeTime iso={r.createdAt} className="text-small" />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {d.escalations.length ? (
        <Panel title="Capability decisions" headingLevel={3} description="Capabilities enabled outside the stage's profile, and calls the policy refused." bodyClassName="p-0">
          <ul className="divide-y divide-border-subtle">
            {d.escalations.map((e) => (
              <li key={e.id} className="flex flex-wrap items-start gap-3 px-4 py-2.5">
                <StatusChip visual={ESCALATION_VISUAL[e.decision]} size="compact" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <code className="font-mono text-code text-fg">{e.capability}</code>
                  <span className="text-small text-fg-secondary wrap-anywhere">{e.reason}</span>
                </span>
                <PermissionBadge level={e.permissionLevel} />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel
        title="Checkpoints"
        headingLevel={3}
        description="Snapshots of the task's files. Rolling back never touches your own pre-existing work."
        actions={
          <Button size="compact" icon={Plus} onClick={() => setLabelOpen(true)} disabled={!connection.online || finished || !task.git.baselineCommit}>
            Create checkpoint
          </Button>
        }
        bodyClassName="p-0"
      >
        {d.checkpoints.length ? (
          <ul className="divide-y divide-border-subtle">
            {[...d.checkpoints].reverse().map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="tabular text-small font-semibold text-fg-secondary">#{c.seq}</span>
                <span className="min-w-0 flex-1 text-body text-fg wrap-anywhere">{c.label}</span>
                {c.type && c.type !== 'git' ? <Badge>{c.type === 'database' ? 'Database' : 'Deployment'}</Badge> : null}
                <RelativeTime iso={c.createdAt} className="text-small" />
                <Button size="compact" variant="destructive" icon={History} onClick={() => setRollback({ id: c.id, seq: c.seq, label: c.label })} disabled={!connection.online || finished || c.type === 'deployment'}>
                  Roll back
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-body text-fg-secondary">No checkpoints yet. One is taken before every step that changes files on supervised tasks, and before high-impact tool calls.</p>
        )}
      </Panel>

      <Panel title="Tool calls" headingLevel={3} description="Every call the task's agents and stages made through the Control Center, newest first." bodyClassName="p-0">
        <DataTable
          caption="Tool calls"
          columns={COLUMNS}
          rows={d.executions}
          rowKey={(e) => e.id}
          initialSort={{ key: 'time', direction: 'desc' }}
          empty={<p className="px-4 py-3 text-body text-fg-secondary">No tool calls yet.</p>}
        />
      </Panel>

      <TerminalDrawer open={terminalOpen} onOpenChange={setTerminalOpen} taskId={task.id} title={`Terminal · ${task.id}`} />
      <Dialog
        open={labelOpen}
        onOpenChange={setLabelOpen}
        title="Create a checkpoint"
        description="A snapshot of the task's working files you can roll back to."
        footer={
          <>
            <Button variant="ghost" onClick={() => setLabelOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={checkpoints.create.isPending}
              disabled={!label.trim()}
              onClick={() =>
                checkpoints.create.mutate(label.trim(), {
                  onSuccess: () => {
                    toast('Checkpoint created');
                    setLabelOpen(false);
                    setLabel('');
                  },
                  onError: (e) => setError(errorMessage(e)),
                })
              }
            >
              Create checkpoint
            </Button>
          </>
        }
      >
        <Field label="Label">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="e.g. Before trying the new parser" autoFocus />
        </Field>
      </Dialog>
      <ConfirmDialog
        open={rollback !== null}
        onOpenChange={(open) => !open && setRollback(null)}
        title={rollback ? `Roll back to checkpoint ${rollback.seq}?` : 'Roll back?'}
        description={rollback ? `The task's files return to "${rollback.label}". A safety checkpoint is taken first, and files that held your own work before the task started are left untouched.` : ''}
        confirmLabel="Roll back"
        destructive
        busy={checkpoints.restore.isPending}
        onConfirm={() => {
          if (!rollback) return;
          checkpoints.restore.mutate(rollback.id, {
            onSuccess: () => {
              toast(`Rolled back to checkpoint ${rollback.seq}`);
              setRollback(null);
            },
            onError: (e) => setError(errorMessage(e)),
          });
        }}
      />
    </div>
  );
}
