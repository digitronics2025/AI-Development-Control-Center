import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess, type ProcessHandle, type ProcessResult, type RunOptions } from './process.js';
import { which } from './which.js';

/**
 * Script runners for every shell the Control Center drives (V2 plan §10–11).
 * Scripts are written to a private temporary file and the interpreter is
 * pointed at it, so multi-line scripts behave exactly as a saved script
 * would, nothing is parsed twice, and no script text travels through argv.
 */

export const SHELL_KINDS = ['powershell', 'cmd', 'bash', 'wsl'] as const;
export type ShellKind = (typeof SHELL_KINDS)[number];

export interface ShellInfo {
  kind: ShellKind;
  /** Which implementation was found (PowerShell 7 vs Windows PowerShell, Git Bash vs system bash). */
  flavor: 'pwsh' | 'windows-powershell' | 'cmd' | 'git-bash' | 'bash' | 'wsl';
  executable: string;
}

export interface ScriptRunOptions extends Omit<RunOptions, 'command' | 'args' | 'stdin'> {
  shell: ShellInfo;
  script: string;
  /** Arguments passed to the script ($args / %1 / $1). */
  args?: string[];
  stdin?: string;
  /** Where temporary script files go; defaults to the OS temp folder. */
  tempDir?: string;
}

const isWindows = process.platform === 'win32';

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return null;
}

/**
 * Locate a shell. PowerShell prefers `pwsh` (7+) and falls back to Windows
 * PowerShell; bash on Windows prefers Git Bash and never picks
 * `System32\bash.exe`, which is the WSL launcher.
 */
