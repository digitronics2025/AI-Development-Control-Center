import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveShell } from '@acc/executor';
import { builtinProviders, dimensions, findBrowser, sanitizeSvg, sniff, ToolHealthCache, ToolRegistry, ToolRouter, type OperationContext, type OperationResult } from '../src/index.js';
import { readMedia, streamToFile } from '../src/packs/media-files.js';

/**
 * The media tools (docs/systems/design-agent.md) against temporary folders, a
 * local HTTP server standing in for a CDN, and (when available) Chromium.
 */

const registry = new ToolRegistry();
for (const p of builtinProviders()) registry.register(p);
const router = new ToolRouter(registry);
const temp = mkdtempSync(path.join(os.tmpdir(), 'acc-media-'));
const health = new ToolHealthCache(registry, () => ({ env: process.env, cwd: temp, shell: (k) => resolveShell(k), tempDir: temp }));
const browser = await findBrowser();

// A real 1×1 PNG and a real 1×1 lossless WebP.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const EVIL_SVG = [
  '<?xml version="1.0"?>',
  '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="24" height="24" onload="alert(1)" viewBox="0 0 24 24">',
  '<!-- editor note -->',
  '<script>alert(document.cookie)</script>',
  '<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>',
  '<a xlink:href="javascript:alert(2)"><rect width="10" height="10"/></a>',
  '<image href="https://tracker.example/pixel.png" width="1" height="1"/>',
  '<set attributeName="href" to="javascript:alert(3)"/>',
  '<style>@import url(https://evil.example/x.css); .a{fill:url(https://evil.example/p)}</style>',
  '<linearGradient id="g"><stop offset="0"/></linearGradient>',
  '<title>Cart icon</title>',
  '<use href="#g"/><path d="M0 0h24v24H0z" fill="url(#g)" onclick="steal()"/>',
  '</svg>',
].join('\n');

function ctx(cwd: string, extra: Partial<OperationContext> = {}): OperationContext {
  return {
    executionId: 'test',
    taskId: null,
    cwd,
    roots: [cwd],
    env: process.env,
    signal: new AbortController().signal,
    timeoutMs: 60_000,
    tempDir: path.join(temp, 'scratch'),
    stateDir: path.join(temp, 'state'),
    shell: (k) => resolveShell(k),
    detection: (id) => health.get(id),
    protectedPaths: [],
    ...extra,
  };
}

async function call(capability: string, input: unknown, context: OperationContext): Promise<OperationResult> {
  const decision = router.route({ capability, detection: (id) => health.get(id) });
  if (!decision.ok) throw new Error(decision.reason);
  return decision.route.operation.run(decision.route.operation.input.parse(input), context);
}

let repo: string;
let server: http.Server;
let base: string;

