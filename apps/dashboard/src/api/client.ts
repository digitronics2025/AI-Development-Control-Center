import type { ApiErrorBody } from '@acc/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * How requests authenticate (design.md §13, docs/systems/cloud-control.md):
 * - local: the orchestrator's bearer token (standalone dashboard, VS Code WebView);
 * - cloud: same-origin behind Cloudflare Access (its cookie travels by itself), no
 *   token anywhere, and the selected execution node named in a header.
 */
export type ApiAuth = { kind: 'local'; token: string } | { kind: 'cloud'; node: () => string | null };

export interface ApiConfig {
  /** '' for same origin (standalone dashboard, cloud), or http://127.0.0.1:PORT (VS Code WebView). */
  baseUrl: string;
  auth: ApiAuth;
}

/** A random key per mutation, so a retried request never runs twice in the cloud. */
function idempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function authHeaders(auth: ApiAuth, method: string): Record<string, string> {
  if (auth.kind === 'local') return { authorization: `Bearer ${auth.token}` };
  const node = auth.node();
  return { ...(node ? { 'x-acc-node': node } : {}), ...(method !== 'GET' ? { 'idempotency-key': idempotencyKey() } : {}) };
}

export type Api = ReturnType<typeof createApi>;

export function createApi(config: ApiConfig) {
  async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          ...authHeaders(config.auth, method),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...extraHeaders,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw new ApiError(config.auth.kind === 'cloud' ? 'The control plane is not reachable. Check your connection.' : 'The orchestrator is not reachable. Check that it is running.', 0, 'UNREACHABLE');
    }
    if (response.status === 204) return undefined as T;
    // Cloud mode: the node accepted the command but has not finished it; the page updates by itself when it does.
    // (A local route may itself answer 202, e.g. a Chairman message: only the command status says 'not finished'.)
    const commandStatus = response.headers.get('x-acc-command-status');
    if (response.status === 202 && commandStatus && commandStatus !== 'succeeded' && commandStatus !== 'failed') {
      throw new ApiError('Sent to the node. This page updates when it finishes.', 202, 'REMOTE_PENDING');
    }
    const text = await response.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const err = (data as ApiErrorBody | undefined)?.error;
      throw new ApiError(err?.message ?? `Request failed (${response.status})`, response.status, err?.code ?? 'HTTP_ERROR', err?.details);
    }
    return data as T;
  }

  return {
    config,
    get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
    /** `headers`: cloud routing hints (node choice, queueing); ignored by the local orchestrator. */
    post: <T>(path: string, body: unknown = {}, headers?: Record<string, string>) => request<T>('POST', path, body, undefined, headers),
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    del: <T = void>(path: string) => request<T>('DELETE', path),
    /** Authenticated download: credentials travel in a header or cookie, never in a URL. */
    async download(path: string, filename: string): Promise<void> {
      const response = await fetch(`${config.baseUrl}${path}`, { headers: authHeaders(config.auth, 'GET'), credentials: 'same-origin' });
      if (!response.ok) throw new ApiError(`Download failed (${response.status})`, response.status, 'DOWNLOAD_FAILED');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  };
}

/** Readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
