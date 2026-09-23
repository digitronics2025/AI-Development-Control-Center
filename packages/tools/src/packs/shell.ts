import path from 'node:path';
import { runProcess, runScript, type ShellKind } from '@acc/executor';
import { classifyCommand, redact } from '@acc/security';
import { z } from 'zod';
import { clip, firstVersion, run } from '../detect.js';
import { resolveInside } from '../paths.js';
import { failure, missing, operation, type OperationContext, type OperationResult, type ToolProvider, type ToolRisk } from '../sdk.js';

/**
 * Shell providers (V2 plan §10–11): PowerShell (7 preferred, Windows
 * PowerShell fallback), CMD, Bash (Git Bash on Windows), optional WSL, and
 * direct executables. Every script is classified before it runs.
 */

const scriptInput = z.object({
  script: z.string().min(1).max(100_000).describe('Script text. Multi-line is fine.'),
  args: z.array(z.string().max(4000)).max(50).optional().describe('Arguments passed to the script.'),
  cwd: z.string().max(1000).optional().describe('Working directory relative to the repository (default: its root).'),
  timeoutSec: z.number().int().min(1).max(3600).optional(),
});

const runInput = scriptInput.extend({
  shell: z.enum(['powershell', 'cmd', 'bash', 'wsl']).optional().describe('Pick a shell; by default the router chooses (PowerShell on Windows).'),
});

export function classifyScript(script: string, args: readonly string[] = []): Partial<ToolRisk> {
  const c = classifyCommand([script, ...args].join(' '));
  return { level: c.level, risk: c.risk, reasons: c.reasons, effects: c.effects, production: c.production };
}

const MAX_OUTPUT_LINES = 4000;

async function execute(kind: ShellKind, input: z.output<typeof scriptInput>, ctx: OperationContext): Promise<OperationResult> {
  const shell = await ctx.shell(kind);
  if (!shell) return failure('NOT_INSTALLED', `${kind} is not available on this machine`);
  let cwd = ctx.cwd;
  try {
    if (input.cwd) cwd = resolveInside(ctx.roots, ctx.cwd, input.cwd);
  } catch (error) {
    return failure('OUTSIDE_ROOT', (error as Error).message);
  }
  const lines: Array<{ stream: string; text: string }> = [];
  const handle = runScript({
    shell,
    script: input.script,
    args: input.args,
    cwd,
    env: ctx.env,
    timeoutMs: (input.timeoutSec ?? Math.round(ctx.timeoutMs / 1000)) * 1000,
    tempDir: ctx.tempDir,
    onLine: (stream, line) => {
      const text = redact(line);
      if (lines.length < MAX_OUTPUT_LINES) lines.push({ stream, text });
      ctx.onLine?.(stream, text);
    },
  });
  const abort = () => void handle.cancel();
  ctx.signal.addEventListener('abort', abort, { once: true });
  const result = await handle.done;
  ctx.signal.removeEventListener('abort', abort);
  const stdout = clip(lines.filter((l) => l.stream === 'stdout').map((l) => l.text).join('\n'));
  const stderr = clip(lines.filter((l) => l.stream === 'stderr').map((l) => l.text).join('\n'), 16_000);
  if (result.cancelled) return failure('CANCELLED', 'Stopped', { stdout, stderr, exitCode: result.exitCode });
  if (result.timedOut) return failure('TIMEOUT', `Timed out after ${Math.round(result.durationMs / 1000)}s`, { stdout, stderr, exitCode: result.exitCode });
  if (result.spawnError) return failure('FAILED', `Could not start ${shell.flavor}: ${result.spawnError}`);
  const ok = result.exitCode === 0;
  return {
    ok,
    summary: `${shell.flavor} exited with ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s`,
    stdout,
    stderr,
    exitCode: result.exitCode,
    output: { shell: shell.flavor, durationMs: result.durationMs },
    ...(ok ? {} : { error: { code: 'FAILED' as const, message: `Exited with ${result.exitCode}` } }),
  };
}

