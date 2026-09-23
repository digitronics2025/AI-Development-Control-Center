import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';

export type StreamName = 'stdout' | 'stderr';

export interface RunOptions {
  /** Executable plus argv. Arguments are never interpreted by a shell. */
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is closed. Prompts travel here, never in argv. */
  stdin?: string;
  timeoutMs?: number;
  onLine?: (stream: StreamName, line: string) => void;
  /**
   * Longest line forwarded before it is split (protects against minified
   * blobs). Callers parsing a line-delimited protocol must raise it so one
   * event is never delivered as several fragments.
   */
  maxLineLength?: number;
}

export interface ShellRunOptions extends Omit<RunOptions, 'command' | 'args'> {
  /** A full command line authored by the user in repository settings. */
  commandLine: string;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Spawn failure (e.g. ENOENT) before the process ran. */
  spawnError: string | null;
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  /** Last lines of combined output, kept for error classification. */
  tail: string[];
}

export interface ProcessHandle {
  pid: number | null;
  done: Promise<ProcessResult>;
  cancel(): Promise<void>;
}

const TAIL_LINES = 200;
/** Tail entries are for error classification only; a huge line must not pin megabytes. */
const TAIL_LINE_CHARS = 4000;
const KILL_GRACE_MS = 3000;
export const DEFAULT_MAX_LINE_LENGTH = 8000;

function createLineSplitter(stream: StreamName, maxLen: number, emit: (stream: StreamName, line: string) => void) {
  let buffer = '';
  // Everything before this offset is known to contain no newline, so a long
  // line arriving in many chunks is scanned once rather than once per chunk.
  let scanned = 0;
  return {
    push(chunk: string) {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n', scanned)) !== -1) {
        emitLong(buffer.slice(0, index > 0 && buffer[index - 1] === '\r' ? index - 1 : index));
        buffer = buffer.slice(index + 1);
        scanned = 0;
      }
      while (buffer.length > maxLen) {
        emit(stream, buffer.slice(0, maxLen));
        buffer = buffer.slice(maxLen);
      }
      // A trailing '\r' may be the first half of a '\r\n' split across chunks.
      scanned = buffer.endsWith('\r') ? buffer.length - 1 : buffer.length;
    },
    flush() {
      if (buffer.length) emitLong(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
      buffer = '';
      scanned = 0;
    },
  };
  function emitLong(line: string) {
    for (let i = 0; i < Math.max(line.length, 1); i += maxLen) emit(stream, line.slice(i, i + maxLen));
  }
}

/** Kill a process and every descendant. */
export function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return resolve();
    if (process.platform === 'win32') {
      const killer = nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {
        child.kill();
        resolve();
      });
      killer.on('exit', () => resolve());
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      resolve();
    }, KILL_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function start(child: ChildProcess, options: RunOptions | ShellRunOptions): ProcessHandle {
  const startedAt = new Date();
  const tail: string[] = [];
  const maxLen = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  let timedOut = false;
  let cancelled = false;
  let spawnError: string | null = null;

  const emit = (stream: StreamName, line: string) => {
    tail.push(line.length > TAIL_LINE_CHARS ? line.slice(0, TAIL_LINE_CHARS) : line);
    if (tail.length > TAIL_LINES) tail.shift();
    options.onLine?.(stream, line);
  };
  const out = createLineSplitter('stdout', maxLen, emit);
  const err = createLineSplitter('stderr', maxLen, emit);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => out.push(chunk));
  child.stderr?.on('data', (chunk: string) => err.push(chunk));

  if (child.stdin) {
    child.stdin.on('error', () => {
      /* the process may exit before reading stdin; that is reported via exit code */
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin, 'utf8');
    else child.stdin.end();
  }

  let timer: NodeJS.Timeout | undefined;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      void killTree(child);
    }, options.timeoutMs);
  }

  const done = new Promise<ProcessResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      out.flush();
      err.flush();
      const finishedAt = new Date();
      resolve({
        exitCode,
        signal,
        timedOut,
        cancelled,
        spawnError,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        startedAt,
        finishedAt,
        tail,
      });
    };
    child.on('error', (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    // 'close' waits for stdio to drain, so no trailing output is lost.
    child.on('close', (code, signal) => finish(code, signal));
  });

  return {
    pid: child.pid ?? null,
    done,
    async cancel() {
      if (cancelled) return;
      cancelled = true;
      await killTree(child);
    },
  };
}

/** Run an executable with an argv array. No shell is involved. */
export function runProcess(options: RunOptions): ProcessHandle {
  const child = crossSpawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  return start(child, options);
}

/**
 * Run a user-authored command line through the platform shell
 * (cmd.exe on Windows, /bin/sh elsewhere). Only for repository commands the
 * user configured; classification happens before this is called.
 */
export function runShell(options: ShellRunOptions): ProcessHandle {
  const child = nodeSpawn(options.commandLine, {
    cwd: options.cwd,
    env: options.env,
    shell: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  return start(child, options);
}
