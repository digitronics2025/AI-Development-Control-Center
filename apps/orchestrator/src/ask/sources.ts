import type { AskSettings, AskSource } from '@acc/shared';
import { CONTROL_CENTER_CAPABILITIES } from '../tools/control-center.js';
import type { CredentialBroker } from '../tools/credentials.js';

/**
 * What each Ask source may call (docs/systems/ask.md). These lists are the
 * whole allow-list of a read-only session: nothing that writes, no generic
 * web or HTTP access, no shell, no files outside what the agent reads itself.
 */
export const SOURCE_CAPABILITIES: Record<AskSource, readonly string[]> = {
  controlcenter: CONTROL_CENTER_CAPABILITIES,
  github: ['github.repos', 'github.file_read', 'github.commits', 'github.code_search', 'github.pulls', 'github.issues', 'github.runs'],
  cloudflare: ['cloudflare.catalog', 'cloudflare.d1_schema', 'cloudflare.d1_read', 'cloudflare.kv_keys', 'cloudflare.kv_get', 'cloudflare.r2_list', 'cloudflare.r2_get', 'cloudflare.logs_query'],
};

/** Lookups one answer may make. */
export const MAX_LOOKUPS_PER_ANSWER = 25;

export interface SourceState {
  source: AskSource;
  /** Set up: its read-only key is chosen and exists. */
  ready: boolean;
  /** Why not, in words for the operator. */
  reason: string | null;
}

/** Whether each source is set up, from Settings → Ask and the credential store. Names only; never values. */
export function sourceStates(settings: AskSettings, credentials: Pick<CredentialBroker, 'list'>): Record<AskSource, SourceState> {
  const stored = new Map(credentials.list().map((c) => [c.name, c.kind]));
  const keyState = (source: 'github' | 'cloudflare', name: string | null): SourceState => {
    if (!name) return { source, ready: false, reason: `Choose a read-only ${source === 'github' ? 'GitHub' : 'Cloudflare'} key in Settings → Ask.` };
    const kind = stored.get(name);
    if (!kind) return { source, ready: false, reason: `The key "${name}" chosen in Settings → Ask no longer exists.` };
    if (kind !== source) return { source, ready: false, reason: `The key "${name}" is a ${kind} key, not a ${source} key.` };
    return { source, ready: true, reason: null };
  };
  const github = keyState('github', settings.sources.github.credential);
  const cloudflareKey = keyState('cloudflare', settings.sources.cloudflare.credential);
  const cloudflare = cloudflareKey.ready && !settings.sources.cloudflare.accountId ? { source: 'cloudflare' as const, ready: false, reason: 'Add the Cloudflare account id in Settings → Ask.' } : cloudflareKey;
  if (github.ready && !settings.sources.github.owners.length) Object.assign(github, { ready: false, reason: 'Add at least one GitHub owner in Settings → Ask.' });
  return { controlcenter: { source: 'controlcenter', ready: true, reason: null }, github, cloudflare };
}
