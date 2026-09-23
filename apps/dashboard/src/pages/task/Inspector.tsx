import { Pause, Pencil, Play, RotateCcw, Shuffle, Square } from 'lucide-react';
import {
  Button,
  KeyValueList,
  Panel,
  PermissionBadge,
  RelativeTime,
  StageStatusChip,
  formatDateTime,
  shortSha,
  useFeedback,
} from '@acc/ui';
import { PERMISSION_LEVEL_INFO, TERMINAL_TASK_STATUSES, type TaskDetail } from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useTaskCommand } from '../../api/hooks';
import { useConnection } from '../../app/runtime';
import { AssignmentText, useAgentNames } from '../../components/agents';
import { DirectiveForm } from './dialogs';

export interface InspectorActions {
  openReroute: () => void;
  openAssignment: (stageKey: string) => void;
  openCancel: () => void;
}

const RESUMABLE = ['PAUSED', 'INTERRUPTED', 'WAITING_FOR_USAGE_RESET', 'WAITING_FOR_USER', 'FAILED'];

/** Right-hand task inspector (design.md §7.3 "Task inspector"). */
export function TaskInspector({ task, actions }: { task: TaskDetail; actions: InspectorActions }) {
  const command = useTaskCommand(task.id);
  const { toast } = useFeedback();
  const connection = useConnection();
  const names = useAgentNames();
  const current = task.stages.find((s) => s.id === task.currentStageId && s.stageKey === task.currentStageKey) ?? null;
  const currentDef = task.workflow.stages.find((s) => s.key === task.currentStageKey);
  const terminal = TERMINAL_TASK_STATUSES.includes(task.status);
  const approvalBlocked = task.blocker?.kind === 'approval';
  const offline = !connection.online;

  const run = (name: 'pause' | 'resume' | 'retry', done: string) =>
    command.mutate({ command: name }, { onSuccess: () => toast(done), onError: (e) => toast(errorMessage(e), 'info') });

  // Future agent stages whose assignment can still change.
  const doneKeys = new Set(task.stages.filter((s) => s.status === 'SUCCESS').map((s) => s.stageKey));
  const upcoming = task.workflow.stages.filter((s) => s.kind === 'agent' && s.key !== task.currentStageKey && !doneKeys.has(s.key));

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Current stage" variant="inspector" headingLevel={3}>
        <KeyValueList
          items={[
            { label: 'Stage', value: task.status === 'COMPLETED' ? 'Complete' : (task.currentStageName ?? '—') },
            { label: 'Status', value: current ? <StageStatusChip status={current.status} size="compact" /> : task.status === 'COMPLETED' ? 'Finished' : 'Not started' },
            { label: 'Permission', value: currentDef ? <PermissionBadge level={currentDef.permissionLevel} /> : '—', hidden: !currentDef },
            { label: 'Started', value: <RelativeTime iso={current?.startedAt} />, hidden: !current?.startedAt },
          ]}
        />
      </Panel>

      <Panel title="Agent, model & effort" variant="inspector" headingLevel={3}>
        <p className="text-body text-fg">
          <AssignmentText assignment={task.currentAssignment} />
        </p>
        {upcoming.length ? (
          <div className="mt-3 flex flex-col gap-1.5 border-t border-border-subtle pt-3">
            <span className="text-small font-semibold text-fg-secondary">Upcoming stages</span>
            <ul className="flex flex-col gap-1">
              {upcoming.map((s) => (
                <li key={s.key} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 text-small text-fg">
                    <span className="font-semibold">{s.name}</span> · <span className="text-fg-secondary">{names(task.assignments[s.key]?.agentId)}</span>
                  </span>
                  <Button size="compact" variant="ghost" icon={Pencil} disabled={terminal || offline} onClick={() => actions.openAssignment(s.key)} aria-label={`Change ${s.name} assignment`}>
                    Change
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>

      <Panel title="Stage controls" variant="inspector" headingLevel={3}>
        <div className="flex flex-wrap gap-2">
          {task.status === 'RUNNING' || task.status === 'QUEUED' ? (
            <Button icon={Pause} disabled={offline} disabledReason="Reconnect first" loading={command.isPending && command.variables?.command === 'pause'} onClick={() => run('pause', 'Pause requested')}>
              Pause
            </Button>
          ) : null}
          {RESUMABLE.includes(task.status) && !approvalBlocked ? (
            <Button icon={Play} disabled={offline} disabledReason="Reconnect first" onClick={() => run('resume', 'Resume requested')}>
              Resume
            </Button>
          ) : null}
          {RESUMABLE.includes(task.status) ? (
            <Button icon={RotateCcw} disabled={offline} disabledReason="Reconnect first" onClick={() => run('retry', 'Retry requested')}>
              Retry stage
            </Button>
          ) : null}
          {!terminal && task.status !== 'DRAFT' ? (
            <Button icon={Shuffle} disabled={offline} disabledReason="Reconnect first" onClick={actions.openReroute}>
              Reroute
            </Button>
          ) : null}
        </div>
        {terminal ? <p className="mt-2 text-small text-fg-secondary">This task is {task.status.toLowerCase()}; its controls are closed.</p> : null}
      </Panel>

      {!terminal ? (
        <Panel title="Add directive" variant="inspector" headingLevel={3}>
          <DirectiveForm task={task} />
        </Panel>
      ) : null}

      <Panel title="Permissions" variant="inspector" headingLevel={3}>
        <p className="text-body text-fg">
          Auto-approves up to <span className="font-semibold">Level {task.autoApproveUpToLevel} · {PERMISSION_LEVEL_INFO[task.autoApproveUpToLevel].name}</span>.
        </p>
        <p className="mt-1 text-small text-fg-secondary">Stages above this level, dangerous commands and production actions wait for your approval.</p>
      </Panel>

      <Panel title="Execution metadata" variant="inspector" headingLevel={3}>
        <KeyValueList
          className="text-small"
          items={[
            { label: 'Task ID', value: <code className="font-mono text-code">{task.id}</code> },
            { label: 'Workflow', value: `${task.workflow.name} v${task.workflow.version}` },
            { label: 'Created', value: formatDateTime(task.createdAt) },
            { label: 'Started', value: formatDateTime(task.startedAt), hidden: !task.startedAt },
            { label: 'Finished', value: formatDateTime(task.finishedAt), hidden: !task.finishedAt },
            { label: 'Branch', value: <code className="font-mono text-code wrap-anywhere">{task.git.taskBranch}</code>, hidden: !task.git.taskBranch },
            { label: 'Baseline', value: <code className="font-mono text-code">{shortSha(task.git.baselineCommit)}</code>, hidden: !task.git.baselineCommit },
            { label: 'Commits', value: task.git.commits.map(shortSha).join(', '), hidden: task.git.commits.length === 0 },
            { label: 'Stage run', value: current ? <code className="font-mono text-code">{current.id.slice(0, 8)}</code> : '—', hidden: !current },
          ]}
        />
      </Panel>

      {!terminal ? (
        <Panel title="Cancel task" variant="danger" headingLevel={3} description="Stops the running stage. The task cannot be resumed afterwards.">
          <Button variant="destructive" icon={Square} disabled={offline} disabledReason="Reconnect first" onClick={actions.openCancel}>
            Cancel task…
          </Button>
        </Panel>
      ) : null}
    </div>
  );
}
