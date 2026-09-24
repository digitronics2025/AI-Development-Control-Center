import path from 'node:path';
import type { ApiClient } from './connection';

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * The absolute file, if `repositoryPath` is a repository the orchestrator
 * registered and `file` stays inside it. The WebView supplies both, so neither
 * is trusted on its own (audit F-48).
 */
export async function registeredFile(api: Pick<ApiClient, 'request'>, repositoryPath: string, file: string): Promise<string | null> {
  const root = await registeredRoot(api, repositoryPath);
  if (!root) return null;
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

/** `repositoryPath` resolved, if it is a repository the orchestrator registered. */
export async function registeredRoot(api: Pick<ApiClient, 'request'>, repositoryPath: string): Promise<string | null> {
  const repositories = await api.request<Array<{ path: string }>>('GET', '/api/repositories');
  return repositories.map((r) => path.resolve(r.path)).find((p) => samePath(p, path.resolve(repositoryPath))) ?? null;
}
