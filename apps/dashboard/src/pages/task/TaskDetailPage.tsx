import { Bot, Copy, FileDiff, FlaskConical, MessageSquarePlus, MoreHorizontal, Pause, Play, RotateCcw, ScrollText, Shuffle, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Banner,
  Button,
  Drawer,
  EmptyState,
  IconButton,
  Menu,
  Skeleton,
  StageTimeline,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TaskStatusChip,
  durationBetween,
  formatDuration,
  formatRelative,
  useBreakpoint,
  useFeedback,
  useNow,
  type Command,
  type TimelineStage,
} from '@acc/ui';
import { MODE_LABEL, TERMINAL_TASK_STATUSES, workflowHappyPath, type TaskDetail } from '@acc/shared';
import { ApiError, errorMessage } from '../../api/client';
import { useTask, useTaskArtifacts, useTaskCommand, useTaskTests } from '../../api/hooks';
import { useBreadcrumb } from '../../app/breadcrumbs';
import { usePageCommands } from '../../app/commands';
import { useConnection } from '../../app/runtime';
import { useAgentNames } from '../../components/agents';
import { TaskPrimaryAction } from '../../components/task-actions';
import { ActivityTab } from './ActivityTab';
import { ArtifactsTab } from './ArtifactsTab';
import { ChangesTab } from './ChangesTab';
import { AssignmentDialog, CancelTaskDialog, DirectiveDialog, RerouteDialog } from './dialogs';
import { TaskInspector } from './Inspector';
import { LogsTab } from './LogsTab';
import { OverviewTab } from './OverviewTab';
import { TestsTab } from './TestsTab';

const TABS = ['overview', 'activity', 'changes', 'tests', 'artifacts', 'logs'] as const;
type TabKey = (typeof TABS)[number];

function buildTimeline(task: TaskDetail, agentName: (id: string | null | undefined) => string): TimelineStage[] {
  const happy = workflowHappyPath(task.workflow);
  const onPath = new Set(happy.map((s) => s.key));
  const latest = new Map(task.stages.map((s) => [s.stageKey, s]));
  const runs = new Map<string, number>();
  for (const s of task.stages) runs.set(s.stageKey, (runs.get(s.stageKey) ?? 0) + 1);
  const ordered = [];
  for (const def of happy) {
    ordered.push(def);
    // Show an off-path fix stage right after the stage that routes to it, once it has run.
    const target = def.onFail ? task.workflow.stages.find((s) => s.key === def.onFail) : null;
    if (target && !onPath.has(target.key) && latest.has(target.key) && !ordered.includes(target)) ordered.push(target);
  }
  return ordered.map((def) => ({
    def,
    instance: latest.get(def.key) ?? null,
    agentName: def.kind === 'agent' ? agentName(latest.get(def.key)?.agentId ?? task.assignments[def.key]?.agentId) : null,
    isCurrent: task.status !== 'COMPLETED' && task.currentStageKey === def.key,
    runs: runs.get(def.key) ?? 0,
  }));
}

function BlockerBanner({ task, onReroute, onDirective }: { task: TaskDetail; onReroute: () => void; onDirective: () => void }) {
  const navigate = useNavigate();
  const blocker = task.blocker;
  if (!blocker) return null;
  const stageDef = task.workflow.stages.find((s) => s.key === (blocker.stageKey ?? task.currentStageKey));
  const agentStage = stageDef?.kind === 'agent';
  const titles: Record<typeof blocker.kind, string> = {
    approval: 'Waiting for your approval',
    usage: 'Paused: usage limit reached',
    auth: 'Blocked: agent authentication',
    fix_limit: 'Fix limit reached',
    error: task.status === 'FAILED' ? `${stageDef?.name ?? 'Stage'} failed` : `${stageDef?.name ?? 'Stage'} is blocked`,
    interrupted: 'Interrupted by a restart',
    tests_missing: 'No verification commands',
    queued: 'Queued',
  };
  const tone = blocker.kind === 'queued' ? 'info' : blocker.kind === 'error' && task.status === 'FAILED' ? 'danger' : 'warning';
  return (
    <Banner
      tone={tone}
      role={blocker.kind === 'queued' ? 'status' : 'alert'}
      title={titles[blocker.kind]}
      actions={
        <>
          {(blocker.kind === 'usage' || blocker.kind === 'error' || blocker.kind === 'auth') && agentStage ? (
            <Button size="compact" icon={Shuffle} onClick={onReroute}>
              Reroute stage
            </Button>
          ) : null}
          {blocker.kind === 'auth' || (blocker.kind === 'error' && blocker.errorClass === 'MODEL_UNAVAILABLE') ? (
            <Button size="compact" icon={Bot} onClick={() => navigate('/agents')}>
              Open Agents
            </Button>
          ) : null}
          {blocker.kind === 'fix_limit' ? (
            <Button size="compact" icon={MessageSquarePlus} onClick={onDirective}>
              Add directive
            </Button>
          ) : null}
        </>
      }
    >
      {blocker.message}
    </Banner>
  );
}

