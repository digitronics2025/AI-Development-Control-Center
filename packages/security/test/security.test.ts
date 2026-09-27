import { describe, expect, it } from 'vitest';
import {
  alwaysRequiresApproval,
  classifyCommand,
  detectApiCredentials,
  REDACTED,
  Redactor,
  redactDeep,
  sanitizeEnv,
  credentialFreeEnv,
  detectAmbientCredentials,
} from '../src/index.js';

// Fake credentials are assembled at runtime so no credential-shaped literal
// lives in the repository (the commit guard scans for them).
const fake = (...parts: string[]) => parts.join('');
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

describe('Redactor', () => {
  const r = new Redactor();

  it.each([
    ['anthropic key', fake('sk-', 'ant-', 'api03-', ALNUM)],
    ['openai project key', fake('sk-', 'proj-', ALNUM)],
    ['github token', fake('gh', 'p_', ALNUM)],
    ['github fine-grained', fake('github', '_pat_', '11ABCDEFG', ALNUM)],
    ['aws key', fake('AK', 'IA', 'ABCDEFGHIJKLMNOP')],
    ['jwt', fake('eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.dozjgNryP4J3jVmNHl0w5N')],
    ['slack', fake('xo', 'xb-', '1234567890-abcdefghij')],
  ])('redacts %s', (_name, secret) => {
    const out = r.redact(`value: ${secret} end`);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(secret);
  });

  it('keeps the key name of key=value secrets', () => {
    expect(r.redact('CLOUDFLARE_API_TOKEN=abc123def456ghi')).toBe(`CLOUDFLARE_API_TOKEN=${REDACTED}`);
    expect(r.redact('"password": "hunter2hunter2"')).toBe(`"password": "${REDACTED}"`);
    expect(r.redact('Authorization: Bearer abcdefghijklmnop.qrstuv')).toContain(`Bearer ${REDACTED}`);
  });

  it('masks only the signature of a signed URL, and stops a key=value secret at the next URL parameter', () => {
    const sig = fake('a1b2c3d4', 'e5f6a7b8', 'c9d0e1f2', 'a3b4c5d6');
    const s3 = `https://bucket.s3.amazonaws.com/generated/hero.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260927T120000Z&X-Amz-Expires=3600&X-Amz-Signature=${sig}`;
    expect(r.redact(s3)).toBe(`https://bucket.s3.amazonaws.com/generated/hero.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260927T120000Z&X-Amz-Expires=3600&X-Amz-Signature=${REDACTED}`);
    const sas = `https://acct.blob.core.windows.net/media/loop.mp4?sv=2024-01-01&se=2026-09-28&sig=${fake('abcDEF', '123%2B', 'xyz%3D')}&sp=r`;
    expect(r.redact(sas)).toBe(`https://acct.blob.core.windows.net/media/loop.mp4?sv=2024-01-01&se=2026-09-28&sig=${REDACTED}&sp=r`);
    // A public CDN URL without a signature stays as it is.
    expect(r.redact('https://v3.fal.media/files/penguin/abc123_hero.png')).toBe('https://v3.fal.media/files/penguin/abc123_hero.png');
    const tokenParam = fake('abc123', 'def456');
    expect(r.redact(`https://api.example.com/x?token=${tokenParam}&size=large`)).toBe(`https://api.example.com/x?token=${REDACTED}&size=large`);
  });

  it('leaves design wording readable while real credentials are still masked', () => {
    for (const text of ['Use token --color-accent-strong for links', 'Basic typography-scale: 16/20/25', 'accentToken: "#3355ff"', 'surfaceToken = var(--surface-2)', 'spacingToken: 1.25rem', 'the token for-the-hero-section']) {
      expect(r.redact(text), text).toBe(text);
    }
    expect(r.redact(`Authorization: Bearer ${fake('abcdefgh', 'ijklmnop')}XYZ`)).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(r.redact(`token ${fake('1234567890', 'abcdef')}`)).toBe(`token ${REDACTED}`);
    expect(r.redact(`Basic ${fake('dXNlcjpw', 'YXNzd29y', 'ZA==')}`)).toBe(`Basic ${REDACTED}`);
    expect(r.redact(`apiKey: "${fake('abcdef', '123456')}"`)).toBe(`apiKey: "${REDACTED}"`);
    expect(r.redact(`authToken=${fake('ghij', 'kl78', '90')}`)).toBe(`authToken=${REDACTED}`);
  });

  it('redacts URL credentials but keeps the host', () => {
    expect(r.redact('https://user:s3cretpass@github.com/x.git')).toBe(`https://${REDACTED}@github.com/x.git`);
  });

  it('leaves ordinary text alone', () => {
    const text = 'npm test passed: 42 tests in src/token-parser.ts, author: Jane';
    expect(r.redact(text)).toBe(text);
  });

  it('redacts literal values of sensitive environment variables', () => {
    const env = Redactor.fromEnv({ MY_SERVICE_TOKEN: 'weird-format-value-1234', PATH: '/usr/bin' });
    expect(env.redact('got weird-format-value-1234 back')).toBe(`got ${REDACTED} back`);
    expect(env.redact('/usr/bin')).toBe('/usr/bin');
  });

  it('suppresses multi-line private keys in streams', () => {
    const line = r.lineRedactor();
    const marker = (edge: string) => fake('-----', edge, ' RSA PRIVATE', ' KEY-----');
    const input = ['before', marker('BEGIN'), 'line-one-of-key', 'abc', marker('END'), 'after'];
    const out = input.map(line);
    expect(out[0]).toBe('before');
    expect(out.slice(1, 5).every((l) => l === REDACTED)).toBe(true);
    expect(out[5]).toBe('after');
  });

  it('redacts nested objects', () => {
    const out = redactDeep({ a: [fake('token', '=abcdefghijk')], b: { c: fake('gh', 'p_', ALNUM) }, n: 3 }, r);
    expect(JSON.stringify(out)).not.toMatch(/abcdefghijk|ghp_/);
    expect(out.n).toBe(3);
  });
});

