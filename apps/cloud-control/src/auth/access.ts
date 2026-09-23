import type { Env } from '../env.js';
import { fromBase64url, HttpError } from '../http.js';

/**
 * Cloudflare Access identity (docs/systems/cloud-control.md §People).
 *
 * Access sits in front of the control hostname; the Worker checks the token
 * again (defence in depth, and the only check if a request reached the Worker
 * some other way). No team domain or audience configured = every request is
 * refused: the dashboard never opens without Access.
 */
export interface AccessIdentity {
  email: string;
  /** Seconds since epoch the Access session was issued (recent-login checks). */
  issuedAt: number;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const JWKS_TTL_MS = 10 * 60_000;
const SKEW_S = 60;
let cache: { team: string; at: number; keys: Jwk[] } | null = null;

async function jwks(env: Env, forceRefresh = false): Promise<Jwk[]> {
  // A static key set is honoured only outside staging/production (tests and local dev).
  if (env.ACCESS_JWKS && env.ENVIRONMENT !== 'production' && env.ENVIRONMENT !== 'staging') {
    return (JSON.parse(env.ACCESS_JWKS) as { keys: Jwk[] }).keys;
  }
  const team = env.ACCESS_TEAM_DOMAIN;
  if (!forceRefresh && cache && cache.team === team && Date.now() - cache.at < JWKS_TTL_MS) return cache.keys;
  const response = await fetch(`https://${team}/cdn-cgi/access/certs`, { cf: { cacheTtl: 300 } } as RequestInit);
  if (!response.ok) throw new HttpError(503, 'ACCESS_UNAVAILABLE', 'The sign-in service could not be reached. Try again.');
  const keys = ((await response.json()) as { keys: Jwk[] }).keys;
  cache = { team, at: Date.now(), keys };
  return keys;
}

function tokenFrom(request: Request): string | null {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header.trim();
  const cookie = request.headers.get('cookie') ?? '';
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null; // a malformed cookie is no sign-in (401), not an error
  }
}

function decodePart<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(fromBase64url(part))) as T;
}

export async function verifyAccess(request: Request, env: Env): Promise<AccessIdentity> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HttpError(503, 'ACCESS_NOT_CONFIGURED', 'Sign-in is not configured for this control plane yet, so nothing is served.');
  }
  const token = tokenFrom(request);
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in through Cloudflare Access first.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid sign-in token.');
  let header: { alg?: string; kid?: string };
  let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; iat?: number; email?: string; type?: string };
  try {
    header = decodePart(parts[0]!);
    claims = decodePart(parts[1]!);
  } catch {
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid sign-in token.');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid sign-in token.');
  let jwk = (await jwks(env)).find((k) => k.kid === header.kid);
  // Access rotates its keys: one refetch for an unknown key id.
  if (!jwk) jwk = (await jwks(env, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, 'UNAUTHORIZED', 'Sign-in token signed by an unknown key.');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid sign-in token.');
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(env.ACCESS_AUD)) throw new HttpError(401, 'UNAUTHORIZED', 'Sign-in token is for another application.');
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new HttpError(401, 'UNAUTHORIZED', 'Sign-in token from another issuer.');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now) throw new HttpError(401, 'UNAUTHORIZED', 'Your sign-in expired. Reload to sign in again.');
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > now) throw new HttpError(401, 'UNAUTHORIZED', 'Sign-in token not valid yet.');
  // Service tokens carry no email: this plane is for people only.
  if (!claims.email) throw new HttpError(403, 'FORBIDDEN', 'Only signed-in people can use the control plane.');
  const email = claims.email.toLowerCase();
  // Second line of defence against a too-broad Access policy.
  const allowed = (env.ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(email)) throw new HttpError(403, 'FORBIDDEN', 'This account is not allowed on this control plane.');
  return { email, issuedAt: claims.iat ?? now };
}
