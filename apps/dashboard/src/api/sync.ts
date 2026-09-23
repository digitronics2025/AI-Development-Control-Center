import type { QueryClient } from '@tanstack/react-query';
import type {
  AgentInfo,
  Approval,
  Artifact,
  ChairmanOverview,
  Directive,
  Execution,
  LogLine,
  Repository,
  ServerMessage,
  StageInstance,
  TaskDetail,
  TaskEvent,
  TestRun,
  WorkflowProfile,
  ToolView,
  TaskProcess,
  TerminalSession,
  McpServerView,
  CredentialView,
} from '@acc/shared';
import type { TaskExecutionView } from './tools';
import { keys } from './keys';

function upsert<T>(list: T[] | undefined, item: T, idOf: (x: T) => string | number): T[] | undefined {
  if (!list) return list;
  const id = idOf(item);
  const index = list.findIndex((x) => idOf(x) === id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

/**
 * Applies orchestrator messages to the query cache without re-mounting
 * anything (design.md §2.7, §9.2). Entity updates are patched in place;
 * list membership (filters, overview) is refreshed in one debounced batch.
 */
export class CacheSync {
  private pendingLists = false;
  private readonly changedTasks = new Set<string>();
  private timer: number | null = null;
  private readonly changedRepositories = new Set<string>();
  private repositoryTimer: number | null = null;

  /** Coalesce bursts of Source Control invalidations into one refetch per repository. */
  private refreshSourceControl(repositoryId: string): void {
    this.changedRepositories.add(repositoryId);
    if (this.repositoryTimer !== null) return;
    this.repositoryTimer = window.setTimeout(() => {
      this.repositoryTimer = null;
      for (const id of this.changedRepositories) {
        void this.qc.invalidateQueries({ queryKey: keys.sourceControl(id) });
        void this.qc.invalidateQueries({ queryKey: keys.sourceControlOperations(id) });
        void this.qc.invalidateQueries({ queryKey: keys.sourceControlReview(id) });
        void this.qc.invalidateQueries({ queryKey: keys.sourceControlHistory(id) });
      }
      this.changedRepositories.clear();
    }, 300);
  }

  constructor(
    private readonly qc: QueryClient,
    private readonly onTaskStatusChange?: (taskId: string, title: string, status: string) => void,
  ) {}

  private scheduleRefresh(taskId?: string): void {
    this.pendingLists = true;
    if (taskId) this.changedTasks.add(taskId);
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.pendingLists) {
        void this.qc.invalidateQueries({ queryKey: keys.tasksRoot });
        void this.qc.invalidateQueries({ queryKey: keys.overview });
      }
      for (const id of this.changedTasks) void this.qc.invalidateQueries({ queryKey: keys.taskChanges(id) });
      this.pendingLists = false;
      this.changedTasks.clear();
    }, 400);
  }

  apply = (message: ServerMessage): void => {
    const qc = this.qc;
    switch (message.type) {
      case 'hello':
        return;
      case 'task': {
        const summary = message.task;
        const before = qc.getQueryData<TaskDetail>(keys.task(summary.id));
        if (before && before.status !== summary.status) this.onTaskStatusChange?.(summary.id, summary.title, summary.status);
        qc.setQueryData<TaskDetail>(keys.task(summary.id), (old) => (old ? { ...old, ...summary } : old));
        this.scheduleRefresh();
        return;
      }
      case 'task.deleted':
        qc.removeQueries({ queryKey: keys.task(message.taskId) });
        this.scheduleRefresh();
        return;
      case 'stage': {
        const stage: StageInstance = message.stage;
        qc.setQueryData<TaskDetail>(keys.task(stage.taskId), (old) =>
          old ? { ...old, stages: upsert(old.stages, stage, (s) => s.id) ?? old.stages } : old,
        );
        if (['SUCCESS', 'FAILED', 'PAUSED', 'CANCELLED'].includes(stage.status)) this.scheduleRefresh(stage.taskId);
        return;
      }
      case 'event': {
        const event: TaskEvent = message.event;
        qc.setQueryData<TaskEvent[]>(keys.taskEvents(event.taskId), (old) => (old && !old.some((e) => e.id === event.id) ? [...old, event] : old));
        if (event.type === 'FILE_CHANGED' || event.type === 'GIT_COMMIT' || event.type === 'GIT_BASELINE') this.scheduleRefresh(event.taskId);
        return;
      }
      case 'execution': {
        const execution: Execution = message.execution;
        qc.setQueryData<Execution[]>(keys.taskExecutions(execution.taskId), (old) => upsert(old, execution, (e) => e.id));
        return;
      }
      case 'logs': {
        qc.setQueryData<LogLine[]>(keys.logs(message.executionId), (old) => {
          if (!old) return old;
          const lastSeq = old.at(-1)?.seq ?? -1;
          const fresh = message.lines.filter((l) => l.seq > lastSeq);
          return fresh.length ? [...old, ...fresh] : old;
        });
        return;
      }
      case 'approval': {
        const approval: Approval = message.approval;
        qc.setQueryData<Approval[]>(keys.approvals('pending'), (old) => {
          if (!old) return old;
          const without = old.filter((a) => a.id !== approval.id);
          return approval.status === 'pending' ? [approval, ...without] : without;
        });
        qc.setQueryData<Approval[]>(keys.approvals('all'), (old) => upsert(old, approval, (a) => a.id));
        qc.setQueryData<Approval[]>(keys.taskApprovals(approval.taskId), (old) => upsert(old, approval, (a) => a.id));
        this.scheduleRefresh();
        return;
      }
      case 'directive': {
        const directive: Directive = message.directive;
        qc.setQueryData<Directive[]>(keys.taskDirectives(directive.taskId), (old) => upsert(old, directive, (d) => d.id));
        return;
      }
      case 'artifact': {
        const artifact: Artifact = message.artifact;
        qc.setQueryData<Artifact[]>(keys.taskArtifacts(artifact.taskId), (old) => upsert(old, artifact, (a) => a.id));
        return;
      }
      case 'testRun': {
        const run: TestRun = message.testRun;
        qc.setQueryData<TestRun[]>(keys.taskTests(run.taskId), (old) => upsert(old, run, (r) => r.id));
        return;
      }
      case 'agents':
        qc.setQueryData<AgentInfo[]>(keys.agents, message.agents);
        this.scheduleRefresh();
        return;
      case 'settings':
        qc.setQueryData(keys.settings, message.settings);
        return;
      case 'repository': {
        const repo: Repository = message.repository;
        qc.setQueryData<Repository[]>(keys.repositories, (old) => upsert(old, repo, (r) => r.id));
        qc.setQueryData(keys.repository(repo.id), repo);
        return;
      }
      case 'repositoryAutomation':
        qc.setQueryData(keys.repositoryAutomation, message.status);
        return;
      case 'repository.deleted':
        qc.setQueryData<Repository[]>(keys.repositories, (old) => old?.filter((r) => r.id !== message.repositoryId));
        return;
      case 'workflow': {
        const wf: WorkflowProfile = message.workflow;
        qc.setQueryData<WorkflowProfile[]>(keys.workflows, (old) => upsert(old, wf, (w) => w.id));
        qc.setQueryData(keys.workflow(wf.id), wf);
        return;
      }
      case 'chairman': {
        const state = message.state;
        qc.setQueryData<ChairmanOverview>(keys.chairman(state.taskId), (old) => (old ? { ...old, state } : old));
        return;
      }
      case 'chairman.message': {
        const m = message.message;
        qc.setQueryData<ChairmanOverview>(keys.chairman(m.taskId), (old) =>
          old ? { ...old, messages: (upsert(old.messages, m, (x) => x.id) ?? old.messages).sort((a, b) => a.seq - b.seq) } : old,
        );
        return;
      }
      case 'chairman.decision': {
        const d = message.decision;
        qc.setQueryData<ChairmanOverview>(keys.chairman(d.taskId), (old) => (old ? { ...old, decisions: upsert(old.decisions, d, (x) => x.id) ?? old.decisions } : old));
        return;
      }
      case 'chairman.action': {
        const a = message.action;
        qc.setQueryData<ChairmanOverview>(keys.chairman(a.taskId), (old) => (old ? { ...old, actions: upsert(old.actions, a, (x) => x.id) ?? old.actions } : old));
        return;
      }
      case 'checkpoint': {
        const c = message.checkpoint;
        qc.setQueryData<ChairmanOverview>(keys.chairman(c.taskId), (old) => (old ? { ...old, checkpoints: upsert(old.checkpoints, c, (x) => x.id) ?? old.checkpoints } : old));
        qc.setQueryData<TaskExecutionView>(keys.taskExecution(c.taskId), (old) => (old ? { ...old, checkpoints: upsert(old.checkpoints, c, (x) => x.id) ?? old.checkpoints } : old));
        return;
      }
      case 'workflow.deleted':
        qc.setQueryData<WorkflowProfile[]>(keys.workflows, (old) => old?.filter((w) => w.id !== message.workflowId));
        return;
      case 'sourceControl':
        this.refreshSourceControl(message.repositoryId);
        return;
      // ----- tool layer ---------------------------------------------------------------
      case 'tool': {
        const tool: ToolView = message.tool;
        qc.setQueryData<ToolView[]>(keys.tools, (old) => upsert(old, tool, (x) => x.id));
        return;
      }
      case 'toolExecution': {
        const e = message.execution;
        if (e.taskId) qc.setQueryData<TaskExecutionView>(keys.taskExecution(e.taskId), (old) => (old ? { ...old, executions: [e, ...old.executions.filter((x) => x.id !== e.id)] } : old));
        return;
      }
      case 'taskProcess': {
        const p: TaskProcess = message.process;
        qc.setQueryData<TaskProcess[]>(keys.processes, (old) => upsert(old, p, (x) => x.id));
        if (p.taskId) qc.setQueryData<TaskExecutionView>(keys.taskExecution(p.taskId), (old) => (old ? { ...old, processes: upsert(old.processes, p, (x) => x.id) ?? old.processes } : old));
        return;
      }
      case 'terminal': {
        const term: TerminalSession = message.terminal;
        qc.setQueryData<TerminalSession[]>(keys.terminals, (old) => upsert(old, term, (x) => x.id));
        return;
      }
      case 'terminal.output':
        return;
      case 'mcpServer': {
        const server: McpServerView = message.server;
        qc.setQueryData<McpServerView[]>(keys.mcpServers, (old) => upsert(old, server, (x) => x.id));
        void qc.invalidateQueries({ queryKey: keys.tools });
        return;
      }
      case 'mcpServer.deleted':
        qc.setQueryData<McpServerView[]>(keys.mcpServers, (old) => old?.filter((x) => x.id !== message.serverId));
        void qc.invalidateQueries({ queryKey: keys.tools });
        return;
      case 'credential': {
        const c: CredentialView = message.credential;
        qc.setQueryData<CredentialView[]>(keys.credentials, (old) => upsert(old, c, (x) => x.id));
        return;
      }
      case 'credential.deleted':
        qc.setQueryData<CredentialView[]>(keys.credentials, (old) => old?.filter((x) => x.id !== message.credentialId));
        return;
      case 'recovery': {
        const a = message.attempt;
        qc.setQueryData<TaskExecutionView>(keys.taskExecution(a.taskId), (old) => (old ? { ...old, recovery: upsert(old.recovery, a, (x) => x.id) ?? old.recovery } : old));
        return;
      }
      case 'escalation': {
        const esc = message.escalation;
        if (esc.taskId) qc.setQueryData<TaskExecutionView>(keys.taskExecution(esc.taskId), (old) => (old ? { ...old, escalations: upsert(old.escalations, esc, (x) => x.id) ?? old.escalations } : old));
        return;
      }
    }
  };
}
