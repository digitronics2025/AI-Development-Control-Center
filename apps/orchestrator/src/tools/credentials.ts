import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { captureScript, resolveShell } from '@acc/executor';
import { newCredentialKey, openSecret, redact, registerSecretValues, sealSecret, secretFingerprint, setBrokerManagedEnvVars, unregisterSecretValues } from '@acc/security';
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_KIND_ENV,
  credentialInputSchema,
  credentialUpdateSchema,
  type CredentialEventView,
  type CredentialKind,
  type CredentialVaultLinkView,
  type CredentialView,
  type VaultResolveAction,
} from '@acc/shared';
import type { z } from 'zod';
import type { Bus } from '../bus.js';
import { newId, now } from '../store/store.js';
import type { CredentialRecord, ToolStore, VaultLinkRecord } from './store.js';

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'DUPLICATE' | 'INVALID' | 'KEY_UNAVAILABLE' | 'MANAGED',
  ) {
    super(message);
  }
}

/** Formats `credential.generate` offers: enough for session keys, signing secrets and webhook tokens. */
export const GENERATED_ENCODINGS = ['base64url', 'hex'] as const;
export type GeneratedEncoding = (typeof GENERATED_ENCODINGS)[number];

export interface GenerateInput {
  name: string;
  kind: CredentialKind;
  envVar: string | null;
  description: string;
  bytes: number;
  encoding: GeneratedEncoding;
  repositoryIds: string[] | null;
  taskId: string | null;
}

/** One shared MyVault item as the bridge delivers it (already schema-checked). */
export interface VaultItemInput {
  itemId: string;
  title: string;
  kind: CredentialKind;
  envVar: string | null;
  value: string;
  updatedAt: string | null;
  /** Set on items the Control Center created (a generated secret MyVault stores). */
  ccId: string | null;
  authority: 'myvault' | 'control-center';
}

export type VaultItemOutcome = 'imported' | 'updated' | 'unchanged' | 'pending' | 'conflict' | 'rejected';

export interface VaultPush {
  credentialId: string;
  name: string;
  kind: CredentialKind;
  envVar: string | null;
  description: string;
  value: string;
  fingerprint: string;
  /** Replace the MyVault copy only if it still holds exactly this value ("keep the Control Center value"). */
  replaceFingerprint: string | null;
}

export interface VaultAck {
  itemId: string | null;
  status: 'saved' | 'unchanged' | 'conflict' | 'detached' | 'error';
  fingerprint: string | null;
  vaultFingerprint: string | null;
  updatedAt: string | null;
  cloudPending: boolean;
  detail: string | null;
}

/** Shown to an operator or a task when a generated secret is not yet in MyVault. */
export const VAULT_SYNC_REQUIRED =
  'MyVault sync required before deploying this newly generated secret. Unlock MyVault and choose Connect and sync in its Settings (Control Center → Tools → Credentials shows the state). The value is kept and will not be regenerated.';

const note = (text: string) => redact(text).slice(0, 300);

/**
 * Variables a generated or imported credential may not take: the broker strips
 * the variables it manages from every process it launches, so a secret named
 * PATH would break every task on the machine, and one named after a provider
 * variable would stand in for the real token.
 */
const RESERVED_ENV_VARS = new Set(
  [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'USERNAME', 'APPDATA',
    'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'TEMP', 'TMP', 'TMPDIR', 'PWD', 'SHELL', 'NODE_OPTIONS', 'NODE_PATH', 'PSMODULEPATH', 'LANG',
    'CLOUDFLARE_ACCOUNT_ID', ...Object.values(CREDENTIAL_KIND_ENV).filter((v): v is string => Boolean(v)),
  ].map((v) => v.toUpperCase()),
);
const reservedEnvVar = (name: string | null) => name !== null && RESERVED_ENV_VARS.has(name.toUpperCase());
/** Provider kinds are injected as provider tokens; a random value is never one, so generation keeps to the others. */
const GENERATABLE_KINDS: ReadonlySet<CredentialKind> = new Set(['other', 'http']);
const NAME_IN_USE = 'This name is already in use. Choose another name.';

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

function linkView(l: VaultLinkRecord | null): CredentialVaultLinkView | null {
  if (!l) return null;
  return { authority: l.authority, state: l.state, origin: l.origin, itemId: l.itemId, firstSyncedAt: l.firstSyncedAt, lastSyncedAt: l.lastSyncedAt, vaultUpdatedAt: l.vaultUpdatedAt, lastError: l.lastError };
}

