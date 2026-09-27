import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { resolveInside } from '../paths.js';
import { builtinDetection, failure, operation, type CostEstimate, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';
import { MAX_IMAGE_BYTES, downloadResult, isFailure, isVideo, readMedia, type SavedMedia } from './media-files.js';
import { mediaPath } from './media.js';
import { apiBase, restRequest, type RestResponse } from './rest.js';

/**
 * Image and video generation through fal's queue API (docs/systems/design-agent.md).
 * Every call is billed by fal, so:
 *  - the key is read by name from a `media` credential only (never another
 *    kind, never an environment variable of any process);
 *  - a submission is never retried: an unknown outcome is reported with its
 *    job id, and status, result and cancel reuse that id;
 *  - job ids carry fal's own status/result/cancel URLs, and each one is
 *    checked against the queue's origin before the key is sent to it;
 *  - results are downloaded into the repository (type proven by the bytes,
 *    SVG sanitised), with the master kept as a task artifact;
 *  - each paid operation states a conservative cost estimate that the spend
 *    gate reserves before the call.
 */

const QUEUE = 'https://queue.fal.run';
/** Loopback-only override, so tests stand in for fal while a real key can never be pointed elsewhere. */
const OVERRIDE = 'ACC_FAL_API_BASE';
const MODEL = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){1,5}$/i;
const POLL_MS = 1500;
/** Largest source image sent inline to a model (as a data URL). */
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/**
 * List prices in USD used only to reserve budget before a call; deliberately
 * on the high side, overridable per model in Settings → Media. The fal bill is
 * the truth; these are estimates.
 */
export const DEFAULT_MEDIA_PRICES = {
  image: 0.1,
  'video-second': 0.3,
  edit: 0.1,
  upscale: 0.05,
  'remove-background': 0.05,
  vectorize: 0.1,
} as const;
export type MediaPriceUnit = keyof typeof DEFAULT_MEDIA_PRICES;

/** units × (the operator's price for this model, else the default for the unit). */
export function estimate(model: string, unit: MediaPriceUnit, units: number, prices: Record<string, number> = {}): CostEstimate {
  const each = prices[model] ?? DEFAULT_MEDIA_PRICES[unit];
  const usd = Math.round(each * units * 10_000) / 10_000;
  return { usd, model, unit, units, basis: `${units} × $${each} per ${unit}${prices[model] === undefined ? ' (default estimate)' : ''}` };
}

const modelField = (fallback: string) => z.string().min(3).max(120).regex(MODEL, 'A fal endpoint id such as fal-ai/flux/dev').default(fallback);
const credentialField = z.string().min(1).max(100).default('fal').describe('Name of the media credential that holds the fal key (Tools → Credentials, kind media).');
/** Parameters that set how much a call bills: only the validated fields (count, durationSec) may set them. */
const BILLED_KEYS = /^(?:num_images|num_outputs|num_samples|num_videos|num_frames|n|count|samples|batch_size|batch_count|duration|seconds|video_length|length|frames)$/i;
const argumentsField = z
  .record(z.string().max(60), z.unknown())
  .refine((a) => Object.keys(a).length <= 30 && JSON.stringify(a).length <= 8192, 'At most 30 extra arguments, 8 KB')
  .refine((a) => !Object.keys(a).some((k) => BILLED_KEYS.test(k)), 'Set how many images and how long a video with count and durationSec, not in arguments: they decide the cost')
  .optional()
  .describe("Extra model parameters, exactly as the model's fal schema names them (not the number of images or the video length).");
const folderField = mediaPath.describe('Repository folder the results are saved in, e.g. public/generated.');
const nameField = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lower-case letters, digits and dashes')
  .describe('Base file name; results are saved as <name>-1.<ext>, <name>-2.<ext>…');
const waitField = (fallback: number) => z.number().int().min(0).max(120).default(fallback).describe('Seconds to wait for the result before returning the job id to poll.');
const ASPECT = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] as const;
const IMAGE_SIZE: Record<(typeof ASPECT)[number], string | { width: number; height: number }> = {
  '1:1': 'square_hd',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
  '3:2': { width: 1536, height: 1024 },
  '2:3': { width: 1024, height: 1536 },
  '21:9': { width: 1680, height: 720 },
};

// ----- jobs ---------------------------------------------------------------------------------

