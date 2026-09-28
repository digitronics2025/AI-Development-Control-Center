import { describe, expect, it } from 'vitest';
import { credentialAudience, normalizeHostEntry } from '@acc/shared';
import {
  describeFindings,
  detectSecrets,
  encodedForms,
  hostAllowed,
  hostOf,
  namedHost,
  REDACTED,
  Redactor,
  redact,
  registerSecretValues,
  resetSharedRedactor,
  scanOutbound,
  SECRET_HOST,
  unregisterSecretValues,
  type OutboundSecret,
} from '../src/index.js';

/**
 * SEC-4: the token formats the redactor learned, the encoded spellings of
 * every secret it knows, credential audiences and the outbound secret check.
 * Every credential-shaped sample is assembled at runtime: the commit guard
 * and the pre-push guard refuse such literals.
 */

const fake = (...parts: string[]) => parts.join('');
const repeat = (alphabet: string, n: number) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEX = '0123456789abcdef';
const B64URL = `${ALNUM}_-`;
/** Every byte of `s` as `%XX`, as a collector decoding byte by byte reads it back. */
const everyByte = (s: string) => [...Buffer.from(s)].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');

/** One sample per new format (gitleaks' shapes), named as `detectSecrets` names it. */
const SAMPLES: Array<[string, string]> = [
  ['huggingface', fake('hf', '_', repeat(ALNUM, 34))],
  ['pypi', fake('pypi-', 'AgEIcHlwaS5vcmc', repeat(B64URL, 70))],
  ['sendgrid', fake('SG', '.', repeat(B64URL, 22), '.', repeat(B64URL, 43))],
  ['shopify', fake('shp', 'at_', repeat(HEX, 32))],
  ['shopify', fake('shp', 'ss_', repeat(HEX, 32))],
  ['supabase', fake('sb', 'p_', repeat(HEX, 40))],
  ['sentry', fake('sntr', 'ys_', 'eyJpYXQiO', repeat(ALNUM, 60), '_', repeat(ALNUM, 43))],
  ['sentry', fake('sntr', 'yu_', repeat(HEX, 64))],
  ['linear', fake('lin', '_api_', repeat(ALNUM, 40))],
  ['telegram', fake('1234567890', ':', 'A', repeat(B64URL, 34))],
];

describe('new token formats (SEC-4)', () => {
  it.each(SAMPLES)('%s is redacted and blocks a commit', (rule, sample) => {
    const text = `before ${sample} after`;
    const out = new Redactor().redact(text);
    expect(out).not.toContain(sample);
    expect(out).toContain(REDACTED);
    expect(out).toMatch(/^before .*after$/);
    expect(detectSecrets(text)).toContain(rule);
  });

  it('keeps look-alikes readable: a short hf_ word, a port, a timestamp, a longer number', () => {
    const tail = repeat(B64URL, 34);
    for (const text of [
      fake('hf', '_', 'short'),
      'http://api.example.com:8443/path',
      'listening on 127.0.0.1:4317',
      fake('at 1727500000', ':', 'A', tail, 'x-more-text-follows'),
      fake('id 123456789012', ':', 'A', tail),
      fake('robot1234567890', ':', 'A', tail),
      fake('v1.1234567890', ':', 'A', tail),
    ]) {
      expect(detectSecrets(text).filter((r) => ['huggingface', 'telegram'].includes(r)), text).toEqual([]);
    }
  });

  it('finds a Telegram bot token in the Bot API URL and in any path segment', () => {
    const token = fake('123456789', ':', 'A', repeat(B64URL, 34));
    for (const text of [`https://api.telegram.org/bot${token}/getMe`, `GET /bot${token}/sendMessage?chat_id=1`, `https://collector.example/${token}/x`, `path/${token}`]) {
      const out = new Redactor().redact(text);
      expect(out, text).not.toContain(token);
      expect(out).toContain(REDACTED);
      expect(detectSecrets(text), text).toContain('telegram');
    }
    expect(new Redactor().redact(`https://api.telegram.org/bot${token}/getMe`)).toBe(`https://api.telegram.org/bot${REDACTED}/getMe`);
    expect(scanOutbound({ url: `https://collector.example/bot${token}/getMe` }, [])).toEqual([expect.objectContaining({ kind: 'telegram', host: 'collector.example', where: 'url', form: 'format' })]);
  });
});

