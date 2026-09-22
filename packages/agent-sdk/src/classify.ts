import type { ErrorClass } from '@acc/shared';

/**
 * Failure classification from provider output (PLAN §31). Order matters:
 * usage limits and auth problems must win over generic crash signatures,
 * because they decide whether a task waits or fails.
 */
const RULES: Array<{ errorClass: ErrorClass; patterns: RegExp[] }> = [
  {
    errorClass: 'USAGE_LIMIT',
    patterns: [
      /usage limit/i,
      /out of credits/i,
      /add credits/i,
      /insufficient[_ ]quota/i,
      /quota exceeded/i,
      /rate[_ -]?limit(?:ed| reached| exceeded)/i,
      /hit your (?:usage )?limit/i,
      /limit (?:will )?reset/i,
      /too many requests/i,
      /\b429\b/,
      /credit balance is too low/i,
    ],
  },
  {
    errorClass: 'AUTH_FAILURE',
    patterns: [
      /not logged in/i,
      /please (?:run )?\/?login/i,
      /log ?in required/i,
      /authentication (?:failed|error|required)/i,
      /unauthori[sz]ed/i,
      /\b401\b/,
      /invalid (?:api[ _-]?key|x-api-key|token|credentials)/i,
      /(?:session|token|oauth token) (?:has )?expired/i,
      /subscription session could not be verified/i,
    ],
  },
  {
    errorClass: 'MODEL_UNAVAILABLE',
    patterns: [
      /model[^\n]{0,80}(?:not found|does not exist|not available|unavailable|not supported)/i,
      /requires a newer version/i,
      /unknown model/i,
      /invalid model/i,
      /no such model/i,
      /model_not_found/i,
    ],
  },
  {
    errorClass: 'PERMISSION_DENIED',
    patterns: [/permission denied/i, /\bEACCES\b/, /not permitted/i, /blocked by (?:policy|sandbox)/i],
  },
  {
    errorClass: 'CONTEXT_FAILURE',
    patterns: [/context (?:length|window) exceeded/i, /prompt is too long/i, /maximum context/i],
  },
];

export function classifyFailureText(text: string): ErrorClass | null {
  for (const rule of RULES) if (rule.patterns.some((p) => p.test(text))) return rule.errorClass;
  return null;
}

/** First line that explains a failure, trimmed for display. */
export function summarizeFailure(messages: string[], tail: string[]): string {
  const candidates = [...messages, ...tail.slice().reverse()];
  const hit = candidates.find((line) => classifyFailureText(line)) ?? messages.at(-1) ?? tail.at(-1) ?? '';
  const clean = hit.replace(/\s+/g, ' ').trim();
  return clean.length > 400 ? `${clean.slice(0, 397)}...` : clean;
}