/** design.md §7.3 — the primary product screen. */
export function TaskDetailPage() {
  const { id = '' } = useParams();
  const task = useTask(id);
  const tests = useTaskTests(id);
  const artifacts = useTaskArtifacts(id);
  const [params, setParams] = useSearchParams();
  const tab: TabKey = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabKey) : 'overview';
  const { isWide, isCompactUp, isMobile } = useBreakpoint();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [rerouteOpen, setRerouteOpen] = useState(false);
  const [directiveOpen, setDirectiveOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [assignmentKey, setAssignmentKey] = useState<string | null>(null);
  const agentName = useAgentNames();
  const command = useTaskCommand(id);
  const connection = useConnection();
  const { toast } = useFeedback();
  const data = task.data;
  const now = useNow(1000, data?.status === 'RUNNING');

  useBreadcrumb([{ label: 'Tasks', to: '/tasks' }, { label: data ? `${data.id} ${data.title}` : id }]);

  const setTab = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === 'overview') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };

  const timeline = useMemo(() => (data ? buildTimeline(data, agentName) : []), [data, agentName]);

  const terminal = data ? TERMINAL_TASK_STATUSES.includes(data.status) : true;
  const commands = useMemo<Command[]>(() => {
    if (!data || terminal) return [];
    const list: Command[] = [];
    const group = `${data.id} · current task`;
    if (data.status === 'RUNNING' || data.status === 'QUEUED')
      list.push({ id: 'task-pause', label: 'Pause current task', group, icon: Pause, onSelect: () => command.mutate({ command: 'pause' }, { onSuccess: () => toast('Pause requested') }) });
    if (['PAUSED', 'INTERRUPTED', 'WAITING_FOR_USAGE_RESET'].includes(data.status))
      list.push({ id: 'task-resume', label: 'Resume current task', group, icon: Play, onSelect: () => command.mutate({ command: 'resume' }, { onSuccess: () => toast('Resume requested') }) });
    list.push({ id: 'task-directive', label: 'Add directive', group, icon: MessageSquarePlus, onSelect: () => setDirectiveOpen(true) });
    list.push({ id: 'task-reroute', label: 'Reroute stage…', group, icon: Shuffle, onSelect: () => setRerouteOpen(true) });
    list.push({ id: 'task-logs', label: 'Open logs', group, icon: ScrollText, onSelect: () => setTab('logs') });
    list.push({ id: 'task-diff', label: 'Open Git diff', group, icon: FileDiff, onSelect: () => setTab('changes') });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt when the task's state changes
  }, [data?.id, data?.status, terminal]);
  usePageCommands(commands);

  if (task.isLoading) {
    return (
      <div className="flex flex-col gap-4 px-4 py-5 sm:px-5 md:px-6 xl:px-8" aria-busy="true">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-16" />
        <Skeleton className="h-10" />
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (task.error || !data) {
    const notFound = task.error instanceof ApiError && task.error.status === 404;
    return (
      <div className="px-4 py-5 sm:px-5 md:px-6 xl:px-8">
        <EmptyState title={notFound ? `Task ${id} was not found` : 'The task could not be loaded'} description={notFound ? 'It may belong to another data directory.' : errorMessage(task.error)} />
      </div>
    );
  }

  const elapsed = durationBetween(data.startedAt ?? data.createdAt, data.finishedAt, now);
  const failedTests = (tests.data ?? []).filter((r) => r.status === 'failed').length;
  const inspectorActions = { openReroute: () => setRerouteOpen(true), openAssignment: (key: string) => setAssignmentKey(key), openCancel: () => setCancelOpen(true) };

  const header = (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2 text-small text-fg-secondary">
            <span className="tabular font-mono">{data.id}</span>
            <span aria-hidden>·</span>
            <span>{data.repositoryName}</span>
          </div>
          <h1 className="text-h1 text-fg wrap-anywhere">{data.title}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-small text-fg-secondary">
            <TaskStatusChip status={data.status} />
            {data.finalStatus ? <span className="font-semibold text-fg">{data.finalStatus === 'READY' ? 'Ready' : 'Needs user action'}</span> : null}
            <span>{data.workflowName}</span>
            <span>{MODE_LABEL[data.mode]}</span>
            <span title={new Date(data.createdAt).toLocaleString()}>Created {formatRelative(data.createdAt, now)}</span>
            <span className="tabular">{data.finishedAt ? 'Took' : 'Elapsed'} {formatDuration(elapsed)}</span>
            {data.fixCycles > 0 ? <span className="tabular">Fix cycle {data.fixCycles} of {data.maxFixCycles}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isMobile ? <TaskPrimaryAction task={data} onOpenReport={() => setTab('overview')} /> : null}
          {!isWide ? (
            <Button icon={SlidersHorizontal} onClick={() => setInspectorOpen(true)}>
              Details
            </Button>
          ) : null}
          <Menu
            trigger={<IconButton icon={MoreHorizontal} label="More actions" variant="secondary" />}
            items={[
              { label: 'Add directive', icon: MessageSquarePlus, disabled: terminal || !connection.online, onSelect: () => setDirectiveOpen(true) },
              { label: 'Reroute stage…', icon: Shuffle, disabled: terminal || !connection.online || data.status === 'DRAFT', onSelect: () => setRerouteOpen(true) },
              {
                label: 'Retry stage',
                icon: RotateCcw,
                disabled: !['PAUSED', 'INTERRUPTED', 'WAITING_FOR_USAGE_RESET', 'WAITING_FOR_USER', 'FAILED'].includes(data.status) || !connection.online,
                onSelect: () => command.mutate({ command: 'retry' }, { onSuccess: () => toast('Retry requested'), onError: (e) => toast(errorMessage(e), 'info') }),
              },
              { label: 'Open test output', icon: FlaskConical, onSelect: () => setTab('tests') },
              { label: 'Copy task ID', icon: Copy, separatorBefore: true, onSelect: () => void navigator.clipboard?.writeText(data.id).then(() => toast('Task ID copied')) },
            ]}
          />
        </div>
      </div>
      <BlockerBanner task={data} onReroute={() => setRerouteOpen(true)} onDirective={() => setDirectiveOpen(true)} />
      {data.pauseRequested && data.status === 'RUNNING' ? (
        <Banner tone="info" role="status" title="Pausing">
          The current stage is stopping; it will run again when you resume.
        </Banner>
      ) : null}
    </header>
  );

  return (
    <div className="flex min-w-0 gap-6 px-4 py-5 pb-24 sm:px-5 sm:pb-5 md:px-6 xl:px-8">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        {header}
        <section aria-label="Workflow progress" className="rounded-lg border border-border-subtle bg-surface p-4">
          <StageTimeline stages={timeline} now={now} orientation={isCompactUp ? 'horizontal' : 'vertical'} />
        </section>
        <Tabs value={tab} onValueChange={setTab}>
          <TabList label="Task sections">
            <Tab value="overview">Overview</Tab>
            <Tab value="activity">Activity</Tab>
            <Tab value="changes">Changes</Tab>
            <Tab value="tests" count={failedTests || undefined}>
              Tests
            </Tab>
            <Tab value="artifacts" count={artifacts.data?.length}>
              Artifacts
            </Tab>
            <Tab value="logs">Logs</Tab>
          </TabList>
          <TabPanel value="overview">
            <OverviewTab task={data} onOpenTab={setTab} />
          </TabPanel>
          <TabPanel value="activity">
            <ActivityTab taskId={data.id} />
          </TabPanel>
          <TabPanel value="changes">
            <ChangesTab task={data} />
          </TabPanel>
          <TabPanel value="tests">
            <TestsTab task={data} />
          </TabPanel>
          <TabPanel value="artifacts">
            <ArtifactsTab task={data} />
          </TabPanel>
          <TabPanel value="logs">
            <LogsTab task={data} />
          </TabPanel>
        </Tabs>
      </div>

      {isWide ? (
        <aside aria-label="Task inspector" className="w-(--inspector-width) shrink-0">
          {/* Focusable so keyboard users can scroll a tall inspector (WCAG 2.1.1). */}
          <div tabIndex={0} className="sticky top-18 max-h-[calc(100dvh-88px)] overflow-y-auto rounded-lg pb-4 focus-visible:outline-2 focus-visible:outline-focus">
            <TaskInspector task={data} actions={inspectorActions} />
          </div>
        </aside>
      ) : (
        <Drawer open={inspectorOpen} onOpenChange={setInspectorOpen} title="Task details" description={`${data.id} · ${data.title}`}>
          <TaskInspector
            task={data}
            actions={{
              openReroute: () => {
                setInspectorOpen(false);
                setRerouteOpen(true);
              },
              openAssignment: (key) => {
                setInspectorOpen(false);
                setAssignmentKey(key);
              },
              openCancel: () => {
                setInspectorOpen(false);
                setCancelOpen(true);
              },
            }}
          />
        </Drawer>
      )}

      {isMobile ? (
        <div className="fixed inset-x-0 bottom-0 z-20 flex justify-end gap-2 border-t border-border-subtle bg-canvas px-4 py-3">
          <TaskPrimaryAction task={data} onOpenReport={() => setTab('overview')} />
        </div>
      ) : null}

      <RerouteDialog key={`reroute-${rerouteOpen}`} task={data} open={rerouteOpen} onOpenChange={setRerouteOpen} />
      <DirectiveDialog task={data} open={directiveOpen} onOpenChange={setDirectiveOpen} />
      <AssignmentDialog key={assignmentKey ?? 'none'} task={data} stageKey={assignmentKey} open={assignmentKey !== null} onOpenChange={(open) => !open && setAssignmentKey(null)} />
      <CancelTaskDialog task={data} open={cancelOpen} onOpenChange={setCancelOpen} />
    </div>
  );
}
