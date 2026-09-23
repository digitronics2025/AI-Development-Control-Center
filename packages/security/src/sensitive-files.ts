/**
 * Files that must never be committed as they are: environment files,
 * private keys, keystores and credential stores. Matching is by name only —
 * content is checked separately with `detectSecrets`.
 */

/** `.env` variants that exist to be committed. */
const SAFE_ENV_SUFFIXES = new Set(['example', 'sample', 'template', 'dist', 'defaults', 'schema']);

const EXACT_NAMES: Record<string, string> = {
  '.npmrc': 'npm configuration, which often holds an auth token',
  '.pypirc': 'PyPI configuration with upload credentials',
  '.netrc': 'stored login credentials',
  _netrc: 'stored login credentials',
  '.git-credentials': 'stored Git credentials',
  '.htpasswd': 'password hashes',
  'credentials.json': 'a credentials file',
  'service-account.json': 'a cloud service account key',
  id_rsa: 'an SSH private key',
  id_dsa: 'an SSH private key',
  id_ecdsa: 'an SSH private key',
  id_ed25519: 'an SSH private key',
};

const EXTENSIONS: Record<string, string> = {
  pem: 'a certificate or private key',
  key: 'a private key',
  p12: 'a certificate bundle with a private key',
  pfx: 'a certificate bundle with a private key',
  jks: 'a Java keystore',
  keystore: 'a keystore',
  ppk: 'a PuTTY private key',
  asc: 'an armoured key file',
};

/** Why a repository path looks like secret material, or null when it does not. */
export function sensitiveFileReason(repoPath: string): string | null {
  const segments = repoPath.split(/[/\\]/);
  const name = (segments.at(-1) ?? '').toLowerCase();
  if (!name) return null;
  if (name === '.env' || name.startsWith('.env.')) {
    const suffix = name.slice('.env.'.length);
    if (name !== '.env' && SAFE_ENV_SUFFIXES.has(suffix)) return null;
    return 'an environment file, which usually holds secrets';
  }
  if (/^\.env\..+\.(example|sample|template)$/.test(name)) return null;
  if (EXACT_NAMES[name]) return EXACT_NAMES[name]!;
  if (/^service-account.*\.json$/.test(name) || /^client_secret.*\.json$/.test(name)) return 'a cloud credentials file';
  const parent = (segments.at(-2) ?? '').toLowerCase();
  if (parent === '.aws' && (name === 'credentials' || name === 'config')) return 'AWS credentials';
  if (parent === '.ssh' && !name.endsWith('.pub') && name !== 'known_hosts' && name !== 'config') return 'SSH material';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (ext && EXTENSIONS[ext]) return EXTENSIONS[ext]!;
  return null;
}
