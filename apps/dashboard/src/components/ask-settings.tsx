import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, Disclosure, Field, IconButton, Input, Panel, Select, Switch } from '@acc/ui';
import type { AskSettings, AskSourceCheck, CredentialView, Settings } from '@acc/shared';
import { ASK_SOURCE_LABEL } from '@acc/shared';
import { errorMessage } from '../api/client';
import { useAskSourceCheck } from '../api/hooks';
import { useCredentials } from '../api/tools';
import { AssignmentPicker } from './assignment-picker';

const NONE = '__none__';
const DATA_KINDS = [
  { value: 'd1', label: 'D1 database' },
  { value: 'kv', label: 'KV namespace' },
  { value: 'r2', label: 'R2 bucket' },
  { value: 'repo', label: 'GitHub repository' },
] as const;

/**
 * Settings → Ask (design.md §7.3.2): the read-only keys each data source uses,
 * where they may look, personal-data masking and the data map. Keys are chosen
 * by name from Tools → Credentials; no value is ever shown or entered here.
 */
export function AskSettingsPanel({ draft, setDraft }: { draft: Settings; setDraft: (next: Settings) => void }) {
  const credentials = useCredentials();
  const check = useAskSourceCheck();
  const [results, setResults] = useState<AskSourceCheck[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const ask = draft.ask;
  const set = (next: Partial<AskSettings>) => setDraft({ ...draft, ask: { ...ask, ...next } });
  const setSource = <K extends 'github' | 'cloudflare'>(key: K, value: Partial<AskSettings['sources'][K]>) => set({ sources: { ...ask.sources, [key]: { ...ask.sources[key], ...value } } });
  const keysOf = (kind: CredentialView['kind']) => [{ value: NONE, label: 'None: not used' }, ...(credentials.data ?? []).filter((c) => c.kind === kind).map((c) => ({ value: c.name, label: c.name, description: c.description || undefined }))];

  return (
    <Panel
      title="Ask"
      headingLevel={2}
      description="Read-only questions outside tasks. Choose the keys Ask may read GitHub and Cloudflare with. It can never change anything, whatever the key allows, but use read-only keys so it could not even if it tried."
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="text-body font-semibold text-fg">Default agent</span>
          <AssignmentPicker
            label="Ask"
            value={{ agentId: ask.agentId, model: ask.model, effort: ask.effort }}
            onChange={(v) => set({ agentId: v.agentId ?? ask.agentId, model: v.model ?? 'default', effort: v.effort ?? 'default' })}
          />
        </div>

        <section aria-labelledby="ask-github" className="flex flex-col gap-3">
          <h3 id="ask-github" className="text-h3 text-fg">GitHub</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Read-only key" helper={<>A credential of kind GitHub from <Link to="/tools/credentials" className="text-fg underline">Tools → Credentials</Link>. Once chosen it is for Ask only: tasks never receive it.</>}>
              <Select aria-label="GitHub read-only key" value={ask.sources.github.credential ?? NONE} onValueChange={(v) => setSource('github', { credential: v === NONE ? null : v })} options={keysOf('github')} />
            </Field>
            <Field label="Owners it may read" helper="Accounts or organisations, separated by commas.">
              <Input
                value={ask.sources.github.owners.join(', ')}
                onChange={(e) => setSource('github', { owners: e.target.value.split(',').map((o) => o.trim()).filter(Boolean).slice(0, 20) })}
                placeholder="digitronics2025"
              />
            </Field>
          </div>
          <Disclosure title="How to create a read-only GitHub key">
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-small text-fg-secondary">
              <li>On GitHub open Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.</li>
              <li>Resource owner: the owner above. Repository access: All repositories (or the ones Ask may read).</li>
              <li>Repository permissions, all Read-only: Contents, Metadata, Issues, Pull requests, Actions. Nothing else.</li>
              <li>Store it in Tools → Credentials as kind GitHub (it is sealed and kept in MyVault), then choose it above.</li>
            </ol>
          </Disclosure>
        </section>

        <section aria-labelledby="ask-cloudflare" className="flex flex-col gap-3">
          <h3 id="ask-cloudflare" className="text-h3 text-fg">Cloudflare</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Read-only key" helper={<>A credential of kind Cloudflare from <Link to="/tools/credentials" className="text-fg underline">Tools → Credentials</Link>. Once chosen it is for Ask only: tasks never receive it.</>}>
              <Select aria-label="Cloudflare read-only key" value={ask.sources.cloudflare.credential ?? NONE} onValueChange={(v) => setSource('cloudflare', { credential: v === NONE ? null : v })} options={keysOf('cloudflare')} />
            </Field>
            <Field label="Account id" helper="32 characters, from the Cloudflare dashboard's account home.">
              <Input
                value={ask.sources.cloudflare.accountId ?? ''}
                onChange={(e) => setSource('cloudflare', { accountId: e.target.value.trim() || null })}
                placeholder="0123456789abcdef0123456789abcdef"
                spellCheck={false}
              />
            </Field>
          </div>
          <Disclosure title="How to create a read-only Cloudflare key">
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-small text-fg-secondary">
              <li>In the Cloudflare dashboard open My Profile → API Tokens → Create Token → Create Custom Token.</li>
              <li>Account permissions, all Read: D1, Workers KV Storage, Workers R2 Storage, Workers Scripts, Workers Observability, Account Settings. Nothing with Edit.</li>
              <li>Account resources: include only this account.</li>
              <li>Store it in Tools → Credentials as kind Cloudflare, then choose it above.</li>
            </ol>
          </Disclosure>
        </section>

        <div className="flex items-start justify-between gap-4 border-t border-border-subtle pt-4">
          <span className="flex max-w-prose flex-col">
            <span className="text-body font-semibold text-fg">Mask personal data by default</span>
            <span className="text-small text-fg-secondary">Customer names, emails, phone numbers and similar are replaced before the agent sees them. A conversation can show them with its own switch.</span>
          </span>
          <Switch aria-label="Mask personal data by default" checked={ask.maskPersonalData} onCheckedChange={(v) => set({ maskPersonalData: v })} />
        </div>

        <section aria-labelledby="ask-data-map" className="flex flex-col gap-3 border-t border-border-subtle pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col">
              <h3 id="ask-data-map" className="text-h3 text-fg">Data map</h3>
              <span className="text-small text-fg-secondary">Friendly names for your data, so a question can say "orders" instead of a database id.</span>
            </div>
            <Button size="compact" icon={Plus} disabled={ask.dataMap.length >= 50} onClick={() => set({ dataMap: [...ask.dataMap, { name: '', kind: 'd1', target: '', note: '' }] })}>
              Add
            </Button>
          </div>
          {ask.dataMap.length === 0 ? <p className="text-small text-fg-secondary">No names yet.</p> : null}
          {ask.dataMap.map((row, i) => {
            const update = (next: Partial<AskSettings['dataMap'][number]>) => set({ dataMap: ask.dataMap.map((r, j) => (j === i ? { ...r, ...next } : r)) });
            return (
              <div key={i} role="group" aria-label={`Data map row ${i + 1}`} className="grid items-end gap-2 md:grid-cols-[minmax(0,1fr)_160px_minmax(0,1.3fr)_minmax(0,1.3fr)_auto]">
                <Field label="Name">
                  <Input value={row.name} onChange={(e) => update({ name: e.target.value })} placeholder="orders" />
                </Field>
                <Field label="Kind">
                  <Select aria-label="Kind" value={row.kind} onValueChange={(v) => update({ kind: v as AskSettings['dataMap'][number]['kind'] })} options={DATA_KINDS.map((k) => ({ value: k.value, label: k.label }))} />
                </Field>
                <Field label="Where it is">
                  <Input value={row.target} onChange={(e) => update({ target: e.target.value })} placeholder="shop-production" />
                </Field>
                <Field label="Note">
                  <Input value={row.note} onChange={(e) => update({ note: e.target.value })} placeholder="table orders, one row per sale" />
                </Field>
                <IconButton icon={Trash2} label={`Remove ${row.name || `row ${i + 1}`}`} onClick={() => set({ dataMap: ask.dataMap.filter((_, j) => j !== i) })} />
              </div>
            );
          })}
        </section>

        <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              icon={ShieldCheck}
              loading={check.isPending}
              onClick={() =>
                check.mutate(undefined, {
                  onSuccess: (r) => {
                    setResults(r);
                    setCheckError(null);
                  },
                  onError: (e) => setCheckError(errorMessage(e)),
                })
              }
            >
              Check access
            </Button>
            <span className="text-small text-fg-secondary">Runs one real read per source with the saved settings. Save first.</span>
          </div>
          {checkError ? <p className="text-small text-danger">{checkError}</p> : null}
          {results ? (
            <ul aria-label="Access check" className="flex flex-col gap-1">
              {results.map((r) => (
                <li key={r.source} className="text-small">
                  <span className="font-semibold text-fg">{ASK_SOURCE_LABEL[r.source]}: </span>
                  <span className={r.ok ? 'text-fg' : 'text-danger'}>{r.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
