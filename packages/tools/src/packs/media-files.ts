import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { referencesSelf } from '@acc/security';
import { guardedFetch, RedirectRefused } from '../net-guard.js';
import { OutsideRootError, relativeTo, resolveInside } from '../paths.js';
import { failure, type OperationContext, type OperationResult } from '../sdk.js';
import { protectedCheck } from './filesystem.js';

/**
 * Shared file handling for the media tools (docs/systems/design-agent.md):
 * what a file really is (by its bytes, not its name or a header), its
 * dimensions, SVG sanitising, and confined, capped, streamed downloads into
 * the repository.
 */

export type MediaKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'svg' | 'mp4' | 'webm';

export const MEDIA_MIME: Record<MediaKind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** File extensions each kind may be saved under. */
export const MEDIA_EXTENSIONS: Record<MediaKind, readonly string[]> = {
  png: ['.png'],
  jpeg: ['.jpg', '.jpeg'],
  gif: ['.gif'],
  webp: ['.webp'],
  avif: ['.avif'],
  svg: ['.svg'],
  mp4: ['.mp4', '.m4v'],
  webm: ['.webm'],
};

export const isVideo = (kind: MediaKind) => kind === 'mp4' || kind === 'webm';

/** Largest image and video file a media tool downloads or reads. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** What a file is, from its first bytes. SVG is recognised as XML text whose root is `<svg`. */
export function sniff(head: Buffer): MediaKind | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'avif';
    return 'mp4';
  }
  const text = head.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (text.startsWith('<')) {
    // The prolog: an XML declaration, comments, and a DOCTYPE with or without an internal subset.
    const withoutProlog = text.replace(/^(?:<\?xml[^>]*>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>\s*)*/i, '');
    if (/^<svg[\s>]/i.test(withoutProlog)) return 'svg';
  }
  return null;
}

export function kindForExtension(file: string): MediaKind | null {
  const ext = path.extname(file).toLowerCase();
  return (Object.keys(MEDIA_EXTENSIONS) as MediaKind[]).find((k) => MEDIA_EXTENSIONS[k].includes(ext)) ?? null;
}

