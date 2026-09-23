import { Gavel, Send, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ActivityDot,
  Badge,
  Banner,
  Button,
  CHAIRMAN_ACTION_STATUS_VISUAL,
  CHAIRMAN_HEALTH_VISUAL,
  CHAIRMAN_STATUS_VISUAL,
  Drawer,
  Field,
  IconButton,
  Skeleton,
  StatusChip,
  Textarea,
  cn,
  formatTime,
  useFeedback,
} from '@acc/ui';
import {
  CHAIRMAN_ACTION_LABEL,
  TERMINAL_TASK_STATUSES,
  type ChairmanAction,
  type ChairmanDecision,
  type ChairmanMessage,
  type ChairmanOverview,
  type Directive,
  type TaskDetail,
} from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useChairman, useChairmanAction, useChairmanMessage, useTaskDirectives } from '../../api/hooks';
import { useConnection } from '../../app/runtime';
import { Markdown } from '../../components/markdown';

const TRIGGER_TITLE: Record<string, string> = {
  strategy_exhausted: 'Fix attempts exhausted',
  repeated_failure: 'Same failure repeating',
  regression: 'Regression',
  verify_repeat: 'Verification rejected again',
  plan_mismatch: 'Work misses the request',
  no_fail_route: 'No repair route',
  worker_failure: 'Agent kept failing',
  provider_blocked: 'Agent unavailable',
  completion_gate: 'Completion check',
  limit: 'Limit reached',
  restart: 'Restart',
  watchdog: 'Watchdog',
};

const SHORTCUTS = '/status /blockers /directives /retest /replan /pause /resume /rollback';

function newClientId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY)) return node;
  }
  return null;
}

/** Header button: the Chairman's state is visible without opening the drawer (design.md §7.3.1). */
export function ChairmanButton({ overview, onOpen, compact }: { overview: ChairmanOverview | undefined; onOpen: () => void; compact?: boolean }) {
  const state = overview?.state;
  const pending = overview?.messages.some((m) => m.role === 'user' && m.status === 'pending');
  const label = state ? CHAIRMAN_STATUS_VISUAL[state.status].label : 'Loading';
  return (
    <Button icon={Gavel} onClick={onOpen} aria-label={`Chairman — ${label}`} className="gap-2">
      {compact ? null : 'Chairman'}
      {state?.status === 'evaluating' || pending ? (
        <ActivityDot />
      ) : state ? (
        <span aria-hidden className={cn('size-2 rounded-full', state.status === 'degraded' ? 'bg-warning' : state.status === 'off' || state.status === 'idle' ? 'bg-border-strong' : 'bg-accent')} />
      ) : null}
    </Button>
  );
}

function DecisionCard({ message, decision }: { message: ChairmanMessage; decision: ChairmanDecision | undefined }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border-subtle border-l-2 border-l-accent bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-small font-semibold text-fg">Decision</span>
        {decision ? <span className="text-small text-fg-secondary">{TRIGGER_TITLE[decision.trigger] ?? decision.trigger}</span> : null}
        {decision ? <Badge title={decision.reasoner === 'model' ? 'Chosen by the reasoning model among safe options' : 'Chosen by the deterministic rules'}>{decision.reasoner === 'model' ? 'Model' : 'Rules'}</Badge> : null}
        {decision?.hardBlocker ? <Badge>Needs you</Badge> : null}
      </div>
      <p className="text-body text-fg wrap-anywhere">{message.body}</p>
      {decision?.reasoningSummary ? <p className="text-small text-fg-secondary wrap-anywhere">Why: {decision.reasoningSummary}</p> : null}
      {decision?.expectedResult ? <p className="text-small text-fg-secondary wrap-anywhere">Expected: {decision.expectedResult}</p> : null}
    </div>
  );
}

function ActionCard({ action, fallback }: { action: ChairmanAction | undefined; fallback: string }) {
  if (!action) return <p className="text-small text-fg-secondary wrap-anywhere">{fallback}</p>;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-small font-semibold text-fg">{CHAIRMAN_ACTION_LABEL[action.type] ?? action.type}</span>
        <StatusChip size="compact" visual={CHAIRMAN_ACTION_STATUS_VISUAL[action.status]} />
      </div>
      <p className="text-small text-fg-secondary wrap-anywhere">{action.status === 'completed' ? action.result : action.reason}</p>
    </div>
  );
}

