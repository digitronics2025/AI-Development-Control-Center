import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ClipboardList, Send, Square } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ActivityDot, Button, Combobox, Disclosure, Drawer, Field, SlashTextarea, formatTime } from '@acc/ui';
import type { AskMessage, AskThread, AskThreadDetail } from '@acc/shared';
import { errorMessage } from '../api/client';
import { keys } from '../api/keys';
import { useAskCancel, useAskMessage, useAskThread, useCreateAskThread, useRepositories, useSettings, useUpdateAskThread } from '../api/hooks';
import { useConnection } from '../app/runtime';
import { AssignmentPicker } from './assignment-picker';
import { Markdown } from './markdown';
import { RequestedSkills, useSkillPicker } from './skill-picker';

/**
 * Ask (design.md §7.3.2, docs/systems/ask.md): read-only questions outside
 * tasks. The orchestrator owns every conversation; the only client state is
 * the text being typed and the draft of an answer being written.
 */

const NO_REPOSITORY = '__none__';
const TASK_CONTEXT_CHARS = 3000;

function newClientId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

interface Draft {
  text: string;
  activity: string | null;
}

/** The answer being written, pushed by the orchestrator; never fetched. */
function useAskDraft(messageId: string, enabled: boolean): Draft | undefined {
  const { data } = useQuery<Draft | null>({ queryKey: keys.askDraft(messageId), queryFn: () => null, enabled: false, staleTime: Infinity, gcTime: 60_000 });
  return enabled ? (data ?? undefined) : undefined;
}

/** "Read README.md" rather than the raw tool line. */
function activityLabel(line: string | null): string | null {
  if (!line) return null;
  const tool = /^\[tool\]\s+(.+)$/.exec(line);
  if (tool) return tool[1]!.slice(0, 120);
  return null;
}

/** What New Task receives from a conversation: the first question, the latest answer, and where it came from. */
export function taskDescriptionFrom(detail: AskThreadDetail): string {
  const question = detail.messages.find((m) => m.role === 'user')?.body ?? '';
  const answer = [...detail.messages].reverse().find((m) => m.role === 'assistant' && m.status === 'done')?.body ?? '';
  const clipped = answer.length > TASK_CONTEXT_CHARS ? `${answer.slice(0, TASK_CONTEXT_CHARS)}\n[shortened]` : answer;
  return [question, '', `Context from the Ask conversation "${detail.thread.title}":`, '', clipped].join('\n').trim();
}

export function useTurnIntoTask() {
  const navigate = useNavigate();
  return useCallback((detail: AskThreadDetail) => navigate('/tasks/new', { state: { description: taskDescriptionFrom(detail), repositoryId: detail.thread.repositoryId } }), [navigate]);
}

export function TurnIntoTaskButton({ detail, onDone }: { detail: AskThreadDetail | undefined; onDone?: () => void }) {
  const turn = useTurnIntoTask();
  const answered = detail?.messages.some((m) => m.role === 'assistant' && m.status === 'done') ?? false;
  return (
    <Button
      icon={ClipboardList}
      disabled={!detail || !answered}
      disabledReason="Available once there is an answer"
      onClick={() => {
        if (!detail) return;
        onDone?.();
        turn(detail);
      }}
    >
      Turn into task
    </Button>
  );
}

function MessageItem({ message }: { message: AskMessage }) {
  const running = message.status === 'running';
  const draft = useAskDraft(message.id, running);
  const mine = message.role === 'user';
  const time = (
    <time dateTime={message.createdAt} className="tabular text-small text-fg-secondary">
      {formatTime(message.createdAt)}
    </time>
  );
  if (mine) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <span className="text-small font-semibold text-fg">You</span>
          {time}
          {message.status === 'cancelled' ? <span className="text-small text-fg-secondary">Not asked</span> : null}
        </div>
        <p className="max-w-[90%] whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-body text-fg wrap-anywhere">{message.body}</p>
      </div>
    );
  }
  const text = running ? (draft?.text ?? '') : message.body;
  const activity = running ? activityLabel(draft?.activity ?? null) : null;
  return (
    <div className="flex flex-col gap-1" aria-busy={running || undefined}>
      <div className="flex items-center gap-2">
        <span className="text-small font-semibold text-fg">Answer</span>
        {time}
      </div>
      {text ? <Markdown className="max-w-full">{text}</Markdown> : null}
      {running ? (
        <p className="flex items-center gap-2 text-small text-fg-secondary">
          <ActivityDot /> {activity ? <span className="min-w-0 truncate">{activity}</span> : text ? 'Writing…' : 'Thinking…'}
        </p>
      ) : null}
      {message.status === 'failed' ? <p className="text-small text-danger wrap-anywhere">Not answered: {message.error ?? 'the agent failed.'}</p> : null}
      {message.status === 'cancelled' ? <p className="text-small text-fg-secondary">Stopped</p> : null}
    </div>
  );
}