function shellProvider(kind: ShellKind, meta: { id: string; name: string; description: string; preference: number; platforms?: NodeJS.Platform[] }): ToolProvider {
  const explicit = operation({
    id: `shell.${kind}`,
    title: `Run a ${meta.name} script`,
    description: `Run a script in ${meta.name}. The script is classified before it runs; destructive or machine-wide commands are refused or need approval.`,
    input: scriptInput,
    level: 2,
    classify: (input) => classifyScript(input.script, input.args),
    run: (input, ctx) => execute(kind, input, ctx),
  });
  const generic = operation({
    id: 'shell.run',
    title: 'Run a shell script',
    description: 'Run a script in the best available shell (PowerShell on Windows unless `shell` says otherwise). Prefer a specific capability (git.*, fs.*, http.request) when one exists.',
    input: runInput,
    level: 2,
    classify: (input) => classifyScript(input.script, input.args),
    run: (input, ctx) => execute(kind, input, ctx),
  });
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    category: 'shell',
    preference: meta.preference,
    platforms: meta.platforms,
    async detect(ctx) {
      const shell = await ctx.shell(kind);
      if (!shell) return missing(`${meta.name} was not found`);
      if (kind === 'cmd') return { installed: true, version: null, path: shell.executable, auth: { required: false, state: 'not_required', message: null }, message: null };
      if (kind === 'wsl') {
        const status = await run(shell.executable, ['-e', 'sh', '-c', 'uname -r'], { env: ctx.env, timeoutMs: 25_000 });
        if (status.code !== 0) return { installed: false, version: null, path: shell.executable, auth: { required: false, state: 'not_required', message: null }, message: 'WSL is present but has no working Linux distribution' };
        return { installed: true, version: firstVersion(status.stdout), path: shell.executable, auth: { required: false, state: 'not_required', message: null }, message: null };
      }
      const args = kind === 'powershell' ? ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'] : ['--version'];
      const out = await run(shell.executable, args, { env: ctx.env, timeoutMs: 20_000 });
      return {
        installed: true,
        version: firstVersion(out.stdout),
        path: shell.executable,
        auth: { required: false, state: 'not_required', message: null },
        message: shell.flavor === 'windows-powershell' ? 'PowerShell 7 not found; using Windows PowerShell' : null,
      };
    },
    operations: [explicit, generic],
  };
}

const execInput = z.object({
  command: z.string().min(1).max(1000).describe('Executable name on PATH or a path inside the repository.'),
  args: z.array(z.string().max(8000)).max(200).default([]),
  cwd: z.string().max(1000).optional(),
  stdin: z.string().max(1_000_000).optional(),
  timeoutSec: z.number().int().min(1).max(3600).optional(),
});

export function shellProviders(): ToolProvider[] {
  const win: NodeJS.Platform[] = ['win32'];
  return [
    shellProvider('powershell', { id: 'powershell', name: 'PowerShell', description: 'PowerShell 7 (pwsh), or Windows PowerShell 5.1 when 7 is not installed.', preference: process.platform === 'win32' ? 10 : 30 }),
    shellProvider('cmd', { id: 'cmd', name: 'Command Prompt', description: 'cmd.exe batch scripts.', preference: 30, platforms: win }),
    shellProvider('bash', { id: 'bash', name: 'Bash', description: 'Git Bash on Windows, system bash elsewhere.', preference: process.platform === 'win32' ? 20 : 10 }),
    shellProvider('wsl', { id: 'wsl', name: 'WSL', description: 'Bash inside the default Windows Subsystem for Linux distribution (optional).', preference: 40, platforms: win }),
    {
      id: 'process',
      name: 'Direct executable',
      description: 'Run a program with an argument list and no shell in between.',
      category: 'shell',
      builtin: true,
      async detect() {
        return { installed: true, version: process.versions.node, path: process.execPath, auth: { required: false, state: 'not_required', message: null }, message: null };
      },
      operations: [
        operation({
          id: 'process.exec',
          title: 'Run a program',
          description: 'Run one executable with arguments (no shell). Use this when quoting through a shell would be error-prone.',
          input: execInput,
          level: 2,
          classify: (input) => classifyScript([input.command, ...input.args].join(' ')),
          async run(input, ctx) {
            let cwd = ctx.cwd;
            let command = input.command;
            try {
              if (input.cwd) cwd = resolveInside(ctx.roots, ctx.cwd, input.cwd);
              if (/[\\/]/.test(command)) command = resolveInside(ctx.roots, ctx.cwd, command);
            } catch (error) {
              return failure('OUTSIDE_ROOT', (error as Error).message);
            }
            const lines: string[] = [];
            const errs: string[] = [];
            const handle = runProcess({
              command,
              args: input.args,
              cwd,
              env: ctx.env,
              stdin: input.stdin,
              timeoutMs: (input.timeoutSec ?? Math.round(ctx.timeoutMs / 1000)) * 1000,
              onLine: (stream, line) => {
                const text = redact(line);
                (stream === 'stdout' ? lines : errs).push(text);
                ctx.onLine?.(stream, text);
              },
            });
            const abort = () => void handle.cancel();
            ctx.signal.addEventListener('abort', abort, { once: true });
            const result = await handle.done;
            ctx.signal.removeEventListener('abort', abort);
            const stdout = clip(lines.join('\n'));
            const stderr = clip(errs.join('\n'), 16_000);
            if (result.spawnError) return failure('FAILED', `Could not start ${path.basename(command)}: ${result.spawnError}`);
            if (result.timedOut) return failure('TIMEOUT', 'Timed out', { stdout, stderr });
            if (result.cancelled) return failure('CANCELLED', 'Stopped', { stdout, stderr });
            return { ok: result.exitCode === 0, summary: `${path.basename(command)} exited with ${result.exitCode}`, stdout, stderr, exitCode: result.exitCode, ...(result.exitCode === 0 ? {} : { error: { code: 'FAILED' as const, message: `Exited with ${result.exitCode}` } }) };
          },
        }),
      ],
    },
  ];
}