interface Job {
  model: string;
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  cancelUrl: string;
}

export function encodeJob(job: Job): string {
  return `fal:${Buffer.from(JSON.stringify({ m: job.model, r: job.requestId, s: job.statusUrl, g: job.responseUrl, c: job.cancelUrl })).toString('base64url')}`;
}

/** A job id back into URLs, each proven to be on the queue's own origin (the key is sent to them). */
export function decodeJob(id: string, base: string): Job | null {
  if (!id.startsWith('fal:')) return null;
  try {
    const raw = JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8')) as Record<string, unknown>;
    const job = { model: String(raw.m), requestId: String(raw.r), statusUrl: String(raw.s), responseUrl: String(raw.g), cancelUrl: String(raw.c) };
    const origin = new URL(base).origin;
    if (!MODEL.test(job.model) || !/^[\w-]{1,100}$/.test(job.requestId)) return null;
    for (const u of [job.statusUrl, job.responseUrl, job.cancelUrl]) if (new URL(u).origin !== origin || !u.includes(job.requestId)) return null;
    return job;
  } catch {
    return null;
  }
}

interface Fal {
  base: string;
  key: string;
}

async function account(ctx: OperationContext, credential: string): Promise<Fal | OperationResult> {
  const value = await ctx.credentials?.value(credential, { kind: 'media' });
  if (!value) return failure('AUTH_REQUIRED', `No media credential named "${credential}" is available to this task: add the fal key in Tools → Credentials (kind media, no environment variable).`);
  return { base: apiBase(ctx, QUEUE, OVERRIDE), key: value.replace(/^Key\s+/i, '').trim() };
}

const headers = (fal: Fal) => ({ authorization: `Key ${fal.key}` });

/** A fal answer in words; the key is never part of it. */
function falFailure(r: RestResponse, what: string): OperationResult {
  const detail = r.json?.detail;
  const message = (typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((d: { msg?: string; loc?: unknown[] }) => `${(d.loc ?? []).join('.')}: ${d.msg ?? ''}`).join('; ') : null) ?? (r.text.slice(0, 300) || `HTTP ${r.status}`);
  if (r.status === 401 || r.status === 403) return failure('AUTH_REQUIRED', `fal refused ${what}: ${message}. Check the key and the account balance.`);
  if (r.status === 404) return failure('INVALID_INPUT', `${what}: fal does not know this model or job (${message}).`);
  if (r.status === 422 || r.status === 400) return failure('INVALID_INPUT', `${what}: fal rejected the input: ${message}. Read the model's schema and pass its parameters in arguments.`);
  if (r.status === 429 || r.status >= 500) return failure('UNAVAILABLE', `fal is not answering ${what} right now (HTTP ${r.status}).`);
  return failure('FAILED', `${what} failed: ${message}`);
}

async function submit(ctx: OperationContext, fal: Fal, model: string, body: Record<string, unknown>): Promise<Job | OperationResult> {
  let r: RestResponse;
  try {
    // Billed: never retried. A timeout leaves the outcome unknown, and that is said, not guessed.
    r = await restRequest(ctx, `${fal.base}/${model}`, { method: 'POST', headers: headers(fal), body, retry: false, timeoutMs: 60_000 });
  } catch (error) {
    return failure('UNAVAILABLE', `The submission to fal did not answer (${(error as Error).message}). It may still have been accepted and billed: do not submit again until you know; check fal's request history.`);
  }
  if (!r.ok) return falFailure(r, `submitting to ${model}`);
  const id = r.json?.request_id;
  if (typeof id !== 'string') return failure('FAILED', 'fal accepted the submission but returned no request id');
  const fallback = `${fal.base}/${model.split('/').slice(0, 2).join('/')}/requests/${id}`;
  const job: Job = {
    model,
    requestId: id,
    statusUrl: typeof r.json.status_url === 'string' ? r.json.status_url : `${fallback}/status`,
    responseUrl: typeof r.json.response_url === 'string' ? r.json.response_url : fallback,
    cancelUrl: typeof r.json.cancel_url === 'string' ? r.json.cancel_url : `${fallback}/cancel`,
  };
  // Proven before the key follows them.
  return decodeJob(encodeJob(job), fal.base) ?? failure('FAILED', 'fal returned job URLs outside its queue; refusing to use them');
}