/**
 * The conversation log. It follows new text only while the reader is at the
 * bottom (design.md §9.3); the scroll container is the nearest scrolling parent.
 */
export function AskLog({ threadId, empty }: { threadId: string | null; empty: ReactNode }) {
  const thread = useAskThread(threadId);
  const qc = useQueryClient();
  const endRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [behind, setBehind] = useState(false);
  const messages = thread.data?.messages ?? [];
  const running = messages.find((m) => m.status === 'running');
  const [tick, setTick] = useState(0);

  // Draft updates change the height without changing the message list.
  useEffect(() => {
    if (!running) return;
    return qc.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey;
      if (key[0] === 'ask' && key[1] === 'draft' && key[2] === running.id) setTick((n) => n + 1);
    });
  }, [qc, running]);

  useEffect(() => {
    const scroller = scrollParent(endRef.current);
    if (!scroller) return;
    const onScroll = () => {
      atBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
      if (atBottom.current) setBehind(false);
    };
    scroller.addEventListener('scroll', onScroll);
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [threadId, thread.isSuccess]);

  useLayoutEffect(() => {
    if (atBottom.current) endRef.current?.scrollIntoView({ block: 'end' });
    else setBehind(true);
  }, [messages.length, running?.status, tick]);

  // A newly opened conversation starts at its latest message.
  useEffect(() => {
    atBottom.current = true;
    setBehind(false);
    const frame = requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end' }));
    return () => cancelAnimationFrame(frame);
  }, [threadId, thread.isSuccess]);

  if (threadId && thread.isError) return <p className="text-body text-danger">This conversation could not be loaded: {errorMessage(thread.error)}</p>;
  return (
    <section aria-label="Ask conversation" role="log" aria-live="polite" className="flex flex-col gap-4">
      {!threadId || (thread.isSuccess && messages.length === 0) ? empty : null}
      {threadId && thread.isLoading ? <p className="text-body text-fg-secondary">Loading the conversation…</p> : null}
      {messages.map((m) => (
        <MessageItem key={m.id} message={m} />
      ))}
      {behind ? (
        <div className="sticky bottom-2 flex justify-center">
          <Button
            size="compact"
            icon={ArrowDown}
            onClick={() => {
              atBottom.current = true;
              setBehind(false);
              endRef.current?.scrollIntoView({ block: 'end' });
            }}
          >
            Jump to latest
          </Button>
        </div>
      ) : null}
      <div ref={endRef} />
    </section>
  );
}

/**
 * Composer: repository, options, the question, Send or Stop. With no
 * conversation yet, the first question creates one.
 */
export function AskComposer({ threadId, onThreadCreated, autoFocus }: { threadId: string | null; onThreadCreated: (thread: AskThread) => void; autoFocus?: boolean }) {
  const thread = useAskThread(threadId);
  const repositories = useRepositories();
  const settings = useSettings();
  const create = useCreateAskThread();
  const update = useUpdateAskThread(threadId ?? '');
  const send = useAskMessage();
  const cancel = useAskCancel();
  const connection = useConnection();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Choices for a conversation that does not exist yet.
  const [newRepositoryId, setNewRepositoryId] = useState<string | null>(null);
  const [newAssignment, setNewAssignment] = useState<{ agentId?: string; model?: string; effort?: string }>({});

  const current = thread.data?.thread;
  const repositoryId = threadId ? (current?.repositoryId ?? null) : newRepositoryId;
  const defaults = settings.data?.ask;
  const assignment = threadId
    ? { agentId: current?.agentId, model: current?.model, effort: current?.effort }
    : { agentId: newAssignment.agentId ?? defaults?.agentId, model: newAssignment.model ?? defaults?.model, effort: newAssignment.effort ?? defaults?.effort };
  const running = thread.data?.messages.some((m) => m.status === 'running' || (m.role === 'user' && m.status === 'pending')) ?? false;
  const picker = useSkillPicker(repositoryId ?? undefined, text);
  const busy = create.isPending || send.isPending;

  const repositoryOptions = useMemo(
    () => [{ value: NO_REPOSITORY, label: 'No repository', description: 'Answer from the Control Center only' }, ...(repositories.data ?? []).map((r) => ({ value: r.id, label: r.name }))],
    [repositories.data],
  );

  const setRepository = (value: string) => {
    const id = value === NO_REPOSITORY ? null : value;
    if (!threadId) return setNewRepositoryId(id);
    update.mutate({ repositoryId: id }, { onError: (e) => setError(errorMessage(e)) });
  };
  const setAssignment = (value: { agentId?: string; model?: string; effort?: string }) => {
    if (!threadId) return setNewAssignment(value);
    if (!value.agentId) return;
    update.mutate({ agentId: value.agentId, model: value.model ?? 'default', effort: value.effort ?? 'default' }, { onError: (e) => setError(errorMessage(e)) });
  };

  const submit = async () => {
    const body = text.trim();
    if (!body) {
      setError('Write a question.');
      return;
    }
    setError(null);
    try {
      let id = threadId;
      if (!id) {
        const chosen = newAssignment.agentId ? { agentId: newAssignment.agentId, model: newAssignment.model ?? 'default', effort: newAssignment.effort ?? 'default' } : {};
        const created = await create.mutateAsync({ repositoryId: newRepositoryId, ...chosen });
        id = created.id;
        onThreadCreated(created);
      }
      await send.mutateAsync({ threadId: id, text: body, clientMessageId: newClientId() });
      setText('');
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !e.defaultPrevented) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Repository">
        <Combobox
          value={repositoryId ?? NO_REPOSITORY}
          onValueChange={setRepository}
          options={repositoryOptions}
          searchPlaceholder="Search repositories…"
          disabled={!connection.online}
        />
      </Field>
      <Disclosure title="Options" description="Agent, model and effort for this conversation">
        <AssignmentPicker label="Ask" value={assignment} onChange={setAssignment} disabled={!connection.online} />
      </Disclosure>
      <Field
        label="Ask a question"
        error={error}
        helper={
          <>
            Read-only: answers never change your files. Enter sends · Shift+Enter adds a line{picker.available ? ' · / for skills' : ''}
            <RequestedSkills names={picker.requested} />
          </>
        }
      >
        <SlashTextarea
          {...picker.textareaProps}
          value={text}
          onValueChange={setText}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          className="min-h-16"
          placeholder="How does…, where is…, why did TASK-0006…"
        />
      </Field>
      <div className="flex justify-end gap-2">
        {running && threadId ? (
          <Button icon={Square} loading={cancel.isPending} onClick={() => cancel.mutate(threadId, { onError: (e) => setError(errorMessage(e)) })}>
            Stop
          </Button>
        ) : null}
        <Button type="submit" variant="primary" icon={Send} loading={busy} disabled={!connection.online} disabledReason="Reconnect to the orchestrator first">
          Send
        </Button>
      </div>
    </form>
  );
}