/** Width and height from the file header; null when the format does not say cheaply (AVIF, video). */
export function dimensions(buf: Buffer, kind: MediaKind): { width: number; height: number } | null {
  try {
    if (kind === 'png' && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (kind === 'gif' && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (kind === 'jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1]!;
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
      return null;
    }
    if (kind === 'webp' && buf.length >= 30) {
      const chunk = buf.subarray(12, 16).toString('latin1');
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (kind === 'svg') {
      const text = buf.subarray(0, 8192).toString('utf8');
      const root = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
      const num = (attr: string) => {
        const m = new RegExp(`\\s${attr}\\s*=\\s*["']\\s*([\\d.]+)(?:px)?\\s*["']`, 'i').exec(root);
        return m ? Math.round(Number(m[1])) : null;
      };
      const w = num('width');
      const h = num('height');
      if (w && h) return { width: w, height: h };
      const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(root);
      return vb ? { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * An SVG with everything that can run, reach out or bloat it removed:
 * scripts, event handlers, foreign objects, embedded documents, animations
 * that retarget links, `javascript:`/external references, style imports,
 * DOCTYPE and entity declarations (XXE and entity expansion), processing
 * instructions, comments, metadata and editor namespaces. Repeated until
 * nothing changes, so nested or split constructs cannot survive one pass.
 */
export function sanitizeSvg(input: string): string {
  let svg = input.replace(/^\uFEFF/, '');
  const passes: Array<[RegExp, string]> = [
    [/<!DOCTYPE[\s\S]*?(?:\[[\s\S]*?\]\s*)?>/gi, ''],
    [/<!ENTITY[\s\S]*?>/gi, ''],
    [/<\?(?!xml\s)[\s\S]*?\?>/gi, ''],
    [/<!--[\s\S]*?-->/g, ''],
    [/<!\[CDATA\[[\s\S]*?\]\]>/g, ''],
    [/<(script|foreignObject|iframe|embed|object|audio|video|canvas|handler|listener|metadata)\b[\s\S]*?<\/\1\s*>/gi, ''],
    [/<(script|foreignObject|iframe|embed|object|audio|video|canvas|handler|listener|metadata|set)\b[^>]*\/?>/gi, ''],
    [/<animate\w*\b[^>]*attributeName\s*=\s*["']?\s*(?:xlink:)?href[\s\S]*?(?:\/>|<\/animate\w*\s*>)/gi, ''],
    [/<(sodipodi|inkscape):[\w-]+\b[\s\S]*?(?:\/>|<\/\1:[\w-]+\s*>)/gi, ''],
    [/\s(?:sodipodi|inkscape):[\w-]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, ''],
    [/\sxmlns:(?:sodipodi|inkscape)\s*=\s*(?:"[^"]*"|'[^']*')/gi, ''],
    [/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''],
    // Links: only same-document fragments and raster data images survive.
    [/\s((?:xlink:)?href|src)\s*=\s*(["'])\s*(?!#|data:image\/(?:png|jpe?g|gif|webp);base64,)[^"']*\2/gi, ''],
    [/\s((?:xlink:)?href|src)\s*=\s*(?!["'])[^\s>]+/gi, ''],
    [/@import[^;]*;?/gi, ''],
    [/url\(\s*(["']?)\s*(?!#)[^)]*\)/gi, 'none'],
    [/expression\s*\(/gi, '('],
    [/javascript\s*:/gi, ''],
  ];
  for (let round = 0; round < 10; round++) {
    const before = svg;
    for (const [re, to] of passes) svg = svg.replace(re, to);
    if (svg === before) break;
  }
  return svg
    .replace(/>\s+</g, '><')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export interface SavedMedia {
  path: string;
  kind: MediaKind;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
}

/** A repository path for a new media file, confined and not holding the user's own work. */
export function destination(ctx: OperationContext, requested: string, overwrite: boolean): { abs: string; rel: string } | OperationResult {
  let abs: string;
  try {
    abs = resolveInside(ctx.roots, ctx.cwd, requested);
  } catch (error) {
    return failure(error instanceof OutsideRootError ? 'OUTSIDE_ROOT' : 'INVALID_INPUT', (error as Error).message);
  }
  const blocked = protectedCheck(ctx, abs);
  if (blocked) return blocked;
  if (!overwrite && existsSync(abs)) return failure('INVALID_INPUT', `${requested} already exists; pass overwrite to replace it`);
  return { abs, rel: relativeTo(ctx.cwd, abs) };
}

export const isFailure = (v: unknown): v is OperationResult => typeof v === 'object' && v !== null && 'ok' in v && (v as OperationResult).ok === false;

/** Read a confined repository file that is an image or video, by its bytes. */
export async function readMedia(ctx: OperationContext, requested: string): Promise<{ abs: string; rel: string; buf: Buffer; kind: MediaKind } | OperationResult> {
  let abs: string;
  try {
    abs = resolveInside(ctx.roots, ctx.cwd, requested);
  } catch (error) {
    return failure(error instanceof OutsideRootError ? 'OUTSIDE_ROOT' : 'INVALID_INPUT', (error as Error).message);
  }
  const s = await stat(abs).catch(() => null);
  if (!s?.isFile()) return failure('INVALID_INPUT', `${requested} is not a file`);
  if (s.size > MAX_VIDEO_BYTES) return failure('INVALID_INPUT', `${requested} is larger than ${MAX_VIDEO_BYTES / 1024 / 1024} MB`);
  const buf = await readFile(abs);
  const kind = sniff(buf);
  if (!kind) return failure('INVALID_INPUT', `${requested} is not an image or video this tool reads (PNG, JPEG, GIF, WebP, AVIF, SVG, MP4, WebM)`);
  return { abs, rel: relativeTo(ctx.cwd, abs), buf, kind };
}

/** Describe saved bytes; SVG is sanitised before it is written. */
export function describe(rel: string, buf: Buffer, kind: MediaKind): SavedMedia {
  const dims = dimensions(buf, kind);
  return { path: rel, kind, mime: MEDIA_MIME[kind], bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), width: dims?.width ?? null, height: dims?.height ?? null };
}

const HTTPS = /^https:\/\//i;
const LOOPBACK_HTTP = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\//i;

/** Stream one URL into a temporary file in `dir` under a size cap: https (or loopback http), redirects judged hop by hop, never into the Control Center. */
async function fetchToTemp(ctx: OperationContext, url: string, dir: string, cap: number, allowLoopback: boolean): Promise<{ temp: string; head: Buffer } | OperationResult> {
  if (!(HTTPS.test(url) || (allowLoopback && LOOPBACK_HTTP.test(url)))) return failure('INVALID_INPUT', 'Only https URLs (or a loopback http address) are downloaded');
  if (referencesSelf(url)) return failure('DENIED', "Refusing to download from the Control Center's own address");
  let guarded;
  try {
    guarded = await guardedFetch(url, { signal: ctx.signal }, { crossOrigin: 'follow' });
  } catch (error) {
    if (error instanceof RedirectRefused) return failure('DENIED', error.message);
    return failure('UNAVAILABLE', `Download failed: ${(error as Error).message}`);
  }
  const { res } = guarded;
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    return failure('FAILED', `Download failed: HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > cap) {
    await res.body.cancel().catch(() => undefined);
    return failure('INVALID_INPUT', `The file is ${Math.round(declared / 1024 / 1024)} MB; the limit is ${cap / 1024 / 1024} MB`);
  }
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.acc-download-${randomBytes(6).toString('hex')}`);
  const out = createWriteStream(temp);
  const reader = res.body.getReader();
  let total = 0;
  let head = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`The file is larger than ${cap / 1024 / 1024} MB`);
      }
      if (head.length < 4096) head = Buffer.concat([head, Buffer.from(value.subarray(0, 4096 - head.length))]);
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    return { temp, head };
  } catch (error) {
    out.destroy();
    await rm(temp, { force: true }).catch(() => undefined);
    return failure('INVALID_INPUT', (error as Error).message);
  }
}

/** Move a downloaded temporary file into place (SVG sanitised first) and describe it. */
async function settle(temp: string, dest: { abs: string; rel: string }, kind: MediaKind): Promise<SavedMedia> {
  let buf = await readFile(temp);
  if (kind === 'svg') {
    buf = Buffer.from(sanitizeSvg(buf.toString('utf8')), 'utf8');
    await writeFile(temp, buf);
  }
  await rename(temp, dest.abs);
  return describe(dest.rel, buf, kind);
}

/**
 * Download one image or video into the repository. The type is proven by
 * the bytes and must match the destination's extension; the body is
 * streamed to a temporary file under a size cap and only then moved into
 * place.
 */
export async function downloadMedia(
  ctx: OperationContext,
  url: string,
  requestedPath: string,
  opts: { overwrite: boolean; allowLoopback?: boolean; allowed?: readonly MediaKind[] },
): Promise<SavedMedia | OperationResult> {
  const expected = kindForExtension(requestedPath);
  if (!expected) return failure('INVALID_INPUT', `${requestedPath} needs an image or video extension (.png, .jpg, .gif, .webp, .avif, .svg, .mp4, .webm)`);
  const dest = destination(ctx, requestedPath, opts.overwrite);
  if (isFailure(dest)) return dest;
  const fetched = await fetchToTemp(ctx, url, path.dirname(dest.abs), isVideo(expected) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES, opts.allowLoopback ?? true);
  if (isFailure(fetched)) return fetched;
  const kind = sniff(fetched.head);
  const problem = !kind
    ? 'The download is not an image or video'
    : opts.allowed && !opts.allowed.includes(kind)
      ? `The download is ${kind}, which this tool does not accept here`
      : kind !== expected
        ? `The download is ${kind}, but ${requestedPath} names ${expected}; save it under a ${MEDIA_EXTENSIONS[kind][0]} name`
        : null;
  if (problem || !kind) {
    await rm(fetched.temp, { force: true }).catch(() => undefined);
    return failure('INVALID_INPUT', problem ?? 'The download is not an image or video');
  }
  return settle(fetched.temp, dest, kind);
}

/**
 * Download a generated result into the repository as `<stem>.<ext>`, the
 * extension chosen from the bytes (a vendor's URL or content type is not
 * trusted). Never overwrites: an existing file is an error.
 */
export async function downloadResult(ctx: OperationContext, url: string, stem: string, opts: { allowLoopback: boolean }): Promise<SavedMedia | OperationResult> {
  const probe = destination(ctx, `${stem}.png`, true);
  if (isFailure(probe)) return probe;
  const fetched = await fetchToTemp(ctx, url, path.dirname(probe.abs), MAX_VIDEO_BYTES, opts.allowLoopback);
  if (isFailure(fetched)) return fetched;
  const kind = sniff(fetched.head);
  const dest = kind ? destination(ctx, `${stem}${MEDIA_EXTENSIONS[kind][0]}`, false) : null;
  if (!kind || !dest || isFailure(dest) || (!isVideo(kind) && (await stat(fetched.temp)).size > MAX_IMAGE_BYTES)) {
    await rm(fetched.temp, { force: true }).catch(() => undefined);
    if (dest && isFailure(dest)) return dest;
    return failure('INVALID_INPUT', kind ? `The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB` : 'The result is not an image or video');
  }
  return settle(fetched.temp, dest, kind);
}
