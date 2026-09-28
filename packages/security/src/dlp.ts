import { isLoopbackHostname } from './commands.js';
import { detectSecrets, encodedForms, MIN_SECRET_LENGTH, percentDecoded } from './redact.js';

/**
 * The outbound secret check (SEC-4): before a tool sends what its caller
 * wrote — an HTTP request, a page to read, a search query, an outside MCP
 * tool's arguments — the request is searched for secrets the Control Center
 * knows (stored credentials, its own token, sensitive environment values),
 * raw or base64/base64url/hex/percent-encoded (an encoding also when wrapped
 * over lines or with its hex bytes separated), and for well-known token
 * formats. A finding names what was found and where it would go, never the
 * value. A secret going to a host it may be sent to is not a finding.
 */

export interface OutboundRequest {
  /** Where it goes. */
  url?: string;
  /** Where it goes when there is no URL (a local MCP server): shown as the host. */
  target?: string;
  headers?: Record<string, string>;
  /** Text, or JSON-like data whose strings (keys too) are searched. */
  body?: unknown;
  /** A stored credential the tool itself will attach by name (`http.request`'s `auth`): the broker checks its audience. */
  credential?: string;
}

export interface OutboundSecret {
  /** How findings name it (`github credential "deploy"`); never the value. */
  label: string;
  /** What kind of secret it is (a credential kind, `control-center-token`, `secret`). */
  kind: string;
  value: string;
  /** Hosts it may be sent to (exact names, or `*.name` for subdomains): the secret going to one of them is no finding. */
  hosts?: readonly string[];
}

export interface OutboundFinding {
  label: string;
  kind: string;
  /** Where it would go. */
  host: string;
  where: 'url' | 'headers' | 'body';
  /** `raw` as written, `encoded` in another spelling, `format` a token of a known shape that is not a stored secret. */
  form: 'raw' | 'encoded' | 'format';
}

/** A URL's host as it is compared with an audience: WHATWG URL parsing (lower case, punycode), no trailing dot. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * Whether `host` is one of `entries`: an exact name, or a subdomain of a
 * `*.name` entry (on a dot boundary, never `name` itself). Both sides are in
 * the form `hostOf` and `normalizeHostEntry` give.
 */
export function hostAllowed(host: string, entries: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return entries.some((entry) => (entry.startsWith('*.') ? h.endsWith(entry.slice(1)) && h.length > entry.length - 1 : h === entry));
}

/** Where a request goes, as findings name it. */
export function outboundHost(req: OutboundRequest): string {
  return (req.url ? hostOf(req.url) : null) ?? req.target ?? 'an unknown host';
}

/**
 * Every string in a JSON-like value, keys included, however deep: walked with
 * a stack, not recursion, so no nesting depth is left unread (a depth limit
 * would pass whatever lies below it unchecked). An object met twice is read once.
 */
function strings(value: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'number' || typeof v === 'bigint') out.push(String(v));
    else if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v);
      // Pushed in reverse, so they are read in document order.
      const entries: unknown[] = Array.isArray(v) ? v : Object.entries(v).flat();
      for (let i = entries.length - 1; i >= 0; i -= 1) stack.push(entries[i]);
    }
  }
  return out;
}

/** Token formats a request may not carry to anyone: credentials in the URL itself are the URL's own business. */
const NOT_OUTBOUND_FORMATS = new Set(['url-credentials']);

/** How a finding names a host whose own name carries a secret or a token: that name is never repeated. */
export const SECRET_HOST = 'a host whose name carries a secret';

