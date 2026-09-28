import { afterEach, describe, expect, it } from 'vitest';
import { setSelfReferences } from '@acc/security';
import { browserRequestReachesSelf } from '../src/net-guard.js';

/** A page a tool drives never loads the Control Center, and only the Control Center is refused (audit F-02, SEC-1). */

afterEach(() => setSelfReferences({}));

const reaches = (href: string) => browserRequestReachesSelf(new URL(href));

describe('browserRequestReachesSelf', () => {
  it('refuses the listen address in every spelling, on the default and the configured port', () => {
    setSelfReferences({ port: 4400, dataDir: 'C:\\Users\\op\\AppData\\Local\\AIDevControlCenter' });
    for (const href of [
      'http://127.0.0.1:4317/',
      'http://localhost:4317/api/tasks',
      'http://127.1:4317/',
      'http://2130706433:4317/',
      'http://[::1]:4317/',
      'http://[::ffff:127.0.0.1]:4317/',
      'http://0.0.0.0:4317/',
      'ws://127.0.0.1:4317/ws',
      'http://127.0.0.1:4400/',
      'http://app.localhost:4400/',
    ]) {
      expect(reaches(href), href).toBe(true);
    }
  });

  it('refuses a local file that names the data folder or a key file', () => {
    setSelfReferences({ dataDir: 'C:\\Users\\op\\AppData\\Local\\AIDevControlCenter' });
    expect(reaches('file:///C:/Users/op/AppData/Local/AIDevControlCenter/acc.db')).toBe(true);
    expect(reaches('file:///C:/somewhere/auth-token')).toBe(true);
  });

  it('refuses a web address that carries the listen address or the data folder inside it (an open redirect)', () => {
    setSelfReferences({ port: 4400, dataDir: 'C:\\Users\\op\\AppData\\Local\\AIDevControlCenter' });
    expect(reaches('https://redirect.example/?to=http://127.0.0.1:4317/')).toBe(true);
    expect(reaches('https://redirect.example/go?next=http://127.1:4400/api')).toBe(true);
    expect(reaches('https://files.example/C:/Users/op/AppData/Local/AIDevControlCenter/acc.db')).toBe(true);
  });

  it('loads a page on another server whose path only names a self-reference word', () => {
    expect(reaches('http://127.0.0.1:5555/octokit/auth-token.js')).toBe(false);
    expect(reaches('https://cdn.example.com/npm/@octokit/auth-token/dist/index.js')).toBe(false);
    expect(reaches('https://docs.example.com/credential-key-rotation')).toBe(false);
    expect(reaches('http://localhost:5173/')).toBe(false);
  });
});