function MessageItem({ message, overview }: { message: ChairmanMessage; overview: ChairmanOverview }) {
  const time = (
    <time dateTime={message.createdAt} className="tabular text-small text-fg-secondary">
      {formatTime(message.createdAt)}
    </time>
  );
  if (message.kind === 'decision') {
    return <DecisionCard message={message} decision={overview.decisions.find((d) => d.id === message.decisionId)} />;
  }
  if (message.kind === 'action') {
    return <ActionCard action={overview.actions.find((a) => a.id === message.actionId)} fallback={message.body} />;
  }
  const mine = message.role === 'user';
  return (
    <div className={cn('flex flex-col gap-1', mine && 'items-end')}>
      <div className="flex items-center gap-2">
        <span className="text-small font-semibold text-fg">{mine ? 'You' : 'Chairman'}</span>
        {time}
        {mine && message.status === 'failed' ? <span className="text-small text-danger">Not handled</span> : null}
      </div>
      {mine ? (
        <p className="max-w-[90%] whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-body text-fg wrap-anywhere">{message.body}</p>
      ) : (
        <Markdown className="max-w-full">{message.body}</Markdown>
      )}
    </div>
  );
}

function Directives({ taskId, directives, terminal }: { taskId: string; directives: Directive[]; terminal: boolean }) {
  const action = useChairmanAction(taskId);
  const connection = useConnection();
  const { toast } = useFeedback();
  if (!directives.length) return null;
  return (
    <section aria-labelledby="chairman-directives" className="flex flex-col gap-2">
      <h3 id="chairman-directives" className="text-small font-semibold text-fg-secondary">
        Active directives ({directives.length})
      </h3>
      <ul className="flex flex-col gap-1.5">
        {directives.map((d) => (
          <li key={d.id} className="flex items-start gap-2 rounded-md border border-border-subtle px-2.5 py-1.5">
            <span className="min-w-0 flex-1 text-small text-fg wrap-anywhere">
              {d.text}
              <span className="block text-fg-secondary">
                {d.kind === 'constraint' ? 'Constraint' : d.kind === 'requirement' ? 'Completion requirement' : d.kind === 'routing' ? 'Routing' : 'Instruction'} · {d.scope === 'CURRENT_TASK' ? 'whole task' : 'next stage only'} · {d.status}
              </span>
            </span>
            {!terminal ? (
              <IconButton
                icon={X}
                size="compact"
                label={`Remove directive: ${d.text.slice(0, 60)}`}
                disabled={!connection.online}
                onClick={() =>
                  action.mutate(
                    { action: { type: 'REMOVE_DIRECTIVE', params: { directiveId: d.id } }, idempotencyKey: `remove-directive-${d.id}` },
                    { onSuccess: () => toast('Directive removed'), onError: (e) => toast(errorMessage(e), 'info') },
                  )
                }
              />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Chairman chat (design.md §7.3.1, docs/systems/chairman.md): one drawer per
 * task. Everything shown comes from the orchestrator; messages are sent with
 * a client id so a retry never runs a command twice.
 */
export function ChairmanDrawer({ task, overview, open, onOpenChange }: { task: TaskDetail; overview: ReturnType<typeof useChairman>; open: boolean; onOpenChange: (open: boolean) => void }) {
  const send = useChairmanMessage(task.id);
  const directives = useTaskDirectives(task.id);
  const connection = useConnection();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const data = overview.data;
  const state = data?.state;
  const terminal = TERMINAL_TASK_STATUSES.includes(task.status);
  const pending = data?.messages.some((m) => m.role === 'user' && m.status === 'pending') ?? false;
  const count = data?.messages.length ?? 0;
  const loaded = data !== undefined;

  // Follow new messages only while the reader is at the bottom (design.md §9.3).
  useEffect(() => {
    if (!open) return;
    const scroller = scrollParent(endRef.current);
    if (!scroller) return;
    const onScroll = () => (atBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32);
    scroller.addEventListener('scroll', onScroll);
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [open, loaded]);
  useLayoutEffect(() => {
    if (open && atBottom.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [open, count, pending]);
  // Opening shows the latest message: once the drawer has laid out, and again after its slide-in.
  useEffect(() => {
    if (!open || !loaded) return;
    atBottom.current = true;
    const toEnd = () => endRef.current?.scrollIntoView({ block: 'end' });
    const frame = requestAnimationFrame(toEnd);
    const settle = window.setTimeout(() => atBottom.current && toEnd(), 260);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [open, loaded]);

  const submit = () => {
    const body = text.trim();
    if (!body) {
      setError('Write a question or an instruction.');
      return;
    }
    atBottom.current = true;
    send.mutate(
      { text: body, clientMessageId: newClientId() },
      {
        onSuccess: () => {
          setText('');
          setError(null);
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const stageName = task.status === 'COMPLETED' ? 'Complete' : (task.currentStageName ?? 'Not started');
  const active = (directives.data ?? []).filter((d) => d.state === 'active');

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      width={460}
      title="Chairman"
      description={`${task.id} · Stage: ${stageName}`}
      footer={
        <form
          className="flex w-full flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="Message the Chairman" error={error} helper={`Enter sends · Shift+Enter adds a line · ${SHORTCUTS}`}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} className="min-h-16" placeholder="Ask what is happening, or tell it what to do." />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" icon={Send} loading={send.isPending} disabled={!connection.online} disabledReason="Reconnect to the orchestrator first">
              Send
            </Button>
          </div>
        </form>
      }
    >
      {!data ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-24" />
          <Skeleton className="h-16" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip visual={CHAIRMAN_STATUS_VISUAL[data.state.status]} />
              {data.state.supervised ? <StatusChip visual={{ ...CHAIRMAN_HEALTH_VISUAL[data.state.health], label: `Health: ${CHAIRMAN_HEALTH_VISUAL[data.state.health].label}` }} /> : null}
            </div>
            <p className="text-small text-fg-secondary">
              {data.state.supervised ? (
                <>
                  Recovery cycle <span className="tabular text-fg">{data.state.recoveryCycle}</span>
                  {data.state.limits ? <> of {data.state.limits.maxRecoveryCycles}</> : null} · Agent runs <span className="tabular text-fg">{data.state.usage.agentRuns}</span>
                  {data.state.limits ? <> of {data.state.limits.maxAgentRuns}</> : null} · Work <span className="tabular text-fg">{Math.round(data.state.usage.workMs / 60_000)} min</span>
                  {data.state.limits ? <> of {data.state.limits.maxRuntimeMinutes}</> : null}
                </>
              ) : (
                'This task is not supervised: it runs its workflow as configured. You can still ask questions and give instructions here.'
              )}
            </p>
            {state?.supervised && state.degradedReason ? (
              <Banner tone="info" role="status" title="Working from rules only">
                {state.degradedReason}
              </Banner>
            ) : null}
            {state?.strategySummary && !terminal ? (
              <div className="rounded-md border border-border-subtle px-3 py-2">
                <span className="text-small font-semibold text-fg-secondary">Current strategy</span>
                <p className="line-clamp-4 text-small text-fg wrap-anywhere">{state.strategySummary}</p>
              </div>
            ) : null}
          </div>

          <Directives taskId={task.id} directives={active} terminal={terminal} />

          <section aria-label="Chairman conversation" role="log" aria-live="polite" className="flex flex-col gap-3 border-t border-border-subtle pt-3">
            {data.messages.length === 0 ? (
              <p className="text-body text-fg-secondary">
                Ask what is happening or why a stage failed, or give an instruction — for example “Do not modify the database schema” or “Re-investigate the root cause”. Questions never change the task.
              </p>
            ) : (
              data.messages.map((m) => <MessageItem key={m.id} message={m} overview={data} />)
            )}
            {pending ? (
              <p className="flex items-center gap-2 text-small text-fg-secondary">
                <ActivityDot /> The Chairman is working on your message…
              </p>
            ) : null}
            <div ref={endRef} />
          </section>
        </div>
      )}
    </Drawer>
  );
}
