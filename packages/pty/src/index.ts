import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ShellInfo } from '@acc/executor';
import { redact } from '@acc/security';
import type { IPty } from 'node-pty';

/**
 * Interactive terminals (V2 plan §12). A real pseudo-terminal (ConPTY on
 * Windows) so prompts, REPLs, installers and colour output behave as they
 * would for a person. Output is redacted and kept in a bounded buffer with a
 * monotonic cursor, so any number of readers can catch up without holding
 * the whole history. Sessions die on idle, on a lifetime cap, and as a tree.
 */

export interface PtyCreateOptions {
  shell: ShellInfo;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  /** Load the user's shell profile (operator terminals); agents get a clean shell. */
  loadProfile?: boolean;
  /** Close after this long with no input or output (default 30 min). */
  idleTimeoutMs?: number;
  /** Close after this long regardless (default 8 h). */
  maxLifetimeMs?: number;
  /** Output kept for late readers (default 256 KB). */
  historyChars?: number;
  owner: { taskId: string | null; kind: 'operator' | 'agent' };
}

export interface PtySnapshot {
  id: string;
  pid: number | null;
  shell: ShellInfo['flavor'];
  cwd: string;
  cols: number;
  rows: number;
  taskId: string | null;
  ownerKind: 'operator' | 'agent';
  startedAt: string;
  lastActivityAt: string;
  exited: boolean;
  exitCode: number | null;
}

export type PtyEvent = { type: 'data'; id: string; data: string; cursor: number } | { type: 'exit'; id: string; exitCode: number | null };

function argsFor(shell: ShellInfo, loadProfile: boolean): string[] {
  switch (shell.kind) {
    case 'powershell':
      return loadProfile ? ['-NoLogo'] : ['-NoLogo', '-NoProfile'];
    case 'cmd':
      return ['/Q'];
    case 'bash':
      return loadProfile ? ['--login', '-i'] : ['--noprofile', '--norc', '-i'];
    case 'wsl':
      return [];
  }
}

export class PtySession {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  private readonly chunks: Array<{ start: number; text: string }> = [];
  private retained = 0;
  private cursorValue = 0;
  private exitCodeValue: number | null = null;
  private exitedValue = false;
  private lastActivity = Date.now();
  private cols: number;
  private rows: number;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly listeners = new Set<(event: PtyEvent) => void>();

  constructor(
    private readonly pty: IPty,
    private readonly options: PtyCreateOptions,
  ) {
    this.cols = options.cols ?? 120;
    this.rows = options.rows ?? 30;
    pty.onData((data) => this.push(data));
    pty.onExit(({ exitCode }) => this.finish(exitCode));
    const idle = options.idleTimeoutMs ?? 30 * 60_000;
    this.timers.push(
      setInterval(() => {
        if (!this.exitedValue && Date.now() - this.lastActivity > idle) void this.kill('idle');
      }, Math.min(idle, 30_000)),
    );
    this.timers.push(setTimeout(() => void this.kill('lifetime'), options.maxLifetimeMs ?? 8 * 3600_000));
    for (const t of this.timers) t.unref?.();
  }

  get pid(): number | null {
    return this.pty.pid ?? null;
  }

  get exited(): boolean {
    return this.exitedValue;
  }

  get cursor(): number {
    return this.cursorValue;
  }

