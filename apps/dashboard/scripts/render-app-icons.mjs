// Renders the installable-app icons (docs/systems/dashboard.md "Installable app")
// from public/favicon.svg with the Chromium that Playwright already provides.
// Run after the logo changes: `node apps/dashboard/scripts/render-app-icons.mjs`,
// then commit the PNGs in public/icons.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'public', 'icons');
const favicon = readFileSync(path.join(root, 'public', 'favicon.svg'), 'utf8');
// The logo's tile colour, so a maskable crop never shows a second colour.
const tile = /<rect[^>]*fill="(#[0-9A-Fa-f]{6})"/.exec(favicon)?.[1] ?? '#151A22';

// Maskable: full-bleed tile, the mark kept inside the 80% safe zone.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${tile}"/><text x="16" y="19.6" text-anchor="middle" font-family="Consolas, monospace" font-size="10" font-weight="700" fill="#6EA8FE">AC</text></svg>`;
// Apple crops to a rounded square itself: full-bleed tile plus the logo's own mark.
const apple = favicon.replace(/rx="\d+"/g, 'rx="0"').replace(/<rect x="1"[^>]*\/>/, '');

const icons = [
  { file: 'icon-192.png', size: 192, svg: favicon, transparent: true },
  { file: 'icon-512.png', size: 512, svg: favicon, transparent: true },
  { file: 'icon-maskable-512.png', size: 512, svg: maskable, transparent: false },
  { file: 'apple-touch-icon.png', size: 180, svg: apple, transparent: false },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' }).catch(() => chromium.launch());
try {
  for (const icon of icons) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    const svg = icon.svg.replace('<svg ', `<svg width="${icon.size}" height="${icon.size}" `);
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
    await page.screenshot({ path: path.join(out, icon.file), omitBackground: icon.transparent, clip: { x: 0, y: 0, width: icon.size, height: icon.size } });
    await page.close();
    console.log(`wrote public/icons/${icon.file}`);
  }
} finally {
  await browser.close();
}
