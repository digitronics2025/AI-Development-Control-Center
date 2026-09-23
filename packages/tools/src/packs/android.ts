import { existsSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '@acc/executor';
import { redact } from '@acc/security';
import { z } from 'zod';
import { clip, detectExecutable, run } from '../detect.js';
import { resolveInside } from '../paths.js';
import { failure, missing, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';

/**
 * Android (V2 plan §26): Gradle (the project's wrapper first) and ADB. The
 * loop build → install → launch → logcat → screenshot is available to
 * agents; wiping app data or uninstalling needs Level 3+.
 */

const pkg = z.string().min(3).max(200).regex(/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/, 'Not an Android package name');
const serial = z.string().min(1).max(100).regex(/^[\w.:-]+$/).optional().describe('Device serial when several are connected.');

async function adb(ctx: OperationContext, device: string | undefined, args: string[], timeoutMs = 60_000, binary = false): Promise<{ code: number | null; stdout: string; stderr: string; spawnError: string | null; buffer?: Buffer }> {
  const exe = ctx.detection('adb')?.path ?? 'adb';
  const full = [...(device ? ['-s', device] : []), ...args];
  if (!binary) return run(exe, full, { cwd: ctx.cwd, env: ctx.env, timeoutMs, maxBytes: 8 * 1024 * 1024 });
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(exe, full, { env: ctx.env, windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (e) => resolve({ code: null, stdout: '', stderr: '', spawnError: e.message }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: '', stderr, spawnError: null, buffer: Buffer.concat(chunks) });
    });
  });
}

function res(r: { code: number | null; stdout: string; stderr: string; spawnError: string | null }, summary: string, output?: unknown): OperationResult {
  if (r.spawnError) return failure('NOT_INSTALLED', 'ADB is not installed (Android SDK platform-tools)');
  if (r.code !== 0) return failure(/no devices|device .* not found|unauthorized|offline/i.test(r.stderr) ? 'UNAVAILABLE' : 'FAILED', redact(r.stderr.trim() || r.stdout.trim()).slice(0, 500), { stdout: clip(redact(r.stdout), 8000) });
  return { ok: true, summary, stdout: clip(redact(r.stdout)), ...(output !== undefined ? { output } : {}) };
}

function gradleWrapper(cwd: string): string | null {
  const name = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  return existsSync(path.join(cwd, name)) ? path.join(cwd, name) : null;
}

