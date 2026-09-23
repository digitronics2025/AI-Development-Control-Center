import { powershellJson, resolveShell, runScript, runShell, type ProcessHandle, type ShellKind } from '@acc/executor';
import { redact, sanitizeEnv } from '@acc/security';
import type { BillingMode, TaskProcess, TaskProcessStatus } from '@acc/shared';
import { tcpConnect, waitForHttp, type ManagedProcessInfo, type ProcessHost } from '@acc/tools';
import type { Bus } from '../bus.js';
import { newId, now } from '../store/store.js';
import type { TaskProcessRecord, ToolStore } from './store.js';

const LIVE: readonly TaskProcessStatus[] = ['starting', 'running', 'healthy', 'unhealthy'];
const LOG_LINES = 2000;

interface Live {
  handle: ProcessHandle;
  lines: string[];
  descendants: Set<number>;
}

export interface StartProcessInput {
  taskId: string | null;
  stageId: string | null;
  name: string;
  command: string;
  shell?: ShellKind;
  cwd: string;
  port?: number | null;
  readyUrl?: string | null;
  readyTimeoutSec?: number;
  env?: Record<string, string>;
}

function view(r: TaskProcessRecord): TaskProcess {
  const { processStartedAt: _unused, ...rest } = r;
  return rest;
}

/**
 * Long-running processes owned by a task (V2 plan §39): dev servers,
 * watchers, emulators. Each is recorded with its pid, when it started and
 * its command, and is stopped (as a tree) when its task ends, is cancelled,
 * or when the orchestrator finds it left over after a restart — but only
 * after proving it is still the same process, never a reused pid.
 */
export class ProcessManager {
  private readonly live = new Map<string, Live>();

  constructor(
    private readonly store: ToolStore,
    private readonly bus: Bus,
    private readonly env: () => { base: NodeJS.ProcessEnv; billing: BillingMode },
  ) {}

  private publish(r: TaskProcessRecord): TaskProcess {
    const v = view(r);
    this.bus.publish({ type: 'taskProcess', process: v });
    return v;
  }

  private info(r: TaskProcessRecord): ManagedProcessInfo {
    return { id: r.id, name: r.name, command: r.command, pid: r.pid, port: r.port, url: r.url, status: r.status, startedAt: r.startedAt, exitCode: r.exitCode };
  }

  list(taskId?: string | null): TaskProcess[] {
    return this.store.listProcesses(taskId === undefined ? {} : { taskId }).map(view);
  }

  logs(id: string, lines: number): string[] {
    return this.live.get(id)?.lines.slice(-lines) ?? [];
  }

  /** The pid (or one of the processes it started) belongs to a live process of this task. */
  owns(taskId: string | null, pid: number): boolean {
    for (const r of this.store.listProcesses({ taskId, live: true })) {
      if (r.pid === pid) return true;
      if (this.live.get(r.id)?.descendants.has(pid)) return true;
    }
    return false;
  }

  /** Refresh the set of child processes (a shell's dev server is its child, and holds the port). */
  private async learnDescendants(id: string, rootPid: number): Promise<void> {
    if (process.platform !== 'win32') return;
    const shell = await resolveShell('powershell');
    if (!shell) return;
    try {
      const pids = await powershellJson<number[] | number | null>(
        shell,
        `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId; $found = New-Object System.Collections.Generic.List[int]; $queue = New-Object System.Collections.Generic.Queue[int]; $queue.Enqueue(${rootPid}); while ($queue.Count -gt 0) { $p = $queue.Dequeue(); foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and -not $found.Contains([int]$c.ProcessId)) { $found.Add([int]$c.ProcessId); $queue.Enqueue([int]$c.ProcessId) } } }; @($found) | ConvertTo-Json -Compress`,
        { timeoutMs: 20_000 },
      );
      const live = this.live.get(id);
      if (live) for (const pid of Array.isArray(pids) ? pids : pids === null ? [] : [pids]) live.descendants.add(pid);
    } catch {
      /* best effort */
    }
  }

  host(taskId: string | null, stageId: string | null): ProcessHost {
    return {
      start: (input) => this.start({ ...input, taskId, stageId }).then((r) => this.info(r)),
      stop: (id, reason) => this.stop(id, reason ?? 'stopped').then((r) => this.info(r)),
      list: () => this.store.listProcesses({ taskId }).map((r) => this.info(r)),
      logs: (id, lines) => this.logs(id, lines),
      isTaskOwnedPid: (pid) => this.owns(taskId, pid),
    };
  }

