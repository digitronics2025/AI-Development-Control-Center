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
      // A CLI older than the flags the adapter passes: same remedy, update the CLI (Open Agents).
      /^error: unknown option '--/im,
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

/**
 * A structured event on an agent CLI's stdout (Claude Code stream-json,
 * Codex JSONL). These lines carry what the agent read and ran — file
 * contents, command output — so they are never evidence of why the CLI
 * failed: a file mentioning "out of credits" or line 429 of any file would
 * otherwise turn a crash into a usage limit. The adapters' parsers already
 * take structured errors out of them. Matched by prefix because the output
 * tail truncates long lines, which then no longer parse as JSON.
 */
export function isProtocolEvent(line: string): boolean {
  return /^\s*\{\s*"type"\s*:\s*"/.test(line);
}

/** Windows process status codes an agent CLI can exit with when it crashes. */
const WINDOWS_STATUS: Record<number, string> = {
  0xc0000005: 'access violation',
  0xc00000fd: 'stack overflow',
  0xc0000142: 'failed to start',
  0xc000013a: 'interrupted',
  0xc0000409: 'fatal internal error',
};

/** A readable reason for a CLI that exited without explaining itself. */
export function describeExit(displayName: string, exitCode: number | null): string {
  if (exitCode === null) return `${displayName} stopped without an exit code`;
  if (exitCode >= 0xc0000000 && exitCode <= 0xffffffff) {
    const label = WINDOWS_STATUS[exitCode];
    return `${displayName} crashed${label ? ` (${label})` : ''} · Windows status 0x${exitCode.toString(16).toUpperCase()}`;
  }
  return `${displayName} exited with code ${exitCode} without reporting an error`;
}
