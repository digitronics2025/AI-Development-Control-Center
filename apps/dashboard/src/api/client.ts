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

export interface ApiConfig {
  /** '' for same origin (standalone dashboard), or http://127.0.0.1:PORT (VS Code WebView). */
  baseUrl: string;
  token: string;
}

export type Api = ReturnType<typeof createApi>;

export function createApi(config: ApiConfig) {
  async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw new ApiError('The orchestrator is not reachable. Check that it is running.', 0, 'UNREACHABLE');
    }
    if (response.status === 204) return undefined as T;
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
    post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    del: <T = void>(path: string) => request<T>('DELETE', path),
    /** Authenticated download: the token travels in a header, never in a URL. */
    async download(path: string, filename: string): Promise<void> {
      const response = await fetch(`${config.baseUrl}${path}`, { headers: { authorization: `Bearer ${config.token}` } });
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
