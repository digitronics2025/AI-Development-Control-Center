import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { captureScript, resolveShell } from '@acc/executor';
import { newCredentialKey, openSecret, registerSecretValues, sealSecret, secretFingerprint, setBrokerManagedEnvVars, unregisterSecretValues } from '@acc/security';
import { CREDENTIAL_KIND_ENV, credentialInputSchema, credentialUpdateSchema, type CredentialKind, type CredentialView } from '@acc/shared';
import type { z } from 'zod';
import type { Bus } from '../bus.js';
import { newId, now } from '../store/store.js';
import type { CredentialRecord, ToolStore } from './store.js';

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'DUPLICATE' | 'INVALID' | 'KEY_UNAVAILABLE',
  ) {
    super(message);
  }
}

/**
 * Where the 32-byte key that seals credentials lives. On Windows it is
 * protected with DPAPI for the current user (only this Windows account can
 * unwrap it); elsewhere it is a file readable only by the owner.
 */
export interface KeyProvider {
  load(): Promise<Buffer>;
}

const DPAPI_PROTECT = `Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($in)
$out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($out)`;

const DPAPI_UNPROTECT = DPAPI_PROTECT.replace('::Protect(', '::Unprotect(');

export function fileKeyProvider(dataDir: string): KeyProvider {
  if (process.platform !== 'win32') {
    const file = path.join(dataDir, 'credential-key');
    return {
      async load() {
        if (!existsSync(file)) {
          writeFileSync(file, newCredentialKey().toString('base64'), { mode: 0o600 });
          chmodSync(file, 0o600);
        }
        return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
      },
    };
  }
  const file = path.join(dataDir, 'credential-key.dpapi');
  const dpapi = async (script: string, input: string): Promise<string> => {
    // Windows PowerShell 5.1 always has System.Security's ProtectedData; PowerShell 7 may not.
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    const shell = { kind: 'powershell' as const, flavor: 'windows-powershell' as const, executable: path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') };
    const usable = existsSync(shell.executable) ? shell : await resolveShell('powershell');
    if (!usable) throw new CredentialError('PowerShell is needed to protect the credential key', 'KEY_UNAVAILABLE');
    const run = await captureScript({ shell: usable, script, stdin: input, cwd: dataDir, env: process.env, timeoutMs: 30_000 });
    if (run.result.exitCode !== 0 || !run.stdout.trim()) throw new CredentialError(`The credential key could not be ${script === DPAPI_PROTECT ? 'protected' : 'unlocked'}: ${run.stderr.slice(0, 200)}`, 'KEY_UNAVAILABLE');
    return run.stdout.trim();
  };
  return {
    async load() {
      if (!existsSync(file)) {
        const key = newCredentialKey();
        writeFileSync(file, await dpapi(DPAPI_PROTECT, key.toString('base64')), { mode: 0o600 });
        return key;
      }
      return Buffer.from(await dpapi(DPAPI_UNPROTECT, readFileSync(file, 'utf8').trim()), 'base64');
    },
  };
}

function view(r: CredentialRecord): CredentialView {
  return { id: r.id, name: r.name, kind: r.kind, envVar: r.envVar, description: r.description, repositoryIds: r.repositoryIds, fingerprint: r.fingerprint, createdAt: r.createdAt, updatedAt: r.updatedAt, lastUsedAt: r.lastUsedAt };
}

function envVarOf(r: Pick<CredentialRecord, 'kind' | 'envVar'>): string | null {
  return r.envVar ?? CREDENTIAL_KIND_ENV[r.kind as CredentialKind] ?? null;
}

/**
 * The credential broker (V2 plan §31). Values go in through the API and come
 * out only into one child process's environment (or one HTTP header) for a
 * call that needs them. They are never returned, logged or stored in plain
 * text; every value handed out is taught to the redactor first, and the
 * environment variables the broker manages are stripped from everything
 * else the orchestrator launches.
 */
export class CredentialBroker {
  private key: Promise<Buffer> | null = null;

  constructor(
    private readonly store: ToolStore,
    private readonly bus: Bus,
    private readonly keys: KeyProvider,
  ) {
    this.syncManagedEnv();
  }

  private loadKey(): Promise<Buffer> {
    this.key ??= this.keys.load().catch((error: unknown) => {
      this.key = null;
      throw error;
    });
    return this.key;
  }

  private syncManagedEnv(): void {
    setBrokerManagedEnvVars(this.store.listCredentials().map(envVarOf).filter((v): v is string => Boolean(v)));
  }

  list(): CredentialView[] {
    return this.store.listCredentials().map(view);
  }

  async create(raw: z.input<typeof credentialInputSchema>): Promise<CredentialView> {
    const input = credentialInputSchema.parse(raw);
    if (this.store.credential(input.name)) throw new CredentialError(`A credential named "${input.name}" already exists`, 'DUPLICATE');
    const id = newId();
    const sealed = sealSecret(await this.loadKey(), input.value, id);
    const ts = now();
    const rec: CredentialRecord = { id, name: input.name, kind: input.kind, envVar: input.envVar ?? null, description: input.description, repositoryIds: input.repositoryIds, ...sealed, fingerprint: secretFingerprint(input.value), createdAt: ts, updatedAt: ts, lastUsedAt: null };
    this.store.upsertCredential(rec);
    registerSecretValues([input.value]);
    this.syncManagedEnv();
    const v = view(rec);
    this.bus.publish({ type: 'credential', credential: v });
    return v;
  }

  async update(id: string, raw: z.input<typeof credentialUpdateSchema>): Promise<CredentialView> {
    const current = this.store.credential(id);
    if (!current) throw new CredentialError('Credential not found', 'NOT_FOUND');
    const input = credentialUpdateSchema.parse(raw);
    let sealed = { ciphertext: current.ciphertext, iv: current.iv, tag: current.tag };
    let fingerprint = current.fingerprint;
    if (input.value !== undefined) {
      const key = await this.loadKey();
      try {
        unregisterSecretValues([openSecret(key, current, current.id)]);
      } catch {
        /* previous value unreadable: nothing to forget */
      }
      sealed = sealSecret(key, input.value, current.id);
      fingerprint = secretFingerprint(input.value);
      registerSecretValues([input.value]);
    }
    const rec: CredentialRecord = {
      ...current,
      kind: input.kind ?? current.kind,
      envVar: input.envVar === undefined ? current.envVar : input.envVar,
      description: input.description ?? current.description,
      repositoryIds: input.repositoryIds === undefined ? current.repositoryIds : input.repositoryIds,
      ...sealed,
      fingerprint,
      updatedAt: now(),
    };
    this.store.upsertCredential(rec);
    this.syncManagedEnv();
    const v = view(rec);
    this.bus.publish({ type: 'credential', credential: v });
    return v;
  }

  delete(id: string): void {
    const current = this.store.credential(id);
    if (!current) throw new CredentialError('Credential not found', 'NOT_FOUND');
    this.store.deleteCredential(current.id);
    this.syncManagedEnv();
    this.bus.publish({ type: 'credential.deleted', credentialId: current.id });
  }

  private inScope(r: CredentialRecord, repositoryId: string | null): boolean {
    return !r.repositoryIds || (repositoryId !== null && r.repositoryIds.includes(repositoryId));
  }

  private async open(r: CredentialRecord): Promise<string> {
    const value = openSecret(await this.loadKey(), r, r.id);
    registerSecretValues([value]);
    this.store.touchCredential(r.id);
    return value;
  }

  /** Plaintext of one named credential for one call, if this repository may use it. */
  async value(name: string, repositoryId: string | null): Promise<string | null> {
    const r = this.store.credential(name);
    if (!r || !this.inScope(r, repositoryId)) return null;
    return this.open(r);
  }

  /** Environment variables for credential kinds (the first in-scope credential of each kind). */
  async envFor(kinds: readonly string[], repositoryId: string | null): Promise<Record<string, string>> {
    if (!kinds.length) return {};
    const env: Record<string, string> = {};
    const all = this.store.listCredentials().filter((r) => this.inScope(r, repositoryId));
    for (const kind of kinds) {
      for (const r of all.filter((c) => c.kind === kind)) {
        const name = envVarOf(r);
        if (!name || env[name]) continue;
        env[name] = await this.open(r);
      }
      // Cloudflare also needs the account id when one is stored as its own credential.
      if (kind === 'cloudflare') {
        const account = all.find((c) => c.envVar === 'CLOUDFLARE_ACCOUNT_ID');
        if (account && !env.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = await this.open(account);
      }
    }
    return env;
  }

  /** Environment for an MCP server: VAR → credential name. */
  async envForMapping(mapping: Record<string, string>, repositoryId: string | null): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const [variable, name] of Object.entries(mapping)) {
      const value = await this.value(name, repositoryId);
      if (value !== null) env[variable] = value;
    }
    return env;
  }

  /** Load every stored value into the redactor once (e.g. at startup), without keeping them. */
  async primeRedactor(): Promise<void> {
    const all = this.store.listCredentials();
    if (!all.length) return;
    const key = await this.loadKey();
    const values: string[] = [];
    for (const r of all) {
      try {
        values.push(openSecret(key, r, r.id));
      } catch {
        /* sealed under another key: skip */
      }
    }
    registerSecretValues(values);
  }
}
