import { ArrowLeft, MessageCircleQuestion, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, ConfirmDialog, Dialog, EmptyState, Field, IconButton, Input, Menu, PageHeader, RelativeTime, Skeleton, cn, useBreakpoint } from '@acc/ui';
import type { AskThread } from '@acc/shared';
import { errorMessage } from '../api/client';
import { useAskThread, useAskThreads, useDeleteAskThread, useUpdateAskThread } from '../api/hooks';
import { useBreadcrumb } from '../app/breadcrumbs';
import { AskComposer, AskEmptyHint, AskLog, TurnIntoTaskButton } from '../components/ask';

/** Ask (design.md §7.3.2): read-only conversations outside tasks. */
export function AskPage() {
  useBreadcrumb([{ label: 'Ask' }]);
  const [params, setParams] = useSearchParams();
  const selected = params.get('thread');
  // A new question: the composer is open with no conversation yet.
  const [composing, setComposing] = useState(false);
  const threads = useAskThreads();
  const { isCompactUp } = useBreakpoint();
  const select = (id: string | null) => {
    setComposing(false);
    setParams(id ? { thread: id } : {}, { replace: false });
  };
  const startNew = () => {
    setParams({}, { replace: false });
    setComposing(true);
  };
  const list = threads.data ?? [];
  const showingConversation = Boolean(selected) || composing;
  const empty = threads.isSuccess && list.length === 0 && !showingConversation;

  return (
    <div className="flex flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader
        title="Ask"
        description="Questions to an agent that can read, never change. Nothing here starts a task."
        actions={
          <Button variant="primary" icon={Plus} onClick={startNew}>
            New question
          </Button>
        }
      />
      {empty ? (
        <EmptyState
          icon={MessageCircleQuestion}
          title="No questions yet"
          description="Ask about a repository, a task or how something works. Ctrl+K and ? asks from anywhere."
          action={
            <Button variant="primary" icon={Plus} onClick={startNew}>
              New question
            </Button>
          }
        />
      ) : (
        <div className="grid min-h-0 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          {isCompactUp || !showingConversation ? (
            <nav aria-label="Conversations" className="flex min-h-0 flex-col gap-1 lg:max-h-[calc(100dvh-var(--topbar-height)-150px)] lg:overflow-y-auto" tabIndex={list.length ? 0 : undefined}>
              {threads.isLoading ? (
                <>
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                </>
              ) : null}
              {threads.isError ? <p className="text-body text-danger">Conversations could not be loaded: {errorMessage(threads.error)}</p> : null}
              {list.map((t) => (
                <ThreadRow key={t.id} thread={t} active={t.id === selected} onSelect={() => select(t.id)} />
              ))}
            </nav>
          ) : null}
          {showingConversation ? (
            <Conversation
              key={selected ?? 'new'}
              threadId={selected}
              onBack={isCompactUp ? undefined : () => select(null)}
              onCreated={(id) => select(id)}
              onDeleted={() => select(null)}
            />
          ) : isCompactUp ? (
            <div className="rounded-lg border border-border-subtle p-6">
              <AskEmptyHint />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ThreadRow({ thread, active, onSelect }: { thread: AskThread; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11',
        active ? 'bg-accent-muted text-fg' : 'text-fg hover:bg-elevated',
      )}
    >
      <span className="truncate text-body font-semibold">{thread.title}</span>
      <RelativeTime iso={thread.updatedAt} className="text-small text-fg-secondary" />
    </button>
  );
}

function Conversation({ threadId, onBack, onCreated, onDeleted }: { threadId: string | null; onBack?: () => void; onCreated: (id: string) => void; onDeleted: () => void }) {
  const detail = useAskThread(threadId);
  const remove = useDeleteAskThread();
  const update = useUpdateAskThread(threadId ?? '');
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const title = detail.data?.thread.title ?? 'New question';

  useEffect(() => {
    if (renaming) setName(title);
  }, [renaming, title]);

  return (
    <section aria-label={title} className="flex min-h-0 flex-col rounded-lg border border-border-subtle bg-surface lg:h-[calc(100dvh-var(--topbar-height)-150px)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-3">
        {onBack ? <IconButton icon={ArrowLeft} label="Back to conversations" onClick={onBack} /> : null}
        <h2 className="min-w-0 flex-1 truncate text-h3 font-semibold text-fg">{title}</h2>
        <TurnIntoTaskButton detail={detail.data} />
        {threadId ? (
          <Menu
            trigger={<IconButton icon={MoreHorizontal} label="Conversation actions" />}
            items={[
              { label: 'Rename', icon: Pencil, onSelect: () => setRenaming(true) },
              { label: 'Delete', icon: Trash2, destructive: true, separatorBefore: true, onSelect: () => setConfirming(true) },
            ]}
          />
        ) : null}
      </header>
      {actionError ? (
        <p role="alert" className="border-b border-border-subtle px-4 py-2 text-small text-danger">
          {actionError}
        </p>
      ) : null}
      <div tabIndex={0} className="min-h-[240px] flex-1 overflow-y-auto px-4 py-4 focus-visible:outline-2 focus-visible:outline-focus">
        <AskLog threadId={threadId} empty={<AskEmptyHint />} />
      </div>
      <div className="border-t border-border-subtle px-4 py-3">
        <AskComposer threadId={threadId} onThreadCreated={(t) => onCreated(t.id)} autoFocus={!threadId} />
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this conversation?"
        description="The questions and answers are removed. Tasks made from it are not affected."
        confirmLabel="Delete"
        destructive
        busy={remove.isPending}
        onConfirm={async () => {
          if (!threadId) return;
          try {
            setActionError(null);
            await remove.mutateAsync(threadId);
            setConfirming(false);
            onDeleted();
          } catch (e) {
            setConfirming(false);
            setActionError(`Not deleted: ${errorMessage(e)}`);
          }
        }}
      />
      <Dialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename conversation"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={update.isPending}
              onClick={() =>
                update.mutate(
                  { title: name.trim() },
                  { onSuccess: () => setRenaming(false), onError: (e) => setActionError(`Not renamed: ${errorMessage(e)}`) },
                )
              }
              disabled={!name.trim()}
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
      </Dialog>
    </section>
  );
}
