import { resolveShell, type ShellKind } from '@acc/executor';
import { PtyManager, type PtySession } from '@acc/pty';
import { classifyCommand, expandsHistory, lineContinues, sanitizeEnv, shellHistory } from '@acc/security';
import type { BillingMode, CommandRisk, PermissionLevel, TerminalSession } from '@acc/shared';
import { withReleaseGate, type TerminalHost } from '@acc/tools';
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

/** How many earlier lines of a terminal a later push is judged after. */
const MAX_HISTORY = 50;
/** The longest command, over all the lines it spans, a terminal accepts from an agent. */
const MAX_COMMAND = 20_000;
/** Shells that rewrite an interactive line from their history (`!!`, `^old^new`); an unknown shell is taken to be one. */
const HISTORY_SHELLS = /bash|wsl|zsh|^sh$/i;

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
  /** Lines each agent terminal ran, oldest first: their checkouts and settings still hold for a later push (SEC-1). */
  private readonly agentHistory = new Map<string, string[]>();
  /** The lines of a command each agent terminal's shell is still reading (an open quote, a trailing `\`), not yet run. */
  private readonly agentPending = new Map<string, string>();
  /** The stage whose agent opened each agent terminal: it closes when that stage ends (a terminal dies with a restart). */
  private readonly stageOf = new Map<string, string>();

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
   * How a line typed into terminal `id` is judged when Enter arrives: the
   * classifier, with a line that deploys — a push to a release or
   * production branch, a pull-request merge — raised to Level 5 production
   * as `terminal.send` and `shell.run` rate it (SEC-1). A push of HEAD is
   * read in the terminal's folder, after the lines it ran `before`. In bash
   * a line that history expansion rewrites (`!^`, `!!`, `^old^new`) is Level
   * 5: what runs is not the line judged.
   */
  judgeLine(id: string, line: string, releaseBranches: readonly string[], before: readonly string[]): { level: PermissionLevel; risk: CommandRisk; reasons: string[]; production: boolean } {
    const c = classifyCommand(line);
    const terminal = this.store.terminal(id);
    const cwd = terminal?.cwd ?? process.cwd();
    const r = withReleaseGate({ level: c.level, risk: c.risk, reasons: c.reasons, production: c.production }, line, { cwd, releaseBranches }, before.join('\n'));
    const judged = { level: r.level ?? c.level, risk: r.risk ?? c.risk, reasons: r.reasons ?? c.reasons, production: r.production ?? c.production };
    if (!HISTORY_SHELLS.test(terminal?.shell ?? 'sh') || !expandsHistory(line)) return judged;
    return { ...judged, level: 5, risk: judged.risk === 'dangerous' ? 'dangerous' : 'elevated', reasons: [...judged.reasons, 'Uses shell history expansion (`!…`, `^old^new`), which changes the line after it is judged'] };
  }

  /**
   * How the line an agent ends with Enter is judged: alone, and — while the
   * shell is still reading a command begun on earlier lines (an open quote,
   * a trailing `\`, a heredoc: `lineContinues`) — as part of that command.
   * Either verdict can refuse it.
   */
  private judgeEnter(id: string, pending: string, typed: string, releaseBranches: readonly string[], history: readonly string[]) {
    return [typed ? this.judgeLine(id, typed, releaseBranches, history) : null, pending ? this.judgeLine(id, `${pending}\n${typed}`, releaseBranches, history) : null].filter((v) => v !== null);
  }

  /**
   * Agent input. The shell runs a line when Enter arrives, so the line is
   * judged then — assembled from every chunk the agent sent, not chunk by chunk
   * (audit F-15), with the release gate (`judgeLine`). Characters are typed as
   * they come; at Enter a refused line is cancelled with Ctrl+C instead: one
   * above `maxLevel`, or one no agent may run (dangerous, Level 5, production).
   * Escape sequences and Tab are dropped: history recall and completion would
   * change the line without the classifier seeing it. A program reading its own
   * input (a REPL) is typed into the same way.
   */
  writeAsAgent(id: string, data: string, maxLevel: number, releaseBranches: readonly string[] = []): void {
    const session = this.session(id);
    let line = this.agentLines.get(id) ?? '';
    let pending = this.agentPending.get(id) ?? '';
    let history = this.agentHistory.get(id) ?? [];
    let out = '';
    // eslint-disable-next-line no-control-regex
    const clean = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]|\x1b/g, '').replace(/\t/g, '');
    const refuse = (message: string): never => {
      this.agentLines.set(id, '');
      this.agentPending.set(id, '');
      this.agentHistory.set(id, history);
      // Ctrl+C also drops the lines of a command the shell was still reading.
      session.write(`${out}\x03`);
      throw new TerminalError(message, 'DENIED');
    };
    for (const ch of clean) {
      if (ch === '\r' || ch === '\n') {
        const typed = line.trim();
        const whole = pending ? `${pending}\n${typed}` : typed;
        if (whole.length > MAX_COMMAND) refuse('Refused to run this line in the terminal: the command it ends is too long to judge. It was cancelled with Ctrl+C.');
        const c = this.judgeEnter(id, pending, typed, releaseBranches, history).find((v) => v.risk === 'dangerous' || v.level >= 5 || v.production || v.level > maxLevel);
        if (c) refuse(`Refused to run this line in the terminal: ${c.reasons.join(', ')} (Level ${c.level}). It was cancelled with Ctrl+C.`);
        if (typed) history = shellHistory([...history, typed], MAX_HISTORY);
        pending = whole && lineContinues(whole) ? whole : '';
        line = '';
        out += '\r';
        continue;
      }
      if (ch === '\x03') {
        line = '';
        pending = '';
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
    this.agentHistory.set(id, history);
    this.agentPending.set(id, pending);
    if (line.length > MAX_COMMAND) throw new TerminalError('The line is too long to type', 'DENIED');
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
    this.agentLines.delete(id);
    this.agentHistory.delete(id);
    this.agentPending.delete(id);
    this.stageOf.delete(id);
    await this.session(id).kill('closed');
    this.store.updateTerminal(id, { status: 'exited', endedAt: now() });
    this.publish(id);
  }

  list(filter: { taskId?: string; running?: boolean } = {}): TerminalSession[] {
    return this.store.listTerminals(filter);
  }

  /** A task's terminals for its agent: every line judged at Enter against `maxLevel` and the task's release branches. */
  host(taskId: string | null, maxLevel: number, releaseBranches: readonly string[] = [], stageId: string | null = null): TerminalHost {
    return {
      start: async (input) => {
        const t = await this.open({ ...input, taskId, ownerKind: 'agent' });
        if (stageId) this.stageOf.set(t.id, stageId);
        return { id: t.id, pid: t.pid };
      },
      send: async (id, text) => {
        const t = this.store.terminal(id);
        if (!t || t.taskId !== taskId) throw new TerminalError('Terminal not found for this task', 'NOT_FOUND');
        this.writeAsAgent(id, text, maxLevel, releaseBranches);
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

  /**
   * Close the terminals one stage's agent opened, when that stage ends: a dev server typed into one would otherwise
   * hold its port into the next stage (review, 2026-09-28). Returns how many were closed.
   */
  async closeForStage(taskId: string, stageId: string): Promise<number> {
    let closed = 0;
    for (const t of this.store.listTerminals({ taskId, running: true })) {
      if (this.stageOf.get(t.id) !== stageId) continue;
      try {
        await this.close(t.id);
        closed++;
      } catch {
        /* already gone */
      }
    }
    return closed;
  }

  async closeForTask(taskId: string): Promise<void> {
    await this.manager.killForTask(taskId);
    for (const t of this.store.listTerminals({ taskId, running: true })) {
      this.stageOf.delete(t.id);
      this.store.updateTerminal(t.id, { status: 'exited', endedAt: now() });
    }
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
