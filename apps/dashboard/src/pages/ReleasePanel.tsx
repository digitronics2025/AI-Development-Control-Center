import { CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';
import { Button, Field, FieldGroup, Input, Panel, SegmentedControl, Textarea, cn } from '@acc/ui';
import { releaseConfigSchema, type ReleaseConfig, type ReleaseSetupCheck } from '@acc/shared';
import { errorMessage } from '../api/client';
import { useReleaseSetupCheck } from '../api/hooks';
import { useConnection } from '../app/runtime';

/** The Release panel's form, as text fields (RELEASE_STAGE_PLAN §3.2). */
export interface ReleaseForm {
  method: 'none' | 'push';
  remote: string;
  branch: string;
  liveUrl: string;
  pagesProject: string;
  versionUrl: string;
  manualPaths: string;
  timeoutMin: string;
}

export function releaseForm(config: ReleaseConfig | undefined): ReleaseForm {
  if (!config || config.method !== 'push') return { method: 'none', remote: 'origin', branch: 'main', liveUrl: '', pagesProject: '', versionUrl: '', manualPaths: '', timeoutMin: '15' };
  return {
    method: 'push',
    remote: config.remote,
    branch: config.branch,
    liveUrl: config.liveUrl,
    pagesProject: config.proof.cloudflarePages?.project ?? '',
    versionUrl: config.proof.versionUrl ?? '',
    manualPaths: config.manualPaths.join('\n'),
    timeoutMin: String(Math.round(config.timeoutSec / 60)),
  };
}

export function releaseConfig(form: ReleaseForm): ReleaseConfig {
  if (form.method === 'none') return { method: 'none' };
  return {
    method: 'push',
    remote: form.remote.trim(),
    branch: form.branch.trim(),
    liveUrl: form.liveUrl.trim(),
    proof: {
      ...(form.pagesProject.trim() ? { cloudflarePages: { project: form.pagesProject.trim() } } : {}),
      ...(form.versionUrl.trim() ? { versionUrl: form.versionUrl.trim() } : {}),
    },
    manualPaths: form.manualPaths.split('\n').map((p) => p.trim()).filter(Boolean),
    timeoutSec: Math.round((Number(form.timeoutMin) || 0) * 60),
  };
}

/** Field → first validation message, from the same schema the orchestrator enforces. */
export function releaseErrors(form: ReleaseForm): Record<string, string> {
  const parsed = releaseConfigSchema.safeParse(releaseConfig(form));
  if (parsed.success) return {};
  const out: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const [first, second] = issue.path.map(String);
    const key = first === 'proof' ? (second === 'cloudflarePages' ? 'pagesProject' : second === 'versionUrl' ? 'versionUrl' : 'proof') : first === 'timeoutSec' ? 'timeoutMin' : (first ?? 'method');
    out[key] ??= key === 'timeoutMin' ? 'Between 1 and 60 minutes' : issue.message;
  }
  return out;
}

