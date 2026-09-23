/** Typed errors, JSON responses, bounded bodies and security headers (docs/systems/cloud-control.md). */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const BASE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cache-control': 'no-store',
};

/** The dashboard page: same-origin everything, no inline script, no framing. */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

export function withSecurityHeaders(response: Response, requestId: string, extra: Record<string, string> = {}): Response {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries({ ...BASE_HEADERS, ...extra })) {
    // Hashed dashboard assets keep their long cache; everything else is no-store.
    if (k === 'cache-control' && out.headers.has('cache-control') && !extra['cache-control']) continue;
    out.headers.set(k, v);
  }
  out.headers.set('x-request-id', requestId);
  return out;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

export function errorResponse(error: HttpError): Response {
  return json({ error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } }, error.status);
}

/** Read a JSON body with a hard size limit; streams are counted, not trusted from content-length alone. */
export async function readJson(request: Request, limitBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limitBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel();
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    }
    chunks.push(value);
  }
  if (!total) return undefined;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? '0.0.0.0';
}

/** Structured log line without payloads (Workers Logs indexes the JSON). */
export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

export function base64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const nowIso = (): string => new Date().toISOString();
export const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();
