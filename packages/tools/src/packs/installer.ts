import path from 'node:path';
import { runProcess, which } from '@acc/executor';
import { redact } from '@acc/security';
import { INSTALLABLE_TOOLS, INSTALLABLE_TOOL_IDS, type InstallableTool } from '@acc/shared';
import { z } from 'zod';
import { clip, run } from '../detect.js';
import { builtinDetection, failure, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';

/**
 * Installs programs from a reviewed catalog (`INSTALLABLE_TOOLS` in
 * @acc/shared) for the user account only: exact winget package ids with
 * `--scope user`, or `npm install -g` for Node CLIs. Nothing outside the
 * catalog can be named, so no call can install an arbitrary package. The
 * learning loop uses it (docs/systems/learning.md); like `npm -g` in the
 * command classifier it is Level 3 — software for the whole user account.
 */

const WINGET_ALREADY = /already installed|No available upgrade found|No newer package versions/i;

async function exec(ctx: OperationContext, command: string, args: string[]): Promise<OperationResult & { text: string }> {
  const exe = (await which(command, ctx.env)) ?? command;
  const lines: string[] = [];
  const handle = runProcess({
    command: exe,
    args,
    cwd: ctx.tempDir,
    env: ctx.env,
    timeoutMs: ctx.timeoutMs,
    onLine: (stream, line) => {
      const text = redact(line);
      lines.push(text);
      ctx.onLine?.(stream, text);
    },
  });
  const abort = () => void handle.cancel();
  ctx.signal.addEventListener('abort', abort, { once: true });
  const result = await handle.done;
  ctx.signal.removeEventListener('abort', abort);
  const text = lines.join('\n');
  const stdout = clip(text, 16_000);
  if (result.spawnError) return { ...failure('NOT_INSTALLED', `${command} is not available on this machine`), text };
  if (result.timedOut) return { ...failure('TIMEOUT', `${command} timed out`, { stdout }), text };
  if (result.cancelled) return { ...failure('CANCELLED', `${command} stopped`, { stdout }), text };
  const ok = result.exitCode === 0;
  return { ok, summary: '', stdout, exitCode: result.exitCode, text, ...(ok ? {} : { error: { code: 'FAILED' as const, message: `Exited with ${result.exitCode}` } }) };
}

/**
 * PATH as a new process would see it: the current entries, then any the
 * user and machine environment gained since this process started (an
 * install adds its folder there, which a running process never sees).
 * Windows only; elsewhere the current PATH.
 */
export async function refreshedPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key] ?? '';
  if (process.platform !== 'win32') return current;
  const read = async (hive: string): Promise<string[]> => {
    const r = await run('reg', ['query', hive, '/v', 'Path'], { env, timeoutMs: 10_000 }).catch(() => null);
    const m = r ? /\bPath\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im.exec(r.stdout) : null;
    if (!m) return [];
    const expanded = m[1]!.trim().replace(/%([^%]+)%/g, (all, name: string) => {
      const k = Object.keys(env).find((x) => x.toUpperCase() === name.toUpperCase());
      return k ? (env[k] ?? all) : all;
    });
    return expanded.split(';').filter(Boolean);
  };
  const seen = new Set(current.split(path.delimiter).filter(Boolean).map((p) => p.toLowerCase().replace(/[\\/]+$/, '')));
  const added: string[] = [];
  for (const entry of [...(await read('HKCU\\Environment')), ...(await read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'))]) {
    const norm = entry.toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(norm)) continue;
    seen.add(norm);
    added.push(entry);
  }
  return added.length ? [current, ...added].filter(Boolean).join(path.delimiter) : current;
}

/** Where a catalog tool's first command resolves, with PATH refreshed. */
export async function locateInstalled(tool: InstallableTool, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const fresh = await refreshedPath(env);
  const probe = { ...env, PATH: fresh, Path: fresh };
  for (const command of tool.commands) {
    const found = await which(command, probe);
    if (found) return found;
  }
  return null;
}

function installArgs(tool: InstallableTool): { command: string; args: string[]; shown: string } {
  if (tool.method.kind === 'winget') {
    const args = ['install', '--id', tool.method.packageId, '--exact', '--scope', 'user', '--silent', '--disable-interactivity', '--accept-source-agreements', '--accept-package-agreements'];
    return { command: 'winget', args, shown: `winget install --id ${tool.method.packageId} --exact --scope user` };
  }
  return { command: 'npm', args: ['install', '-g', tool.method.packageName], shown: `npm install -g ${tool.method.packageName}` };
}

export function installerProvider(): ToolProvider {
  return {
    id: 'installer',
    name: 'Program installer',
    description: 'Installs programs from the reviewed catalog for your user account (winget, npm).',
    category: 'system',
    builtin: true,
    async detect() {
      return builtinDetection(`${INSTALLABLE_TOOLS.length} programs in the catalog`);
    },
    operations: [
      operation({
        id: 'software.catalog',
        title: 'List installable programs',
        description: 'The reviewed catalog of programs the Control Center can install for this user, and whether each is already present.',
        input: z.object({}),
        level: 1,
        async run(_input, ctx) {
          const rows = await Promise.all(INSTALLABLE_TOOLS.map(async (t) => ({ id: t.id, name: t.name, purpose: t.purpose, commands: t.commands, installedAt: await locateInstalled(t, ctx.env) })));
          return { ok: true, summary: `${rows.filter((r) => r.installedAt).length} of ${rows.length} catalog programs present`, output: { tools: rows } };
        },
      }),
      operation({
        id: 'software.install',
        title: 'Install a catalog program',
        description: 'Install one program from the reviewed catalog for the current user (no administrator rights). Only catalog ids are accepted.',
        input: z.object({ toolId: z.enum(INSTALLABLE_TOOL_IDS) }),
        level: 3,
        classify: () => ({ level: 3, risk: 'elevated', reasons: ['Installs software for the whole user account'], effects: ['persistence', 'network'], production: false }),
        async run(input, ctx) {
          const tool = INSTALLABLE_TOOLS.find((t) => t.id === input.toolId)!;
          const before = await locateInstalled(tool, ctx.env);
          if (before) return { ok: true, summary: `${tool.name} is already installed (${before})`, output: { toolId: tool.id, path: before, alreadyInstalled: true } };
          if (tool.method.kind === 'winget' && process.platform !== 'win32') return failure('UNAVAILABLE', `${tool.name} is installed with winget, which is Windows-only`);
          const { command, args, shown } = installArgs(tool);
          const r = await exec(ctx, command, args);
          if (!r.ok && !(tool.method.kind === 'winget' && WINGET_ALREADY.test(r.text))) {
            const why = r.error?.code === 'NOT_INSTALLED' ? r.summary : `${shown} failed: ${redact(r.text.split('\n').filter(Boolean).slice(-3).join(' ')).slice(0, 300) || r.summary}`;
            return failure(r.error?.code ?? 'FAILED', why, { stdout: r.stdout });
          }
          const after = await locateInstalled(tool, ctx.env);
          if (!after) return failure('FAILED', `${shown} finished, but ${tool.commands[0]} cannot be found on PATH`, { stdout: r.stdout });
          return { ok: true, summary: `Installed ${tool.name} (${after})`, stdout: r.stdout, output: { toolId: tool.id, path: after, alreadyInstalled: false }, evidence: [`${tool.commands[0]} found at ${after}`] };
        },
      }),
    ],
  };
}