/** The host of a URL as written (before WHATWG parsing lower-cases and punycodes it), without user info. */
function writtenHost(url: string): string {
  const authority = /^\s*[A-Za-z][A-Za-z0-9+.-]*:[\\/]*([^/?#\\]*)/.exec(url)?.[1] ?? '';
  return authority.slice(authority.lastIndexOf('@') + 1);
}

/**
 * Where a request goes, as findings name it (`outboundHost`), unless the
 * host's own name carries one of `secrets` — raw or in any encoded spelling,
 * in any case, as written or as parsed — or a token of a known format: then
 * `SECRET_HOST`. WHATWG parsing lower-cases a host, so the redactor, which
 * matches a value in its own case, could not hide it there.
 */
export function namedHost(req: OutboundRequest, secrets: readonly OutboundSecret[]): string {
  const host = outboundHost(req);
  if (!req.url) return host;
  const written = writtenHost(req.url);
  const names = [...new Set([host, written, percentDecoded(written)])];
  const lower = names.map((n) => n.toLowerCase());
  const carries = secrets.some((s) => {
    if (s.value.length < MIN_SECRET_LENGTH) return false;
    const f = encodedForms(s.value);
    return [s.value, ...f.exact, ...f.anyCase].some((x) => lower.some((n) => n.includes(x.toLowerCase())));
  });
  return carries || detectSecrets(names.join('\n')).some((rule) => !NOT_OUTBOUND_FORMATS.has(rule)) ? SECRET_HOST : host;
}

function formatLabel(rule: string): string {
  return rule === 'private-key' ? 'a private key' : `a ${rule} token`;
}

/**
 * The secrets `req` would carry off this machine, one finding per secret and
 * part (URL, headers, body). `secrets` are the values to look for; each may
 * name the hosts it is allowed to reach. A loopback URL stays on this machine
 * as far as tokens of a known format go (an app under test's own test keys),
 * but not for `secrets`: a local server can pass those on.
 */
export function scanOutbound(req: OutboundRequest, secrets: readonly OutboundSecret[]): OutboundFinding[] {
  const host = outboundHost(req);
  const local = req.url !== undefined && isLoopbackHostname(host);
  const parts: Array<{ where: OutboundFinding['where']; text: string }> = [];
  if (req.url) {
    let normalised = req.url;
    try {
      normalised = new URL(req.url).href;
    } catch {
      /* searched as written */
    }
    parts.push({ where: 'url', text: normalised === req.url ? req.url : `${req.url}\n${normalised}` });
  }
  if (req.headers && Object.keys(req.headers).length) parts.push({ where: 'headers', text: Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\n') });
  if (req.body !== undefined && req.body !== null) parts.push({ where: 'body', text: strings(req.body).join('\n') });
  if (!parts.length) return [];

  const findings: OutboundFinding[] = [];
  const seen = new Set<string>();
  const known = secrets.filter((s) => s.value.length >= MIN_SECRET_LENGTH);
  let named: string | null = null;
  const add = (f: Omit<OutboundFinding, 'host'>) => {
    const key = `${f.label}\0${f.where}`;
    if (!seen.has(key)) {
      seen.add(key);
      named ??= namedHost(req, known);
      findings.push({ ...f, host: named });
    }
  };
  const forms = new Map(known.map((s) => [s, encodedForms(s.value)]));
  for (const part of parts) {
    // As written, and with percent-encoding undone (a secret's base64 inside a query string is percent-encoded too).
    const decoded = percentDecoded(part.text);
    // Encoded spellings are also read joined up the way tools break them: base64 wrapped over lines (`base64`, MIME,
    // PEM), hex bytes spaced or separated by `:` or `-`.
    const texts = [
      ...new Set([part.text, decoded].flatMap((t) => [t, t.replace(/\s+/g, ''), t.replace(/(?<=[0-9A-Fa-f])[\s:-]+(?=[0-9A-Fa-f])/g, '')])),
    ];
    const lower = texts.map((t) => t.toLowerCase());
    let masked = decoded;
    for (const secret of known) {
      // A known secret never counts again as a token of some format, allowed here or not.
      if (masked.includes(secret.value)) masked = masked.split(secret.value).join(' ');
      if (secret.hosts && hostAllowed(host, secret.hosts)) continue;
      const f = forms.get(secret)!;
      const raw = part.text.includes(secret.value);
      const encoded =
        !raw && (decoded.includes(secret.value) || f.exact.some((x) => texts.some((t) => t.includes(x))) || f.anyCase.some((x) => lower.some((t) => t.includes(x.toLowerCase()))));
      if (raw || encoded) add({ label: secret.label, kind: secret.kind, where: part.where, form: raw ? 'raw' : 'encoded' });
    }
    if (local) continue;
    for (const rule of detectSecrets(masked)) if (!NOT_OUTBOUND_FORMATS.has(rule)) add({ label: formatLabel(rule), kind: rule, where: part.where, form: 'format' });
  }
  return findings;
}

/** One line naming what a request would carry where: kind, name and host, never a value or its encoding. */
export function describeFindings(findings: readonly OutboundFinding[], max = 3): string {
  const byWhat = new Map<string, OutboundFinding[]>();
  for (const f of findings) byWhat.set(`${f.label}\0${f.host}`, [...(byWhat.get(`${f.label}\0${f.host}`) ?? []), f]);
  const lines = [...byWhat.values()].map((group) => {
    const f = group[0]!;
    const where = [...new Set(group.map((g) => g.where))].join(' and ');
    const encoded = group.some((g) => g.form === 'encoded') ? ', encoded' : '';
    return `Carries ${f.label} to ${f.host} (in the ${where}${encoded})`;
  });
  return lines.length > max ? `${lines.slice(0, max).join('; ')}; and ${lines.length - max} more` : lines.join('; ');
}
