import { redact } from '@acc/security';
import { z } from 'zod';
import { clip, detectExecutable, run } from '../detect.js';
import { resolveInside } from '../paths.js';
import { failure, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';

/**
 * Docker (V2 plan §25), used when isolation helps. Everything a task creates
 * carries the label `acc.task=<task id>`, so cleanup removes exactly that and
 * nothing else. Acting on containers a task did not create needs Level 3.
 */

const LABEL = 'acc.task';
const nameRe = /^[\w][\w.-]{0,127}$/;
const imageRe = /^[\w][\w./:@-]{0,254}$/;

async function docker(ctx: OperationContext, args: string[], timeoutMs = 120_000): Promise<OperationResult & { raw?: string }> {
  const exe = ctx.detection('docker')?.path ?? 'docker';
  const r = await run(exe, args, { cwd: ctx.cwd, env: ctx.env, timeoutMs, maxBytes: 4 * 1024 * 1024 });
  if (r.spawnError) return failure('NOT_INSTALLED', 'Docker is not installed');
  if (r.code !== 0) {
    const message = redact(r.stderr.trim() || r.stdout.trim()).slice(0, 500);
    return failure(/daemon|pipe.*docker_engine|Is the docker daemon running/i.test(message) ? 'UNAVAILABLE' : 'FAILED', message);
  }
  return { ok: true, summary: '', stdout: clip(redact(r.stdout)), raw: r.stdout };
}

function jsonLines(text: string | undefined): any[] {
  return (text ?? '')
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function taskOwned(ctx: OperationContext, container: string): Promise<boolean> {
  if (!ctx.taskId) return false;
  const r = await docker(ctx, ['inspect', '--format', `{{ index .Config.Labels "${LABEL}" }}`, container], 30_000);
  return r.ok && (r.raw ?? '').trim() === ctx.taskId;
}

export function dockerProvider(): ToolProvider {
  return {
    id: 'docker',
    name: 'Docker',
    description: 'Containers, images, logs and Compose; task-created resources are labelled and cleaned up.',
    category: 'docker',
    async detect(ctx) {
      const d = await detectExecutable(ctx, ['docker']);
      if (!d.installed || !d.path) return d;
      const info = await run(d.path, ['info', '--format', '{{.ServerVersion}}'], { env: ctx.env, timeoutMs: 20_000 });
      return info.code === 0 ? { ...d, message: `engine ${info.stdout.trim()}` } : { ...d, installed: false, message: 'Docker is installed but the engine is not running (start Docker Desktop)' };
    },
    operations: [
      operation({
        id: 'docker.ps',
        title: 'List containers',
        description: 'Running (or all) containers; `taskOnly` limits to containers this task created.',
        input: z.object({ all: z.boolean().default(false), taskOnly: z.boolean().default(false) }),
        level: 1,
        async run(input, ctx) {
          const r = await docker(ctx, ['ps', ...(input.all ? ['-a'] : []), ...(input.taskOnly && ctx.taskId ? ['--filter', `label=${LABEL}=${ctx.taskId}`] : []), '--format', '{{json .}}']);
          if (!r.ok) return r;
          const rows = jsonLines(r.raw).map((c) => ({ id: c.ID, name: c.Names, image: c.Image, status: c.Status, ports: c.Ports }));
          return { ok: true, summary: `${rows.length} container(s)`, output: { containers: rows } };
        },
      }),
      operation({
        id: 'docker.images',
        title: 'List images',
        description: 'Local images.',
        input: z.object({}),
        level: 1,
        async run(_input, ctx) {
          const r = await docker(ctx, ['images', '--format', '{{json .}}']);
          if (!r.ok) return r;
          const rows = jsonLines(r.raw).map((i) => ({ repository: i.Repository, tag: i.Tag, id: i.ID, size: i.Size }));
          return { ok: true, summary: `${rows.length} image(s)`, output: { images: rows } };
        },
      }),
      operation({
        id: 'docker.logs',
        title: 'Container logs',
        description: 'Last lines of a container log.',
        input: z.object({ container: z.string().regex(nameRe), tail: z.number().int().min(1).max(5000).default(200) }),
        level: 1,
        async run(input, ctx) {
          const r = await docker(ctx, ['logs', '--tail', String(input.tail), input.container]);
          return r.ok ? { ...r, summary: `Logs of ${input.container}` } : r;
        },
      }),
      operation({
        id: 'docker.inspect',
        title: 'Inspect a container or image',
        description: 'Configuration, state and health (environment values hidden).',
        input: z.object({ target: z.string().regex(imageRe) }),
        level: 1,
        async run(input, ctx) {
          const r = await docker(ctx, ['inspect', input.target]);
          if (!r.ok) return r;
          const parsed = JSON.parse(r.raw ?? '[]').map((o: any) => ({ ...o, Config: o.Config ? { ...o.Config, Env: (o.Config.Env ?? []).map((e: string) => `${e.split('=')[0]}=[hidden]`) } : undefined }));
          return { ok: true, summary: `${input.target}: ${parsed[0]?.State?.Status ?? 'image'}${parsed[0]?.State?.Health ? ` (${parsed[0].State.Health.Status})` : ''}`, output: parsed };
        },
      }),
      operation({
        id: 'docker.build',
        title: 'Build an image',
        description: 'Build an image from a folder in the repository; tagged and labelled for this task.',
        input: z.object({ context: z.string().min(1).max(500).default('.'), file: z.string().max(500).optional(), tag: z.string().regex(imageRe) }),
        level: 2,
        async run(input, ctx) {
          let dir: string;
          let file: string | null = null;
          try {
            dir = resolveInside(ctx.roots, ctx.cwd, input.context);
            // The Dockerfile is read on this machine too: confined like the context (audit F-34).
            if (input.file) file = resolveInside(ctx.roots, ctx.cwd, input.file);
          } catch (error) {
            return failure('OUTSIDE_ROOT', (error as Error).message);
          }
          const r = await docker(ctx, ['build', '-t', input.tag, ...(ctx.taskId ? ['--label', `${LABEL}=${ctx.taskId}`] : []), ...(file ? ['-f', file] : []), dir], 1_800_000);
          return r.ok ? { ...r, summary: `Built ${input.tag}` } : r;
        },
      }),
      operation({
        id: 'docker.run',
        title: 'Run a container',
        description: 'Start a detached container labelled for this task (ports published on 127.0.0.1 only).',
        input: z.object({
          image: z.string().regex(imageRe),
          name: z.string().regex(nameRe),
          ports: z.array(z.object({ host: z.number().int().min(1024).max(65535), container: z.number().int().min(1).max(65535) })).max(20).default([]),
          env: z.record(z.string().regex(/^\w+$/), z.string().max(4000)).default({}),
          command: z.array(z.string().max(2000)).max(40).default([]),
        }),
        level: 2,
        classify: () => ({ reasons: ['Starts a container'], effects: ['process', 'infrastructure'] }),
        async run(input, ctx) {
          const args = ['run', '-d', '--name', input.name, ...(ctx.taskId ? ['--label', `${LABEL}=${ctx.taskId}`] : [])];
          for (const p of input.ports) args.push('-p', `127.0.0.1:${p.host}:${p.container}`);
          for (const [k, v] of Object.entries(input.env)) args.push('-e', `${k}=${v}`);
          const r = await docker(ctx, [...args, input.image, ...input.command], 600_000);
          return r.ok ? { ...r, summary: `Started ${input.name}`, output: { id: (r.raw ?? '').trim().slice(0, 12) } } : r;
        },
      }),
      operation({
        id: 'docker.exec',
        title: 'Run a command in a container',
        description: 'Execute a command inside a container. Containers this task created are Level 2; others Level 3.',
        input: z.object({ container: z.string().regex(nameRe), command: z.array(z.string().max(4000)).min(1).max(60) }),
        level: 2,
        async run(input, ctx) {
          if (!(await taskOwned(ctx, input.container)) && ctx.taskId) return failure('DENIED', `${input.container} was not created by this task; exec into it needs approval (use shell with docker exec)`);
          const r = await docker(ctx, ['exec', input.container, ...input.command], 600_000);
          return r.ok ? { ...r, summary: `Ran in ${input.container}` } : r;
        },
      }),
      operation({
        id: 'docker.compose',
        title: 'Docker Compose up/down/ps',
        description: 'Run Compose for a file in the repository under a project name owned by this task.',
        input: z.object({ action: z.enum(['up', 'down', 'ps', 'logs']), file: z.string().min(1).max(500).default('docker-compose.yml') }),
        level: 2,
        classify: (i) => (i.action === 'ps' || i.action === 'logs' ? { level: 1 } : { reasons: [`Compose ${i.action}`], effects: ['process', 'infrastructure'] }),
        async run(input, ctx) {
          let file: string;
          try {
            file = resolveInside(ctx.roots, ctx.cwd, input.file);
          } catch (error) {
            return failure('OUTSIDE_ROOT', (error as Error).message);
          }
          const project = `acc-${(ctx.taskId ?? 'operator').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
          const extra = input.action === 'up' ? ['up', '-d', '--wait'] : input.action === 'down' ? ['down', '--remove-orphans'] : input.action === 'logs' ? ['logs', '--tail', '200'] : ['ps', '--format', 'json'];
          const r = await docker(ctx, ['compose', '-f', file, '-p', project, ...extra], 900_000);
          return r.ok ? { ...r, summary: `compose ${input.action} (${project})` } : r;
        },
      }),
      operation({
        id: 'docker.cleanup',
        title: 'Remove task containers',
        description: 'Stop and remove every container labelled for this task (nothing else).',
        input: z.object({}),
        level: 2,
        async run(_input, ctx) {
          if (!ctx.taskId) return failure('INVALID_INPUT', 'Only a task can clean up its own containers');
          const list = await docker(ctx, ['ps', '-aq', '--filter', `label=${LABEL}=${ctx.taskId}`]);
          if (!list.ok) return list;
          const ids = (list.raw ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
          if (!ids.length) return { ok: true, summary: 'No task containers to remove' };
          const r = await docker(ctx, ['rm', '-f', ...ids]);
          return r.ok ? { ...r, summary: `Removed ${ids.length} task container(s)` } : r;
        },
      }),
    ],
  };
}
