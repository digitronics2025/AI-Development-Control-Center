import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { runProcess, which } from '@acc/executor';
import type { DetectContext, ToolDetection } from './sdk.js';
import { missing } from './sdk.js';

export interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

/** Run a short command (no shell) and capture bounded output. */
export async function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; stdin?: string; maxBytes?: number } = {}): Promise<CommandOutput> {
  const out: string[] = [];
  const err: string[] = [];
  let bytes = 0;
  const max = options.maxBytes ?? 2 * 1024 * 1024;
  const handle = runProcess({
    command,
    args,
    cwd: options.cwd ?? os.homedir(),
    env: options.env ?? process.env,
    stdin: options.stdin,
    timeoutMs: options.timeoutMs ?? 20_000,
    onLine: (stream, line) => {
      bytes += line.length + 1;
      if (bytes <= max) (stream === 'stdout' ? out : err).push(line);
    },
  });
  const result = await handle.done;
  return { code: result.exitCode, stdout: out.join('\n'), stderr: err.join('\n'), timedOut: result.timedOut, spawnError: result.spawnError };
}

export function firstVersion(text: string): string | null {
  return /(\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?)/.exec(text)?.[1] ?? null;
}

/**
 * Standard detection for a CLI: find it on PATH (or at an explicit path),
 * then read its version. `versionArgs` defaults to `--version`.
 */
export async function detectExecutable(ctx: DetectContext, names: string[], versionArgs: string[] = ['--version'], parse: (out: string) => string | null = firstVersion): Promise<ToolDetection> {
  for (const name of names) {
    const found = await which(name, ctx.env);
    if (!found) continue;
    try {
      const out = await run(found, versionArgs, { env: ctx.env, cwd: ctx.cwd ?? os.homedir(), timeoutMs: 15_000 });
      const version = parse(`${out.stdout}\n${out.stderr}`);
      return { installed: true, version, path: found, auth: { required: false, state: 'not_required', message: null }, message: version ? null : 'Version could not be read' };
    } catch (error) {
      return { installed: true, version: null, path: found, auth: { required: false, state: 'not_required', message: null }, message: (error as Error).message };
    }
  }
  return missing(`${names[0]} was not found on PATH`);
}

/** A repository-local binary (node_modules/.bin) wins over a global one. */
export function localBin(cwd: string | null, name: string): string | null {
  if (!cwd) return null;
  const base = path.join(cwd, 'node_modules', '.bin', name);
  for (const candidate of process.platform === 'win32' ? [`${base}.cmd`, `${base}.exe`, base] : [base]) if (existsSync(candidate)) return candidate;
  return null;
}

export function withAuth(detection: ToolDetection, auth: ToolDetection['auth']): ToolDetection {
  return { ...detection, auth };
}

/** Bound text for results that go back to a model or into a row. */
/**
 * Keep the last `max` lines of a stream while it runs: a command that prints for
 * the whole stage must not grow the orchestrator's memory without bound (audit
 * F-35). The tail is kept because that is where errors are.
 */
export function pushBounded(list: string[], text: string, max = 4000): void {
  list.push(text);
  if (list.length > max) list.splice(0, list.length - max);
}

export function clip(text: string, max = 32_000): string {
  return text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters]` : text;
}
