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
const ALWAYS_STRIPPED: readonly string[] = ['ACC_TOKEN', 'ACC_AUTH_TOKEN'];

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
  const strip = billingMode === 'subscription' ? [...API_BILLING_ENV_VARS, ...ALWAYS_STRIPPED] : ALWAYS_STRIPPED;
  for (const name of strip) {
    const actual = keys.get(name.toUpperCase());
    if (actual !== undefined && env[actual] !== undefined) {
      delete env[actual];
      removed.push(name);
    }
  }
  return { env, removed };
}

/** Names of API-billing variables present in an environment (for health/warnings). */
export function detectApiCredentials(source: NodeJS.ProcessEnv): string[] {
  const keys = upperKeyMap(source);
  return API_BILLING_ENV_VARS.filter((name) => {
    const actual = keys.get(name.toUpperCase());
    return actual !== undefined && Boolean(source[actual]);
  });
}
