import { resolveShell, type ShellKind } from '@acc/executor';
import { PtyManager, type PtySession } from '@acc/pty';
import { classifyCommand, sanitizeEnv } from '@acc/security';
import type { BillingMode, TerminalSession } from '@acc/shared';
import type { TerminalHost } from '@acc/tools';
import type { Bus } from '../bus.js';
import { now } from '../store/store.js';
import type { ToolStore } from './store.js';

export class TerminalError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'DISABLED' | 'UNAVAILABLE' | 'LIMIT' | 'DENIED',
  ) {
    super(message);
  }
}

/**
 * Interactive terminals (V2 plan §12, §47). Operator terminals behave like
 * the operator's own shell; agent terminals classify every line before it is
 * typed. Output reaches only WebSocket clients that subscribed to that
 * terminal, is redacted, and is never stored.
 */
export class TerminalService {
  private readonly manager = new PtyManager({ maxSessions: 12 });
  /** What an agent has typed on the current line of each of its terminals, not yet run. */
  private readonly agentLines = new Map<string, string>();

  constructor(
    private readonly store: ToolStore,
    private readonly bus: Bus,
    private readonly options: { enabled: () => boolean; loopbackOnly: boolean; env: () => { base: NodeJS.ProcessEnv; billing: BillingMode } },
  ) {}

  private publish(id: string): void {
    const t = this.store.terminal(id);
    if (t) this.bus.publish({ type: 'terminal', terminal: t });
  }

  async open(input: { shell?: ShellKind; cwd: string; cols?: number; rows?: number; taskId: string | null; ownerKind: 'operator' | 'agent' }): Promise<TerminalSession> {
    if (!this.options.enabled()) throw new TerminalError('Terminals are turned off in Settings → Execution', 'DISABLED');
    if (!this.options.loopbackOnly) throw new TerminalError('Terminals are only available while the Control Center listens on this computer alone', 'DISABLED');
    const kind: ShellKind = input.shell ?? (process.platform === 'win32' ? 'powershell' : 'bash');
    const shell = await resolveShell(kind);
    if (!shell) throw new TerminalError(`${kind} is not available on this machine`, 'UNAVAILABLE');
    const { base, billing } = this.options.env();
    let session: PtySession;
    try {
      session = await this.manager.create({
        shell,
        cwd: input.cwd,
        env: sanitizeEnv(base, billing).env,
        cols: input.cols,
        rows: input.rows,
        loadProfile: input.ownerKind === 'operator',
        owner: { taskId: input.taskId, kind: input.ownerKind },
      });
    } catch (error) {
      throw new TerminalError((error as Error).message, /At most/.test((error as Error).message) ? 'LIMIT' : 'UNAVAILABLE');
    }
    const snap = session.snapshot();
    const record: TerminalSession = { id: session.id, taskId: input.taskId, shell: shell.flavor, cwd: input.cwd, pid: snap.pid, ownerKind: input.ownerKind, status: 'running', cols: snap.cols, rows: snap.rows, startedAt: snap.startedAt, endedAt: null, exitCode: null };
    this.store.insertTerminal(record);
    session.onEvent((e) => {
      if (e.type === 'data') this.bus.publish({ type: 'terminal.output', terminalId: e.id, data: e.data, cursor: e.cursor });
      else {
        this.store.updateTerminal(e.id, { status: 'exited', endedAt: now(), exitCode: e.exitCode });
        this.publish(e.id);
      }
    });
    this.bus.publish({ type: 'terminal', terminal: record });
    return record;
  }

  private session(id: string): PtySession {
    const s = this.manager.get(id);
    if (!s) throw new TerminalError('Terminal not found (it may have closed)', 'NOT_FOUND');
    return s;
  }

  /** Operator input: typed by the person at the dashboard, like their own shell. */
  write(id: string, data: string): void {
    this.session(id).write(data);
  }

