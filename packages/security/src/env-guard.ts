import type { BillingMode } from '@acc/shared';

/**
 * Subscription-only guard (PLAN §11).
 *
 * Provider CLIs switch from the user's subscription session to metered API
 * billing when certain variables are present. In `subscription` mode those
 * variables are stripped from every child process environment, so a key left
 * in the shell can never silently change who pays.
 */

/** Variables that select API-key billing or a metered third-party provider. */
export const API_BILLING_ENV_VARS: readonly string[] = [
  // OpenAI / Codex
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT_ID',
  'OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  // Anthropic / Claude Code
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK',
  // Other metered providers an agent could pick up.
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
];

/** Credentials that no agent or repository command needs, in any billing mode. */
const ALWAYS_STRIPPED: readonly string[] = ['ACC_TOKEN', 'ACC_AUTH_TOKEN', 'ACC_TOOL_SESSION', 'ACC_TOKEN_OVERRIDE'];

/**
 * Provider credentials an operator commonly keeps in their own shell or user
 * environment (audit F-03). None of them may be inherited by an agent, a
 * repository command, a tool shell, a terminal or a Git hook: a tool that needs
 * one gets it from the credential broker for that call only, after the policy
 * decided. Stripped in every billing mode. `CLAUDE_CODE_OAUTH_TOKEN` is not here:
 * it is the subscription sign-in itself.
 */
export const AMBIENT_CREDENTIAL_ENV_VARS: readonly string[] = [
  // Cloudflare
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CF_API_TOKEN',
  'CF_API_KEY',
  // GitHub, GitLab, registries
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_PAT',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'PYPI_TOKEN',
  'TWINE_PASSWORD',
  'DOCKER_PASSWORD',
  'DOCKERHUB_TOKEN',
  // Cloud providers
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'AZURE_STORAGE_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'DIGITALOCEAN_ACCESS_TOKEN',
  // Hosting and deploy platforms
  'VERCEL_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'FLY_API_TOKEN',
  'RENDER_API_KEY',
  'HEROKU_API_KEY',
  'RAILWAY_TOKEN',
  'SUPABASE_ACCESS_TOKEN',
  'SENTRY_AUTH_TOKEN',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  // Databases
  'DATABASE_URL',
  'PGPASSWORD',
  'MYSQL_PWD',
  'MONGODB_URI',
  'REDIS_URL',
];

/**
 * Variables whose values the credential broker now holds. Children receive
 * them only through a brokered tool call, so they are stripped from every
 * inherited environment (agents and repository commands alike).
 */
const brokerManaged = new Set<string>();

export function setBrokerManagedEnvVars(names: Iterable<string>): void {
  brokerManaged.clear();
  for (const name of names) if (name.trim()) brokerManaged.add(name.trim().toUpperCase());
}

export function brokerManagedEnvVars(): string[] {
  return [...brokerManaged];
}

export interface SanitizedEnv {
  env: NodeJS.ProcessEnv;
  /** Names (never values) of variables that were removed. */
  removed: string[];
}

function upperKeyMap(env: NodeJS.ProcessEnv): Map<string, string> {
  // Windows environment names are case-insensitive; match them that way.
  const map = new Map<string, string>();
  for (const key of Object.keys(env)) map.set(key.toUpperCase(), key);
  return map;
}

export function sanitizeEnv(source: NodeJS.ProcessEnv, billingMode: BillingMode): SanitizedEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  const keys = upperKeyMap(env);
  const removed: string[] = [];
  const strip = [...(billingMode === 'subscription' ? [...API_BILLING_ENV_VARS, ...ALWAYS_STRIPPED] : ALWAYS_STRIPPED), ...AMBIENT_CREDENTIAL_ENV_VARS, ...brokerManaged];
  for (const name of strip) {
    const actual = keys.get(name.toUpperCase());
    if (actual !== undefined && env[actual] !== undefined) {
      delete env[actual];
      removed.push(name);
    }
  }
  return { env, removed };
}

/**
 * An environment with every credential this guard knows removed — billing keys
 * included, whatever the billing mode. For processes that never need one: Git
 * and the hooks it runs, the browser.
 */
export function credentialFreeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return sanitizeEnv(source, 'subscription').env;
}

/** Names of ambient provider credentials present in an environment (never values), for warnings. */
export function detectAmbientCredentials(source: NodeJS.ProcessEnv): string[] {
  const keys = upperKeyMap(source);
  return AMBIENT_CREDENTIAL_ENV_VARS.filter((name) => {
    const actual = keys.get(name.toUpperCase());
    return actual !== undefined && Boolean(source[actual]);
  });
}

/** Names of API-billing variables present in an environment (for health/warnings). */
export function detectApiCredentials(source: NodeJS.ProcessEnv): string[] {
  const keys = upperKeyMap(source);
  return API_BILLING_ENV_VARS.filter((name) => {
    const actual = keys.get(name.toUpperCase());
    return actual !== undefined && Boolean(source[actual]);
  });
}
