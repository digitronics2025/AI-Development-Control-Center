import type { WorkspaceHub } from './hub.js';

export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  HUB: DurableObjectNamespace<WorkspaceHub>;
  ASSETS: Fetcher;
  PAIRING_LIMITER: RateLimit;
  AUTH_LIMITER: RateLimit;
  COMMAND_LIMITER: RateLimit;
  ENVIRONMENT: string;
  /** Comma-separated hostnames that serve people (dashboard, /api, /ws). */
  CONTROL_HOSTS: string;
  /** Comma-separated hostnames that serve execution nodes (/node/v1/*). */
  RELAY_HOSTS: string;
  /** e.g. `yourteam.cloudflareaccess.com`; empty = Access not configured = every human request refused. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's audience tag. */
  ACCESS_AUD: string;
  /** Comma-separated emails allowed in, on top of the Access policy; empty = whoever Access admits. */
  ALLOWED_EMAILS?: string;
  /** Tests only: a static JWKS instead of fetching the team's certs. Never set in staging or production. */
  ACCESS_JWKS?: string;
  /** Secret (wrangler secret put): signs short-lived node sessions. */
  NODE_SESSION_SECRET?: string;
}