  onEvent(listener: (event: PtyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: PtyEvent): void {
    for (const l of this.listeners) l(event);
  }

  private push(raw: string): void {
    this.lastActivity = Date.now();
    const text = redact(raw);
    const start = this.cursorValue;
    this.cursorValue += text.length;
    this.chunks.push({ start, text });
    this.retained += text.length;
    const cap = this.options.historyChars ?? 256 * 1024;
    while (this.retained > cap && this.chunks.length > 1) this.retained -= this.chunks.shift()!.text.length;
    this.emit({ type: 'data', id: this.id, data: text, cursor: this.cursorValue });
  }

  private finish(exitCode: number | null): void {
    if (this.exitedValue) return;
    this.exitedValue = true;
    this.exitCodeValue = exitCode;
    for (const t of this.timers) clearTimeout(t);
    this.emit({ type: 'exit', id: this.id, exitCode });
  }

  /** Output after `since` (a cursor from an earlier read); older output may have been dropped. */
  read(since = 0): { output: string; cursor: number; exited: boolean; exitCode: number | null; truncated: boolean } {
    const first = this.chunks[0]?.start ?? this.cursorValue;
    const from = Math.max(since, first);
    let output = '';
    for (const c of this.chunks) {
      const end = c.start + c.text.length;
      if (end <= from) continue;
      output += c.text.slice(Math.max(0, from - c.start));
    }
    return { output, cursor: this.cursorValue, exited: this.exitedValue, exitCode: this.exitCodeValue, truncated: since < first };
  }

  write(data: string): void {
    if (this.exitedValue) throw new Error('The terminal has exited');
    this.lastActivity = Date.now();
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exitedValue) return;
    this.cols = Math.max(20, Math.min(400, Math.floor(cols)));
    this.rows = Math.max(5, Math.min(200, Math.floor(rows)));
    this.pty.resize(this.cols, this.rows);
  }

  /** Kill the shell and everything it started. */
  async kill(reason = 'closed'): Promise<void> {
    if (this.exitedValue) return;
    const pid = this.pid;
    // ConPTY's own kill ends every process attached to the console; a tree kill
    // afterwards catches anything that detached (and must come second, or the
    // console is already gone when ConPTY looks for its processes).
    try {
      this.pty.kill();
    } catch {
      /* already gone */
    }
    if (pid && process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const k = spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.on('exit', () => resolve());
        k.on('error', () => resolve());
      });
    }
    this.push(`\r\n[terminal ${reason}]\r\n`);
    // ConPTY reports exit asynchronously: wait briefly for it, then consider the session gone.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      const off = this.onEvent((e) => {
        if (e.type !== 'exit') return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    this.finish(this.exitCodeValue);
  }

  snapshot(): PtySnapshot {
    return {
      id: this.id,
      pid: this.pid,
      shell: this.options.shell.flavor,
      cwd: this.options.cwd,
      cols: this.cols,
      rows: this.rows,
      taskId: this.options.owner.taskId,
      ownerKind: this.options.owner.kind,
      startedAt: this.startedAt,
      lastActivityAt: new Date(this.lastActivity).toISOString(),
      exited: this.exitedValue,
      exitCode: this.exitCodeValue,
    };
  }
}

export class PtyManager {
  private readonly sessions = new Map<string, PtySession>();

  constructor(private readonly limits: { maxSessions?: number } = {}) {}

  async create(options: PtyCreateOptions): Promise<PtySession> {
    const live = [...this.sessions.values()].filter((s) => !s.exited);
    if (live.length >= (this.limits.maxSessions ?? 12)) throw new Error(`At most ${this.limits.maxSessions ?? 12} terminals may be open at once; close one first`);
    const pty = await import('node-pty');
    const env = Object.fromEntries(Object.entries({ ...options.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const proc = pty.spawn(options.shell.executable, argsFor(options.shell, options.loadProfile ?? false), {
      name: 'xterm-256color',
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
      cwd: options.cwd,
      env,
      // The bundled ConPTY (OpenConsole) ends its session cleanly on kill; the tree kill in PtySession.kill catches the rest.
      ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
    });
    const session = new PtySession(proc, options);
    this.sessions.set(session.id, session);
    session.onEvent((e) => {
      // Keep exited sessions briefly so a reader sees the exit, then forget them.
      if (e.type === 'exit') setTimeout(() => this.sessions.delete(session.id), 10 * 60_000).unref?.();
    });
    return session;
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  list(): PtySession[] {
    return [...this.sessions.values()];
  }

  async kill(id: string, reason?: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    await s.kill(reason);
    return true;
  }

  /** Close every session a task owns (task finished or cancelled). */
  async killForTask(taskId: string): Promise<number> {
    const owned = this.list().filter((s) => s.snapshot().taskId === taskId && !s.exited);
    await Promise.all(owned.map((s) => s.kill('task finished')));
    return owned.length;
  }

  async killAll(): Promise<void> {
    await Promise.all(this.list().map((s) => s.kill('shutdown')));
  }
}
