import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { Banner, Drawer, Skeleton } from '@acc/ui';
import type { TerminalSession } from '@acc/shared';
import { errorMessage } from '../api/client';
import { useTerminalMutations } from '../api/tools';
import { useApi, useRuntime } from '../app/runtime';

function token(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * An interactive terminal (design.md §7.3 "Terminal drawer"): xterm themed
 * from the design tokens, output over the WebSocket, keystrokes back to the
 * orchestrator's pseudo-terminal. Nothing is stored in the browser.
 */
export function TerminalView({ terminal }: { terminal: TerminalSession }) {
  const host = useRef<HTMLDivElement | null>(null);
  const { realtime } = useRuntime();
  const api = useApi();

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontFamily: token('--font-mono-stack', 'Consolas, monospace'),
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: token('--bg-canvas', '#090b0f'),
        foreground: token('--text-primary', '#f4f7fb'),
        cursor: token('--accent', '#6ea8fe'),
        selectionBackground: token('--accent-muted', 'rgba(110,168,254,0.3)'),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    let cursor = 0;
    let disposed = false;
    const fitNow = () => {
      try {
        fit.fit();
        realtime.resizeTerminal(terminal.id, term.cols, term.rows);
      } catch {
        /* hidden or zero-sized: fit again when visible */
      }
    };
    // Catch up with what the terminal printed before this view opened, then stream.
    const unsubscribe = realtime.subscribeTerminal(terminal.id, (data, next) => {
      if (next <= cursor) return;
      term.write(data);
      cursor = next;
    });
    void api.get<{ output: string; cursor: number }>(`/api/terminals/${terminal.id}/output?since=0`).then((r) => {
      if (disposed) return;
      if (r.cursor > cursor) {
        term.write(r.output);
        cursor = r.cursor;
      }
    }, () => undefined);
    const input = term.onData((data) => realtime.sendTerminalInput(terminal.id, data));
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(host.current);
    fitNow();
    term.focus();
    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      unsubscribe();
      term.dispose();
    };
  }, [terminal.id, realtime, api]);

  return <div ref={host} className="h-full min-h-[320px] w-full overflow-hidden rounded-md border border-border-subtle bg-canvas p-2" aria-label={`Terminal (${terminal.shell}) in ${terminal.cwd}`} role="region" />;
}

/** "Open terminal" drawer for a task or repository; closing the drawer closes the terminal. */
export function TerminalDrawer({ open, onOpenChange, taskId, repositoryId, title }: { open: boolean; onOpenChange: (open: boolean) => void; taskId?: string; repositoryId?: string; title: string }) {
  const mutations = useTerminalMutations();
  const [terminal, setTerminal] = useState<TerminalSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { mutate: openTerminal } = mutations.open;
  const { mutate: closeTerminal } = mutations.close;

  useEffect(() => {
    if (!open) return;
    let current: TerminalSession | null = null;
    let closed = false;
    setError(null);
    openTerminal(
      { taskId, repositoryId, cols: 120, rows: 32 },
      {
        onSuccess: (t) => {
          // Closed before it started: close it at once rather than leave it running.
          if (closed) return closeTerminal(t.id);
          current = t;
          setTerminal(t);
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
    return () => {
      closed = true;
      if (current) closeTerminal(current.id);
      setTerminal(null);
    };
  }, [open, taskId, repositoryId, openTerminal, closeTerminal]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={title} description={terminal ? `${terminal.shell} in ${terminal.cwd}. Commands typed here run as you.` : 'Starting a terminal…'} width={960}>
      {error ? (
        <Banner tone="danger" title="The terminal could not start">
          {error}
        </Banner>
      ) : terminal ? (
        <div className="h-[min(70vh,640px)]">
          <TerminalView terminal={terminal} />
        </div>
      ) : (
        <Skeleton className="h-[320px]" />
      )}
    </Drawer>
  );
}