describe('sanitizeEnv', () => {
  const source = {
    PATH: '/bin',
    OPENAI_API_KEY: 'sk-x',
    anthropic_api_key: 'sk-ant-x',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ACC_TOKEN: 'local',
    HOME: '/home/u',
  };

  it('strips API billing credentials in subscription mode (case-insensitive)', () => {
    const { env, removed } = sanitizeEnv(source, 'subscription');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.anthropic_api_key).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.ACC_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(removed).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK']));
    expect(source.OPENAI_API_KEY).toBe('sk-x');
  });

  it('keeps provider credentials in explicit API mode but still strips the local token', () => {
    const { env } = sanitizeEnv(source, 'api');
    expect(env.OPENAI_API_KEY).toBe('sk-x');
    expect(env.ACC_TOKEN).toBeUndefined();
  });

  it('strips ambient provider credentials in every billing mode, and keeps the subscription sign-in (audit F-03)', () => {
    const ambient = { PATH: '/bin', CLOUDFLARE_API_TOKEN: fake('cf', ALNUM), gh_token: fake('g', ALNUM), DATABASE_URL: fake('postgres://u:', 'p', '@h/db'), CLAUDE_CODE_OAUTH_TOKEN: 'sub' };
    for (const mode of ['subscription', 'api'] as const) {
      const { env, removed } = sanitizeEnv(ambient, mode);
      expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
      expect(env.gh_token).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sub');
      expect(env.PATH).toBe('/bin');
      expect(removed).toEqual(expect.arrayContaining(['CLOUDFLARE_API_TOKEN', 'GH_TOKEN', 'DATABASE_URL']));
    }
    expect(credentialFreeEnv({ ...ambient, OPENAI_API_KEY: 'x' }).OPENAI_API_KEY).toBeUndefined();
    expect(detectAmbientCredentials(ambient)).toEqual(['CLOUDFLARE_API_TOKEN', 'GH_TOKEN', 'DATABASE_URL']);
  });

  it('strips media generation keys in every billing mode: generation is billed per call', () => {
    const media = { PATH: '/bin', FAL_KEY: fake('fal-', ALNUM), replicate_api_token: fake('r8_', ALNUM), RUNWAYML_API_SECRET: fake('key_', ALNUM), ELEVENLABS_API_KEY: fake('el', ALNUM), HIGGSFIELD_API_KEY: fake('hf', ALNUM) };
    for (const mode of ['subscription', 'api'] as const) {
      const { env, removed } = sanitizeEnv(media, mode);
      expect(Object.keys(env)).toEqual(['PATH']);
      expect(removed).toEqual(expect.arrayContaining(['FAL_KEY', 'REPLICATE_API_TOKEN', 'RUNWAYML_API_SECRET', 'ELEVENLABS_API_KEY', 'HIGGSFIELD_API_KEY']));
    }
    expect(credentialFreeEnv(media)).toEqual({ PATH: '/bin' });
    expect(detectAmbientCredentials(media)).toEqual(expect.arrayContaining(['FAL_KEY', 'REPLICATE_API_TOKEN']));
  });

  it('reports present API credentials by name only', () => {
    expect(detectApiCredentials(source)).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']));
    expect(detectApiCredentials({ PATH: '/bin' })).toEqual([]);
  });
});

describe('classifyCommand', () => {
  it.each([
    ['npm test', 'normal', 2],
    ['pnpm run build', 'normal', 2],
    ['git status', 'normal', 1],
    ['git push origin main', 'elevated', 3],
    ['wrangler deploy --env staging', 'elevated', 4],
    ['rm -rf node_modules', 'dangerous', 5],
    ['Remove-Item -Recurse -Force dist', 'dangerous', 5],
    ['git push --force origin main', 'dangerous', 5],
    ['git reset --hard HEAD~1', 'dangerous', 5],
    ['sqlite3 db "DROP TABLE users"', 'dangerous', 5],
    ['psql -c "DELETE FROM users"', 'dangerous', 5],
    ['terraform destroy', 'dangerous', 5],
  ] as const)('%s → %s L%d', (command, risk, level) => {
    const c = classifyCommand(command);
    expect(c.risk).toBe(risk);
    expect(c.level).toBe(level);
  });

  it('treats a scoped DELETE as not dangerous', () => {
    expect(classifyCommand('psql -c "DELETE FROM users WHERE id = 3"').risk).toBe('normal');
  });

  it('escalates anything aimed at production to level 5', () => {
    const c = classifyCommand('wrangler deploy --env production');
    expect(c.level).toBe(5);
    expect(c.production).toBe(true);
    expect(alwaysRequiresApproval(c)).toBe(true);
  });

  it('does not require approval for local commands', () => {
    expect(alwaysRequiresApproval(classifyCommand('npm run lint'))).toBe(false);
  });
});
