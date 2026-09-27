import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { credentialFreeEnv, redact } from '@acc/security';
import { z } from 'zod';
import { detectExecutable, run } from '../detect.js';
import { failure, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';
import { describe, destination, isFailure, isVideo, readMedia, sniff, type SavedMedia } from './media-files.js';
import { MAX_MODEL_IMAGE_BYTES, mediaPath } from './media.js';

/**
 * Media optimisation with FFmpeg (docs/systems/design-agent.md): responsive
 * AVIF/WebP widths, web video (WebM first, H.264 MP4 with faststart, no audio),
 * poster frames and a contact sheet of frames for the model. Every command is
 * a fixed template: argv only (no shell), numbers and choices validated by the
 * schema, and every path confined to the repository and passed with the
 * `file:` protocol so a file name can never be read as an option or another
 * protocol; inputs are limited to local files. A path with `%` is refused:
 * FFmpeg's image reader and writer read it as a sequence pattern (`x%d` is
 * x1, `%%` is `%`), so the file touched would not be the one checked.
 */

const nameField = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lower-case letters, digits and dashes')
  .optional()
  .describe('Base file name for the outputs; defaults to the source name.');
const outDirField = mediaPath.optional().describe('Repository folder for the outputs; defaults to the source folder.');

interface Tool {
  ffmpeg: string;
  ffprobe: string | null;
}

function tool(ctx: OperationContext): Tool | OperationResult {
  const d = ctx.detection('ffmpeg');
  if (!d?.installed || !d.path) return failure('NOT_INSTALLED', 'FFmpeg is not installed: install it (winget install Gyan.FFmpeg, or Tools → Install software) and try again');
  const probe = path.join(path.dirname(d.path), path.basename(d.path).replace(/ffmpeg/i, 'ffprobe'));
  return { ffmpeg: d.path, ffprobe: existsSync(probe) ? probe : null };
}

const file = (abs: string) => `file:${abs}`;
/** Writes a JPEG to exactly this name: the image muxer otherwise expands `%d` in it. */
const single = ['-update', '1'];

/**
 * A path FFmpeg will open as named. `-pattern_type none` cannot do this for
 * inputs: it is an option of the image-sequence reader alone, and FFmpeg
 * refuses it when another reader (PNG, WebP, AVIF, video) opens the file.
 */
function literal<T extends { abs: string; rel: string }>(p: T): T | OperationResult {
  if (!p.abs.includes('%')) return p;
  return failure('INVALID_INPUT', `${p.rel.includes('%') ? p.rel : p.abs} has "%" in its path, which FFmpeg reads as an image-sequence pattern (x%d is x1), so it would use another file: rename it or choose another folder`);
}

async function source(ctx: OperationContext, requested: string) {
  const src = await readMedia(ctx, requested);
  return isFailure(src) ? src : literal(src);
}

function target(ctx: OperationContext, requested: string, overwrite: boolean) {
  const dest = destination(ctx, requested, overwrite);
  return isFailure(dest) ? dest : literal(dest);
}

async function ffmpeg(ctx: OperationContext, t: Tool, args: string[]): Promise<OperationResult | null> {
  const out = await run(t.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file', ...args], { cwd: ctx.cwd, env: credentialFreeEnv(ctx.env), timeoutMs: Math.max(30_000, ctx.timeoutMs - 5_000) });
  if (out.spawnError) return failure('FAILED', `FFmpeg could not start: ${out.spawnError}`);
  if (out.timedOut) return failure('TIMEOUT', 'FFmpeg did not finish in time');
  if (out.code !== 0) return failure('FAILED', `FFmpeg failed: ${redact(out.stderr).split('\n').slice(-3).join(' ').slice(0, 400)}`);
  return null;
}

const encoderCache = new Map<string, Set<string>>();
async function encoders(ctx: OperationContext, t: Tool): Promise<Set<string>> {
  const cached = encoderCache.get(t.ffmpeg);
  if (cached) return cached;
  const out = await run(t.ffmpeg, ['-hide_banner', '-encoders'], { env: credentialFreeEnv(ctx.env), timeoutMs: 15_000 });
  const found = new Set([...out.stdout.matchAll(/^\s*[VAS][.FSXBD]{5}\s+(\S+)/gm)].map((m) => m[1]!));
  encoderCache.set(t.ffmpeg, found);
  return found;
}

/** Duration in seconds and whether an audio stream exists, from ffprobe (null when ffprobe is missing). */
export async function probe(ctx: OperationContext, t: Tool, abs: string): Promise<{ duration: number | null; width: number | null; height: number | null; audio: boolean } | null> {
  if (!t.ffprobe) return null;
  const out = await run(t.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file(abs)], { env: credentialFreeEnv(ctx.env), timeoutMs: 30_000 });
  try {
    const json = JSON.parse(out.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
    const video = json.streams?.find((s) => s.codec_type === 'video');
    return { duration: json.format?.duration ? Number(json.format.duration) : null, width: video?.width ?? null, height: video?.height ?? null, audio: Boolean(json.streams?.some((s) => s.codec_type === 'audio')) };
  } catch {
    return null;
  }
}

function outputs(sourceRel: string, outDir: string | undefined, name: string | undefined) {
  const dir = outDir ?? path.posix.dirname(sourceRel);
  const stem = name ?? path.posix.basename(sourceRel).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return (suffix: string) => `${dir === '.' ? '' : `${dir}/`}${stem || 'media'}${suffix}`;
}

async function saved(dest: { abs: string; rel: string }): Promise<SavedMedia | OperationResult> {
  const buf = await readFile(dest.abs);
  const kind = sniff(buf);
  if (!kind) return failure('FAILED', `FFmpeg wrote ${dest.rel}, but it is not a readable image or video`);
  return describe(dest.rel, buf, kind);
}

function kb(n: number): string {
  return `${Math.round(n / 1024)} KB`;
}

export function ffmpegProvider(): ToolProvider {
  return {
    id: 'ffmpeg',
    name: 'FFmpeg',
    description: 'Optimise images and video for the web and pull frames from video (docs/systems/design-agent.md).',
    category: 'media',
    detect: (ctx) => detectExecutable(ctx, process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'], ['-version'], (out) => /ffmpeg version (\S+)/.exec(out)?.[1] ?? null),
    operations: [
      operation({
        id: 'media.asset.optimize',
        title: 'Make responsive image files',
        description:
          'From one raster image, write AVIF and WebP files at several widths (never upscaled) and return the srcset and a <picture> snippet with width and height. Use it for every image a page ships.',
        input: z.object({
          image: mediaPath,
          widths: z.array(z.number().int().min(16).max(4096)).min(1).max(6).default([640, 1280, 1920]),
          formats: z.array(z.enum(['avif', 'webp', 'jpeg'])).min(1).max(3).default(['avif', 'webp']),
          quality: z.number().int().min(1).max(100).default(70).describe('Visual quality 1-100.'),
          outDir: outDirField,
          name: nameField,
          overwrite: z.boolean().default(true),
        }),
        level: 2,
        classify: () => ({ reasons: ['Writes optimised image files into the repository'], effects: ['filesystem'] }),
        run: async (input, ctx) => {
          const t = tool(ctx);
          if (isFailure(t)) return t;
          const src = await source(ctx, input.image);
          if (isFailure(src)) return src;
          if (isVideo(src.kind) || src.kind === 'svg') return failure('INVALID_INPUT', `${src.rel} is ${src.kind}: optimise raster images here (media.svg.optimize for SVG, media.video.encode for video)`);
          const info = describe(src.rel, src.buf, src.kind);
          const original = info.width ?? (await probe(ctx, t, src.abs))?.width ?? Math.max(...input.widths);
          const widths = [...new Set(input.widths.map((w) => Math.min(w, original)))].sort((a, b) => a - b);
          const available = await encoders(ctx, t);
          const avif = available.has('libaom-av1') ? 'libaom-av1' : available.has('libsvtav1') ? 'libsvtav1' : null;
          const name = outputs(src.rel, input.outDir, input.name);
          const files: SavedMedia[] = [];
          const notes: string[] = [];
          for (const format of input.formats) {
            if (format === 'avif' && !avif) {
              notes.push('No AVIF encoder in this FFmpeg build; AVIF skipped');
              continue;
            }
            if (format === 'webp' && !available.has('libwebp')) {
              notes.push('No WebP encoder in this FFmpeg build; WebP skipped');
              continue;
            }
            for (const w of widths) {
              const dest = target(ctx, name(`-${w}.${format === 'jpeg' ? 'jpg' : format}`), input.overwrite);
              if (isFailure(dest)) return dest;
              await mkdir(path.dirname(dest.abs), { recursive: true });
              const scale = ['-vf', `scale=${w}:-2:flags=lanczos`];
              const codec =
                format === 'webp'
                  ? ['-c:v', 'libwebp', '-quality', String(input.quality), '-compression_level', '6']
                  : format === 'jpeg'
                    ? ['-c:v', 'mjpeg', '-q:v', String(Math.max(2, Math.round(31 - (input.quality / 100) * 29))), '-pix_fmt', 'yuvj420p', ...single]
                    : avif === 'libaom-av1'
                      ? ['-c:v', 'libaom-av1', '-still-picture', '1', '-crf', String(Math.round(63 - (input.quality / 100) * 45)), '-cpu-used', '6', '-pix_fmt', 'yuv420p']
                      : ['-c:v', 'libsvtav1', '-crf', String(Math.round(63 - (input.quality / 100) * 45)), '-preset', '8', '-pix_fmt', 'yuv420p'];
              const failed = await ffmpeg(ctx, t, ['-y', '-i', file(src.abs), ...scale, '-frames:v', '1', ...codec, file(dest.abs)]);
              if (failed) return failed;
              const s = await saved(dest);
              if (isFailure(s)) return s;
              // AVIF dimensions are not read from the bytes: ask ffprobe, else use the scale FFmpeg was given.
              if (s.width === null || s.height === null) {
                const p = await probe(ctx, t, dest.abs);
                s.width = p?.width ?? w;
                s.height = p?.height ?? (info.width && info.height ? Math.round((w * info.height) / info.width / 2) * 2 : null);
              }
              files.push(s);
            }
          }
          if (!files.length) return failure('NOT_INSTALLED', notes.join('; ') || 'Nothing was written');
          const srcset = (fmt: string) => files.filter((f) => f.kind === fmt).map((f) => `/${f.path.replace(/^public\//, '')} ${f.width}w`).join(', ');
          const largest = files.filter((f) => f.kind === files.at(-1)!.kind).at(-1)!;
          const sources = (['avif', 'webp'] as const).filter((k) => files.some((f) => f.kind === k)).map((k) => `  <source type="image/${k}" srcset="${srcset(k)}" sizes="100vw">`);
          const fallback = files.find((f) => f.kind === 'jpeg') ?? largest;
          const snippet = [`<picture>`, ...sources, `  <img src="/${fallback.path.replace(/^public\//, '')}" width="${fallback.width}" height="${fallback.height}" alt="" loading="lazy" decoding="async">`, `</picture>`].join('\n');
          const total = files.reduce((n, f) => n + f.bytes, 0);
          return {
            ok: true,
            summary: `${src.rel} (${kb(src.bytes)}) → ${files.length} files, ${kb(total)} in total${notes.length ? ` · ${notes.join('; ')}` : ''}`,
            output: { source: info, files, srcset: Object.fromEntries((['avif', 'webp', 'jpeg'] as const).filter((k) => files.some((f) => f.kind === k)).map((k) => [k, srcset(k)])), snippet, notes },
            filesChanged: files.map((f) => f.path),
          };
        },
      }),
      operation({
        id: 'media.video.encode',
        title: 'Make web video files',
        description:
          'From one video, write WebM (VP9) and MP4 (H.264, +faststart) at up to maxWidth, without audio by default, and return a <video> snippet (WebM first, muted, playsinline). Use it for every clip a page ships.',
        input: z.object({
          video: mediaPath,
          formats: z.array(z.enum(['webm', 'mp4'])).min(1).max(2).default(['webm', 'mp4']),
          maxWidth: z.number().int().min(160).max(3840).default(1280),
          quality: z.enum(['small', 'balanced', 'high']).default('balanced'),
          keepAudio: z.boolean().default(false),
          outDir: outDirField,
          name: nameField,
          overwrite: z.boolean().default(true),
        }),
        level: 2,
        classify: () => ({ reasons: ['Writes encoded video files into the repository'], effects: ['filesystem'] }),
        run: async (input, ctx) => {
          const t = tool(ctx);
          if (isFailure(t)) return t;
          const src = await source(ctx, input.video);
          if (isFailure(src)) return src;
          if (!isVideo(src.kind)) return failure('INVALID_INPUT', `${src.rel} is not a video`);
          const name = outputs(src.rel, input.outDir, input.name);
          const crf = { small: { vp9: 40, h264: 28 }, balanced: { vp9: 34, h264: 23 }, high: { vp9: 28, h264: 19 } }[input.quality];
          const audio = input.keepAudio ? ['-c:a', 'libopus', '-b:a', '96k'] : ['-an'];
          const files: SavedMedia[] = [];
          for (const format of input.formats) {
            const dest = target(ctx, name(`.${format}`), input.overwrite);
            if (isFailure(dest)) return dest;
            if (path.resolve(dest.abs) === path.resolve(src.abs)) return failure('INVALID_INPUT', `The output would replace the source ${src.rel}: pass another name or outDir`);
            await mkdir(path.dirname(dest.abs), { recursive: true });
            const scale = ['-vf', `scale='min(${input.maxWidth},iw)':-2`];
            const codec =
              format === 'webm'
                ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf.vp9), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', ...audio]
                : ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf.h264), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...(input.keepAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an'])];
            const failed = await ffmpeg(ctx, t, ['-y', '-i', file(src.abs), ...scale, ...codec, file(dest.abs)]);
            if (failed) return failed;
            const s = await saved(dest);
            if (isFailure(s)) return s;
            files.push(s);
          }
          const url = (f: SavedMedia) => `/${f.path.replace(/^public\//, '')}`;
          const snippet = [`<video autoplay muted loop playsinline preload="metadata" poster="">`, ...files.map((f) => `  <source src="${url(f)}" type="${f.mime}">`), `</video>`].join('\n');
          return {
            ok: true,
            summary: `${src.rel} (${kb(src.bytes)}) → ${files.map((f) => `${f.path} (${kb(f.bytes)})`).join(', ')}`,
            output: { files, snippet, audio: input.keepAudio },
            filesChanged: files.map((f) => f.path),
          };
        },
      }),
      operation({
        id: 'media.video.poster',
        title: 'Save a poster frame',
        description: 'Write one frame of a video (at a time in seconds) as a JPEG or WebP poster image, for the <video poster> attribute.',
        input: z.object({ video: mediaPath, atSec: z.number().min(0).max(3600).default(0.5), format: z.enum(['jpeg', 'webp']).default('jpeg'), outDir: outDirField, name: nameField, overwrite: z.boolean().default(true) }),
        level: 2,
        classify: () => ({ reasons: ['Writes a poster image into the repository'], effects: ['filesystem'] }),
        run: async (input, ctx) => {
          const t = tool(ctx);
          if (isFailure(t)) return t;
          const src = await source(ctx, input.video);
          if (isFailure(src)) return src;
          if (!isVideo(src.kind)) return failure('INVALID_INPUT', `${src.rel} is not a video`);
          const dest = target(ctx, outputs(src.rel, input.outDir, input.name)(`-poster.${input.format === 'jpeg' ? 'jpg' : 'webp'}`), input.overwrite);
          if (isFailure(dest)) return dest;
          await mkdir(path.dirname(dest.abs), { recursive: true });
          const codec = input.format === 'jpeg' ? ['-q:v', '3', ...single] : ['-c:v', 'libwebp', '-quality', '80'];
          const failed = await ffmpeg(ctx, t, ['-y', '-ss', String(input.atSec), '-i', file(src.abs), '-frames:v', '1', ...codec, file(dest.abs)]);
          if (failed) return failed;
          const s = await saved(dest);
          if (isFailure(s)) return s;
          return { ok: true, summary: `Poster ${s.path} (${s.width}×${s.height}, ${kb(s.bytes)})`, output: s, filesChanged: [s.path] };
        },
      }),
      operation({
        id: 'media.video.frames',
        title: 'Look at a video',
        description: 'Show the model a contact sheet of evenly spaced frames from a repository video, with its duration, size and whether it has audio. Writes nothing into the repository.',
        input: z.object({ video: mediaPath, count: z.number().int().min(1).max(8).default(4) }),
        level: 1,
        readOnly: true,
        classify: () => ({ reasons: ['Reads a video file'], effects: [], writes: false }),
        run: async (input, ctx) => {
          const t = tool(ctx);
          if (isFailure(t)) return t;
          const src = await source(ctx, input.video);
          if (isFailure(src)) return src;
          if (!isVideo(src.kind)) return failure('INVALID_INPUT', `${src.rel} is not a video: use media.image.view`);
          const facts = await probe(ctx, t, src.abs);
          const duration = facts?.duration && facts.duration > 0 ? facts.duration : 1;
          await mkdir(ctx.tempDir, { recursive: true });
          const sheet = path.join(ctx.tempDir, `frames-${ctx.executionId}-${Date.now()}.jpg`);
          try {
            const perRow = Math.min(4, input.count);
            const rows = Math.ceil(input.count / perRow);
            const fps = Math.max(0.01, input.count / duration);
            const failed = await ffmpeg(ctx, t, ['-y', '-i', file(src.abs), '-vf', `fps=${fps.toFixed(4)},scale=480:-2,tile=${perRow}x${rows}`, '-frames:v', '1', '-q:v', '4', ...single, file(sheet)]);
            if (failed) return failed;
            const data = await readFile(sheet);
            if (data.length > MAX_MODEL_IMAGE_BYTES) return failure('FAILED', 'The contact sheet is too large to show; ask for fewer frames');
            const size = facts?.width && facts.height ? `${facts.width}×${facts.height}` : 'size unknown';
            const summary = `${src.rel}: ${src.kind}, ${facts?.duration ? `${facts.duration.toFixed(1)} s` : 'duration unknown'}, ${size}, ${facts ? (facts.audio ? 'with audio' : 'no audio') : 'audio unknown'}, ${kb(src.bytes)}`;
            return { ok: true, summary, output: { path: src.rel, kind: src.kind, bytes: src.bytes, ...facts }, images: [{ name: `${path.basename(src.rel)}-frames.jpg`, mime: 'image/jpeg', data }], evidence: [`Viewed ${input.count} frames of ${src.rel}`] };
          } finally {
            await rm(sheet, { force: true }).catch(() => undefined);
          }
        },
      }),
    ],
  };
}
