import { runProcess } from '@acc/executor';
import { classifyCommand } from '@acc/security';
import { z } from 'zod';
import { detectExecutable } from '../detect.js';
import { resolveInside } from '../paths.js';
import { builtinDetection, failure, operation, type ToolProvider } from '../sdk.js';

/**
 * Providers backed by orchestrator services (V2 plan §12, §16, §35, §39):
 * long-running task processes, interactive terminals, checkpoints, the
 * privileged helper, and VS Code. The orchestrator supplies the hosts; a
 * session without one reports the capability as unavailable.
 */

const shellKind = z.enum(['powershell', 'cmd', 'bash', 'wsl']);

export function hostedProviders(): ToolProvider[] {
  return [
    {
      id: 'processes',
      name: 'Task processes',
      description: 'Development servers, watchers and emulators started for a task, stopped when it ends.',
      category: 'process',
      builtin: true,
      async detect() {
        return builtinDetection();
      },
      operations: [
        operation({
          id: 'process.start',
          title: 'Start a background process',
          description: 'Start a long-running command (dev server, watcher) owned by this task. Give `port`/`readyUrl` to wait until it answers. It is stopped automatically when the task ends.',
          input: z.object({
            name: z.string().min(1).max(60),
            command: z.string().min(1).max(2000),
            shell: shellKind.optional(),
            cwd: z.string().max(1000).optional(),
            port: z.number().int().min(1).max(65535).optional(),
            readyUrl: z.string().url().max(1000).optional(),
            readyTimeoutSec: z.number().int().min(1).max(600).default(60),
          }),
          level: 2,
          longRunning: true,
          classify: (input) => {
            const c = classifyCommand(input.command);
            return { level: c.level === 1 ? 2 : c.level, risk: c.risk, reasons: ['Starts a background process', ...c.reasons], effects: ['process', ...c.effects], production: c.production };
          },
          async run(input, ctx) {
            if (!ctx.processes) return failure('UNAVAILABLE', 'Background processes are not available in this session');
            let cwd = ctx.cwd;
            try {
              if (input.cwd) cwd = resolveInside(ctx.roots, ctx.cwd, input.cwd);
            } catch (error) {
              return failure('OUTSIDE_ROOT', (error as Error).message);
            }
            const info = await ctx.processes.start({ name: input.name, command: input.command, shell: input.shell, cwd, port: input.port ?? null, readyUrl: input.readyUrl ?? null, readyTimeoutSec: input.readyTimeoutSec });
            const up = info.status === 'healthy' || (info.status === 'running' && !input.readyUrl && !input.port);
            return {
              ok: up,
              summary: up ? `${input.name} is ${info.status}${info.url ? ` at ${info.url}` : ''} (process ${info.id})` : `${input.name} did not come up (${info.status}); read process.logs ${info.id}`,
              output: info,
              evidence: [`process ${input.name} → ${info.status}`],
              ...(up ? {} : { error: { code: 'FAILED' as const, message: `${input.name} is ${info.status}` } }),
            };
          },
        }),
        operation({
          id: 'process.stop',
          title: 'Stop a background process',
          description: 'Stop a process this task started (and its children).',
          input: z.object({ id: z.string().min(1).max(100) }),
          level: 2,
          async run(input, ctx) {
            if (!ctx.processes) return failure('UNAVAILABLE', 'Background processes are not available in this session');
            const info = await ctx.processes.stop(input.id, 'stopped by a tool call');
            return { ok: true, summary: `${info.name} ${info.status}`, output: info };
          },
        }),
        operation({
          id: 'process.list',
          title: 'List background processes',
          description: "This task's background processes with status, port and URL.",
          input: z.object({}),
          level: 1,
          async run(_input, ctx) {
            const list = ctx.processes?.list() ?? [];
            return { ok: true, summary: `${list.length} process(es)`, output: { processes: list } };
          },
        }),
        operation({
          id: 'process.logs',
          title: 'Read process output',
          description: 'Last lines a background process printed.',
          input: z.object({ id: z.string().min(1).max(100), lines: z.number().int().min(1).max(5000).default(200) }),
          level: 1,
          async run(input, ctx) {
            if (!ctx.processes) return failure('UNAVAILABLE', 'Background processes are not available in this session');
            const lines = ctx.processes.logs(input.id, input.lines);
            return { ok: true, summary: `${lines.length} line(s)`, stdout: lines.join('\n') };
          },
        }),
      ],
    },
    {
      id: 'terminal',
      name: 'Interactive terminal',
      description: 'Pseudo-terminal sessions for interactive programs (prompts, REPLs, installers).',
      category: 'terminal',
      builtin: true,
      async detect() {
        return builtinDetection();
      },
      operations: [
        operation({
          id: 'terminal.start',
          title: 'Open a terminal',
          description: 'Start an interactive shell session (PTY). Use terminal.send to type and terminal.read to see output. Every line you send is classified first.',
          input: z.object({ shell: shellKind.default(process.platform === 'win32' ? 'powershell' : 'bash'), cols: z.number().int().min(20).max(400).default(120), rows: z.number().int().min(5).max(200).default(30) }),
          level: 2,
          async run(input, ctx) {
            if (!ctx.terminals) return failure('UNAVAILABLE', 'Terminals are not available in this session');
            const t = await ctx.terminals.start({ shell: input.shell, cwd: ctx.cwd, cols: input.cols, rows: input.rows });
            return { ok: true, summary: `Terminal ${t.id} started`, output: t };
          },
        }),
        operation({
          id: 'terminal.send',
          title: 'Type into a terminal',
          description: 'Send input to a terminal. End a command with "\\n" (Enter). The text is classified like a command.',
          input: z.object({ id: z.string().min(1).max(100), input: z.string().min(1).max(20_000) }),
          level: 2,
          classify: (input) => {
            const c = classifyCommand(input.input);
            return { level: c.level === 1 ? 2 : c.level, risk: c.risk, reasons: c.reasons, effects: c.effects, production: c.production };
          },
          async run(input, ctx) {
            if (!ctx.terminals) return failure('UNAVAILABLE', 'Terminals are not available in this session');
            await ctx.terminals.send(input.id, input.input);
            await new Promise((r) => setTimeout(r, 300));
            const out = ctx.terminals.read(input.id);
            return { ok: true, summary: `Sent ${input.input.length} character(s)`, output: { cursor: out.cursor, exited: out.exited }, stdout: out.output.slice(-8000) };
          },
        }),
        operation({
          id: 'terminal.read',
          title: 'Read terminal output',
          description: 'Output since a cursor (0 = everything kept).',
          input: z.object({ id: z.string().min(1).max(100), since: z.number().int().min(0).default(0) }),
          level: 1,
          async run(input, ctx) {
            if (!ctx.terminals) return failure('UNAVAILABLE', 'Terminals are not available in this session');
            const out = ctx.terminals.read(input.id, input.since);
            return { ok: true, summary: out.exited ? `Terminal exited (${out.exitCode})` : `${out.output.length} character(s)`, output: { cursor: out.cursor, exited: out.exited, exitCode: out.exitCode }, stdout: out.output.slice(-32_000) };
          },
        }),
        operation({
          id: 'terminal.stop',
          title: 'Close a terminal',
          description: 'End a terminal session and everything running in it.',
          input: z.object({ id: z.string().min(1).max(100) }),
          level: 2,
          async run(input, ctx) {
            if (!ctx.terminals) return failure('UNAVAILABLE', 'Terminals are not available in this session');
            await ctx.terminals.stop(input.id);
            return { ok: true, summary: `Terminal ${input.id} closed` };
          },
        }),
      ],
    },
    {
      id: 'checkpoints',
      name: 'Checkpoints',
      description: 'Recoverable snapshots of the task working tree.',
      category: 'checkpoint',
      builtin: true,
      async detect() {
        return builtinDetection();
      },
      operations: [
        operation({
          id: 'checkpoint.create',
          title: 'Create a checkpoint',
          description: 'Snapshot the working tree before a risky change so it can be rolled back.',
          input: z.object({ label: z.string().min(1).max(120) }),
          level: 2,
          async run(input, ctx) {
            if (!ctx.checkpoints) return failure('UNAVAILABLE', 'Checkpoints need a task');
            const cp = await ctx.checkpoints.create(input.label);
            return cp ? { ok: true, summary: `Checkpoint ${cp.seq}: ${cp.label}`, output: cp } : failure('UNAVAILABLE', 'No Git baseline yet, so there is nothing to checkpoint');
          },
        }),
        operation({
          id: 'checkpoint.list',
          title: 'List checkpoints',
          description: "This task's checkpoints.",
          input: z.object({}),
          level: 1,
          async run(_input, ctx) {
            const list = ctx.checkpoints?.list() ?? [];
            return { ok: true, summary: `${list.length} checkpoint(s)`, output: { checkpoints: list } };
          },
        }),
        operation({
          id: 'checkpoint.restore',
          title: 'Roll back to a checkpoint',
          description: "Restore the task's files to a checkpoint (your own pre-existing work is never touched; a safety checkpoint is taken first).",
          input: z.object({ id: z.string().min(1).max(100) }),
          level: 3,
          classify: () => ({ reasons: ['Rolls task files back to a checkpoint'], effects: ['filesystem', 'git'] }),
          async run(input, ctx) {
            if (!ctx.checkpoints) return failure('UNAVAILABLE', 'Checkpoints need a task');
            const r = await ctx.checkpoints.restore(input.id);
            return { ok: true, summary: `Rolled back: ${r.restored} restored, ${r.removed} removed, ${r.skipped} of your files untouched`, output: r };
          },
        }),
      ],
    },
    {
      id: 'privileged',
      name: 'Privileged helper',
      description: 'A narrow, allowlisted set of administrator operations, each confirmed through Windows UAC.',
      category: 'system',
      platforms: ['win32'],
      builtin: true,
      async detect() {
        return builtinDetection('allowlisted operations only');
      },
      operations: [
        operation({
          id: 'system.privileged',
          title: 'Administrator operation (allowlisted)',
          description: 'Install an allowlisted package with winget, add/remove an ACC firewall rule for a TCP port, or start/stop an allowlisted service. Always needs your approval and a UAC prompt.',
          input: z.object({
            operation: z.enum(['install_package', 'firewall_allow_port', 'firewall_remove_rule', 'service_start', 'service_stop', 'service_restart']),
            params: z.record(z.string(), z.union([z.string().max(200), z.number()])).default({}),
          }),
          level: 5,
          classify: () => ({ level: 5, risk: 'dangerous', reasons: ['Changes the machine with administrator rights'], effects: ['privilege', 'persistence'] }),
          async run(input, ctx) {
            if (!ctx.privileged) return failure('UNAVAILABLE', 'The privileged helper is not available here');
            const r = await ctx.privileged.run(input.operation, input.params);
            return r.ok ? { ok: true, summary: r.message } : failure('FAILED', r.message);
          },
        }),
      ],
    },
    {
      id: 'vscode',
      name: 'VS Code',
      description: 'Open files and diffs in VS Code on this machine.',
      category: 'editor',
      detect: (ctx) => detectExecutable(ctx, ['code']),
      operations: [
        operation({
          id: 'editor.open_file',
          title: 'Open a file in VS Code',
          description: 'Show a file (optionally at a line) in the operator’s VS Code.',
          input: z.object({ path: z.string().min(1).max(1000), line: z.number().int().min(1).optional() }),
          level: 1,
          async run(input, ctx) {
            let file: string;
            try {
              file = resolveInside(ctx.roots, ctx.cwd, input.path);
            } catch (error) {
              return failure('OUTSIDE_ROOT', (error as Error).message);
            }
            const handle = runProcess({ command: ctx.detection('vscode')?.path ?? 'code', args: ['--reuse-window', '-g', `${file}${input.line ? `:${input.line}` : ''}`], cwd: ctx.cwd, env: ctx.env, timeoutMs: 20_000 });
            const r = await handle.done;
            return r.exitCode === 0 ? { ok: true, summary: `Opened ${input.path} in VS Code` } : failure('FAILED', r.spawnError ?? `code exited with ${r.exitCode}`);
          },
        }),
        operation({
          id: 'editor.open_diff',
          title: 'Open a diff in VS Code',
          description: 'Compare two files side by side in VS Code.',
          input: z.object({ left: z.string().min(1).max(1000), right: z.string().min(1).max(1000) }),
          level: 1,
          async run(input, ctx) {
            let left: string;
            let right: string;
            try {
              left = resolveInside(ctx.roots, ctx.cwd, input.left);
              right = resolveInside(ctx.roots, ctx.cwd, input.right);
            } catch (error) {
              return failure('OUTSIDE_ROOT', (error as Error).message);
            }
            const r = await runProcess({ command: ctx.detection('vscode')?.path ?? 'code', args: ['--reuse-window', '--diff', left, right], cwd: ctx.cwd, env: ctx.env, timeoutMs: 20_000 }).done;
            return r.exitCode === 0 ? { ok: true, summary: `Opened diff in VS Code` } : failure('FAILED', r.spawnError ?? `code exited with ${r.exitCode}`);
          },
        }),
      ],
    },
  ];
}