describe('encoded spellings of known secrets (SEC-4)', () => {
  const secret = fake('Quartz', '+Lantern/', 'Meadow=', 'Orbit42');
  const r = new Redactor([secret]);
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it.each([
    ['base64', b64(secret)],
    ['base64 inside Basic user:secret', `Authorization-like header: ${b64(`someone:${secret}`)}`],
    ['base64 at an odd offset', b64(`x${secret}yz`)],
    ['base64 at the other offset', b64(`xy${secret}`)],
    ['base64url', Buffer.from(`ab${secret}`).toString('base64url')],
    ['hex', Buffer.from(secret).toString('hex')],
    ['upper-case hex', Buffer.from(`${secret}!`).toString('hex').toUpperCase()],
    ['percent-encoded', `https://collector.example/?q=${encodeURIComponent(secret)}`],
    ['form-encoded', new URLSearchParams({ q: secret }).toString()],
    ['lower-case percent', encodeURIComponent(secret).toLowerCase()],
    ['every byte percent-encoded', `https://collector.example/c?d=${everyByte(secret)}`],
    ['every byte percent-encoded after a stray invalid byte', `?d=%FF${everyByte(secret).toUpperCase()}`],
  ])('%s is redacted', (_name, text) => {
    const out = r.redact(text);
    expect(out).toContain(REDACTED);
    for (const form of [...encodedForms(secret).exact, ...encodedForms(secret).anyCase]) expect(out.toLowerCase()).not.toContain(form.toLowerCase());
  });

  it('makes encoded forms for every value it masks, the shortest (8 characters) included, but not for huge ones', () => {
    for (const short of [fake('Short', '9x!'), fake('Short', '9x!z', 'Qw')]) {
      const shortRedactor = new Redactor([short]);
      expect(shortRedactor.redact(`raw ${short}`)).toBe(`raw ${REDACTED}`);
      const forms = encodedForms(short);
      expect(forms.exact.length).toBeGreaterThan(0);
      for (const text of [b64(short), b64(`user:${short}`), Buffer.from(short).toString('hex'), Buffer.from(short).toString('hex').toUpperCase(), everyByte(short)]) {
        const out = shortRedactor.redact(`seen ${text} here`);
        expect(out, text).toContain(REDACTED);
        for (const form of [...forms.exact, ...forms.anyCase]) expect(out.toLowerCase(), text).not.toContain(form.toLowerCase());
      }
    }
    // Below 8 characters nothing is masked, in any spelling.
    expect(encodedForms(fake('Sh0rt', '!x'))).toEqual({ exact: [], anyCase: [] });
    expect(new Redactor([fake('Sh0rt', '!x')]).redact('Sh0rt!x')).toBe('Sh0rt!x');
    expect(encodedForms('k'.repeat(600))).toEqual({ exact: [], anyCase: [] });
  });

  it('covers registered values and the local token through the shared redactor', () => {
    resetSharedRedactor({});
    const token = fake('local', '-token-', repeat(B64URL, 36));
    registerSecretValues([token]);
    try {
      expect(redact(`x ${Buffer.from(token).toString('base64')} y`)).toContain(REDACTED);
      expect(redact(Buffer.from(token).toString('hex'))).toBe(REDACTED);
    } finally {
      unregisterSecretValues([token]);
      resetSharedRedactor();
    }
  });

  it('leaves ordinary base64 and hex alone', () => {
    const plain = `${Buffer.from('hello world, nothing secret here').toString('base64')} ${Buffer.from('also plain').toString('hex')}`;
    expect(r.redact(plain)).toBe(plain);
  });

  it('masks a value, or a token of a known format, with only some of its characters percent-encoded', () => {
    const escape = (c: string) => [...Buffer.from(c)].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');
    const spellings = (s: string) => [
      escape(s[0]!) + s.slice(1),
      s[0]! + [...s.slice(1)].map(escape).join(''),
      [...s].map((c, i) => (i % 2 ? escape(c) : c)).join(''),
      [...s].map((c, i) => (i % 2 ? c : escape(c).toUpperCase())).join(''),
    ];
    const gh = fake('gh', 'p_', repeat(ALNUM, 36));
    const decode = (s: string) => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));
    for (const [redactor, value] of [
      [r, secret],
      [new Redactor([gh]), gh],
      [new Redactor(), gh],
    ] as const) {
      for (const spelled of spellings(value)) {
        const text = `GET https://collector.example/c?a=1&d=${spelled}#top "${spelled}"`;
        const out = redactor.redact(text);
        expect(decode(out), spelled).not.toContain(value);
        // Only the stretch carrying it goes: the host, the other parameter and the fragment stay readable.
        expect(out).toBe(`GET https://collector.example/c?a=1&${REDACTED}#top "${REDACTED}"`);
      }
    }
  });

  it('keeps ordinary percent-encoded text readable', () => {
    for (const text of ['https://docs.example/a%20b?q=rotate%20a%20key&page=2', 'progress 100%25 done', '2024%SummerPlan', `q=${encodeURIComponent('hello world, nothing secret')}`]) {
      expect(r.redact(text)).toBe(text);
    }
  });
});

