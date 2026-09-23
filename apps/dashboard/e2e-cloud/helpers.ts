import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

export interface CloudE2EState {
  cloudUrl: string;
  nodeUrl: string;
  nodeToken: string;
  nodeId: string;
  accessToken: string;
}

export function state(): CloudE2EState {
  return JSON.parse(readFileSync(path.join(process.env.ACC_CLOUD_E2E_ROOT!, 'state.json'), 'utf8')) as CloudE2EState;
}

/** The node's own local API (what its operator does on that machine). */
export async function nodeApi<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
  const s = state();
  const res = await fetch(`${s.nodeUrl}${p}`, { method, headers: { authorization: `Bearer ${s.nodeToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** The cloud API as the signed-in browser (the Access cookie is in the storage state). */
export async function cloudApi<T = unknown>(page: Page, method: 'GET' | 'POST', p: string, data?: unknown): Promise<T> {
  const s = state();
  const res = await page.request.fetch(`${s.cloudUrl}${p}`, { method, data, headers: { origin: s.cloudUrl } });
  if (!res.ok()) throw new Error(`${method} ${p}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}