  async start(input: StartProcessInput): Promise<TaskProcessRecord> {
    const { base, billing } = this.env();
    const env = { ...sanitizeEnv(base, billing).env, ...(input.env ?? {}), ...(input.port ? { PORT: String(input.port) } : {}) };
    const url = input.readyUrl ?? (input.port ? `http://127.0.0.1:${input.port}` : null);
    const id = newId();
    const record: TaskProcessRecord = {
      id,
      taskId: input.taskId,
      stageId: input.stageId,
      name: input.name.slice(0, 60),
      command: redact(input.command).slice(0, 2000),
      cwd: input.cwd,
      pid: null,
      port: input.port ?? null,
      url,
      status: 'starting',
      startedAt: now(),
      stoppedAt: null,
      exitCode: null,
      stopReason: null,
      processStartedAt: null,
    };

    // Never start on top of someone else's server: say who holds the port instead.
    if (input.port) {
      const busy = await tcpConnect('127.0.0.1', input.port, 1500);
      if (busy.ok) {
        this.store.insertProcess({ ...record, status: 'failed', stoppedAt: now(), stopReason: `Port ${input.port} is already in use` });
        return this.store.process(id)!;
      }
    }

    const lines: string[] = [];
    const onLine = (_stream: string, line: string) => {
      lines.push(redact(line));
      if (lines.length > LOG_LINES) lines.shift();
    };
    const shell = input.shell ? await resolveShell(input.shell) : null;
    const handle = shell ? runScript({ shell, script: input.command, cwd: input.cwd, env, onLine }) : runShell({ commandLine: input.command, cwd: input.cwd, env, onLine });
    record.pid = handle.pid;
    record.processStartedAt = new Date().toISOString();
    record.status = 'running';
    this.store.insertProcess(record);
    this.live.set(id, { handle, lines, descendants: new Set() });
    this.publish(record);

    let exited = false;
    void handle.done.then((result) => {
      exited = true;
      this.live.delete(id);
      const current = this.store.process(id);
      if (current && LIVE.includes(current.status)) {
        this.publish(this.store.updateProcess(id, { status: result.cancelled ? 'stopped' : 'exited', exitCode: result.exitCode, stoppedAt: now(), stopReason: result.cancelled ? current.stopReason : `exited with ${result.exitCode}` }));
      }
    });

    if (url) {
      const controller = new AbortController();
      const watch = setInterval(() => exited && controller.abort(), 200);
      const health = await waitForHttp(url, { timeoutMs: (input.readyTimeoutSec ?? 60) * 1000, intervalMs: 400, signal: controller.signal });
      clearInterval(watch);
      if (!exited) {
        this.publish(this.store.updateProcess(id, { status: health.ok ? 'healthy' : 'unhealthy' }));
        if (handle.pid) await this.learnDescendants(id, handle.pid);
      }
    } else if (handle.pid) {
      await this.learnDescendants(id, handle.pid);
    }
    return this.store.process(id)!;
  }

  async stop(id: string, reason: string): Promise<TaskProcessRecord> {
    const current = this.store.process(id);
    if (!current) throw new Error(`Unknown process ${id}`);
    const live = this.live.get(id);
    if (live && LIVE.includes(current.status)) {
      this.store.updateProcess(id, { stopReason: reason });
      await live.handle.cancel();
      await Promise.race([live.handle.done, new Promise((r) => setTimeout(r, 5000))]);
    }
    const after = this.store.process(id)!;
    if (LIVE.includes(after.status)) return this.store.updateProcess(id, { status: 'stopped', stoppedAt: now(), stopReason: reason });
    this.publish(after);
    return after;
  }

  /** Stop everything a task started (task completed, cancelled or failed). */
  async stopForTask(taskId: string, reason: string): Promise<number> {
    const live = this.store.listProcesses({ taskId, live: true });
    for (const p of live) {
      try {
        await this.stop(p.id, reason);
      } catch {
        /* already gone */
      }
    }
    return live.length;
  }

  async stopAll(reason: string): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id, reason).catch(() => undefined)));
  }

  /**
   * After a restart: processes recorded as live were started by a previous
   * orchestrator. Kill each only if the pid still belongs to the same
   * process (created within seconds of when we started it); otherwise just
   * mark it gone. Returns how many were stopped.
   */
  async reconcileAfterRestart(): Promise<{ stopped: number; gone: number }> {
    const leftovers = this.store.listProcesses({ live: true }).filter((p) => !this.live.has(p.id));
    if (!leftovers.length) return { stopped: 0, gone: 0 };
    const alive = await this.processTimes(leftovers.map((p) => p.pid).filter((p): p is number => p !== null));
    let stopped = 0;
    let gone = 0;
    for (const p of leftovers) {
      const created = p.pid ? alive.get(p.pid) : undefined;
      const same = created && p.processStartedAt && Math.abs(new Date(created).getTime() - new Date(p.processStartedAt).getTime()) < 15_000;
      if (same && p.pid) {
        await this.killTree(p.pid);
        this.publish(this.store.updateProcess(p.id, { status: 'stopped', stoppedAt: now(), stopReason: 'Left over from before a restart; stopped' }));
        stopped++;
      } else {
        this.publish(this.store.updateProcess(p.id, { status: 'exited', stoppedAt: now(), stopReason: 'Gone after a restart' }));
        gone++;
      }
    }
    return { stopped, gone };
  }

  private async processTimes(pids: number[]): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    if (!pids.length) return map;
    if (process.platform === 'win32') {
      const shell = await resolveShell('powershell');
      if (!shell) return map;
      try {
        const rows = await powershellJson<Array<{ pid: number; created: string }> | { pid: number; created: string } | null>(
          shell,
          `@(${pids.join(',')}) | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ pid = [int]$p.ProcessId; created = $p.CreationDate.ToUniversalTime().ToString('o') } } } | ConvertTo-Json -Compress`,
          { timeoutMs: 30_000 },
        );
        for (const r of Array.isArray(rows) ? rows : rows ? [rows] : []) map.set(r.pid, r.created);
      } catch {
        /* cannot tell: treat as gone (safe: nothing is killed) */
      }
      return map;
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        // Without a portable creation time, only claim identity for pids that exist; the time check below then fails closed.
      } catch {
        /* not running */
      }
    }
    return map;
  }

  private async killTree(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      const { spawn } = await import('node:child_process');
      await new Promise<void>((resolve) => {
        const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.on('exit', () => resolve());
        k.on('error', () => resolve());
      });
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
}