export function androidProviders(): ToolProvider[] {
  return [
    {
      id: 'adb',
      name: 'ADB',
      description: 'Android Debug Bridge: devices, installs, launches, logcat and screenshots.',
      category: 'android',
      detect: (ctx) => detectExecutable(ctx, ['adb'], ['version']),
      operations: [
        operation({
          id: 'android.devices',
          title: 'Connected devices',
          description: 'Devices and emulators ADB can see, with their state.',
          input: z.object({}),
          level: 1,
          async run(_input, ctx) {
            const r = await adb(ctx, undefined, ['devices', '-l'], 20_000);
            const devices = r.stdout
              .split('\n')
              .slice(1)
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => {
                const [id, state, ...rest] = l.split(/\s+/);
                return { serial: id, state, details: rest.join(' ') };
              });
            return res(r, `${devices.filter((d) => d.state === 'device').length} device(s) ready`, { devices });
          },
        }),
        operation({
          id: 'android.device_info',
          title: 'Device information',
          description: 'Model, Android version and screen size.',
          input: z.object({ device: serial }),
          level: 1,
          async run(input, ctx) {
            const props = await adb(ctx, input.device, ['shell', 'getprop'], 20_000);
            if (props.code !== 0) return res(props, '');
            const get = (k: string) => new RegExp(`\\[${k.replace(/\./g, '\\.')}\\]: \\[([^\\]]*)\\]`).exec(props.stdout)?.[1] ?? null;
            const size = await adb(ctx, input.device, ['shell', 'wm', 'size'], 20_000);
            return { ok: true, summary: `${get('ro.product.model')} · Android ${get('ro.build.version.release')}`, output: { model: get('ro.product.model'), android: get('ro.build.version.release'), sdk: get('ro.build.version.sdk'), screen: size.stdout.trim() } };
          },
        }),
        operation({
          id: 'android.install_apk',
          title: 'Install an APK',
          description: 'Install (or replace) an APK from the repository on a device.',
          input: z.object({ apk: z.string().min(1).max(1000), device: serial }),
          level: 2,
          async run(input, ctx) {
            let apk: string;
            try {
              apk = resolveInside(ctx.roots, ctx.cwd, input.apk);
            } catch (error) {
              return failure('OUTSIDE_ROOT', (error as Error).message);
            }
            const r = await adb(ctx, input.device, ['install', '-r', '-t', apk], 300_000);
            return { ...res(r, `Installed ${path.basename(apk)}`), evidence: r.code === 0 ? [`installed ${path.basename(apk)}`] : [] };
          },
        }),
        operation({
          id: 'android.launch',
          title: 'Launch an app',
          description: 'Start an app (its launcher activity, or a given activity).',
          input: z.object({ package: pkg, activity: z.string().max(300).regex(/^[\w.$/]+$/).optional(), device: serial }),
          level: 2,
          async run(input, ctx) {
            const args = input.activity ? ['shell', 'am', 'start', '-W', '-n', `${input.package}/${input.activity}`] : ['shell', 'monkey', '-p', input.package, '-c', 'android.intent.category.LAUNCHER', '1'];
            const r = await adb(ctx, input.device, args, 60_000);
            return { ...res(r, `Launched ${input.package}`), evidence: r.code === 0 ? [`launched ${input.package}`] : [] };
          },
        }),
        operation({
          id: 'android.logcat',
          title: 'Read logcat',
          description: 'Recent log lines, optionally only from one app (by package) and at or above a priority.',
          input: z.object({ package: pkg.optional(), lines: z.number().int().min(10).max(10_000).default(500), priority: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).default('I'), device: serial }),
          level: 1,
          async run(input, ctx) {
            let pidFilter: string[] = [];
            if (input.package) {
              const pid = await adb(ctx, input.device, ['shell', 'pidof', input.package], 15_000);
              if (pid.stdout.trim()) pidFilter = [`--pid=${pid.stdout.trim().split(/\s+/)[0]}`];
            }
            const r = await adb(ctx, input.device, ['logcat', '-d', '-t', String(input.lines), ...pidFilter, `*:${input.priority}`], 60_000);
            const crashes = r.stdout.split('\n').filter((l) => /FATAL EXCEPTION|ANR in|AndroidRuntime: /.test(l)).length;
            return { ...res(r, `${r.stdout.split('\n').length} log line(s)${crashes ? ` · ${crashes} crash line(s)` : ''}`, { crashLines: crashes }), evidence: [`logcat${input.package ? ` ${input.package}` : ''}: ${crashes} crash line(s)`] };
          },
        }),
        operation({
          id: 'android.screenshot',
          title: 'Device screenshot',
          description: 'Capture the device screen as an artifact.',
          input: z.object({ device: serial, name: z.string().max(60).regex(/^[\w-]+$/).default('device') }),
          level: 1,
          async run(input, ctx) {
            const r = await adb(ctx, input.device, ['exec-out', 'screencap', '-p'], 60_000, true);
            if (r.spawnError || r.code !== 0 || !r.buffer?.length) return res({ ...r, code: r.code ?? 1, stderr: r.stderr || 'no image' }, '');
            const saved = ctx.artifacts ? await ctx.artifacts.write({ name: `${input.name}.png`, type: 'screenshot', content: r.buffer, mime: 'image/png' }) : null;
            return { ok: true, summary: `Screenshot ${input.name}.png (${r.buffer.length} bytes)`, artifacts: saved ? [saved] : [] };
          },
        }),
        operation({
          id: 'android.screenrecord',
          title: 'Record the screen',
          description: 'Record the device screen for a few seconds and save the video as an artifact.',
          input: z.object({ seconds: z.number().int().min(1).max(60).default(10), device: serial }),
          level: 1,
          async run(input, ctx) {
            const remote = '/sdcard/acc-record.mp4';
            const rec = await adb(ctx, input.device, ['shell', 'screenrecord', '--time-limit', String(input.seconds), remote], (input.seconds + 20) * 1000);
            if (rec.code !== 0) return res(rec, '');
            const pulled = await adb(ctx, input.device, ['exec-out', 'cat', remote], 120_000, true);
            await adb(ctx, input.device, ['shell', 'rm', '-f', remote], 20_000);
            const saved = pulled.buffer?.length && ctx.artifacts ? await ctx.artifacts.write({ name: `screen-${Date.now()}.mp4`, type: 'tool-output', content: pulled.buffer, mime: 'video/mp4' }) : null;
            return { ok: Boolean(pulled.buffer?.length), summary: `Recorded ${input.seconds}s`, artifacts: saved ? [saved] : [] };
          },
        }),
        operation({
          id: 'android.grant_permission',
          title: 'Grant an app permission',
          description: 'Grant a runtime permission to an app under test.',
          input: z.object({ package: pkg, permission: z.string().regex(/^android\.permission\.[A-Z_]+$/), device: serial }),
          level: 2,
          async run(input, ctx) {
            return res(await adb(ctx, input.device, ['shell', 'pm', 'grant', input.package, input.permission], 20_000), `Granted ${input.permission}`);
          },
        }),
        operation({
          id: 'android.clear_data',
          title: 'Clear app data',
          description: "Wipe an app's data on the device (Level 3: it deletes that app's local state).",
          input: z.object({ package: pkg, device: serial }),
          level: 3,
          classify: () => ({ reasons: ["Deletes an app's data on the device"], effects: ['filesystem'] }),
          async run(input, ctx) {
            return res(await adb(ctx, input.device, ['shell', 'pm', 'clear', input.package], 30_000), `Cleared data of ${input.package}`);
          },
        }),
        operation({
          id: 'android.uninstall',
          title: 'Uninstall an app',
          description: 'Remove an app from the device (Level 3).',
          input: z.object({ package: pkg, device: serial }),
          level: 3,
          classify: () => ({ reasons: ['Removes an app and its data from the device'], effects: ['filesystem'] }),
          async run(input, ctx) {
            return res(await adb(ctx, input.device, ['uninstall', input.package], 60_000), `Uninstalled ${input.package}`);
          },
        }),
      ],
    },
    {
      id: 'gradle',
      name: 'Gradle',
      description: "The project's Gradle wrapper (or a global Gradle) for builds and tests.",
      category: 'android',
      async detect(ctx) {
        const wrapper = ctx.cwd ? gradleWrapper(ctx.cwd) : null;
        if (wrapper) return { installed: true, version: null, path: wrapper, auth: { required: false, state: 'not_required', message: null }, message: 'project wrapper' };
        const global = await detectExecutable(ctx, ['gradle']);
        return global.installed ? global : missing('No gradlew in the repository and no gradle on PATH');
      },
      operations: [
        operation({
          id: 'android.gradle',
          title: 'Run a Gradle task',
          description: 'Build, test or lint with Gradle, e.g. assembleDebug, testDebugUnitTest, lint, connectedAndroidTest.',
          input: z.object({ tasks: z.array(z.string().regex(/^[\w:.-]+$/)).min(1).max(10), args: z.array(z.string().regex(/^--?[\w.=-]+$/)).max(20).default([]), timeoutSec: z.number().int().min(30).max(7200).default(1800) }),
          level: 2,
          async run(input, ctx) {
            const exe = gradleWrapper(ctx.cwd) ?? ctx.detection('gradle')?.path ?? 'gradle';
            const lines: string[] = [];
            const handle = runProcess({
              command: exe,
              args: [...input.tasks, '--console=plain', ...input.args],
              cwd: ctx.cwd,
              env: ctx.env,
              timeoutMs: input.timeoutSec * 1000,
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
            const apks = input.tasks.some((t) => /assemble/i.test(t)) ? lines.filter((l) => /\.apk\b/.test(l)).slice(-5) : [];
            const ok = result.exitCode === 0;
            return {
              ok,
              summary: `gradle ${input.tasks.join(' ')} ${ok ? 'succeeded' : 'failed'} in ${Math.round(result.durationMs / 1000)}s`,
              stdout: clip(lines.slice(-400).join('\n')),
              exitCode: result.exitCode,
              evidence: [`gradle ${input.tasks.join(' ')} → ${ok ? 'BUILD SUCCESSFUL' : 'failed'}`, ...apks],
              ...(ok ? {} : { error: { code: result.timedOut ? ('TIMEOUT' as const) : ('FAILED' as const), message: lines.filter((l) => /FAILURE|error:|What went wrong/i.test(l)).slice(0, 3).join(' ') || `Exited with ${result.exitCode}` } }),
            };
          },
        }),
      ],
    },
  ];
}
