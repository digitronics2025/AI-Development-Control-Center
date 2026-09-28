/**
 * Secret redaction for everything the orchestrator persists or broadcasts:
 * log lines, command strings, artifacts and error messages.
 *
 * Two layers:
 *  1. Pattern rules for well-known credential formats and `key=value` pairs
 *     whose key names a secret.
 *  2. Value rules: the literal values of sensitive environment variables
 *     present on this machine and of the secrets registered with it, so a
 *     token printed by a tool is caught even when its format is unknown —
 *     also once base64, base64url, hex or percent-encoded (`encodedForms`).
 * A stretch that shows such a value, or a token of a blocking format, only
 * once its `%XX` escapes are decoded is masked whole, however few of its
 * characters are escaped.
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

/** Where an assignment's value ends: a design value is skipped only when nothing follows it in the value. */
const VALUE_END = `(?=[\\s"',;}{]|$)`;

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
  // Registry, messaging and SaaS tokens (gitleaks' shapes, SEC-4).
  { name: 'huggingface', pattern: /\bhf_[A-Za-z0-9]{34,}\b/g, replace: REDACTED, blocking: true },
  { name: 'pypi', pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g, replace: REDACTED, blocking: true },
  { name: 'sendgrid', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, replace: REDACTED, blocking: true },
  { name: 'shopify', pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g, replace: REDACTED, blocking: true },
  { name: 'supabase', pattern: /\bsbp_[a-f0-9]{40}\b/g, replace: REDACTED, blocking: true },
  { name: 'sentry', pattern: /\b(?:sntrys_[A-Za-z0-9+/=_]{40,}|sntryu_[a-f0-9]{64}\b)/g, replace: REDACTED, blocking: true },
  { name: 'linear', pattern: /\blin_api_[A-Za-z0-9]{40}\b/g, replace: REDACTED, blocking: true },
  // A bot id, `:`, then 35 characters starting `A`. Anchored on both sides, so a longer number, a host:port or a
  // timestamp followed by other text is not one; a path segment and the Bot API's own `/bot<token>/` spelling are.
  { name: 'telegram', pattern: /(?:(?<=\bbot)|(?<![\w:.-]))\d{8,10}:A[A-Za-z0-9_-]{34}(?![\w-])/g, replace: REDACTED, blocking: true },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // An Authorization header's value is a credential whatever it looks like (any scheme, any case, all lowercase),
  // `:` included: a fal key is `Key <id>:<secret>`.
  {
    name: 'authorization',
    pattern: /\b(authorization\s*[:=]\s*["'`]?\s*(?:(?:bearer|basic|token|digest|key)\s+)?)(?!--[a-z0-9]+(?:-[a-z0-9]+)*(?![A-Za-z0-9._~+/=:-]))[A-Za-z0-9._~+/=:-]{8,}/gi,
    replace: `$1${REDACTED}`,
  },
  // Bearer/Basic/Token values elsewhere, in any case. Two design spellings stay readable (docs/systems/design-agent.md)
  // when they are the whole value: a CSS custom property ("token --color-accent") and plain hyphenated words
  // ("Basic typography-scale").
  {
    name: 'bearer',
    pattern: /\b(bearer|basic|token)\s+(?!--[a-z0-9]+(?:-[a-z0-9]+)*(?![A-Za-z0-9._~+/=-]))(?![a-z]+(?:-[a-z]+)+(?![A-Za-z0-9._~+/=-]))[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: `$1 ${REDACTED}`,
  },
  // Signed URLs (S3, GCS, Azure SAS, CloudFront): only the signature and session parameters are masked, so the
  // host, path and expiry stay readable in logs and reports.
  {
    name: 'signed-url',
    pattern: /([?&](?:sig|signature|x-amz-signature|x-goog-signature|x-amz-security-token|x-amz-credential|x-goog-credential)=)[^&#\s"'<>]+/gi,
    replace: `$1${REDACTED}`,
  },
  // URLs with embedded credentials: https://user:pass@host
  { name: 'url-credentials', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, replace: `$1${REDACTED}@`, blocking: true },
  // A URL query parameter that names a secret: the value ends at the next parameter, so the rest of the URL stays readable.
  {
    name: 'query-secret',
    pattern: new RegExp(`([?&]${SECRET_KEY_NAME}=)[^&#\\s"'<>]+`, 'gi'),
    replace: `$1${REDACTED}`,
  },
  // key=value / key: value / "key": "value" where the key names a secret. `&` is part of the value (a password
  // may hold one). A design value after a name such as `accentToken` is not a secret when it is the whole value:
  // a colour (#3355ff, rgb(), oklch()), a CSS variable (var(--x)) or a length (16px, 1.25rem).
  {
    name: 'assignment',
    pattern: new RegExp(
      `(${SECRET_KEY_NAME}["']?\\s*[:=]\\s*["']?)(?!\\[REDACTED\\])(?!#[0-9A-Fa-f]{3,8}${VALUE_END})(?!(?:(?:rgba?|hsla?|oklch|oklab|color-mix)\\(|var\\(--)(?:[^()"';{}\\r\\n]|\\([^()"';{}\\r\\n]*\\))*\\)${VALUE_END})(?!\\d+(?:\\.\\d+)?(?:px|rem|em|%|ms|s|vh|vw|deg)${VALUE_END})([^\\s"',;}{]{6,})`,
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

/** The shortest literal value the redactor masks: shorter ones would hit ordinary words. */
export const MIN_SECRET_LENGTH = 8;
/**
 * Encoded spellings are made for every value the redactor masks as written,
 * up to a length: a longer one (a certificate, a key file) would swell the
 * pattern, and key blocks have a rule. The shortest value's spellings are no
 * weaker than the value itself: 8 characters give base64 cores of 10 and hex of 16.
 */
export const ENCODED_SECRET_LENGTH = { min: MIN_SECRET_LENGTH, max: 512 } as const;

/**
 * The part of `bytes`' base64 (or base64url) that the bytes alone decide, at
 * each of the three offsets they can start at inside longer encoded data (so
 * `secret` is found in the encoding of `user:secret`): the characters shared
 * with a neighbouring byte are left off at both ends.
 */
function base64Cores(bytes: Buffer, alphabet: 'base64' | 'base64url'): string[] {
  const cores: string[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const total = offset + bytes.length;
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(alphabet).replace(/=+$/, '');
    const skip = [0, 2, 3][offset]!;
    const keep = Math.floor(total / 3) * 4 + [0, 1, 2][total % 3]!;
    cores.push(encoded.slice(skip, keep));
  }
  return cores;
}

/**
 * The spellings a secret takes once a tool or a request encodes it (SEC-4):
 * base64 and base64url (each at the three byte offsets), matched exactly; hex
 * and percent-encoding (URI component and form style, of the value and of its
 * base64, as a query string carries it, and every byte as `%XX`), matched in
 * any case. Empty outside `ENCODED_SECRET_LENGTH`. Never shown: they are
 * secrets too.
 */
export function encodedForms(value: string): { exact: string[]; anyCase: string[] } {
  if (value.length < ENCODED_SECRET_LENGTH.min || value.length > ENCODED_SECRET_LENGTH.max) return { exact: [], anyCase: [] };
  const bytes = Buffer.from(value, 'utf8');
  const exact = new Set([...base64Cores(bytes, 'base64'), ...base64Cores(bytes, 'base64url')].filter((f) => f !== value));
  const percent = (text: string) => [encodeURIComponent(text), new URLSearchParams({ v: text }).toString().slice(2)];
  const hex = bytes.toString('hex');
  const anyCase = new Set([hex, hex.replace(/../g, '%$&'), ...percent(value), ...[...exact].flatMap(percent)].filter((f) => f !== value && !exact.has(f)));
  return { exact: [...exact], anyCase: [...anyCase] };
}

/** One alternation of literal strings, longest first, or null for none. */
function literals(values: Iterable<string>, flags: string): RegExp | null {
  const sorted = [...new Set(values)].sort((a, b) => b.length - a.length);
  return sorted.length ? new RegExp(sorted.map(escapeRegExp).join('|'), flags) : null;
}

/**
 * `%XX` runs decoded byte by byte as UTF-8, an invalid byte becoming U+FFFD
 * (never throwing), so a secret percent-encoded any way at all reads as itself
 * — a stray `%FF` beside it included, which a whole-run `decodeURIComponent`
 * would give up on.
 */
export function percentDecoded(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));
}

/** A stretch of text between spaces, quotes and URL separators (`?`, `&`, `#`): what one percent-encoded value spans. */
const PERCENT_SPAN = /[^\s"'`<>?&#]+/g;
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;

export class Redactor {
  private valuePattern: RegExp | null;
  /** Hex and percent spellings of the same values, whose letters may be either case. */
  private anyCasePattern: RegExp | null;

  constructor(secretValues: Iterable<string> = []) {
    const values = [...new Set([...secretValues].filter((v) => v.length >= MIN_SECRET_LENGTH))];
    const forms = values.map(encodedForms);
    this.valuePattern = literals([...values, ...forms.flatMap((f) => f.exact)], 'g');
    this.anyCasePattern = literals(forms.flatMap((f) => f.anyCase), 'gi');
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
    if (this.anyCasePattern) out = out.replace(this.anyCasePattern, REDACTED);
    if (out.includes('%')) out = out.replace(PERCENT_SPAN, (span) => (this.hiddenByPercent(span) ? REDACTED : span));
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
   * Whether percent-encoding hides a secret in `span`, however few of its
   * characters are escaped (`%51uartz…`, `%67hp_…`): once decoded it holds a
   * value this redactor knows, in any spelling, or a token of a blocking
   * format that the span as written does not show. Such a span is masked whole.
   */
  private hiddenByPercent(span: string): boolean {
    if (!PERCENT_ESCAPE.test(span)) return false;
    const decoded = percentDecoded(span);
    if ((this.valuePattern && decoded.search(this.valuePattern) >= 0) || (this.anyCasePattern && decoded.search(this.anyCasePattern) >= 0)) return true;
    const written = new Set(detectSecrets(span));
    return detectSecrets(decoded).some((rule) => !written.has(rule));
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
 * How a finding names each format `detectSecrets` reports ("contains what
 * looks like a GitHub token"): the commit and push preflights and the
 * `security.secret_scan` tool word it the same way.
 */
export const SECRET_LABEL: Readonly<Record<string, string>> = {
  anthropic: 'an Anthropic API key',
  openai: 'an OpenAI API key',
  github: 'a GitHub token',
  gitlab: 'a GitLab token',
  slack: 'a Slack token',
  'aws-access-key': 'an AWS access key',
  'google-api-key': 'a Google API key',
  stripe: 'a Stripe key',
  npm: 'an npm token',
  huggingface: 'a Hugging Face token',
  pypi: 'a PyPI token',
  sendgrid: 'a SendGrid API key',
  shopify: 'a Shopify token',
  supabase: 'a Supabase token',
  sentry: 'a Sentry token',
  linear: 'a Linear API key',
  telegram: 'a Telegram bot token',
  'url-credentials': 'a password inside a URL',
  'private-key': 'a private key',
};

/** The words for one `detectSecrets` rule name; an unlabelled rule is named as it is. */
export function secretLabel(rule: string): string {
  return SECRET_LABEL[rule] ?? rule;
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
let sharedEnv: NodeJS.ProcessEnv | undefined;
/** Secret values the credential broker handed to a child process (never persisted). */
const registered = new Set<string>();

function sharedRedactor(): Redactor {
  shared ??= new Redactor([...envSecretValues(sharedEnv), ...registered]);
  return shared;
}

function envSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && !NON_SECRET_ENV.has(name.toUpperCase()) && SENSITIVE_ENV_NAME.test(name)) values.push(value);
  }
  return values;
}

/** Process-wide redactor seeded from the orchestrator's own environment. */
export function redact(text: string): string {
  return sharedRedactor().redact(text);
}

/**
 * Every literal value the shared redactor masks: the orchestrator's sensitive
 * environment values and the values registered with it (brokered credentials,
 * the local token, sign-in tokens). For the outbound check (`scanOutbound`),
 * which must know them to refuse a request that carries one; never shown.
 */
export function knownSecretValues(): string[] {
  return [...new Set([...envSecretValues(sharedEnv), ...registered])].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

export function resetSharedRedactor(env?: NodeJS.ProcessEnv): void {
  sharedEnv = env;
  shared = null;
}

/**
 * Teach the shared redactor literal secret values that do not live in the
 * orchestrator's environment — credentials the broker injects into one child
 * process. Values shorter than 8 characters are ignored (too many false hits).
 */
export function registerSecretValues(values: Iterable<string>): void {
  let changed = false;
  for (const value of values) {
    if (value.length >= MIN_SECRET_LENGTH && !registered.has(value)) {
      registered.add(value);
      changed = true;
    }
  }
  if (changed) shared = null;
}

/** Forget a value (a rotated or deleted credential). */
export function unregisterSecretValues(values: Iterable<string>): void {
  let changed = false;
  for (const value of values) changed = registered.delete(value) || changed;
  if (changed) shared = null;
}

/**
 * `redact` for a stream handed over in pieces (a terminal's output): a
 * private key block one piece opens stays hidden in the pieces after it, up
 * to and including its END line. Every other secret must lie within one
 * piece, so the caller cuts at safe points (whole lines, as `PtySession`
 * does). Uses the shared redactor as it is at each piece.
 */
export function streamRedactor(): (piece: string) => string {
  let inPrivateKey = false;
  const last = (re: RegExp, text: string) => {
    let at = -1;
    for (const m of text.matchAll(re)) at = m.index ?? at;
    return at;
  };
  const begins = new RegExp(PRIVATE_KEY_BEGIN.source, 'g');
  const ends = new RegExp(PRIVATE_KEY_END.source, 'g');
  return (piece: string) => {
    let rest = piece;
    if (inPrivateKey) {
      const end = PRIVATE_KEY_END.exec(rest);
      if (!end) return '';
      inPrivateKey = false;
      rest = rest.slice(end.index + end[0].length);
    }
    if (last(begins, rest) > last(ends, rest)) inPrivateKey = true;
    return sharedRedactor().redact(rest);
  };
}

/** Deeply redact string values of a JSON-like object. */
export function redactDeep<T>(value: T, redactor: Redactor = sharedRedactor()): T {
  if (typeof value === 'string') return redactor.redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redactor)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redactor);
    return out as T;
  }
  return value;
}
