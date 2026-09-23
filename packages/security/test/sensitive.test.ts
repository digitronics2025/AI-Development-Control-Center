import { describe, expect, it } from 'vitest';
import { detectSecrets, sensitiveFileReason } from '../src/index.js';

// Credential-shaped values are assembled at runtime so no literal reaches the commit guard.
const fake = {
  github: ['gh', 'p_', 'A'.repeat(36)].join(''),
  aws: ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join(''),
  privateKey: ['-----BEGIN ', 'RSA PRIVATE KEY-----\nabc\n-----END ', 'RSA PRIVATE KEY-----'].join(''),
  urlCredentials: ['https://user', ':', 'hunter2secret', '@example.com/repo.git'].join(''),
};

describe('detectSecrets', () => {
  it('finds high-confidence credential formats and names only the rule', () => {
    expect(detectSecrets(`const token = "${fake.github}";`)).toEqual(['github']);
    expect(detectSecrets(`key ${fake.aws}`)).toEqual(['aws-access-key']);
    expect(detectSecrets(fake.privateKey)).toEqual(['private-key']);
    expect(detectSecrets(`remote = ${fake.urlCredentials}`)).toEqual(['url-credentials']);
  });

  it('does not block ordinary code that merely mentions secrets', () => {
    expect(detectSecrets('password: z.string().min(8),\nconst apiKey = process.env.API_KEY;\nAuthorization: Bearer ${token}')).toEqual([]);
  });

  it('is stable across repeated calls (no regex state leaks)', () => {
    const text = `x ${fake.github}`;
    expect(detectSecrets(text)).toEqual(detectSecrets(text));
  });
});

describe('sensitiveFileReason', () => {
  it.each(['.env', 'apps/api/.env.production', '.env.local', 'certs/server.pem', 'deploy/id_ed25519', 'keys/app.p12', '.npmrc', 'home/.aws/credentials', 'gcp/service-account-prod.json'])(
    'flags %s',
    (file) => expect(sensitiveFileReason(file)).not.toBeNull(),
  );

  it.each(['.env.example', '.env.sample', 'config/.env.template', 'src/env.ts', 'id_ed25519.pub', 'README.md', 'docs/keys.md', '.ssh/known_hosts'])('allows %s', (file) =>
    expect(sensitiveFileReason(file)).toBeNull(),
  );
});