function view(r: CredentialRecord, link: VaultLinkRecord | null): CredentialView {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    envVar: r.envVar,
    description: r.description,
    repositoryIds: r.repositoryIds,
    fingerprint: r.fingerprint,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastUsedAt: r.lastUsedAt,
    source: !link ? 'manual' : link.authority === 'myvault' ? 'myvault' : 'generated',
    vault: linkView(link),
  };
}

/** A broker name from a MyVault title: the allowed characters only, never empty. */
function nameFromTitle(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 90);
  return base || 'myvault-item';
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
    /**
     * Names of the credentials Settings → Ask reads with (lower case). They serve
     * only Ask's pinned read-only sessions: a task tool choosing a credential by
     * kind never picks one, so a read-only key can never stand in for (or shadow)
     * the key a deploy needs.
     */
    private readonly reservedForAsk: () => ReadonlySet<string> = () => new Set(),
    /**
     * Names of credentials only the orchestrator itself reads (lower case): the
     * messenger token phone alerts post with (docs/plans/LEAD_TIME_PLAN.md §3.4).
     * No tool path, MCP server or task environment gets them; only a secret
     * deploy (`cloudflare.secret_put`, `github.secret_put`, both approval-gated)
     * may read one, to put it where it is used.
     */
    private readonly reservedForOrchestrator: () => ReadonlySet<string> = () => new Set(),
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
    const links = new Map(this.store.listVaultLinks().map((l) => [l.credentialId, l]));
    return this.store.listCredentials().map((r) => view(r, links.get(r.id) ?? null));
  }

  get(id: string): CredentialView | null {
    const r = this.store.credential(id);
    return r ? view(r, this.store.vaultLink(r.id)) : null;
  }

  events(credentialId?: string, limit = 100): CredentialEventView[] {
    return this.store.listCredentialEvents({ credentialId, limit });
  }

  private publish(id: string): CredentialView | null {
    const v = this.get(id);
    if (v) this.bus.publish({ type: 'credential', credential: v });
    return v;
  }

  private event(e: Pick<CredentialEventView, 'credentialId' | 'credentialName' | 'operation' | 'status'> & Partial<Pick<CredentialEventView, 'detail' | 'target' | 'taskId' | 'direction'>>): void {
    this.store.insertCredentialEvent({
      id: newId(),
      credentialId: e.credentialId,
      credentialName: e.credentialName,
      operation: e.operation,
      direction: e.direction ?? null,
      status: e.status,
      taskId: e.taskId ?? null,
      target: e.target ? note(e.target) : null,
      detail: e.detail ? note(e.detail) : null,
      createdAt: now(),
    });
  }

  /**
   * Seal a non-credential secret of the orchestrator's own (the remote node's
   * private key) with the same protected key. `boundTo` names its purpose, so
   * a sealed value cannot be opened as anything else.
   */
  async sealValue(plaintext: string, boundTo: string): Promise<{ ciphertext: string; iv: string; tag: string }> {
    return sealSecret(await this.loadKey(), plaintext, boundTo);
  }

  async openValue(sealed: { ciphertext: string; iv: string; tag: string }, boundTo: string): Promise<string> {
    return openSecret(await this.loadKey(), sealed, boundTo);
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
    this.event({ credentialId: id, credentialName: rec.name, operation: 'create', direction: 'local', status: 'ok' });
    return this.publish(id)!;
  }

  async update(id: string, raw: z.input<typeof credentialUpdateSchema>): Promise<CredentialView> {
    const current = this.store.credential(id);
    if (!current) throw new CredentialError('Credential not found', 'NOT_FOUND');
    const input = credentialUpdateSchema.parse(raw);
    const link = this.store.vaultLink(current.id);
    // Server-side, not only in the dashboard: MyVault owns the value of an imported item.
    if (input.value !== undefined && link?.authority === 'myvault' && link.state !== 'detached') {
      throw new CredentialError('This credential is managed by MyVault: change the value there and sync, or detach it first', 'MANAGED');
    }
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
    this.store.transaction(() => {
      this.store.upsertCredential(rec);
      // A new value for a generated secret is owed to MyVault again.
      if (input.value !== undefined && link?.authority === 'control-center' && link.state !== 'detached') this.store.upsertVaultLink({ ...link, state: 'pending_push', lastError: null, updatedAt: now() });
    });
    this.syncManagedEnv();
    if (input.value !== undefined) this.event({ credentialId: rec.id, credentialName: rec.name, operation: 'replace', direction: 'local', status: 'ok' });
    if (input.repositoryIds !== undefined) this.event({ credentialId: rec.id, credentialName: rec.name, operation: 'scope', direction: 'local', status: 'ok', target: rec.repositoryIds === null ? 'all repositories' : `${rec.repositoryIds.length} repositories` });
    return this.publish(rec.id)!;
  }

  delete(id: string): void {
    const current = this.store.credential(id);
    if (!current) throw new CredentialError('Credential not found', 'NOT_FOUND');
    // Local only: a linked MyVault item is never deleted from here.
    this.store.deleteCredential(current.id);
    this.syncManagedEnv();
    this.event({ credentialId: current.id, credentialName: current.name, operation: 'delete', direction: 'local', status: 'ok' });
    this.bus.publish({ type: 'credential.deleted', credentialId: current.id });
  }

  // ===========================================================================
  // Generated secrets (credential.generate)
  // ===========================================================================

  /**
   * Generate a secret with the CSPRNG and seal it before anything else sees
   * it. Idempotent by name: a retry returns the credential already generated
   * — never a new value — so a failed sync or deploy cannot rotate a secret.
   */
  async generate(input: GenerateInput): Promise<{ credential: CredentialView; created: boolean }> {
    const parsed = credentialInputSchema.omit({ value: true }).parse({ name: input.name, kind: input.kind, envVar: input.envVar, description: input.description, repositoryIds: input.repositoryIds });
    if (!Number.isInteger(input.bytes) || input.bytes < 16 || input.bytes > 64) throw new CredentialError('A generated secret is 16 to 64 random bytes', 'INVALID');
    if (!GENERATABLE_KINDS.has(parsed.kind)) throw new CredentialError('A generated secret is an application secret (kind "other" or "http"); provider tokens come from the provider', 'INVALID');
    if (reservedEnvVar(parsed.envVar ?? null)) throw new CredentialError(`${parsed.envVar} is reserved for the system or a provider token; choose another variable name`, 'INVALID');
    const existing = this.store.credential(parsed.name);
    if (existing) {
      // One answer whether the name belongs to a manual credential or to a secret of another repository.
      const sameScope = existing.repositoryIds === null || (parsed.repositoryIds ?? []).every((id) => existing.repositoryIds!.includes(id));
      if (this.store.vaultLink(existing.id)?.authority === 'control-center' && sameScope) return { credential: this.get(existing.id)!, created: false };
      throw new CredentialError(NAME_IN_USE, 'DUPLICATE');
    }
    const key = await this.loadKey();
    const value = randomBytes(input.bytes).toString(input.encoding);
    // The redactor learns the value before it exists anywhere else.
    registerSecretValues([value]);
    const id = newId();
    const ts = now();
    const rec: CredentialRecord = { id, name: parsed.name, kind: parsed.kind, envVar: parsed.envVar ?? null, description: parsed.description, repositoryIds: parsed.repositoryIds, ...sealSecret(key, value, id), fingerprint: secretFingerprint(value), createdAt: ts, updatedAt: ts, lastUsedAt: null };
    this.store.transaction(() => {
      this.store.upsertCredential(rec);
      this.store.upsertVaultLink({ credentialId: id, authority: 'control-center', origin: null, vaultId: null, itemId: null, state: 'pending_push', syncedFingerprint: null, vaultFingerprint: null, replaceVaultFingerprint: null, vaultUpdatedAt: null, firstSyncedAt: null, lastSyncedAt: null, lastError: null, createdAt: ts, updatedAt: ts });
    });
    this.syncManagedEnv();
    this.event({ credentialId: id, credentialName: rec.name, operation: 'generate', direction: 'local', status: 'ok', taskId: input.taskId, target: rec.repositoryIds === null ? 'all repositories' : rec.repositoryIds.join(', ') || 'no repository', detail: `${input.bytes} bytes, ${input.encoding}` });
    return { credential: this.publish(id)!, created: true };
  }

  /**
   * Vault before external deploy: a generated value may leave this machine
   * only once MyVault has acknowledged holding exactly that value. Returns
   * the blocker, or null when deployment may go ahead.
   */
  deployGate(name: string, repositoryId: string | null, context: { taskId: string | null; target: string }): string | null {
    const r = this.store.credential(name);
    if (!r || !this.inScope(r, repositoryId)) return null;
    const link = this.store.vaultLink(r.id);
    if (link?.authority !== 'control-center' || link.syncedFingerprint === r.fingerprint) return null;
    this.event({ credentialId: r.id, credentialName: r.name, operation: 'deploy_blocked', status: 'blocked', taskId: context.taskId, target: context.target, detail: 'MyVault has not acknowledged this value yet' });
    return VAULT_SYNC_REQUIRED;
  }

  // ===========================================================================
  // MyVault bridge (called by VaultBridgeService only; never an HTTP response)
  // ===========================================================================

  private async reseal(current: CredentialRecord, value: string, patch: Partial<CredentialRecord> = {}): Promise<CredentialRecord> {
    const key = await this.loadKey();
    try {
      unregisterSecretValues([openSecret(key, current, current.id)]);
    } catch {
      /* previous value unreadable: nothing to forget */
    }
    registerSecretValues([value]);
    return { ...current, ...patch, ...sealSecret(key, value, current.id), fingerprint: secretFingerprint(value), updatedAt: now() };
  }

  private uniqueName(base: string): string {
    let name = base;
    for (let n = 2; this.store.credential(name); n += 1) name = `${base.slice(0, 90)}-${n}`;
    return name;
  }

  /** Generated secrets MyVault still owes an acknowledgement for, in this vault or not bound to any yet. */
  async pendingPushes(origin: string, vaultId: string, limit: number): Promise<VaultPush[]> {
    const due = this.store.listVaultLinks().filter((l) => l.authority === 'control-center' && l.state === 'pending_push' && (l.origin === null || (l.origin === origin && l.vaultId === vaultId)));
    if (!due.length) return [];
    const key = await this.loadKey();
    const out: VaultPush[] = [];
    for (const l of due.slice(0, limit)) {
      const r = this.store.credential(l.credentialId);
      if (!r) continue;
      const value = openSecret(key, r, r.id);
      registerSecretValues([value]);
      out.push({ credentialId: r.id, name: r.name, kind: r.kind, envVar: r.envVar, description: r.description, value, fingerprint: r.fingerprint, replaceFingerprint: l.replaceVaultFingerprint });
    }
    return out;
  }

  /** MyVault's answer to one push. The fingerprint must match the value pushed, or nothing is marked synced. */
  recordPushAck(credentialId: string, origin: string, vaultId: string, pushedFingerprint: string, ack: VaultAck): void {
    const r = this.store.credential(credentialId);
    const link = r && r.id === credentialId ? this.store.vaultLink(r.id) : null;
    if (!r || !link || link.authority !== 'control-center') return;
    if (link.origin !== null && (link.origin !== origin || link.vaultId !== vaultId)) return;
    const ts = now();
    const bound = { ...link, origin, vaultId, itemId: ack.itemId ?? link.itemId, vaultUpdatedAt: ack.updatedAt ?? link.vaultUpdatedAt, vaultFingerprint: ack.vaultFingerprint ?? link.vaultFingerprint, updatedAt: ts };
    let next: VaultLinkRecord;
    if ((ack.status === 'saved' || ack.status === 'unchanged') && ack.fingerprint === pushedFingerprint) {
      // The value changed here while the push was in flight: MyVault holds the older one; the new one is still owed.
      const current = r.fingerprint === pushedFingerprint;
      next = { ...bound, state: current ? 'synced' : 'pending_push', syncedFingerprint: pushedFingerprint, vaultFingerprint: pushedFingerprint, replaceVaultFingerprint: null, firstSyncedAt: link.firstSyncedAt ?? ts, lastSyncedAt: ts, lastError: null };
      this.event({ credentialId: r.id, credentialName: r.name, operation: 'ack', direction: 'to_vault', status: 'ok', target: origin, detail: ack.cloudPending ? 'Saved in MyVault on this device; its cloud sync is pending' : 'Saved in MyVault' });
    } else if (ack.status === 'conflict') {
      next = { ...bound, state: 'conflict', lastError: 'The MyVault copy was changed there: choose which value to keep' };
      this.event({ credentialId: r.id, credentialName: r.name, operation: 'conflict', direction: 'to_vault', status: 'failed', target: origin });
    } else if (ack.status === 'detached') {
      next = { ...bound, state: 'detached', lastError: 'The MyVault item is no longer shared with the Control Center' };
      this.event({ credentialId: r.id, credentialName: r.name, operation: 'detached', direction: 'to_vault', status: 'failed', target: origin });
    } else {
      next = { ...link, lastError: note(ack.detail ?? 'MyVault could not save the value'), updatedAt: ts };
      this.event({ credentialId: r.id, credentialName: r.name, operation: 'push', direction: 'to_vault', status: 'failed', target: origin, detail: next.lastError ?? undefined });
    }
    this.store.upsertVaultLink(next);
    this.publish(r.id);
  }

  /** One shared MyVault item from a snapshot. MyVault-owned values follow MyVault; generated ones never change silently. */
  async applyVaultItem(origin: string, vaultId: string, item: VaultItemInput): Promise<{ outcome: VaultItemOutcome; credentialId: string | null }> {
    const ts = now();
    const vaultFingerprint = secretFingerprint(item.value);
    // A reserved variable from MyVault is dropped, not taken.
    if (reservedEnvVar(item.envVar)) item = { ...item, envVar: null };
    const kind: CredentialKind = (CREDENTIAL_KINDS as readonly string[]).includes(item.kind) ? item.kind : 'other';

    if (item.authority === 'control-center' && item.ccId) {
      const r = this.store.credential(item.ccId);
      const link = r && r.id === item.ccId ? this.store.vaultLink(r.id) : null;
      if (!r || !link || link.authority !== 'control-center') return { outcome: 'rejected', credentialId: null };
      if (link.origin !== null && (link.origin !== origin || link.vaultId !== vaultId)) return { outcome: 'rejected', credentialId: null };
      if (link.state === 'detached') {
        // The operator stopped following MyVault for this secret: nothing moves.
        this.store.upsertVaultLink({ ...link, vaultFingerprint, vaultUpdatedAt: item.updatedAt, updatedAt: ts });
        return { outcome: 'unchanged', credentialId: r.id };
      }
      const seen: VaultLinkRecord = { ...link, origin, vaultId, itemId: item.itemId, vaultFingerprint, vaultUpdatedAt: item.updatedAt, updatedAt: ts };
      if (vaultFingerprint === r.fingerprint) {
        this.store.upsertVaultLink({ ...seen, state: 'synced', syncedFingerprint: r.fingerprint, replaceVaultFingerprint: null, firstSyncedAt: link.firstSyncedAt ?? ts, lastSyncedAt: ts, lastError: null });
        if (link.state !== 'synced') this.publish(r.id);
        return { outcome: 'unchanged', credentialId: r.id };
      }
      if (link.state === 'pending_pull') {
        // The operator chose the MyVault value for this generated secret.
        const rec = await this.reseal(r, item.value);
        this.store.transaction(() => {
          this.store.upsertCredential(rec);
          this.store.upsertVaultLink({ ...seen, state: 'synced', syncedFingerprint: rec.fingerprint, replaceVaultFingerprint: null, firstSyncedAt: link.firstSyncedAt ?? ts, lastSyncedAt: ts, lastError: null });
        });
        this.event({ credentialId: r.id, credentialName: r.name, operation: 'update_from_vault', direction: 'from_vault', status: 'ok', target: origin, detail: 'Took the MyVault value, as chosen' });
        this.publish(r.id);
        return { outcome: 'updated', credentialId: r.id };
      }
      if (vaultFingerprint === link.syncedFingerprint || (link.state === 'pending_push' && link.replaceVaultFingerprint === vaultFingerprint)) {
        // MyVault still holds the last agreed value (or the one the operator chose to replace): the value here is owed to it.
        this.store.upsertVaultLink({ ...seen, state: 'pending_push' });
        return { outcome: 'pending', credentialId: r.id };
      }
      this.store.upsertVaultLink({ ...seen, state: 'conflict', lastError: 'The MyVault copy was changed there: choose which value to keep' });
      if (link.state !== 'conflict') {
        this.event({ credentialId: r.id, credentialName: r.name, operation: 'conflict', direction: 'from_vault', status: 'failed', target: origin });
        this.publish(r.id);
      }
      return { outcome: 'conflict', credentialId: r.id };
    }

    const link = this.store.vaultLinkByItem(origin, vaultId, item.itemId);
    if (!link) {
      // First import: sealed at once, and usable by no repository until the operator assigns one.
      const key = await this.loadKey();
      registerSecretValues([item.value]);
      const id = newId();
      const name = this.uniqueName(nameFromTitle(item.title));
      const rec: CredentialRecord = { id, name, kind, envVar: item.envVar, description: 'Imported from MyVault', repositoryIds: [], ...sealSecret(key, item.value, id), fingerprint: vaultFingerprint, createdAt: ts, updatedAt: ts, lastUsedAt: null };
      this.store.transaction(() => {
        this.store.upsertCredential(rec);
        this.store.upsertVaultLink({ credentialId: id, authority: 'myvault', origin, vaultId, itemId: item.itemId, state: 'synced', syncedFingerprint: vaultFingerprint, vaultFingerprint, replaceVaultFingerprint: null, vaultUpdatedAt: item.updatedAt, firstSyncedAt: ts, lastSyncedAt: ts, lastError: null, createdAt: ts, updatedAt: ts });
      });
      this.syncManagedEnv();
      this.event({ credentialId: id, credentialName: name, operation: 'import', direction: 'from_vault', status: 'ok', target: origin });
      this.publish(id);
      return { outcome: 'imported', credentialId: id };
    }
    const r = this.store.credential(link.credentialId);
    if (!r || link.authority !== 'myvault') return { outcome: 'rejected', credentialId: null };
    const seen: VaultLinkRecord = { ...link, vaultFingerprint, vaultUpdatedAt: item.updatedAt, updatedAt: ts };
    if (link.state === 'detached') {
      // Detached on purpose: the operator stopped following MyVault for this one.
      this.store.upsertVaultLink(seen);
      return { outcome: 'unchanged', credentialId: r.id };
    }
    if (r.fingerprint !== link.syncedFingerprint && link.state !== 'pending_pull') {
      // The local copy moved without MyVault: never pick a winner silently.
      this.store.upsertVaultLink({ ...seen, state: 'conflict', lastError: 'The local copy differs from the MyVault value it came from' });
      if (link.state !== 'conflict') this.publish(r.id);
      return { outcome: 'conflict', credentialId: r.id };
    }
    const metadata = { kind, envVar: item.envVar };
    const metadataChanged = r.kind !== metadata.kind || r.envVar !== metadata.envVar;
    if (vaultFingerprint === r.fingerprint && !metadataChanged) {
      this.store.upsertVaultLink({ ...seen, state: 'synced', syncedFingerprint: vaultFingerprint, lastSyncedAt: ts, lastError: null });
      if (link.state !== 'synced') this.publish(r.id);
      return { outcome: 'unchanged', credentialId: r.id };
    }
    const rec = vaultFingerprint === r.fingerprint ? { ...r, ...metadata, updatedAt: ts } : await this.reseal(r, item.value, metadata);
    this.store.transaction(() => {
      this.store.upsertCredential(rec);
      this.store.upsertVaultLink({ ...seen, state: 'synced', syncedFingerprint: rec.fingerprint, lastSyncedAt: ts, lastError: null });
    });
    this.syncManagedEnv();
    this.event({ credentialId: r.id, credentialName: r.name, operation: 'update_from_vault', direction: 'from_vault', status: 'ok', target: origin, detail: vaultFingerprint === r.fingerprint ? 'Kind or variable changed in MyVault' : 'New value from MyVault' });
    this.publish(r.id);
    return { outcome: 'updated', credentialId: r.id };
  }

  /**
   * After a complete snapshot only: links of this vault whose item was not in
   * it are marked missing. The local credential stays; nothing is deleted.
   */
  markUnseen(origin: string, vaultId: string, seen: ReadonlySet<string>): number {
    let missing = 0;
    for (const l of this.store.listVaultLinks()) {
      if (l.origin !== origin || l.vaultId !== vaultId || seen.has(l.credentialId)) continue;
      if (l.state !== 'synced' && l.state !== 'conflict' && l.state !== 'error' && l.state !== 'pending_pull') continue;
      const r = this.store.credential(l.credentialId);
      if (!r) continue;
      this.store.upsertVaultLink({ ...l, state: 'missing', lastError: 'The MyVault item was deleted or is no longer shared. The copy here is kept.', updatedAt: now() });
      this.event({ credentialId: r.id, credentialName: r.name, operation: 'missing', direction: 'from_vault', status: 'failed', target: origin });
      this.publish(r.id);
      missing += 1;
    }
    return missing;
  }

  /** The operator's choice for a conflict, a missing item or a detached link. */
  resolve(id: string, action: VaultResolveAction): CredentialView {
    const r = this.store.credential(id);
    const link = r ? this.store.vaultLink(r.id) : null;
    if (!r || !link) throw new CredentialError('This credential is not linked to MyVault', 'NOT_FOUND');
    const generated = link.authority === 'control-center';
    let next: VaultLinkRecord;
    if (action === 'keep-control-center' && generated && link.state === 'conflict') next = { ...link, state: 'pending_push', replaceVaultFingerprint: link.vaultFingerprint, lastError: null };
    else if (action === 'use-myvault' && link.state === 'conflict') next = { ...link, state: 'pending_pull', lastError: null };
    else if (action === 'push-again' && generated && (link.state === 'missing' || link.state === 'detached' || link.state === 'error' || link.state === 'pending_push'))
      // Unbound again: the next trusted MyVault to connect receives it (and finds its item by id if it already has it).
      next = { ...link, state: 'pending_push', origin: null, vaultId: null, itemId: null, lastError: null };
    else if (action === 'detach' && link.state !== 'detached') next = { ...link, state: 'detached', lastError: null };
    else throw new CredentialError(`"${action}" does not apply to a ${link.state.replace('_', ' ')} ${generated ? 'generated' : 'MyVault'} credential`, 'INVALID');
    this.store.upsertVaultLink({ ...next, updatedAt: now() });
    this.event({ credentialId: r.id, credentialName: r.name, operation: 'resolve', direction: 'local', status: 'ok', detail: action });
    return this.publish(r.id)!;
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

  /**
   * A generated value MyVault has not acknowledged yet is held back from every
   * tool path (an HTTP header, an injected variable, an MCP server), not only
   * from `cloudflare.secret_put`: any of them can carry it off this machine.
   */
  private heldForVault(r: CredentialRecord): boolean {
    const link = this.store.vaultLink(r.id);
    return link?.authority === 'control-center' && link.syncedFingerprint !== r.fingerprint;
  }

  /**
   * Plaintext of one named credential for one call, if this repository may use
   * it. `includeUnsynced` is for the orchestrator's own checks only; no tool
   * path passes it.
   */
  async value(name: string, repositoryId: string | null, opts: { includeUnsynced?: boolean; reserved?: 'orchestrator' | 'deploy' } = {}): Promise<string | null> {
    const r = this.store.credential(name);
    if (!r || !this.inScope(r, repositoryId)) return null;
    // A credential kept for the orchestrator's own use (an http token) is read only by it, or deployed by a production secret put.
    const reserved = r.kind === 'http' && this.reservedForOrchestrator().has(r.name.toLowerCase());
    if (reserved && !opts.reserved) return null;
    // The orchestrator reads only such a token: naming a provider key in Settings never sends it anywhere.
    if (opts.reserved === 'orchestrator' && !reserved) return null;
    if (!opts.includeUnsynced && this.heldForVault(r)) return null;
    return this.open(r);
  }

  /** Environment variables for credential kinds (the first in-scope credential of each kind, never one reserved for Ask). */
  async envFor(kinds: readonly string[], repositoryId: string | null): Promise<Record<string, string>> {
    if (!kinds.length) return {};
    const env: Record<string, string> = {};
    const reserved = this.reservedForAsk();
    const own = this.reservedForOrchestrator();
    const all = this.store
      .listCredentials()
      .filter((r) => this.inScope(r, repositoryId) && !this.heldForVault(r) && !reserved.has(r.name.toLowerCase()) && !(r.kind === 'http' && own.has(r.name.toLowerCase())));
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

  /**
   * Environment for a read-only session's pinned credentials (docs/systems/ask.md):
   * exactly the named credential of each kind, as that kind's variable, or a
   * missing kind. Never another credential of the same kind. The operator chose
   * these by name in Settings → Ask, which is their scope; a value MyVault has
   * not saved yet is still held back.
   */
  async envForPinned(kinds: readonly string[], pins: Partial<Record<string, string>>): Promise<{ env: Record<string, string>; missing: string[] }> {
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const kind of kinds) {
      const name = pins[kind];
      const r = name ? this.store.credential(name) : null;
      const variable = CREDENTIAL_KIND_ENV[kind as CredentialKind];
      if (!r || r.kind !== kind || !variable || this.heldForVault(r)) {
        missing.push(kind);
        continue;
      }
      env[variable] = await this.open(r);
    }
    return { env, missing };
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
