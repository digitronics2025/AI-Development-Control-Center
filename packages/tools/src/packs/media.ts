import { credentialFreeEnv } from '@acc/security';
import { z } from 'zod';
import { guardBrowserContext } from '../net-guard.js';
import { builtinDetection, failure, operation, type OperationContext, type OperationResult, type ResultImage, type ToolProvider } from '../sdk.js';
import { findBrowser } from './browser.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, destination, downloadMedia, isFailure, isVideo, readMedia, sanitizeSvg, type MediaKind } from './media-files.js';

/**
 * Media tools (docs/systems/design-agent.md): bring images and video into the
 * repository and let the model look at them. Generation (paid) lives in
 * media-fal.ts; optimisation that needs FFmpeg in media-ffmpeg.ts.
 */

/** Largest picture handed to a model (the same ceiling as browser screenshots). */
export const MAX_MODEL_IMAGE_BYTES = 3 * 1024 * 1024;

export const mediaPath = z.string().min(1).max(1000).describe('Path relative to the repository root.');

async function launchIsolated() {
  const choice = await findBrowser();
  if (!choice) return null;
  const { chromium } = await import('playwright-core');
  return chromium.launch({ headless: true, executablePath: choice.executablePath ?? undefined, args: ['--no-first-run', '--no-default-browser-check'], env: credentialFreeEnv(process.env) as Record<string, string> });
}

/**
 * A picture of an image file for the model, drawn by Chromium from a `data:`
 * URL with scripts off and every network request refused, on a checkerboard
 * so transparency shows. Scaled to `maxWidth`, JPEG under the model ceiling.
 */
export async function renderForModel(buf: Buffer, mime: string, name: string, maxWidth: number): Promise<ResultImage | null> {
  const browser = await launchIsolated();
  if (!browser) return null;
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: maxWidth, height: 800 }, deviceScaleFactor: 1 });
    await guardBrowserContext(context);
    await context.route('**/*', (route) => route.abort('blockedbyclient'));
    const page = await context.newPage();
    const html = `<!doctype html><html><body style="margin:0;background:repeating-conic-gradient(#d9d9d9 0 25%,#fff 0 50%) 0 0/16px 16px"><img id="m" alt="" src="data:${mime};base64,${buf.toString('base64')}" style="display:block;max-width:${maxWidth}px;height:auto"></body></html>`;
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
    const img = page.locator('#m');
    for (const quality of [85, 70, 55]) {
      const data = await img.screenshot({ type: 'jpeg', quality, timeout: 20_000 });
      if (data.length <= MAX_MODEL_IMAGE_BYTES) return { name: name.replace(/\.[^.]+$/, '') + '.jpg', mime: 'image/jpeg', data };
    }
    return null;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function viewImage(ctx: OperationContext, input: { path: string; maxWidth: number }): Promise<OperationResult> {
  const media = await readMedia(ctx, input.path);
  if (isFailure(media)) return media;
  if (isVideo(media.kind)) return failure('INVALID_INPUT', `${media.rel} is a video: use media.video.frames to look at it`);
  const info = describe(media.rel, media.buf, media.kind);
  const name = media.rel.split('/').pop() ?? 'image';
  const direct = (media.kind === 'png' || media.kind === 'jpeg') && media.buf.length <= MAX_MODEL_IMAGE_BYTES && (info.width ?? Infinity) <= input.maxWidth;
  const image: ResultImage | null = direct ? { name, mime: media.kind === 'png' ? 'image/png' : 'image/jpeg', data: media.buf } : await renderForModel(media.buf, info.mime, name, input.maxWidth);
  if (!image) return failure('NOT_INSTALLED', `No browser is available to draw ${media.rel} (${media.kind}); install Chromium (npx playwright install chromium) or view a PNG/JPEG copy`, { output: info });
  const size = info.width && info.height ? `${info.width}×${info.height}` : 'size unknown';
  return { ok: true, summary: `${media.rel}: ${media.kind}, ${size}, ${Math.round(info.bytes / 1024)} KB`, output: info, images: [image], evidence: [`Viewed ${media.rel} (${media.kind}, ${size})`] };
}