beforeAll(async () => {
  repo = path.join(temp, 'repo');
  mkdirSync(path.join(repo, 'public'), { recursive: true });
  server = http.createServer((req, res) => {
    const send = (type: string, body: Buffer | string) => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };
    if (req.url === '/hero.png') return send('image/png', PNG);
    if (req.url === '/hero.webp') return send('image/webp', WEBP);
    if (req.url === '/icon.svg') return send('image/svg+xml', EVIL_SVG);
    if (req.url === '/fake.png') return send('image/png', '<html>not a picture</html>');
    if (req.url === '/huge.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(500 * 1024 * 1024) });
      return res.end();
    }
    if (req.url === '/to-control-center') {
      res.writeHead(302, { location: 'http://127.0.0.1:4317/api/tasks' });
      return res.end();
    }
    if (req.url === '/moved') {
      res.writeHead(301, { location: '/hero.png' });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('media file facts', () => {
  it('knows a file by its bytes and reads its dimensions', () => {
    expect(sniff(PNG)).toBe('png');
    expect(dimensions(PNG, 'png')).toEqual({ width: 1, height: 1 });
    expect(sniff(WEBP)).toBe('webp');
    expect(dimensions(WEBP, 'webp')).toEqual({ width: 1, height: 1 });
    expect(sniff(Buffer.from('GIF89a\x02\x00\x03\x00', 'latin1'))).toBe('gif');
    expect(dimensions(Buffer.from('GIF89a\x02\x00\x03\x00', 'latin1'), 'gif')).toEqual({ width: 2, height: 3 });
    expect(sniff(Buffer.from('<?xml version="1.0"?>\n<svg viewBox="0 0 48 32"></svg>'))).toBe('svg');
    expect(dimensions(Buffer.from('<svg viewBox="0 0 48 32"></svg>'), 'svg')).toEqual({ width: 48, height: 32 });
    expect(sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe('webm');
    expect(sniff(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypisom')]))).toBe('mp4');
    expect(sniff(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif')]))).toBe('avif');
    expect(sniff(Buffer.from('<html><svg></svg></html>'))).toBeNull();
    expect(sniff(Buffer.from('plain text'))).toBeNull();
  });

  it('sanitises SVG: nothing that runs, reaches out or declares entities survives; fragments and titles do', () => {
    const clean = sanitizeSvg(EVIL_SVG);
    for (const bad of ['<script', 'onload', 'onclick', 'javascript:', 'foreignObject', 'iframe', 'ENTITY', 'DOCTYPE', 'evil.example', 'tracker.example', '<set', '@import', 'editor note']) expect(clean, bad).not.toContain(bad);
    expect(clean).toContain('href="#g"');
    expect(clean).toContain('fill="url(#g)"');
    expect(clean).toContain('<title>Cart icon</title>');
    expect(clean).toContain('viewBox="0 0 24 24"');
    // Split or nested constructs cannot survive one pass.
    expect(sanitizeSvg('<svg><scr<script></script>ipt>alert(1)</script></svg>')).not.toMatch(/<script/i);
    expect(sanitizeSvg('<svg><a href="jav&#x09;ascript:x" onmouseover = "y"></a></svg>')).not.toMatch(/href=|onmouseover/i);
    // Entity-encoded attribute names in an animation, a renamed xlink prefix, entity- or escape-built url().
    const tricks = [
      '<svg xmlns:foo="http://www.w3.org/1999/xlink"><image id="i"/>',
      '<animate xlink:href="#i" attributeName="hr&#x65;f" to="https://attacker.example/pixel" dur="1s"/>',
      '<animateMotion dur="1s"><mpath href="#p"/></animateMotion>',
      '<image foo:href="https://attacker.example/foo.png"/>',
      '<rect style="fill:url&#40;https://attacker.example/entity)"/>',
      '<rect style="fill:u\\72l(https://attacker.example/escape)"/>',
      '<rect fill="url&#x28;https://attacker.example/attr)"/>',
      '<style>.a{fill:u\\72l(https://attacker.example/block)}</style>',
      '<rect fill="url(#g)" title="a &#x22;quote&#x22; &#60;kept&#62;"/></svg>',
    ].join('');
    const clean2 = sanitizeSvg(tricks);
    expect(clean2).not.toMatch(/attacker\.example|<animate|<set|foo:href/i);
    expect(clean2).toContain('fill="url(#g)"');
    // What must stay escaped for well-formed markup stays escaped.
    expect(clean2).toContain('title="a &#x22;quote&#x22; &#60;kept&#62;"');
  });
});

describe('media file limits and writes', () => {
  it('reads only a prefix to learn the type, then applies the image or video limit', async () => {
    const big = (name: string, head: Buffer) => {
      const file = path.join(repo, name);
      writeFileSync(file, head);
      truncateSync(file, 30 * 1024 * 1024);
      return name;
    };
    // A 30 MB image is over the 25 MB image limit; a 30 MB video is fine and its body is never buffered.
    const image = await readMedia(ctx(repo), big('huge.png', PNG));
    expect((image as OperationResult).ok).toBe(false);
    expect((image as OperationResult).summary).toMatch(/larger than 25 MB, the limit for an image/);
    const video = await readMedia(ctx(repo), big('long.webm', Buffer.from('1a45dfa3a34286810142f7810142f2810442f381084282847765626d', 'hex')));
    expect(video).toMatchObject({ kind: 'webm', bytes: 30 * 1024 * 1024 });
    expect((video as { buf: Buffer }).buf.length).toBeLessThanOrEqual(64 * 1024);
  });

  it.skipIf(!existsSync('/dev/full'))('turns a write error (a full disk) into a failure instead of an unhandled stream error', async () => {
    const body = new Blob([Buffer.alloc(256 * 1024, 1)]).stream();
    await expect(streamToFile(body as never, '/dev/full', 1024 * 1024)).rejects.toThrow(/ENOSPC|no space/i);
    await expect(streamToFile(new Blob([Buffer.alloc(2048, 1)]).stream() as never, path.join(repo, '.acc-cap-test'), 1024)).rejects.toThrow(/larger than/);
  });
});

describe('media.asset.fetch', () => {
  it('saves an image into the repository with its facts', async () => {
    const r = await call('media.asset.fetch', { url: `${base}/moved`, path: 'public/generated/hero.png' }, ctx(repo));
    expect(r.ok, r.summary).toBe(true);
    expect(r.output).toMatchObject({ path: 'public/generated/hero.png', kind: 'png', mime: 'image/png', bytes: PNG.length, width: 1, height: 1 });
    expect((r.output as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.filesChanged).toEqual(['public/generated/hero.png']);
    expect(readFileSync(path.join(repo, 'public/generated/hero.png')).equals(PNG)).toBe(true);
    // A second download to the same path needs overwrite.
    expect((await call('media.asset.fetch', { url: `${base}/hero.png`, path: 'public/generated/hero.png' }, ctx(repo))).error?.code).toBe('INVALID_INPUT');
    expect((await call('media.asset.fetch', { url: `${base}/hero.png`, path: 'public/generated/hero.png', overwrite: true }, ctx(repo))).ok).toBe(true);
  });

  it('writes a sanitised SVG', async () => {
    const r = await call('media.asset.fetch', { url: `${base}/icon.svg`, path: 'public/icons/cart.svg' }, ctx(repo));
    expect(r.ok, r.summary).toBe(true);
    const saved = readFileSync(path.join(repo, 'public/icons/cart.svg'), 'utf8');
    expect(saved).not.toMatch(/script|onload|javascript:|evil\.example/i);
    expect(r.output).toMatchObject({ kind: 'svg', width: 24, height: 24 });
  });

  it('stays inside the repository and off your own uncommitted work', async () => {
    expect((await call('media.asset.fetch', { url: `${base}/hero.png`, path: '../outside.png' }, ctx(repo))).error?.code).toBe('OUTSIDE_ROOT');
    const outside = mkdtempSync(path.join(os.tmpdir(), 'acc-media-outside-'));
    symlinkSync(outside, path.join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await call('media.asset.fetch', { url: `${base}/hero.png`, path: 'linked/escape.png' }, ctx(repo))).error?.code).toBe('OUTSIDE_ROOT');
    expect(existsSync(path.join(outside, 'escape.png'))).toBe(false);
    const guarded = await call('media.asset.fetch', { url: `${base}/hero.png`, path: 'public/mine/photo.png' }, ctx(repo, { protectedPaths: ['public/mine'] }));
    expect(guarded.error?.code).toBe('PROTECTED_PATH');
  });

  it('refuses what is not the image it claims, oversized files, other schemes and redirects into the Control Center', async () => {
    const fake = await call('media.asset.fetch', { url: `${base}/fake.png`, path: 'public/fake.png' }, ctx(repo));
    expect(fake.error?.code).toBe('INVALID_INPUT');
    expect(fake.summary).toMatch(/not an image or video/);
    expect(existsSync(path.join(repo, 'public/fake.png'))).toBe(false);
    const mismatch = await call('media.asset.fetch', { url: `${base}/hero.png`, path: 'public/hero.webp' }, ctx(repo));
    expect(mismatch.summary).toMatch(/is png, but public\/hero.webp names webp/);
    expect((await call('media.asset.fetch', { url: `${base}/huge.mp4`, path: 'public/huge.mp4' }, ctx(repo))).summary).toMatch(/limit is 200 MB/);
    expect((await call('media.asset.fetch', { url: 'http://example.com/a.png', path: 'public/a.png' }, ctx(repo))).summary).toMatch(/Only https/);
    expect((await call('media.asset.fetch', { url: 'file:///etc/passwd', path: 'public/a.png' }, ctx(repo))).summary).toMatch(/Only https/);
    const self = await call('media.asset.fetch', { url: `${base}/to-control-center`, path: 'public/cc.png' }, ctx(repo));
    expect(self.error?.code).toBe('DENIED');
    expect(self.summary).toMatch(/Control Center/);
    expect((await call('media.asset.fetch', { url: `${base}/hero.png`, path: 'public/notes.txt' }, ctx(repo))).summary).toMatch(/needs an image or video extension/);
    // No temporary files are left behind by refused downloads.
    expect(readFileSync(path.join(repo, 'public/icons/cart.svg'), 'utf8').length).toBeGreaterThan(0);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(path.join(repo, 'public')).filter((f) => f.startsWith('.acc-download-'))).toEqual([]);
  });
});

describe('media.image.view', () => {
  it('shows a small PNG to the model as it is and refuses what is not an image', async () => {
    writeFileSync(path.join(repo, 'public', 'dot.png'), PNG);
    const r = await call('media.image.view', { path: 'public/dot.png' }, ctx(repo));
    expect(r.ok, r.summary).toBe(true);
    expect(r.images?.[0]).toMatchObject({ mime: 'image/png' });
    expect(r.images?.[0]?.data.equals(PNG)).toBe(true);
    expect(r.summary).toMatch(/png, 1×1/);
    writeFileSync(path.join(repo, 'public', 'notes.txt'), 'hello');
    expect((await call('media.image.view', { path: 'public/notes.txt' }, ctx(repo))).error?.code).toBe('INVALID_INPUT');
    writeFileSync(path.join(repo, 'public', 'clip.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]));
    expect((await call('media.image.view', { path: 'public/clip.webm' }, ctx(repo))).summary).toMatch(/media.video.frames/);
    expect((await call('media.image.view', { path: '../x.png' }, ctx(repo))).error?.code).toBe('OUTSIDE_ROOT');
  });

  it.skipIf(!browser)('draws WebP and SVG in an isolated Chromium and returns a JPEG under the model ceiling', async () => {
    writeFileSync(path.join(repo, 'public', 'dot.webp'), WEBP);
    const webp = await call('media.image.view', { path: 'public/dot.webp' }, ctx(repo));
    expect(webp.ok, webp.summary).toBe(true);
    expect(webp.images?.[0]?.mime).toBe('image/jpeg');
    expect(webp.images![0]!.data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    const svg = await call('media.image.view', { path: 'public/icons/cart.svg', maxWidth: 256 }, ctx(repo));
    expect(svg.ok, svg.summary).toBe(true);
    expect(svg.images?.[0]?.mime).toBe('image/jpeg');
  }, 60_000);
});

describe('fal generation (a stand-in queue)', () => {
  const KEY = ['fal', 'test', 'key', '0123456789abcdef'].join('-');
  let fal: http.Server;
  let falBase: string;
  const seen: Array<{ method: string; url: string; auth: string | undefined; body: any }> = [];
  let state: 'IN_QUEUE' | 'COMPLETED' = 'COMPLETED';
  let submitStatus = 200;
  let result: unknown = null;
  let jobUrls: 'own' | 'foreign' = 'own';
  /** A connection the queue drops after the submission was accepted: while the status or the result is read. */
  let drop: 'none' | 'status' | 'result' = 'none';

  beforeAll(async () => {
    fal = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
        if ((drop === 'status' && req.url!.endsWith('/status')) || (drop === 'result' && req.method === 'GET' && /\/requests\/[\w-]+$/.test(req.url!))) return req.socket.destroy();
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.url!.startsWith('/files/')) {
          const file = req.url!.slice(7);
          if (file.endsWith('.png')) return res.end(PNG);
          if (file.endsWith('.webp')) return res.end(WEBP);
          if (file.endsWith('.svg')) return res.end(EVIL_SVG);
          return res.end('not media');
        }
        if (req.method === 'POST') {
          if (submitStatus !== 200) return json(submitStatus, { detail: submitStatus === 422 ? [{ loc: ['body', 'prompt'], msg: 'field required' }] : 'boom' });
          const root = jobUrls === 'own' ? falBase : 'https://evil.example';
          const app = req.url!.slice(1).split('/').slice(0, 2).join('/');
          return json(200, { request_id: 'req-1', status_url: `${root}/${app}/requests/req-1/status`, response_url: `${root}/${app}/requests/req-1`, cancel_url: `${root}/${app}/requests/req-1/cancel` });
        }
        if (req.url!.endsWith('/status')) return json(200, { status: state, queue_position: state === 'IN_QUEUE' ? 3 : null });
        if (req.url!.endsWith('/cancel')) return json(200, { status: 'CANCELLATION_REQUESTED' });
        if (req.url!.includes('/requests/')) return json(200, result);
        json(404, { detail: 'unknown' });
      });
    });
    await new Promise<void>((r) => fal.listen(0, '127.0.0.1', r));
    falBase = `http://127.0.0.1:${(fal.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => fal.close(() => r())));

  const written: Array<{ name: string; type: string; bytes: number }> = [];
  const falCtx = (extra: Partial<OperationContext> = {}) =>
    ctx(repo, {
      env: { ...process.env, ACC_FAL_API_BASE: falBase },
      credentials: { value: async (name, opts) => (name === 'fal' && opts?.kind === 'media' ? KEY : null), envFor: async () => ({}) },
      artifacts: { write: async (a) => (written.push({ name: a.name, type: a.type, bytes: Buffer.byteLength(a.content) }), { id: `art-${written.length}`, name: a.name }) },
      ...extra,
    });
  const reset = () => {
    seen.length = 0;
    state = 'COMPLETED';
    submitStatus = 200;
    jobUrls = 'own';
    drop = 'none';
  };

  it('submits once with the key, waits, and saves every result into the repository by its real type', async () => {
    reset();
    result = { images: [{ url: `${falBase}/files/a.png` }, { url: `${falBase}/files/b.webp` }], seed: 7 };
    const r = await call('media.image.generate', { prompt: 'A calm hero photo of a phone on marble', aspectRatio: '16:9', count: 2, path: 'public/generated', name: 'hero' }, falCtx());
    expect(r.ok, r.summary).toBe(true);
    expect(r.filesChanged).toEqual(['public/generated/hero-1.png', 'public/generated/hero-2.webp']);
    expect(r.output).toMatchObject({ status: 'COMPLETED', model: 'fal-ai/flux/dev', seed: 7, estimatedCost: { usd: 0.2, unit: 'image', units: 2 } });
    const submits = seen.filter((s) => s.method === 'POST');
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({ url: '/fal-ai/flux/dev', auth: `Key ${KEY}`, body: { prompt: 'A calm hero photo of a phone on marble', num_images: 2, image_size: 'landscape_16_9' } });
    // Masters are kept with the task; the key is never part of what comes back.
    expect(written.map((w) => [w.name, w.type])).toEqual([['hero-1.png', 'image'], ['hero-2.webp', 'image']]);
    expect(JSON.stringify(r)).not.toContain(KEY);
    // A second run never overwrites the first.
    const again = await call('media.image.generate', { prompt: 'x', path: 'public/generated', name: 'hero' }, falCtx());
    expect(again.ok).toBe(false);
    expect(again.summary).toMatch(/already exists/);
  });

  it('never lets extra arguments set what is billed: the count and length decide, and the validated fields win', async () => {
    reset();
    const op = (id: string) => registry.provider('fal')!.operations.find((o) => o.id === id)!;
    for (const args of [{ num_images: 100 }, { N: 4 }, { batch_size: 8 }]) expect(op('media.image.generate').input.safeParse({ prompt: 'x', path: 'p', name: 'n', arguments: args }).success, JSON.stringify(args)).toBe(false);
    expect(op('media.video.generate').input.safeParse({ prompt: 'x', path: 'p', name: 'n', arguments: { duration: '30' } }).success).toBe(false);
    expect(op('media.image.edit').input.safeParse({ prompt: 'x', image: 'a.png', path: 'p', name: 'n', arguments: { num_outputs: 4 } }).success).toBe(false);
    result = { images: [{ url: `${falBase}/files/c.png` }] };
    const r = await call('media.image.generate', { prompt: 'The real prompt', count: 1, path: 'public/generated', name: 'args', arguments: { prompt: 'another prompt', guidance_scale: 4 } }, falCtx());
    expect(r.ok, r.summary).toBe(true);
    expect(seen.find((q) => q.method === 'POST')!.body).toMatchObject({ prompt: 'The real prompt', num_images: 1, guidance_scale: 4 });
  });

  it('hands back a job id when the result is not ready, and status and fetch finish it without submitting again', async () => {
    reset();
    state = 'IN_QUEUE';
    result = { video: { url: `${falBase}/files/c.png` } };
    const r = await call('media.video.generate', { prompt: 'Slow dolly in', image: 'public/dot.png', durationSec: 6, path: 'public/generated', name: 'loop', waitSec: 0 }, falCtx());
    expect(r.ok, r.summary).toBe(true);
    expect(r.output).toMatchObject({ status: 'IN_QUEUE', model: 'fal-ai/kling-video/v2.1/standard/image-to-video', estimatedCost: { usd: 1.8, unit: 'video-second', units: 6 } });
    expect(r.summary).toMatch(/do not submit again/);
    const submit = seen.find((s) => s.method === 'POST')!;
    expect(submit.body).toMatchObject({ prompt: 'Slow dolly in', duration: '6' });
    expect(submit.body.image_url).toMatch(/^data:image\/png;base64,/);
    const jobId = (r.output as { jobId: string }).jobId;
    expect((await call('media.job.status', { jobId }, falCtx())).output).toMatchObject({ status: 'IN_QUEUE', position: 3 });
    state = 'COMPLETED';
    const fetched = await call('media.job.fetch', { jobId, path: 'public/generated', name: 'loop' }, falCtx());
    expect(fetched.ok, fetched.summary).toBe(true);
    expect(fetched.filesChanged).toEqual(['public/generated/loop-1.png']);
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(1);
    expect((await call('media.job.cancel', { jobId }, falCtx())).ok).toBe(true);
  });

  it('never retries a billed submission and explains fal errors', async () => {
    reset();
    submitStatus = 500;
    const failed = await call('media.image.generate', { prompt: 'x', path: 'public/generated', name: 'retry' }, falCtx());
    expect(failed.error?.code).toBe('UNAVAILABLE');
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(1);
    reset();
    submitStatus = 422;
    const invalid = await call('media.image.generate', { prompt: 'x', path: 'public/generated', name: 'bad' }, falCtx());
    expect(invalid.error?.code).toBe('INVALID_INPUT');
    expect(invalid.summary).toContain('body.prompt: field required');
  });

  it('keeps the job id when following a billed job fails, so it is polled and fetched, never submitted again', async () => {
    reset();
    result = { images: [{ url: `${falBase}/files/d.png` }, { url: `${falBase}/files/e.png` }] };
    const jobOf = (r: OperationResult) => (r.output as { jobId: string }).jobId;
    // The queue accepts the submission, then the connection drops while the status is read.
    drop = 'status';
    const lost = await call('media.image.generate', { prompt: 'x', path: 'public/generated', name: 'dropped' }, falCtx());
    expect(lost.ok).toBe(false);
    expect(lost.output).toMatchObject({ status: 'UNKNOWN', jobId: expect.stringMatching(/^fal:/), model: 'fal-ai/flux/dev' });
    expect(lost.summary).toMatch(/submitted[\s\S]*poll media\.job\.status[\s\S]*do not submit again/);
    const jobId = jobOf(lost);
    // media.job.fetch keeps it too when the status read fails.
    const fetchLost = await call('media.job.fetch', { jobId, path: 'public/generated', name: 'dropped' }, falCtx());
    expect(fetchLost.output).toMatchObject({ status: 'UNKNOWN', jobId });
    expect(fetchLost.summary).toMatch(/do not submit again/);
    // ...or while the finished result is read, by the paid call and by media.job.fetch.
    drop = 'result';
    const unread = await call('media.image.generate', { prompt: 'x', path: 'public/generated', name: 'unread' }, falCtx());
    expect(unread.ok).toBe(false);
    expect(unread.output).toMatchObject({ status: 'COMPLETED', jobId: expect.stringMatching(/^fal:/) });
    expect(unread.summary).toMatch(/media\.job\.fetch[\s\S]*do not submit again/);
    const fetchUnread = await call('media.job.fetch', { jobId, path: 'public/generated', name: 'dropped' }, falCtx());
    expect(fetchUnread.output).toMatchObject({ status: 'COMPLETED', jobId });
    // Each paid call submitted exactly once, whatever failed after it.
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(2);
    // A write that fails part way says what was saved (so a retry picks another name) and keeps the job id.
    drop = 'none';
    const partial = await call('media.job.fetch', { jobId, path: 'public/generated', name: 'dropped' }, falCtx({ artifacts: { write: async () => Promise.reject(new Error('artifact store is full')) } }));
    expect(partial.ok).toBe(false);
    expect(partial.summary).toMatch(/artifact store is full[\s\S]*1 file saved/);
    expect(partial.filesChanged).toEqual(['public/generated/dropped-1.png']);
    expect(partial.output).toMatchObject({ status: 'COMPLETED', jobId });
    const retried = await call('media.job.fetch', { jobId, path: 'public/generated', name: 'dropped-again' }, falCtx());
    expect(retried.ok, retried.summary).toBe(true);
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(2);
  });

  it('reads only a media credential, and sends the key only to the queue it came from', async () => {
    reset();
    const other = await call('media.image.generate', { prompt: 'x', path: 'public/generated', name: 'k', credential: 'github' }, falCtx());
    expect(other.error?.code).toBe('AUTH_REQUIRED');
    const wrongKind = await call('media.image.generate', { prompt: 'x', path: 'public/generated', name: 'k' }, falCtx({ credentials: { value: async (_n, opts) => (opts?.kind === 'media' ? null : KEY), envFor: async () => ({}) } }));
    expect(wrongKind.error?.code).toBe('AUTH_REQUIRED');
    expect(seen).toHaveLength(0);
    // A forged job id pointing elsewhere is refused before any request.
    const forged = `fal:${Buffer.from(JSON.stringify({ m: 'fal-ai/flux/dev', r: 'req-1', s: 'https://evil.example/requests/req-1/status', g: 'https://evil.example/requests/req-1', c: 'https://evil.example/requests/req-1/cancel' })).toString('base64url')}`;
    expect((await call('media.job.status', { jobId: forged }, falCtx())).error?.code).toBe('INVALID_INPUT');
    expect((await call('media.job.status', { jobId: 'not-a-job' }, falCtx())).error?.code).toBe('INVALID_INPUT');
    expect(seen).toHaveLength(0);
    // Job URLs the queue returns on another origin are not followed with the key.
    jobUrls = 'foreign';
    const foreign = await call('media.image.generate', { prompt: 'x', path: 'public/generated', name: 'f' }, falCtx());
    expect(foreign.summary).toMatch(/outside its queue/);
    expect(seen.map((s) => s.url)).toEqual(['/fal-ai/flux/dev']);
  });

  it('sanitises a vectorised SVG and refuses a result that is not media', async () => {
    reset();
    result = { image: { url: `${falBase}/files/logo.svg`, content_type: 'image/svg+xml' } };
    const svg = await call('media.image.vectorize', { image: 'public/dot.png', path: 'public/icons', name: 'logo' }, falCtx());
    expect(svg.ok, svg.summary).toBe(true);
    expect(readFileSync(path.join(repo, 'public/icons/logo-1.svg'), 'utf8')).not.toMatch(/script|onload|evil\.example/);
    reset();
    result = { images: [{ url: `${falBase}/files/readme.txt` }] };
    const junk = await call('media.image.generate', { prompt: 'x', path: 'public/generated', name: 'junk' }, falCtx());
    expect(junk.summary).toMatch(/not an image or video/);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(path.join(repo, 'public/generated')).filter((f) => f.startsWith('.acc-download-') || f.startsWith('junk'))).toEqual([]);
  });
});

describe('media.svg.optimize', () => {
  it('sanitises and minifies an SVG in place or to another path', async () => {
    writeFileSync(path.join(repo, 'public', 'raw.svg'), EVIL_SVG);
    const r = await call('media.svg.optimize', { path: 'public/raw.svg', out: 'public/icons/clean.svg' }, ctx(repo));
    expect(r.ok, r.summary).toBe(true);
    const clean = readFileSync(path.join(repo, 'public/icons/clean.svg'), 'utf8');
    expect(clean).not.toMatch(/script|onload|onclick|javascript:|evil\.example|ENTITY/);
    expect(clean.length).toBeLessThan(EVIL_SVG.length);
    expect((r.output as { before: number }).before).toBe(Buffer.byteLength(EVIL_SVG));
    writeFileSync(path.join(repo, 'public', 'dot2.png'), PNG);
    expect((await call('media.svg.optimize', { path: 'public/dot2.png' }, ctx(repo))).summary).toMatch(/not SVG/);
    expect((await call('media.svg.optimize', { path: 'public/raw.svg', out: 'public/raw.txt' }, ctx(repo))).summary).toMatch(/\.svg name/);
    expect((await call('media.svg.optimize', { path: 'public/raw.svg', out: 'public/mine/x.svg' }, ctx(repo, { protectedPaths: ['public/mine'] }))).error?.code).toBe('PROTECTED_PATH');
  });
});

await health.refresh({ ids: ['ffmpeg'] });
const ffmpegPath = health.get('ffmpeg')?.installed ? health.get('ffmpeg')!.path : null;

describe('FFmpeg media tools', () => {
  beforeAll(async () => {
    if (!ffmpegPath) return;
    const { execFileSync } = await import('node:child_process');
    // Real fixtures made by FFmpeg itself: an 800×600 picture and a 2-second clip with a tone.
    mkdirSync(path.join(repo, 'media src'), { recursive: true });
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=800x600', '-frames:v', '1', path.join(repo, 'media src', 'Hero Shot.png')]);
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(repo, 'media src', 'clip.mp4')]);
  }, 60_000);
  const needs = () => !ffmpegPath;

  it('says how to install FFmpeg when it is missing', async () => {
    const op = registry.provider('ffmpeg')!.operations.find((o) => o.id === 'media.asset.optimize')!;
    const r = await op.run(op.input.parse({ image: 'public/dot.png' }), ctx(repo, { detection: () => undefined }));
    expect(r.error?.code).toBe('NOT_INSTALLED');
    expect(r.summary).toMatch(/Gyan.FFmpeg/);
  });

  it.skipIf(needs())('writes AVIF and WebP widths without upscaling, with srcset and a picture snippet', async () => {
    const r = await call('media.asset.optimize', { image: 'media src/Hero Shot.png', widths: [320, 640, 1920], outDir: 'public/img', quality: 60 }, ctx(repo));
    expect(r.ok, r.summary).toBe(true);
    const files = (r.output as { files: Array<{ path: string; kind: string; width: number | null }> }).files;
    // 1920 is clamped to the 800 px original: never upscaled.
    expect(files.map((f) => f.path).sort()).toEqual(['public/img/hero-shot-320.avif', 'public/img/hero-shot-320.webp', 'public/img/hero-shot-640.avif', 'public/img/hero-shot-640.webp', 'public/img/hero-shot-800.avif', 'public/img/hero-shot-800.webp']);
    expect(files.filter((f) => f.kind === 'webp').map((f) => f.width)).toEqual([320, 640, 800]);
    const out = r.output as { srcset: Record<string, string>; snippet: string };
    expect(out.srcset.webp).toBe('/img/hero-shot-320.webp 320w, /img/hero-shot-640.webp 640w, /img/hero-shot-800.webp 800w');
    // AVIF carries its widths too (its dimensions are not read from the bytes).
    expect(out.srcset.avif).toBe('/img/hero-shot-320.avif 320w, /img/hero-shot-640.avif 640w, /img/hero-shot-800.avif 800w');
    const avifOnly = await call('media.asset.optimize', { image: 'media src/Hero Shot.png', widths: [400], formats: ['avif'], outDir: 'public/img', name: 'only' }, ctx(repo));
    expect((avifOnly.output as { snippet: string }).snippet).toMatch(/width="400" height="300"/);
    expect(out.snippet).toContain('<source type="image/avif"');
    expect(out.snippet).toMatch(/width="800" height="600"/);
    for (const f of files) expect(sniff(readFileSync(path.join(repo, f.path)))).toBe(f.kind);
  }, 120_000);

  it.skipIf(needs())('writes WebM and faststart MP4 without audio, a poster, and a contact sheet for the model', async () => {
    const r = await call('media.video.encode', { video: 'media src/clip.mp4', outDir: 'public/video', name: 'loop', maxWidth: 480, quality: 'small' }, ctx(repo));
    expect(r.ok, r.summary).toBe(true);
    expect(r.filesChanged).toEqual(['public/video/loop.webm', 'public/video/loop.mp4']);
    const mp4 = readFileSync(path.join(repo, 'public/video/loop.mp4'));
    // +faststart: the index (moov) comes before the media data (mdat).
    expect(mp4.indexOf('moov')).toBeGreaterThan(0);
    expect(mp4.indexOf('moov')).toBeLessThan(mp4.indexOf('mdat'));
    expect((r.output as { snippet: string }).snippet).toMatch(/<video autoplay muted loop playsinline[\s\S]*video\/webm[\s\S]*video\/mp4/);
    const frames = await call('media.video.frames', { video: 'public/video/loop.mp4', count: 4 }, ctx(repo));
    expect(frames.ok, frames.summary).toBe(true);
    expect(frames.summary).toMatch(/no audio/);
    expect(frames.output).toMatchObject({ width: 480, audio: false });
    expect(frames.images?.[0]?.mime).toBe('image/jpeg');
    const original = await call('media.video.frames', { video: 'media src/clip.mp4', count: 2 }, ctx(repo));
    expect(original.summary).toMatch(/with audio/);
    const poster = await call('media.video.poster', { video: 'public/video/loop.webm', atSec: 1 }, ctx(repo));
    expect(poster.ok, poster.summary).toBe(true);
    expect(poster.filesChanged).toEqual(['public/video/loop-poster.jpg']);
    expect(poster.output).toMatchObject({ kind: 'jpeg', width: 480 });
    // Never replaces its own source, and an image is not a video.
    expect((await call('media.video.encode', { video: 'public/video/loop.mp4', formats: ['mp4'], outDir: 'public/video', name: 'loop' }, ctx(repo))).summary).toMatch(/replace the source/);
    expect((await call('media.video.encode', { video: 'public/dot.png' }, ctx(repo))).summary).toMatch(/not a video/);
  }, 180_000);

  it.skipIf(needs())('refuses "%" in any path it hands FFmpeg, which would read x%d as x1 and write past the path checks', async () => {
    // A protected, existing poster in public/x1: 'public/x%d' names another folder, but FFmpeg would expand it to x1.
    mkdirSync(path.join(repo, 'public', 'x1'), { recursive: true });
    const mine = path.join(repo, 'public', 'x1', 'clip-poster.jpg');
    writeFileSync(mine, 'my own poster');
    const guarded = ctx(repo, { protectedPaths: ['public/x1'] });
    expect((await call('media.video.poster', { video: 'media src/clip.mp4', outDir: 'public/x1' }, guarded)).error?.code).toBe('PROTECTED_PATH');
    const poster = await call('media.video.poster', { video: 'media src/clip.mp4', outDir: 'public/x%d' }, guarded);
    expect(poster.error?.code).toBe('INVALID_INPUT');
    expect(poster.summary).toMatch(/public\/x%d\/clip-poster\.jpg has "%" in its path[\s\S]*image-sequence pattern/);
    expect(readFileSync(mine, 'utf8')).toBe('my own poster');
    // The same for the other tools and for a source whose folder has "%" (outputs default to it; FFmpeg would read seq1/ instead).
    const jpeg = await call('media.asset.optimize', { image: 'media src/Hero Shot.png', widths: [64], formats: ['jpeg'], outDir: 'public/q%d' }, ctx(repo));
    expect(jpeg.summary).toMatch(/image-sequence pattern/);
    expect((await call('media.video.encode', { video: 'media src/clip.mp4', formats: ['webm'], outDir: 'public/v%d' }, ctx(repo))).summary).toMatch(/image-sequence pattern/);
    mkdirSync(path.join(repo, 'seq%d'), { recursive: true });
    writeFileSync(path.join(repo, 'seq%d', 'shot.png'), readFileSync(path.join(repo, 'media src', 'Hero Shot.png')));
    writeFileSync(path.join(repo, 'seq%d', 'clip.mp4'), readFileSync(path.join(repo, 'media src', 'clip.mp4')));
    const input = await call('media.asset.optimize', { image: 'seq%d/shot.png', widths: [64], formats: ['jpeg'], outDir: 'public/img' }, ctx(repo));
    expect(input.error?.code).toBe('INVALID_INPUT');
    expect(input.summary).toMatch(/seq%d\/shot\.png has "%"/);
    expect((await call('media.video.poster', { video: 'seq%d/clip.mp4' }, ctx(repo))).summary).toMatch(/seq%d\/clip\.mp4 has "%"/);
    expect((await call('media.video.frames', { video: 'seq%d/clip.mp4' }, ctx(repo))).summary).toMatch(/image-sequence pattern/);
    // Nothing was written or created for a refused path.
    for (const p of ['public/x%d', 'public/q%d', 'public/q1', 'public/v%d', 'public/img/shot-64.jpg', 'seq%d/clip-poster.jpg', 'seq1']) expect(existsSync(path.join(repo, p)), p).toBe(false);
    // The contact sheet is written to the operator's temporary folder exactly as named, even when that has a "%".
    const frames = await call('media.video.frames', { video: 'media src/clip.mp4', count: 2 }, ctx(repo, { tempDir: path.join(temp, 'scratch%d') }));
    expect(frames.ok, frames.summary).toBe(true);
    expect(existsSync(path.join(temp, 'scratch1'))).toBe(false);
  }, 120_000);
});