  /**
   * Agent input. The shell runs a line when Enter arrives, so the line is
   * judged then — assembled from every chunk the agent sent, not chunk by chunk
   * (audit F-15). Characters are typed as they come; at Enter a refused line is
   * cancelled with Ctrl+C instead. Escape sequences and Tab are dropped: history
   * recall and completion would change the line without the classifier seeing
   * it. A program reading its own input (a REPL) is typed into the same way.
   */
  writeAsAgent(id: string, data: string, maxLevel: number): void {
    const session = this.session(id);
    let line = this.agentLines.get(id) ?? '';
    let out = '';
    // eslint-disable-next-line no-control-regex
    const clean = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]|\x1b/g, '').replace(/\t/g, '');
    for (const ch of clean) {
      if (ch === '\r' || ch === '\n') {
        const c = line.trim() ? classifyCommand(line.trim()) : null;
        if (c && (c.risk === 'dangerous' || c.level > maxLevel)) {
          this.agentLines.set(id, '');
          session.write(`${out}\x03`);
          throw new TerminalError(`Refused to run this line in the terminal: ${c.reasons.join(', ')} (Level ${c.level}). It was cancelled with Ctrl+C.`, 'DENIED');
        }
        line = '';
        out += '\r';
        continue;
      }
      if (ch === '\x03') {
        line = '';
        out += ch;
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        line = Array.from(line).slice(0, -1).join('');
        out += ch;
        continue;
      }
      if (ch < ' ') continue;
      line += ch;
      out += ch;
    }
    if (line.length > 20_000) throw new TerminalError('The line is too long to type', 'DENIED');
    this.agentLines.set(id, line);
    if (out) session.write(out);
  }

  read(id: string, since = 0) {
    return this.session(id).read(since);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.session(id);
    s.resize(cols, rows);
    const snap = s.snapshot();
    this.store.updateTerminal(id, { cols: snap.cols, rows: snap.rows });
  }

  async close(id: string): Promise<void> {
    await this.session(id).kill('closed');
    this.store.updateTerminal(id, { status: 'exited', endedAt: now() });
    this.publish(id);
  }

  list(filter: { taskId?: string; running?: boolean } = {}): TerminalSession[] {
    return this.store.listTerminals(filter);
  }

  host(taskId: string | null, maxLevel: number): TerminalHost {
    return {
      start: async (input) => {
        const t = await this.open({ ...input, taskId, ownerKind: 'agent' });
        return { id: t.id, pid: t.pid };
      },
      send: async (id, text) => {
        const t = this.store.terminal(id);
        if (!t || t.taskId !== taskId) throw new TerminalError('Terminal not found for this task', 'NOT_FOUND');
        this.writeAsAgent(id, text, maxLevel);
      },
      read: (id, since) => {
        const t = this.store.terminal(id);
        if (!t || t.taskId !== taskId) throw new TerminalError('Terminal not found for this task', 'NOT_FOUND');
        return this.read(id, since);
      },
      stop: async (id) => {
        const t = this.store.terminal(id);
        if (!t || t.taskId !== taskId) throw new TerminalError('Terminal not found for this task', 'NOT_FOUND');
        await this.close(id);
      },
    };
  }

  async closeForTask(taskId: string): Promise<void> {
    await this.manager.killForTask(taskId);
    for (const t of this.store.listTerminals({ taskId, running: true })) this.store.updateTerminal(t.id, { status: 'exited', endedAt: now() });
  }

  /** Terminals recorded as running before a restart died with the old process. */
  reconcileAfterRestart(): number {
    let n = 0;
    for (const t of this.store.listTerminals({ running: true })) {
      if (this.manager.get(t.id)) continue;
      this.store.updateTerminal(t.id, { status: 'exited', endedAt: now() });
      n++;
    }
    return n;
  }

  async shutdown(): Promise<void> {
    await this.manager.killAll();
    this.reconcileAfterRestart();
  }
}