describe('credential audiences (SEC-4)', () => {
  it('normalises host entries with WHATWG URL parsing and refuses anything that is not one host', () => {
    expect(normalizeHostEntry('API.GitHub.com')).toBe('api.github.com');
    expect(normalizeHostEntry('api.github.com.')).toBe('api.github.com');
    expect(normalizeHostEntry('bücher.example')).toBe('xn--bcher-kva.example');
    expect(normalizeHostEntry('*.Example.com')).toBe('*.example.com');
    expect(normalizeHostEntry('127.1')).toBe('127.0.0.1');
    expect(normalizeHostEntry('[::1]')).toBe('[::1]');
    for (const bad of ['', '*', '*.com', 'https://api.github.com', 'api.github.com:443', 'api.github.com/path', 'user@api.github.com', 'a b', '*.*.example.com', 'api.*.com', '*.127.0.0.1']) expect(normalizeHostEntry(bad), bad).toBeNull();
  });

  it('matches exact hosts and subdomains on a dot boundary only', () => {
    expect(hostAllowed('api.github.com', ['api.github.com'])).toBe(true);
    expect(hostAllowed('API.GITHUB.COM.', ['api.github.com'])).toBe(true);
    expect(hostAllowed('api.github.com.evil.example', ['api.github.com'])).toBe(false);
    expect(hostAllowed('evilapi.github.com', ['api.github.com'])).toBe(false);
    expect(hostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('notexample.com', ['*.example.com'])).toBe(false);
    // WHATWG parsing puts an international name in punycode on both sides.
    expect(hostAllowed(hostOf('https://BÜCHER.example/x')!, [normalizeHostEntry('bücher.example')!])).toBe(true);
  });

  it('defaults by kind; a credential saved before audiences is any host, for review', () => {
    expect(credentialAudience('github', null)).toEqual({ hosts: ['api.github.com', 'uploads.github.com', 'github.com'], anyHost: false, fromKind: true });
    expect(credentialAudience('cloudflare', null).hosts).toEqual(['api.cloudflare.com']);
    expect(credentialAudience('npm', null).hosts).toEqual(['registry.npmjs.org']);
    expect(credentialAudience('http', null)).toEqual({ hosts: [], anyHost: false, fromKind: true });
    expect(credentialAudience('http', ['*'])).toEqual({ hosts: [], anyHost: true, fromKind: false });
    expect(credentialAudience('github', ['ghe.example.com'])).toEqual({ hosts: ['ghe.example.com'], anyHost: false, fromKind: false });
  });
});

