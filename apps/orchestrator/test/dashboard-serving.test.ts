import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, TOKEN, type TestApp } from './helpers.js';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

function writeBuild(dir: string, entry: string, mtime: Date) {
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'assets', entry), 'console.log(1)');
  const index = path.join(dir, 'index.html');
  writeFileSync(index, `<!doctype html><html><head><script type="module" src="/assets/${entry}"></script></head><body></body></html>`);
  utimesSync(index, mtime, mtime);
}

const get = (url: string) => t!.app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } });

describe('dashboard serving', () => {
  it('follows a rebuild made while the orchestrator runs', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-dash-'));
    writeBuild(dir, 'index-old.js', new Date('2026-01-01T00:00:00Z'));
    t = await createTestApp({ dashboardDir: dir });

    const first = await get('/');
    expect(first.body).toContain('/assets/index-old.js');
    expect(first.body).toContain(`<meta name="acc-token" content="${TOKEN}">`);

    // Rebuild: the old chunk disappears, a new one and a new index.html appear.
    rmSync(path.join(dir, 'assets'), { recursive: true });
    writeBuild(dir, 'index-new.js', new Date('2026-01-02T00:00:00Z'));

    const deepLink = await get('/tasks/TASK-0001');
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.body).toContain('/assets/index-new.js');
    expect((await get('/assets/index-new.js')).statusCode).toBe(200);
    expect((await get('/assets/index-old.js')).statusCode).toBe(404);
    // API paths never fall back to the page.
    const api = await t!.app.inject({ method: 'GET', url: '/api/nope', headers: { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}` } });
    expect(api.statusCode).toBe(404);
    expect(api.body).not.toContain('<html>');
  });

  it('answers 503 rather than a broken page while the build folder is empty', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-dash-'));
    writeBuild(dir, 'index-a.js', new Date('2026-01-01T00:00:00Z'));
    t = await createTestApp({ dashboardDir: dir });
    rmSync(path.join(dir, 'index.html'));
    const res = await get('/');
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
  });
});