type Status = { state: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'; position: number | null };

async function status(ctx: OperationContext, fal: Fal, job: Job): Promise<Status | OperationResult> {
  const r = await restRequest(ctx, job.statusUrl, { headers: headers(fal) });
  if (!r.ok && r.status !== 202) return falFailure(r, 'reading the job status');
  const state = r.json?.status;
  if (state !== 'IN_QUEUE' && state !== 'IN_PROGRESS' && state !== 'COMPLETED') return failure('FAILED', `fal returned an unknown job status (${String(state).slice(0, 40)})`);
  return { state, position: typeof r.json.queue_position === 'number' ? r.json.queue_position : null };
}

/** Every https (or, in tests, loopback) file URL in a result, images first. */
export function resultFiles(result: unknown, allowLoopback: boolean): string[] {
  const urls: string[] = [];
  const ok = (u: unknown): u is string => typeof u === 'string' && (/^https:\/\//i.test(u) || (allowLoopback && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(u)));
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || urls.length >= 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (ok(o.url) && !urls.includes(o.url)) urls.push(o.url);
    for (const key of ['images', 'image', 'video', 'videos', 'output', 'file', 'files', 'data']) if (key in o) visit(o[key], depth + 1);
  };
  visit(result, 0);
  return urls;
}

interface Delivery {
  files: SavedMedia[];
  seed: number | null;
  artifacts: Array<{ id: string; name: string }>;
}

/** Download a completed job's files into `<folder>/<name>-N.<ext>`; masters up to 50 MB are also kept as task artifacts. */
async function deliver(ctx: OperationContext, fal: Fal, job: Job, folder: string, name: string): Promise<Delivery | OperationResult> {
  const r = await restRequest(ctx, job.responseUrl, { headers: headers(fal), maxBytes: 2 * 1024 * 1024 });
  if (!r.ok) return falFailure(r, 'reading the result');
  const loopback = fal.base !== QUEUE;
  const urls = resultFiles(r.json, loopback);
  if (!urls.length) return failure('FAILED', 'The job finished without an image or video to download');
  const files: SavedMedia[] = [];
  const artifacts: Array<{ id: string; name: string }> = [];
  for (const [i, url] of urls.entries()) {
    const saved = await downloadResult(ctx, url, `${folder.replace(/\/+$/, '')}/${name}-${i + 1}`, { allowLoopback: loopback });
    if (isFailure(saved)) return { ...saved, summary: `${saved.summary} (result ${i + 1} of ${urls.length}; ${files.length} saved before it)`, filesChanged: files.map((f) => f.path) };
    files.push(saved);
    if (ctx.artifacts && saved.bytes <= 50 * 1024 * 1024) {
      const content = await readFile(resolveInside(ctx.roots, ctx.cwd, saved.path));
      artifacts.push(await ctx.artifacts.write({ name: saved.path.split('/').pop()!, type: isVideo(saved.kind) ? 'video' : 'image', content, mime: saved.mime }));
    }
  }
  const seed = typeof r.json?.seed === 'number' ? r.json.seed : null;
  return { files, seed, artifacts };
}

function delivered(d: Delivery, job: Job, cost: CostEstimate | null): OperationResult {
  const list = d.files.map((f) => `${f.path} (${f.kind}${f.width && f.height ? ` ${f.width}×${f.height}` : ''}, ${Math.round(f.bytes / 1024)} KB)`).join(', ');
  return {
    ok: true,
    summary: `${job.model}: saved ${list}${cost ? ` · estimated $${cost.usd}` : ''}`,
    output: { status: 'COMPLETED', jobId: encodeJob(job), model: job.model, seed: d.seed, files: d.files, ...(cost ? { estimatedCost: cost } : {}) },
    filesChanged: d.files.map((f) => f.path),
    artifacts: d.artifacts,
    networkTargets: [new URL(job.statusUrl).host],
    evidence: d.files.map((f) => `Generated ${f.path} with ${job.model} (sha256 ${f.sha256.slice(0, 12)})`),
  };
}

function pending(job: Job, s: Status, cost: CostEstimate | null): OperationResult {
  return {
    ok: true,
    summary: `${job.model}: ${s.state === 'IN_QUEUE' ? `queued${s.position !== null ? ` (position ${s.position})` : ''}` : 'still running'}. Poll media.job.status with this jobId, then media.job.fetch; do not submit again.`,
    output: { status: s.state, jobId: encodeJob(job), model: job.model, ...(cost ? { estimatedCost: cost } : {}) },
    networkTargets: [new URL(job.statusUrl).host],
  };
}

/** Submit, wait up to `waitSec` for the result, and download it; otherwise hand back the job id. */
async function generate(ctx: OperationContext, input: { model: string; credential: string; path: string; name: string; waitSec: number }, body: Record<string, unknown>, cost: CostEstimate | null): Promise<OperationResult> {
  const fal = await account(ctx, input.credential);
  if (isFailure(fal)) return fal;
  const job = await submit(ctx, fal, input.model, body);
  if (isFailure(job)) return job;
  const deadline = Date.now() + Math.min(input.waitSec * 1000, Math.max(0, ctx.timeoutMs - 15_000));
  let s = await status(ctx, fal, job);
  while (!isFailure(s) && s.state !== 'COMPLETED' && Date.now() + POLL_MS < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    s = await status(ctx, fal, job);
  }
  if (isFailure(s)) return { ...s, summary: `${s.summary} The job was submitted: ${encodeJob(job)}`, output: { status: 'UNKNOWN', jobId: encodeJob(job) } };
  if (s.state !== 'COMPLETED') return pending(job, s, cost);
  const d = await deliver(ctx, fal, job, input.path, input.name);
  if (isFailure(d)) return { ...d, output: { status: 'COMPLETED', jobId: encodeJob(job) } };
  return delivered(d, job, cost);
}

/** A repository image as a data URL for a model's `image_url`. */
async function sourceImage(ctx: OperationContext, requested: string): Promise<string | OperationResult> {
  const media = await readMedia(ctx, requested);
  if (isFailure(media)) return media;
  if (isVideo(media.kind)) return failure('INVALID_INPUT', `${media.rel} is a video; pass an image`);
  if ((await stat(media.abs)).size > Math.min(MAX_SOURCE_BYTES, MAX_IMAGE_BYTES)) return failure('INVALID_INPUT', `${media.rel} is larger than 10 MB; optimise it first`);
  const mime = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml' }[media.kind as 'png'];
  return `data:${mime};base64,${media.buf.toString('base64')}`;
}

const videoModel = (input: { model?: string; image?: string }) => input.model ?? (input.image ? 'fal-ai/kling-video/v2.1/standard/image-to-video' : 'fal-ai/kling-video/v2.1/standard/text-to-video');

const PAID = (what: string) => ({ reasons: [`Paid generation on fal (${what})`], effects: ['network' as const, 'filesystem' as const] });

export function falMediaProvider(): ToolProvider {
  return {
    id: 'fal',
    name: 'fal (image and video generation)',
    description: "Generate, edit, upscale, cut out and vectorise images and generate video with fal's models; results are saved into the repository (docs/systems/design-agent.md).",
    category: 'media',
    builtin: true,
    detect: async () => builtinDetection('Needs a media credential holding a fal key'),
    operations: [
      operation({
        id: 'media.image.generate',
        title: 'Generate images (paid)',
        description:
          'Generate 1-4 images from a prompt with a fal model and save them into the repository. Paid: check the estimate, explore with a cheap model (fal-ai/flux/schnell) before a final one. Pass model-specific parameters in arguments. Long jobs return a jobId to poll with media.job.status and fetch with media.job.fetch; never submit twice.',
        input: z.object({
          prompt: z.string().min(1).max(4000),
          model: modelField('fal-ai/flux/dev'),
          aspectRatio: z.enum(ASPECT).optional(),
          count: z.number().int().min(1).max(4).default(1),
          seed: z.number().int().min(0).max(2 ** 31).optional(),
          negativePrompt: z.string().max(2000).optional(),
          arguments: argumentsField,
          path: folderField,
          name: nameField,
          waitSec: waitField(60),
          credential: credentialField,
        }),
        level: 3,
        classify: () => PAID('images'),
        estimateCost: (input, prices) => estimate(input.model, 'image', input.count, prices),
        run: (input, ctx) =>
          generate(
            ctx,
            input,
            {
              // Extra parameters first: the validated fields below always win.
              ...input.arguments,
              prompt: input.prompt,
              num_images: input.count,
              ...(input.aspectRatio ? { image_size: IMAGE_SIZE[input.aspectRatio] } : {}),
              ...(input.seed !== undefined ? { seed: input.seed } : {}),
              ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
            },
            estimate(input.model, 'image', input.count, ctx.prices),
          ),
      }),
      operation({
        id: 'media.image.edit',
        title: 'Edit an image with a prompt (paid)',
        description: 'Change a repository image with an instruction (restyle, recolour, extend a scene) using a fal image-editing model, and save the result. Paid.',
        input: z.object({ prompt: z.string().min(1).max(4000), image: mediaPath, model: modelField('fal-ai/flux-pro/kontext'), arguments: argumentsField, path: folderField, name: nameField, waitSec: waitField(60), credential: credentialField }),
        level: 3,
        classify: () => PAID('image edit'),
        estimateCost: (input, prices) => estimate(input.model, 'edit', 1, prices),
        run: async (input, ctx) => {
          const image = await sourceImage(ctx, input.image);
          if (isFailure(image)) return image;
          return generate(ctx, input, { ...input.arguments, prompt: input.prompt, image_url: image }, estimate(input.model, 'edit', 1, ctx.prices));
        },
      }),
      operation({
        id: 'media.image.upscale',
        title: 'Upscale an image (paid)',
        description: 'Enlarge a repository image 2× or 4× with a fal upscaling model and save the result. Paid.',
        input: z.object({ image: mediaPath, scale: z.union([z.literal(2), z.literal(4)]).default(2), model: modelField('fal-ai/esrgan'), arguments: argumentsField, path: folderField, name: nameField, waitSec: waitField(60), credential: credentialField }),
        level: 3,
        classify: () => PAID('upscale'),
        estimateCost: (input, prices) => estimate(input.model, 'upscale', 1, prices),
        run: async (input, ctx) => {
          const image = await sourceImage(ctx, input.image);
          if (isFailure(image)) return image;
          return generate(ctx, input, { ...input.arguments, image_url: image, scale: input.scale }, estimate(input.model, 'upscale', 1, ctx.prices));
        },
      }),
      operation({
        id: 'media.image.remove_background',
        title: 'Cut out an image (paid)',
        description: 'Remove the background of a repository image (a product shot, a portrait) with a fal model and save a transparent PNG. Paid.',
        input: z.object({ image: mediaPath, model: modelField('fal-ai/bria/background/remove'), arguments: argumentsField, path: folderField, name: nameField, waitSec: waitField(60), credential: credentialField }),
        level: 3,
        classify: () => PAID('background removal'),
        estimateCost: (input, prices) => estimate(input.model, 'remove-background', 1, prices),
        run: async (input, ctx) => {
          const image = await sourceImage(ctx, input.image);
          if (isFailure(image)) return image;
          return generate(ctx, input, { ...input.arguments, image_url: image }, estimate(input.model, 'remove-background', 1, ctx.prices));
        },
      }),
      operation({
        id: 'media.image.vectorize',
        title: 'Vectorise an image into SVG (paid)',
        description: 'Turn a repository raster image (a logo, an icon, a flat illustration) into an SVG with a fal model; the SVG is sanitised when saved. Paid.',
        input: z.object({ image: mediaPath, model: modelField('fal-ai/recraft/vectorize'), arguments: argumentsField, path: folderField, name: nameField, waitSec: waitField(60), credential: credentialField }),
        level: 3,
        classify: () => PAID('vectorise'),
        estimateCost: (input, prices) => estimate(input.model, 'vectorize', 1, prices),
        run: async (input, ctx) => {
          const image = await sourceImage(ctx, input.image);
          if (isFailure(image)) return image;
          return generate(ctx, input, { ...input.arguments, image_url: image }, estimate(input.model, 'vectorize', 1, ctx.prices));
        },
      }),
      operation({
        id: 'media.video.generate',
        title: 'Generate a video clip (paid)',
        description:
          'Generate a short clip (up to 10 s) from a prompt, or from a repository image as the first frame (image-to-video keeps a brand-consistent look), with a fal video model. Paid per second. Usually returns a jobId: poll media.job.status, then media.job.fetch; never submit twice.',
        input: z.object({
          prompt: z.string().min(1).max(4000),
          image: mediaPath.optional().describe('Repository image used as the first frame.'),
          durationSec: z.number().int().min(1).max(10).default(5),
          aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
          model: z.string().min(3).max(120).regex(MODEL).optional().describe('A fal video endpoint; defaults to Kling image-to-video or text-to-video.'),
          arguments: argumentsField,
          path: folderField,
          name: nameField,
          waitSec: waitField(20),
          credential: credentialField,
        }),
        level: 3,
        classify: () => PAID('video'),
        estimateCost: (input, prices) => estimate(videoModel(input), 'video-second', input.durationSec, prices),
        run: async (input, ctx) => {
          const model = videoModel(input);
          const image = input.image ? await sourceImage(ctx, input.image) : null;
          if (image && isFailure(image)) return image;
          const body = { ...input.arguments, prompt: input.prompt, duration: String(input.durationSec), ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}), ...(image ? { image_url: image } : {}) };
          return generate(ctx, { ...input, model }, body, estimate(model, 'video-second', input.durationSec, ctx.prices));
        },
      }),
      operation({
        id: 'media.job.status',
        title: 'Status of a generation job',
        description: 'Whether a fal job returned by a media tool is queued, running or completed. Free; never submits anything.',
        input: z.object({ jobId: z.string().min(5).max(4000), credential: credentialField }),
        level: 1,
        classify: () => ({ reasons: ['Reads a generation job status'], effects: ['network'] }),
        run: async (input, ctx) => {
          const fal = await account(ctx, input.credential);
          if (isFailure(fal)) return fal;
          const job = decodeJob(input.jobId, fal.base);
          if (!job) return failure('INVALID_INPUT', 'Not a job id returned by a media tool');
          const s = await status(ctx, fal, job);
          if (isFailure(s)) return s;
          return { ok: true, summary: `${job.model}: ${s.state}${s.position !== null ? ` (position ${s.position})` : ''}`, output: { status: s.state, position: s.position, jobId: input.jobId, model: job.model }, networkTargets: [new URL(job.statusUrl).host] };
        },
      }),
      operation({
        id: 'media.job.fetch',
        title: 'Save a finished generation job',
        description: 'Download the results of a completed fal job into the repository as <name>-N.<ext>. Free; never submits anything.',
        input: z.object({ jobId: z.string().min(5).max(4000), path: folderField, name: nameField, credential: credentialField }),
        level: 2,
        classify: () => ({ reasons: ['Downloads generated files into the repository'], effects: ['network', 'filesystem'] }),
        run: async (input, ctx) => {
          const fal = await account(ctx, input.credential);
          if (isFailure(fal)) return fal;
          const job = decodeJob(input.jobId, fal.base);
          if (!job) return failure('INVALID_INPUT', 'Not a job id returned by a media tool');
          const s = await status(ctx, fal, job);
          if (isFailure(s)) return s;
          if (s.state !== 'COMPLETED') return pending(job, s, null);
          const d = await deliver(ctx, fal, job, input.path, input.name);
          if (isFailure(d)) return d;
          return delivered(d, job, null);
        },
      }),
      operation({
        id: 'media.job.cancel',
        title: 'Cancel a generation job',
        description: 'Cancel a queued fal job you no longer need (a job already running may still be billed).',
        input: z.object({ jobId: z.string().min(5).max(4000), credential: credentialField }),
        level: 2,
        classify: () => ({ reasons: ['Cancels a generation job'], effects: ['network'] }),
        run: async (input, ctx) => {
          const fal = await account(ctx, input.credential);
          if (isFailure(fal)) return fal;
          const job = decodeJob(input.jobId, fal.base);
          if (!job) return failure('INVALID_INPUT', 'Not a job id returned by a media tool');
          const r = await restRequest(ctx, job.cancelUrl, { method: 'PUT', headers: headers(fal) });
          if (!r.ok && r.status !== 400) return falFailure(r, 'cancelling the job');
          const done = r.json?.status === 'ALREADY_COMPLETED' || r.status === 400;
          return { ok: true, summary: done ? `${job.model}: already finished; nothing to cancel` : `${job.model}: cancellation requested`, output: { jobId: input.jobId, status: r.json?.status ?? null } };
        },
      }),
    ],
  };
}