describe('scanOutbound (SEC-4)', () => {
  const value = fake('gh', 'p_', repeat(ALNUM, 36));
  const secrets: OutboundSecret[] = [{ label: 'github credential "deploy"', kind: 'github', value, hosts: ['api.github.com'] }];

  it.each([
    ['url', { url: `https://collector.example/?t=${value}` }],
    ['url', { url: `https://collector.example/${Buffer.from(value).toString('hex')}` }],
    ['url', { url: `https://collector.example/?t=${encodeURIComponent(`a b ${value}`)}` }],
    ['headers', { url: 'https://collector.example/', headers: { 'x-trace': Buffer.from(`user:${value}`).toString('base64') } }],
    ['body', { url: 'https://collector.example/', body: { nested: [{ note: `token is ${value}` }] } }],
    ['body', { target: 'the MCP server "notes"', body: { text: Buffer.from(value).toString('base64url') } }],
  ] as const)('finds a known secret in the %s and names kind and host, never the value', (where, req) => {
    const findings = scanOutbound(req, secrets);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ label: 'github credential "deploy"', kind: 'github', where });
    const text = describeFindings(findings);
    expect(text).toMatch(/^Carries github credential "deploy" to (collector\.example|the MCP server "notes")/);
    expect(text).not.toContain(value);
    expect(JSON.stringify(findings)).not.toContain(value);
  });

  it('lets a secret go to a host in its audience, and nowhere else', () => {
    expect(scanOutbound({ url: `https://api.github.com/?t=${value}` }, secrets)).toEqual([]);
    expect(scanOutbound({ url: `https://api.github.com.collector.example/?t=${value}` }, secrets)).toHaveLength(1);
    // With no hosts of its own it is exempt nowhere.
    expect(scanOutbound({ url: `https://api.github.com/?t=${value}` }, [{ ...secrets[0]!, hosts: [] }])).toHaveLength(1);
  });

  it('reports a token of a known format that is not stored, but not credentials in the URL itself', () => {
    const unknown = fake('hf', '_', repeat(ALNUM, 36));
    expect(scanOutbound({ url: 'https://collector.example/', body: `x=${unknown}` }, [])).toEqual([expect.objectContaining({ label: 'a huggingface token', kind: 'huggingface', form: 'format' })]);
    expect(scanOutbound({ url: fake('https://someone', ':', 'pass-word-1', '@collector.example/') }, [])).toEqual([]);
    // A stored secret sent where it may go is not reported again as a token of its format.
    expect(scanOutbound({ url: 'https://api.github.com/', body: value }, secrets)).toEqual([]);
  });

  it('leaves a clean request alone', () => {
    expect(scanOutbound({ url: 'https://docs.example/search?q=how+to+rotate+a+token', headers: { accept: 'text/html' }, body: { q: 'plain words' } }, secrets)).toEqual([]);
  });

  it('reads a body however deep it nests, and survives a cycle', () => {
    for (const depth of [63, 64, 65, 100, 5000]) {
      let nested: unknown = { note: value };
      for (let i = 0; i < depth; i += 1) nested = i % 2 ? [nested] : { d: nested };
      expect(scanOutbound({ url: 'https://collector.example/c', body: nested }, secrets), `depth ${depth}`).toEqual([expect.objectContaining({ kind: 'github', where: 'body', form: 'raw' })]);
      expect(scanOutbound({ target: 'the MCP server "notes"', body: { args: nested } }, secrets), `depth ${depth}`).toHaveLength(1);
    }
    const cyclic: Record<string, unknown> = { a: 'plain' };
    cyclic.self = cyclic;
    cyclic.deep = { back: cyclic, note: value };
    expect(scanOutbound({ url: 'https://collector.example/c', body: cyclic }, secrets)).toHaveLength(1);
  });

  it('reads an encoding broken up the way tools print it: base64 over lines, hex bytes spaced or separated', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const hex = Buffer.from(value).toString('hex');
    // A config file encoded by `base64` (76 columns), and the secret's own base64 wrapped short, CRLF.
    const config = b64(`${'# settings for the build\n'.repeat(3)}deploy with ${value}\n`).replace(/.{76}/g, '$&\n');
    // The line break falls inside the secret's part of it: no unbroken spelling is left to find.
    for (const form of encodedForms(value).exact) expect(config).not.toContain(form);
    for (const body of [
      config,
      b64(value).replace(/.{12}/g, '$&\r\n'),
      hex.replace(/../g, '$& ').trim(),
      hex.replace(/../g, '$&:').slice(0, -1).toUpperCase(),
      hex.replace(/.{8}/g, '$&-'),
      { lines: b64(value).match(/.{1,20}/g) },
    ]) {
      expect(scanOutbound({ url: 'https://collector.example/b', body }, secrets), JSON.stringify(body)).toEqual([expect.objectContaining({ kind: 'github', where: 'body', form: 'encoded' })]);
    }
    // In a URL too, its line breaks percent-encoded.
    expect(scanOutbound({ url: `https://collector.example/?d=${encodeURIComponent(b64(value).replace(/.{16}/g, '$&\n'))}` }, secrets)).toEqual([expect.objectContaining({ where: 'url', form: 'encoded' })]);
    // Ordinary wrapped base64, spaced hex and prose stay clean.
    const plain = { file: b64('nothing secret in here at all, '.repeat(12)).replace(/.{76}/g, '$&\n'), dump: Buffer.from('plain bytes only').toString('hex').replace(/../g, '$& '), note: 'a b c de-ad be:ef' };
    expect(scanOutbound({ url: 'https://collector.example/b', body: plain }, secrets)).toEqual([]);
  });

  it('decodes percent-encoding byte by byte: a stray invalid escape beside the secret hides nothing', () => {
    const encoded = everyByte(value);
    for (const url of [
      `https://collector.example/c?d=${encoded}`,
      `https://collector.example/c?d=%FF${encoded}`,
      `https://collector.example/c?d=%C3${encoded}`,
      `https://collector.example/c?d=${encoded}%FF`,
      `https://collector.example/c?d=%E2%82${encoded.toUpperCase()}%80`,
    ]) {
      expect(scanOutbound({ url }, secrets), url).toEqual([expect.objectContaining({ kind: 'github', where: 'url', form: 'encoded' })]);
    }
    // The same for a token of a known format that is not stored.
    const unknown = fake('hf', '_', repeat(ALNUM, 36));
    expect(scanOutbound({ url: 'https://collector.example/', body: `q=%FF${everyByte(unknown)}` }, [])).toEqual([expect.objectContaining({ kind: 'huggingface', form: 'format' })]);
  });

  it('never names a host whose own name carries the secret or a token, in any case or spelling', () => {
    const mixed: OutboundSecret = { label: 'other credential "mixed"', kind: 'other', value: fake('Walrus', 'Pepper', 'Quokka', 'Marble', '0042', 'Zeta') };
    const aws = fake('AK', 'IA', 'QWERTYUIOPASDFGH');
    for (const [url, known] of [
      [`https://${mixed.value}.collector.example/x`, [mixed]],
      [`https://${everyByte(mixed.value)}.collector.example/x`, [mixed]],
      [fake('https://someone', ':', 'pw', '@', mixed.value, '.collector.example/'), [mixed]],
      [`https://${Buffer.from(mixed.value).toString('hex')}.collector.example/x`, [mixed]],
      [`https://${aws}.collector.example/x`, []],
    ] as const) {
      const findings = scanOutbound({ url }, known);
      expect(findings.length, url).toBeGreaterThan(0);
      for (const f of findings) expect(f.host, url).toBe(SECRET_HOST);
      expect(describeFindings(findings).toLowerCase()).not.toContain(mixed.value.toLowerCase());
      expect(describeFindings(findings).toLowerCase()).not.toContain(aws.toLowerCase());
      expect(namedHost({ url }, known)).toBe(SECRET_HOST);
    }
    // Elsewhere in the URL, the host is named as usual; a secret in the user info does not hide it.
    expect(scanOutbound({ url: `https://collector.example/${mixed.value}` }, [mixed])[0]!.host).toBe('collector.example');
    expect(namedHost({ url: fake('https://someone', ':', mixed.value, '@', 'collector.example/') }, [mixed])).toBe('collector.example');
    expect(namedHost({ target: 'the MCP server "notes"' }, [mixed])).toBe('the MCP server "notes"');
  });

  it('lets a token of a known format reach this machine, but never a stored secret', () => {
    const testKey = fake('sk', '_test_', repeat(ALNUM, 28));
    for (const url of ['http://127.0.0.1:3000/api/settings', 'http://localhost:5173/x', 'http://[::1]:8080/', 'http://app.localhost/']) {
      expect(scanOutbound({ url, body: { stripeKey: testKey } }, []), url).toEqual([]);
      expect(scanOutbound({ url, headers: { 'x-key': testKey }, body: { note: value } }, secrets), url).toEqual([expect.objectContaining({ kind: 'github', where: 'body', form: 'raw' })]);
    }
    // A name that only resolves to this machine is not this machine, and a local MCP server by name is checked in full.
    expect(scanOutbound({ url: 'http://127.0.0.1.nip.io/', body: testKey }, [])).toHaveLength(1);
    expect(scanOutbound({ target: 'the MCP server "notes"', body: testKey }, [])).toHaveLength(1);
  });
});
