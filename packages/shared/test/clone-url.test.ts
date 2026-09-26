import { describe, expect, it } from 'vitest';
import { isCloneFolderName, parseCloneUrl } from '../src/schemas.js';

describe('parseCloneUrl', () => {
  it('turns owner/name into a GitHub https address', () => {
    expect(parseCloneUrl('digitronics2025/Simple-calc-01')).toEqual({ url: 'https://github.com/digitronics2025/Simple-calc-01.git', folderName: 'Simple-calc-01' });
    expect(parseCloneUrl('  owner/app.git ')).toEqual({ url: 'https://github.com/owner/app.git', folderName: 'app' });
  });

  it('accepts https, ssh, scp-style and file addresses', () => {
    expect(parseCloneUrl('https://github.com/owner/app.git')?.folderName).toBe('app');
    expect(parseCloneUrl('https://github.com/owner/app')?.folderName).toBe('app');
    expect(parseCloneUrl('https://github.com/owner/app/')?.folderName).toBe('app');
    expect(parseCloneUrl('ssh://git@github.com/owner/app.git')?.folderName).toBe('app');
    expect(parseCloneUrl('git@github.com:owner/app.git')).toEqual({ url: 'git@github.com:owner/app.git', folderName: 'app' });
    expect(parseCloneUrl('file:///C:/tmp/remote.git')?.folderName).toBe('remote');
  });

  it('refuses transports that run commands or travel unencrypted', () => {
    for (const bad of ['ext::sh -c touch% /tmp/pwned', 'ext::git-remote-x', 'http://github.com/owner/app.git', 'git://github.com/owner/app.git', 'fd::3', 'ftp://host/app.git']) {
      expect(parseCloneUrl(bad)).toBeNull();
    }
  });

  it('refuses credentials in the address', () => {
    // Assembled at runtime: a credential-shaped literal would (rightly) trip the commit's secret scan.
    const withLogin = (scheme: string, login: string) => `${scheme}://${login}@github.com/owner/app.git`;
    expect(parseCloneUrl(withLogin('https', ['user', 'secret'].join(':')))).toBeNull();
    expect(parseCloneUrl(withLogin('https', 'tokenvalue'))).toBeNull();
    expect(parseCloneUrl(withLogin('ssh', ['git', 'pw'].join(':')))).toBeNull();
  });

  it('refuses option-like, empty, spaced and unusable input', () => {
    for (const bad of ['', '   ', '--upload-pack=evil', '-o/app', 'owner/app extra', 'https://github.com/', 'https://github.com/owner/..', 'owner', 'a/b/c']) {
      expect(parseCloneUrl(bad)).toBeNull();
    }
  });
});

describe('isCloneFolderName', () => {
  it('allows plain names and refuses paths', () => {
    expect(isCloneFolderName('Simple-calc-01')).toBe(true);
    for (const bad of ['', '.', '..', '-x', 'a/b', 'a\\b', 'C:', 'has space']) expect(isCloneFolderName(bad)).toBe(false);
  });
});