// ----- the palette's drawer ---------------------------------------------------------------

interface AskLauncher {
  /** Open the Ask drawer; with a question, ask it at once in a new conversation. */
  open: (question?: string) => void;
}

const LauncherCtx = createContext<AskLauncher | null>(null);

/** Null outside local mode: Ask exists only on the machine itself (design.md §3). */
export function useAskLauncher(): AskLauncher | null {
  return useContext(LauncherCtx);
}

export function AskEmptyHint() {
  return (
    <p className="text-body text-fg-secondary">
      Ask about a repository, a task (for example “Why did TASK-0006 stop?”) or how something works. The agent can read, never change; if something needs doing, turn the answer into a task.
    </p>
  );
}

/**
 * The Ask drawer (design.md §7.3.2), opened from the palette. It keeps the
 * conversation it last showed; a question typed as `?question` starts a new one.
 */
export function AskDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateAskThread();
  const send = useAskMessage();
  const navigate = useNavigate();
  const detail = useAskThread(threadId);
  const createRef = useRef(create.mutateAsync);
  const sendRef = useRef(send.mutateAsync);
  createRef.current = create.mutateAsync;
  sendRef.current = send.mutateAsync;

  const launch = useCallback((question?: string) => {
    setOpen(true);
    setError(null);
    if (!question) return;
    setThreadId(null);
    void (async () => {
      try {
        const thread = await createRef.current({});
        setThreadId(thread.id);
        await sendRef.current({ threadId: thread.id, text: question, clientMessageId: newClientId() });
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, []);
  const value = useMemo(() => ({ open: launch }), [launch]);

  return (
    <LauncherCtx.Provider value={value}>
      {children}
      <Drawer
        open={open}
        onOpenChange={setOpen}
        width={460}
        title={detail.data?.thread.title ?? 'Ask'}
        description="Read-only questions. Nothing here changes a task or a file."
        footer={
          <div className="flex w-full flex-col gap-3">
            <AskComposer threadId={threadId} onThreadCreated={(t) => setThreadId(t.id)} autoFocus />
            <div className="flex flex-wrap justify-between gap-2 border-t border-border-subtle pt-3">
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  navigate(threadId ? `/ask?thread=${encodeURIComponent(threadId)}` : '/ask');
                }}
              >
                Open in Ask
              </Button>
              <div className="flex gap-2">
                {threadId ? (
                  <Button variant="ghost" onClick={() => setThreadId(null)}>
                    New question
                  </Button>
                ) : null}
                <TurnIntoTaskButton detail={detail.data} onDone={() => setOpen(false)} />
              </div>
            </div>
          </div>
        }
      >
        {error ? <p className="mb-3 text-body text-danger">{error}</p> : null}
        <AskLog threadId={threadId} empty={<AskEmptyHint />} />
      </Drawer>
    </LauncherCtx.Provider>
  );
}