function SetupResult({ result }: { result: ReleaseSetupCheck }) {
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Setup check results" data-testid="release-setup-results">
      {result.checks.map((c) => (
        <li key={c.name} className="flex items-start gap-2 text-body text-fg">
          {c.ok ? <CheckCircle2 size={16} aria-hidden className="mt-0.5 shrink-0 text-success" /> : <XCircle size={16} aria-hidden className="mt-0.5 shrink-0 text-danger" />}
          <span className="min-w-0 wrap-anywhere">
            <span className="font-semibold">{c.name}</span>
            <span className="sr-only">{c.ok ? ' passed' : ' failed'}</span>: {c.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Repository → Release (design.md §7.7): how tested work goes live. Nothing
 * here sends anything; Check setup only reads.
 */
export function ReleasePanel({ repositoryId, form, onChange }: { repositoryId: string; form: ReleaseForm; onChange: (form: ReleaseForm) => void }) {
  const check = useReleaseSetupCheck(repositoryId);
  const connection = useConnection();
  const errors = releaseErrors(form);
  const set = (patch: Partial<ReleaseForm>) => {
    check.reset();
    onChange({ ...form, ...patch });
  };
  return (
    <div data-testid="release-panel" className="contents">
      <Panel
        title="Release"
        headingLevel={3}
        description="Releasing sends work to your live site. It always asks you first."
        actions={
          form.method === 'push' ? (
            <Button
              size="compact"
              icon={ShieldCheck}
              loading={check.isPending}
              disabled={!connection.online || Object.keys(errors).length > 0}
              disabledReason={!connection.online ? 'Reconnect to the orchestrator first' : 'Fix the highlighted fields first'}
              onClick={() => check.mutate(releaseConfig(form))}
            >
              Check setup
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          <FieldGroup
            label="Release"
            inline
            helper={
              form.method === 'none'
                ? 'Tasks never release. Their Release stage is skipped without asking.'
                : "After its checks pass, a task asks you to push its commit to this branch. Your host (for example Cloudflare Pages connected to Git) builds it; the task shows Live only when the host serves that commit."
            }
          >
            <SegmentedControl<'none' | 'push'>
              label="Release"
              value={form.method}
              onValueChange={(method) => set({ method })}
              options={[
                { value: 'none', label: 'Off' },
                { value: 'push', label: 'Push to a branch' },
              ]}
            />
          </FieldGroup>
          {form.method === 'push' ? (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Remote" error={errors.remote ?? null}>
                  <Input value={form.remote} onChange={(e) => set({ remote: e.target.value })} className="font-mono" spellCheck={false} />
                </Field>
                <Field label="Branch" error={errors.branch ?? null} helper="The branch your host builds for production.">
                  <Input value={form.branch} onChange={(e) => set({ branch: e.target.value })} className="font-mono" spellCheck={false} />
                </Field>
              </div>
              <Field label="Live URL" error={errors.liveUrl ?? null} helper="The live app (https). It must answer before anything is sent.">
                <Input value={form.liveUrl} onChange={(e) => set({ liveUrl: e.target.value })} className="font-mono" spellCheck={false} placeholder="https://app.example.com/" inputMode="url" />
              </Field>
              <div className={cn('flex flex-col gap-4 rounded-md border p-3', errors.proof ? 'border-danger' : 'border-border-subtle')}>
                <p className="text-small text-fg-secondary">
                  How Live is proved — at least one.{errors.proof ? <span className="font-semibold text-fg"> {errors.proof}.</span> : null}
                </p>
                <Field label="Cloudflare Pages project" optional error={errors.pagesProject ?? null} helper="Live when this project's production deployment is the pushed commit and its deploy succeeded. Uses the repository's Cloudflare key, read-only.">
                  <Input value={form.pagesProject} onChange={(e) => set({ pagesProject: e.target.value })} className="font-mono" spellCheck={false} placeholder="my-app" />
                </Field>
                <Field label="Version URL" optional error={errors.versionUrl ?? null} helper="Live when this address (https, no sign-in) shows the pushed commit id.">
                  <Input value={form.versionUrl} onChange={(e) => set({ versionUrl: e.target.value })} className="font-mono" spellCheck={false} placeholder="https://app.example.com/api/version" inputMode="url" />
                </Field>
              </div>
              <Field label="Manual paths" optional helper="One pattern per line. A release that changes one of these is refused, for example db/migrations/** (they need a manual step).">
                <Textarea value={form.manualPaths} rows={3} onChange={(e) => set({ manualPaths: e.target.value })} className="font-mono" spellCheck={false} placeholder="db/migrations/**" />
              </Field>
              <Field label="Wait for Live up to (minutes)" inline error={errors.timeoutMin ?? null}>
                <Input value={form.timeoutMin} onChange={(e) => set({ timeoutMin: e.target.value.replace(/\D/g, '') })} inputMode="numeric" className="w-24" />
              </Field>
              {check.data ? <SetupResult result={check.data} /> : null}
              {check.error ? <p className="text-body text-fg" role="alert">Setup check failed: {errorMessage(check.error)}</p> : null}
            </>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