export async function resolveShell(kind: ShellKind, env: NodeJS.ProcessEnv = process.env): Promise<ShellInfo | null> {
  switch (kind) {
    case 'powershell': {
      const pwsh = await which('pwsh', env);
      if (pwsh) return { kind, flavor: 'pwsh', executable: pwsh };
      if (!isWindows) return null;
      const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
      const legacy = (await which('powershell', env)) ?? (await firstExisting([path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]));
      return legacy ? { kind, flavor: 'windows-powershell', executable: legacy } : null;
    }
    case 'cmd': {
      if (!isWindows) return null;
      const comspec = env.ComSpec ?? env.COMSPEC ?? path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
      return existsSync(comspec) ? { kind, flavor: 'cmd', executable: comspec } : null;
    }
    case 'bash': {
      if (!isWindows) {
        const bash = await which('bash', env);
        return bash ? { kind, flavor: 'bash', executable: bash } : null;
      }
      const gitExe = await which('git', env);
      const fromGit = gitExe ? [path.resolve(path.dirname(gitExe), '..', 'bin', 'bash.exe'), path.resolve(path.dirname(gitExe), '..', 'usr', 'bin', 'bash.exe')] : [];
      const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[];
      const known = programFiles.map((p) => path.join(p, 'Git', 'bin', 'bash.exe'));
      const found = await firstExisting([...fromGit, ...known]);
      if (found) return { kind, flavor: 'git-bash', executable: found };
      const onPath = await which('bash', env);
      if (onPath && !/[\\/]system32[\\/]bash\.exe$/i.test(onPath)) return { kind, flavor: 'bash', executable: onPath };
      return null;
    }
    case 'wsl': {
      if (!isWindows) return null;
      const wsl = (await which('wsl', env)) ?? (await firstExisting([path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')]));
      return wsl ? { kind, flavor: 'wsl', executable: wsl } : null;
    }
  }
}

function scriptFile(tempDir: string | undefined, extension: string, content: string | Buffer): string {
  const dir = tempDir ?? path.join(os.tmpdir(), 'acc-scripts');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `script-${randomBytes(8).toString('hex')}${extension}`);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

/** Windows PowerShell 5.1 reads BOM-less scripts as ANSI; a UTF-8 BOM makes both editions read UTF-8. */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Prologue for PowerShell scripts: UTF-8 output, no progress bars on stderr. */
export const POWERSHELL_PROLOGUE = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
].join('\n');

function launch(shell: ShellInfo, script: string, options: ScriptRunOptions): { command: string; args: string[]; file: string | null; stdin?: string } {
  const extra = options.args ?? [];
  switch (shell.kind) {
    case 'powershell': {
      const file = scriptFile(options.tempDir, '.ps1', Buffer.concat([UTF8_BOM, Buffer.from(`${POWERSHELL_PROLOGUE}\n${script}\n`, 'utf8')]));
      const args = ['-NoProfile', '-NonInteractive'];
      // Process-scope only: lets the temporary script run without changing any policy on the machine.
      if (isWindows) args.push('-ExecutionPolicy', 'Bypass');
      return { command: shell.executable, args: [...args, '-File', file, ...extra], file, stdin: options.stdin };
    }
    case 'cmd': {
      const file = scriptFile(options.tempDir, '.cmd', `@echo off\r\n${script.replace(/\r?\n/g, '\r\n')}\r\n`);
      return { command: shell.executable, args: ['/d', '/c', file, ...extra], file, stdin: options.stdin };
    }
    case 'bash': {
      const file = scriptFile(options.tempDir, '.sh', `${script.replace(/\r\n/g, '\n')}\n`);
      // Git Bash understands C:/… paths; forward slashes avoid backslash escaping.
      return { command: shell.executable, args: ['--noprofile', '--norc', file.replace(/\\/g, '/'), ...extra], file, stdin: options.stdin };
    }
    case 'wsl':
      // The script goes on stdin: the Linux side cannot see the Windows temp path without translation.
      return { command: shell.executable, args: ['-e', 'bash', '--noprofile', '--norc', '-s', '--', ...extra], file: null, stdin: `${script.replace(/\r\n/g, '\n')}\n` };
  }
}

/** Run a script in the given shell. The temporary file is removed when the process ends. */
export function runScript(options: ScriptRunOptions): ProcessHandle {
  const plan = launch(options.shell, options.script, options);
  const handle = runProcess({
    command: plan.command,
    args: plan.args,
    cwd: options.cwd,
    env: options.env,
    stdin: plan.stdin,
    timeoutMs: options.timeoutMs,
    onLine: options.onLine,
    maxLineLength: options.maxLineLength,
  });
  const done = handle.done.finally(() => {
    if (plan.file) rmSync(plan.file, { force: true });
  });
  return { pid: handle.pid, done, cancel: () => handle.cancel() };
}

export interface CapturedRun {
  result: ProcessResult;
  stdout: string;
  stderr: string;
}

/** Run a script and collect its output (bounded). For short structured operations. */
export async function captureScript(options: Omit<ScriptRunOptions, 'onLine'> & { maxBytes?: number }): Promise<CapturedRun> {
  const out: string[] = [];
  const err: string[] = [];
  let bytes = 0;
  const max = options.maxBytes ?? 4 * 1024 * 1024;
  const handle = runScript({
    ...options,
    onLine: (stream, line) => {
      bytes += line.length + 1;
      if (bytes > max) return;
      (stream === 'stdout' ? out : err).push(line);
    },
  });
  const result = await handle.done;
  return { result, stdout: out.join('\n'), stderr: err.join('\n') };
}

/**
 * Run a PowerShell script that prints JSON (`… | ConvertTo-Json -Compress`)
 * and parse the result. Throws with the script's error output on failure.
 */
export async function powershellJson<T = unknown>(shell: ShellInfo, script: string, options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; tempDir?: string } = {}): Promise<T> {
  if (shell.kind !== 'powershell') throw new Error('powershellJson needs a PowerShell shell');
  const run = await captureScript({
    shell,
    script: `$ErrorActionPreference = 'Stop'\n${script}`,
    cwd: options.cwd ?? os.homedir(),
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? 30_000,
    tempDir: options.tempDir,
  });
  if (run.result.timedOut) throw new Error('PowerShell timed out');
  if (run.result.exitCode !== 0) throw new Error((run.stderr || run.stdout || `PowerShell exited with ${run.result.exitCode}`).slice(0, 2000));
  const text = run.stdout.trim();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`PowerShell did not return JSON: ${text.slice(0, 300)}`);
  }
}
