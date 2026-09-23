/**
 * Secret redaction for everything the orchestrator persists or broadcasts:
 * log lines, command strings, artifacts and error messages.
 *
 * Two layers:
 *  1. Pattern rules for well-known credential formats and `key=value` pairs
 *     whose key names a secret.
 *  2. Value rules: the literal values of sensitive environment variables
 *     present on this machine, so a token printed by a tool is caught even
 *     when its format is unknown.
 */

export const REDACTED = '[REDACTED]';

interface Rule {
  name: string;
  pattern: RegExp;
  /** Replacement; `$1` etc. keep a non-secret prefix such as the key name. */
  replace: string;
  /**
   * The format is specific enough that a match is almost certainly a real
   * credential. Only these rules may block a commit or push; the broad
   * `key=value` rules would stop ordinary code (`password: z.string()`).
   */
  blocking?: boolean;
}

const SECRET_KEY_NAME =
  '(?:[A-Za-z0-9_.-]*?(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|private[_-]?key|client[_-]?secret|access[_-]?key|auth|cookie|session[_-]?id|credential)s?)';

const RULES: Rule[] = [
  // Provider keys with recognisable prefixes.
  { name: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, replace: REDACTED, blocking: true },
  { name: 'openai', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, replace: REDACTED, blocking: true },
  { name: 'github', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: REDACTED, blocking: true },
  { name: 'gitlab', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, replace: REDACTED, blocking: true },
  { name: 'slack', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: REDACTED, blocking: true },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: REDACTED, blocking: true },
  { name: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g, replace: REDACTED, blocking: true },
  { name: 'stripe', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: REDACTED, blocking: true },
  { name: 'npm', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: REDACTED, blocking: true },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // Authorization headers.
  { name: 'bearer', pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: `$1 ${REDACTED}` },
  // URLs with embedded credentials: https://user:pass@host
  { name: 'url-credentials', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, replace: `$1${REDACTED}@`, blocking: true },
  // key=value / key: value / "key": "value" where the key names a secret.
  {
    name: 'assignment',
    pattern: new RegExp(
      `(${SECRET_KEY_NAME}["']?\\s*[:=]\\s*["']?)(?!\\[REDACTED\\])([^\\s"',;}{]{6,})`,
      'gi',
    ),
    replace: `$1${REDACTED}`,
  },
  // Cookie headers.
  { name: 'cookie', pattern: /\b((?:set-)?cookie:\s*)[^\r\n]+/gi, replace: `$1${REDACTED}` },
];

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

const SENSITIVE_ENV_NAME =
  /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|COOKIE|AUTH|PRIVATE|SESSION)/i;
/** Environment variables whose values look sensitive by name but are not secrets. */
const NON_SECRET_ENV = new Set(['PWD', 'OLDPWD', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'XAUTHORITY', 'AUTHOR']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Redactor {
  private valuePattern: RegExp | null;

  constructor(secretValues: Iterable<string> = []) {
    const values = [...new Set([...secretValues].filter((v) => v.length >= 8))].sort((a, b) => b.length - a.length);
    this.valuePattern = values.length ? new RegExp(values.map(escapeRegExp).join('|'), 'g') : null;
  }

  /** Build a redactor that also knows the sensitive values in an environment. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Redactor {
    const values: string[] = [];
    for (const [name, value] of Object.entries(env)) {
      if (!value || NON_SECRET_ENV.has(name.toUpperCase())) continue;
      if (SENSITIVE_ENV_NAME.test(name)) values.push(value);
    }
    return new Redactor(values);
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    if (this.valuePattern) out = out.replace(this.valuePattern, REDACTED);
    for (const rule of RULES) out = out.replace(rule.pattern, rule.replace);
    if (PRIVATE_KEY_BEGIN.test(out)) {
      out = out.replace(
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
        `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
      );
    }
    return out;
  }

  /**
   * Stateful per-line redaction for streams: a private key spans many lines,
   * so once a BEGIN marker is seen every line is suppressed until END.
   */
  lineRedactor(): (line: string) => string {
    let inPrivateKey = false;
    return (line: string) => {
      if (inPrivateKey) {
        if (PRIVATE_KEY_END.test(line)) inPrivateKey = false;
        return REDACTED;
      }
      if (PRIVATE_KEY_BEGIN.test(line) && !PRIVATE_KEY_END.test(line)) {
        inPrivateKey = true;
        return REDACTED;
      }
      return this.redact(line);
    };
  }
}

/**
 * Names of the high-confidence credential formats found in `text` (provider
 * keys, credentials in URLs, private key blocks). Used by the Source Control
 * preflight before a commit or push; the values themselves are never returned.
 */
export function detectSecrets(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const rule of RULES) {
    if (!rule.blocking) continue;
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) found.add(rule.name);
    rule.pattern.lastIndex = 0;
  }
  if (PRIVATE_KEY_BEGIN.test(text)) found.add('private-key');
  return [...found];
}

let shared: Redactor | null = null;

/** Process-wide redactor seeded from the orchestrator's own environment. */
export function redact(text: string): string {
  shared ??= Redactor.fromEnv();
  return shared.redact(text);
}

export function resetSharedRedactor(env?: NodeJS.ProcessEnv): void {
  shared = Redactor.fromEnv(env);
}

/** Deeply redact string values of a JSON-like object. */
export function redactDeep<T>(value: T, redactor: Redactor = (shared ??= Redactor.fromEnv())): T {
  if (typeof value === 'string') return redactor.redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redactor)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redactor);
    return out as T;
  }
  return value;
}