const ALL_KINDS: readonly MediaKind[] = ['png', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'mp4', 'webm'];

export function mediaProvider(): ToolProvider {
  return {
    id: 'media',
    name: 'Media files',
    description: 'Download images and video into the repository and show them to the model (docs/systems/design-agent.md).',
    category: 'media',
    builtin: true,
    detect: async () => builtinDetection(),
    operations: [
      operation({
        id: 'media.asset.fetch',
        title: 'Download an image or video into the repository',
        description:
          'Download one image or video (PNG, JPEG, GIF, WebP, AVIF, SVG, MP4, WebM) from an https URL into a repository path. The type is checked from the bytes and must match the extension; SVG is sanitised (scripts, handlers and external references removed). Use it to bring a generated result into the repo instead of linking a vendor URL.',
        input: z.object({ url: z.string().url().max(4000), path: mediaPath, overwrite: z.boolean().default(false) }),
        level: 2,
        classify: () => ({ reasons: ['Downloads a file into the repository'], effects: ['network', 'filesystem'] }),
        run: async (input, ctx) => {
          const saved = await downloadMedia(ctx, input.url, input.path, { overwrite: input.overwrite, allowed: ALL_KINDS });
          if (isFailure(saved)) return saved;
          const host = new URL(input.url).host;
          const size = saved.width && saved.height ? `, ${saved.width}×${saved.height}` : '';
          return { ok: true, summary: `Saved ${saved.path} (${saved.kind}${size}, ${Math.round(saved.bytes / 1024)} KB)`, output: saved, filesChanged: [saved.path], networkTargets: [host] };
        },
      }),
      operation({
        id: 'media.image.view',
        title: 'Look at an image file',
        description:
          'Show the model an image file from the repository (PNG, JPEG, GIF, WebP, AVIF, SVG), scaled to maxWidth, on a checkerboard so transparency shows. Returns its type, dimensions and weight. Use it to critique generated or existing assets.',
        input: z.object({ path: mediaPath, maxWidth: z.number().int().min(64).max(2048).default(1568) }),
        level: 1,
        readOnly: true,
        classify: () => ({ reasons: ['Reads an image file'], effects: [], writes: false }),
        run: (input, ctx) => viewImage(ctx, input),
      }),
      operation({
        id: 'media.svg.optimize',
        title: 'Clean and minify an SVG',
        description: 'Sanitise an SVG (scripts, event handlers, foreign objects, external references and entity declarations removed) and minify it (comments, metadata, editor data, whitespace), in place or to another path. Use it for every SVG a page ships.',
        input: z.object({ path: mediaPath, out: mediaPath.optional().describe('Write here instead of replacing the file.') }),
        level: 2,
        classify: () => ({ reasons: ['Rewrites an SVG file'], effects: ['filesystem'] }),
        run: async (input, ctx) => {
          const src = await readMedia(ctx, input.path);
          if (isFailure(src)) return src;
          if (src.kind !== 'svg') return failure('INVALID_INPUT', `${src.rel} is ${src.kind}, not SVG`);
          const dest = destination(ctx, input.out ?? input.path, true);
          if (isFailure(dest)) return dest;
          if (!dest.rel.toLowerCase().endsWith('.svg')) return failure('INVALID_INPUT', 'The output needs a .svg name');
          const clean = Buffer.from(sanitizeSvg(src.buf.toString('utf8')), 'utf8');
          await mkdir(path.dirname(dest.abs), { recursive: true });
          await writeFile(dest.abs, clean);
          const info = describe(dest.rel, clean, 'svg');
          return { ok: true, summary: `${dest.rel}: ${Math.round(src.buf.length / 102.4) / 10} KB → ${Math.round(clean.length / 102.4) / 10} KB, sanitised`, output: { ...info, before: src.buf.length }, filesChanged: [dest.rel] };
        },
      }),
    ],
  };
}
