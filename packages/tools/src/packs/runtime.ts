import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess, which } from '@acc/executor';
import { classifyCommand, redact } from '@acc/security';
import { z } from 'zod';
import { clip, detectExecutable } from '../detect.js';
import { expandPackageScripts } from '../package-scripts.js';
import { resolveInside } from '../paths.js';
import { failure, operation, type OperationContext, type OperationResult, type ToolProvider, type ToolRisk } from '../sdk.js';

/** Node, Python and Java toolchains (V2 plan §2 scope). Project dependency installs are Level 2 (allowed in Autopilot). */

export function packageManager(cwd: string): 'pnpm' | 'yarn' | 'bun' | 'npm' | null {
  if (!existsSync(path.join(cwd, 'package.json'))) return null;
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(cwd, 'bun.lockb')) || existsSync(path.join(cwd, 'bun.lock'))) return 'bun';
  return 'npm';
}

export function declaredDependencies(cwd: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
  } catch {
    return [];
  }
}

async function exec(ctx: OperationContext, command: string, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<OperationResult> {
  const exe = (await which(command, ctx.env)) ?? command;
  const out: string[] = [];
  const err: string[] = [];
  const handle = runProcess({
    command: exe,
    args,
    cwd: opts.cwd ?? ctx.cwd,
    env: ctx.env,
    timeoutMs: opts.timeoutMs ?? ctx.timeoutMs,
    onLine: (stream, line) => {
      const text = redact(line);
      (stream === 'stdout' ? out : err).push(text);
      ctx.onLine?.(stream, text);
    },
  });
  const abort = () => void handle.cancel();
  ctx.signal.addEventListener('abort', abort, { once: true });
  const result = await handle.done;
  ctx.signal.removeEventListener('abort', abort);
  const stdout = clip(out.join('\n'));
  const stderr = clip(err.join('\n'), 16_000);
  const shown = `${command} ${args.join(' ')}`.trim();
  if (result.spawnError) return failure('NOT_INSTALLED', `${command} could not start: ${result.spawnError}`);
  if (result.timedOut) return failure('TIMEOUT', `${shown} timed out`, { stdout, stderr });
  if (result.cancelled) return failure('CANCELLED', `${shown} stopped`, { stdout, stderr });
  const ok = result.exitCode === 0;
  return { ok, summary: `${shown} ${ok ? 'succeeded' : `failed (exit ${result.exitCode})`} in ${(result.durationMs / 1000).toFixed(1)}s`, stdout, stderr, exitCode: result.exitCode, ...(ok ? {} : { error: { code: 'FAILED' as const, message: `Exited with ${result.exitCode}` } }) };
}

function risk(command: string): Partial<ToolRisk> {
  const c = classifyCommand(command);
  return { level: c.level, risk: c.risk, reasons: c.reasons, effects: c.effects, production: c.production };
}

const scriptName = z.string().min(1).max(200).regex(/^[\w:.@/-]+$/);
const pkgName = z.string().min(1).max(214).regex(/^(?:@[\w.-]+\/)?[\w.-]+(?:@[\w.^~<>=*-]+)?$/, 'Not a package name');

export function runtimeProviders(): ToolProvider[] {
  return [
    {
      id: 'node',
      name: 'Node.js',
      description: 'Node.js with npm, pnpm, yarn or bun for the repository.',
      category: 'runtime',
      preference: 10,
      detect: (ctx) => detectExecutable(ctx, ['node']),
      operations: [
        operation({
          id: 'node.install',
          title: 'Install project dependencies',
          description: "Install the repository's dependencies with its own package manager (lockfile respected unless `frozen` is false).",
          input: z.object({ frozen: z.boolean().default(true) }),
          level: 2,
          classify: () => ({ reasons: ['Installs project dependencies'], effects: ['network', 'filesystem'] }),
          async run(input, ctx) {
            const pm = packageManager(ctx.cwd);
            if (!pm) return failure('INVALID_INPUT', 'No package.json in the working directory');
            const args = pm === 'npm' ? [input.frozen ? 'ci' : 'install'] : ['install', ...(input.frozen ? ['--frozen-lockfile'] : [])];
            return exec(ctx, pm, args, { timeoutMs: 15 * 60_000 });
          },
        }),
        operation({
          id: 'node.add_dependency',
          title: 'Add a dependency',
          description: 'Add a package to the project (dev dependency when `dev`). Uses the repository package manager.',
          input: z.object({ packages: z.array(pkgName).min(1).max(20), dev: z.boolean().default(false) }),
          level: 2,
          classify: () => ({ reasons: ['Adds project dependencies'], effects: ['network', 'filesystem'] }),
          async run(input, ctx) {
            const pm = packageManager(ctx.cwd);
            if (!pm) return failure('INVALID_INPUT', 'No package.json in the working directory');
            const verb = pm === 'npm' ? 'install' : 'add';
            const devFlag = input.dev ? (pm === 'npm' ? '--save-dev' : '-D') : null;
            const result = await exec(ctx, pm, [verb, ...(devFlag ? [devFlag] : []), ...input.packages], { timeoutMs: 15 * 60_000 });
            return { ...result, filesChanged: ['package.json'] };
          },
        }),
        operation({
          id: 'node.run_script',
          title: 'Run a package script',
          description: 'Run a script from package.json (e.g. test, build, lint). What the script really runs is classified, not just its name.',
          input: z.object({ script: scriptName, args: z.array(z.string().max(1000)).max(40).default([]), timeoutSec: z.number().int().min(5).max(7200).optional() }),
          level: 2,
          classify: (input, ctx) => risk(expandPackageScripts(ctx.cwd, `${packageManager(ctx.cwd) ?? 'npm'} run ${input.script} ${input.args.join(' ')}`)),
          async run(input, ctx) {
            const pm = packageManager(ctx.cwd) ?? 'npm';
            return exec(ctx, pm, ['run', input.script, ...(input.args.length ? (pm === 'npm' ? ['--', ...input.args] : input.args) : [])], { timeoutMs: input.timeoutSec ? input.timeoutSec * 1000 : undefined });
          },
        }),
        operation({
          id: 'node.exec',
          title: 'Run a package binary',
          description: 'Run a binary installed in the project (npx/pnpm exec), e.g. `tsc --noEmit` or `vitest run file`.',
          input: z.object({ bin: z.string().min(1).max(100).regex(/^[\w@./-]+$/), args: z.array(z.string().max(2000)).max(80).default([]), timeoutSec: z.number().int().min(5).max(7200).optional() }),
          level: 2,
          classify: (input) => risk(`${input.bin} ${input.args.join(' ')}`),
          async run(input, ctx) {
            const pm = packageManager(ctx.cwd) ?? 'npm';
            const [cmd, args] = pm === 'pnpm' ? ['pnpm', ['exec', input.bin, ...input.args]] : pm === 'yarn' ? ['yarn', [input.bin, ...input.args]] : pm === 'bun' ? ['bunx', [input.bin, ...input.args]] : ['npx', ['--no-install', input.bin, ...input.args]];
            return exec(ctx, cmd as string, args as string[], { timeoutMs: input.timeoutSec ? input.timeoutSec * 1000 : undefined });
          },
        }),
        operation({
          id: 'node.info',
          title: 'Node project information',
          description: 'Package manager, scripts and dependency counts of the repository.',
          input: z.object({}),
          level: 1,
          async run(_input, ctx) {
            const pm = packageManager(ctx.cwd);
            if (!pm) return { ok: true, summary: 'Not a Node project', output: { packageManager: null } };
            const pkg = JSON.parse(readFileSync(path.join(ctx.cwd, 'package.json'), 'utf8'));
            return {
              ok: true,
              summary: `${pkg.name ?? 'package'} · ${pm} · ${Object.keys(pkg.scripts ?? {}).length} scripts`,
              output: { packageManager: pm, scripts: pkg.scripts ?? {}, dependencies: Object.keys(pkg.dependencies ?? {}).length, devDependencies: Object.keys(pkg.devDependencies ?? {}).length, engines: pkg.engines ?? null, nodeModules: existsSync(path.join(ctx.cwd, 'node_modules')) },
            };
          },
        }),
      ],
    },
    {
      id: 'pnpm',
      name: 'pnpm',
      description: 'pnpm package manager.',
      category: 'runtime',
      preference: 20,
      detect: (ctx) => detectExecutable(ctx, ['pnpm']),
      operations: [],
    },
    {
      id: 'npm',
      name: 'npm',
      description: 'npm package manager and npx.',
      category: 'runtime',
      preference: 20,
      detect: (ctx) => detectExecutable(ctx, ['npm']),
      operations: [],
    },
    {
      id: 'python',
      name: 'Python',
      description: 'Python with pip (or uv when installed).',
      category: 'runtime',
      detect: (ctx) => detectExecutable(ctx, process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']),
      operations: [
        operation({
          id: 'python.run',
          title: 'Run a Python script',
          description: 'Run a Python file in the repository with arguments.',
          input: z.object({ file: z.string().min(1).max(1000), args: z.array(z.string().max(2000)).max(80).default([]), timeoutSec: z.number().int().min(5).max(7200).optional() }),
          level: 2,
          async run(input, ctx) {
            let file: string;
            try {
              file = resolveInside(ctx.roots, ctx.cwd, input.file);
            } catch (error) {
              return failure('OUTSIDE_ROOT', (error as Error).message);
            }
            const py = ctx.detection('python')?.path ?? 'python';
            return exec(ctx, py, [file, ...input.args], { timeoutMs: input.timeoutSec ? input.timeoutSec * 1000 : undefined });
          },
        }),
        operation({
          id: 'python.install',
          title: 'Install Python requirements',
          description: 'Install requirements.txt (with uv when available, else pip) — into the active virtual environment if there is one.',
          input: z.object({ file: z.string().max(500).default('requirements.txt') }),
          level: 2,
          classify: () => ({ reasons: ['Installs project dependencies'], effects: ['network'] }),
          async run(input, ctx) {
            let file: string;
            try {
              file = resolveInside(ctx.roots, ctx.cwd, input.file);
            } catch (error) {
              return failure('OUTSIDE_ROOT', (error as Error).message);
            }
            if (!existsSync(file)) return failure('INVALID_INPUT', `${input.file} does not exist`);
            const uv = await which('uv', ctx.env);
            if (uv) return exec(ctx, uv, ['pip', 'install', '-r', file], { timeoutMs: 15 * 60_000 });
            const py = ctx.detection('python')?.path ?? 'python';
            return exec(ctx, py, ['-m', 'pip', 'install', '-r', file], { timeoutMs: 15 * 60_000 });
          },
        }),
      ],
    },
    {
      id: 'uv',
      name: 'uv',
      description: 'Fast Python package installer.',
      category: 'runtime',
      detect: (ctx) => detectExecutable(ctx, ['uv']),
      operations: [],
    },
    {
      id: 'java',
      name: 'Java',
      description: 'Java runtime (needed by Gradle and Android builds).',
      category: 'runtime',
      detect: (ctx) => detectExecutable(ctx, ['java'], ['-version']),
      operations: [],
    },
  ];
}

