import { Send } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Banner, Button, Field, Input, Select } from '@acc/ui';
import type { PhoneAlertSettings, Settings } from '@acc/shared';
import { errorMessage } from '../api/client';
import { useTestPhoneAlert } from '../api/hooks';
import { useCredentials } from '../api/tools';

const NONE = '__none__';

/**
 * Settings → Notifications → Phone alerts (docs/plans/LEAD_TIME_PLAN.md §3.4):
 * tasks that need you, fail or finish reach your phone through your messenger,
 * with no dashboard open. The same switches above choose which ones. The token
 * is chosen by name from Tools → Credentials; no value is shown or entered here.
 */
export function PhoneAlertsSection({ draft, setDraft, dirty }: { draft: Settings; setDraft: (next: Settings) => void; dirty: boolean }) {
  const credentials = useCredentials();
  const test = useTestPhoneAlert();
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const phone = draft.notifications.phone;
  const set = (next: Partial<PhoneAlertSettings>) => setDraft({ ...draft, notifications: { ...draft.notifications, phone: { ...phone, ...next } } });
  const keys = [{ value: NONE, label: 'None: phone alerts off' }, ...(credentials.data ?? []).filter((c) => c.kind === 'http').map((c) => ({ value: c.name, label: c.name, description: c.description || undefined }))];
  const complete = Boolean(phone.url && phone.credentialName && phone.recipientEmail);

  return (
    <section aria-labelledby="phone-alerts" className="flex flex-col gap-3 pt-4">
      <div className="flex flex-col">
        <h3 id="phone-alerts" className="text-h3 text-fg">Phone alerts</h3>
        <span className="text-small text-fg-secondary">Sent to your messenger, which pushes them to your phone even when no dashboard is open. Off until the address, the token and the recipient are all set.</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Messenger address" helper="Its https address, for example https://messenger.example.com.">
          <Input value={phone.url} onChange={(e) => set({ url: e.target.value.trim() })} placeholder="https://" inputMode="url" />
        </Field>
        <Field label="Token" helper={<>A credential of kind HTTP from <Link to="/tools/credentials" className="text-fg underline">Tools → Credentials</Link>. Once chosen it is the Control Center's own: no task or tool call receives it.</>}>
          <Select aria-label="Messenger token" value={phone.credentialName || NONE} onValueChange={(v) => set({ credentialName: v === NONE ? '' : v })} options={keys} />
        </Field>
        <Field label="Recipient" helper="Your email address in the messenger.">
          <Input value={phone.recipientEmail} onChange={(e) => set({ recipientEmail: e.target.value.trim() })} placeholder="you@example.com" inputMode="email" />
        </Field>
        <Field label="Link to open" helper="Optional. The dashboard address an alert opens, for example the cloud dashboard.">
          <Input value={phone.openUrl} onChange={(e) => set({ openUrl: e.target.value.trim() })} placeholder="https://" inputMode="url" />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="compact"
          icon={Send}
          disabled={!complete || dirty}
          disabledReason={dirty ? 'Save your changes first' : 'Set the address, the token and the recipient first'}
          loading={test.isPending}
          onClick={() => {
            setResult(null);
            test.mutate(undefined, {
              onSuccess: (r) => setResult(r.ok ? { tone: 'success', text: 'Sent. It should arrive on your phone within a minute.' } : { tone: 'danger', text: `Not sent: ${r.reason ?? 'unknown reason'}.` }),
              onError: (e) => setResult({ tone: 'danger', text: errorMessage(e) }),
            });
          }}
        >
          Send a test
        </Button>
      </div>
      {result ? <Banner tone={result.tone} title={result.text} /> : null}
    </section>
  );
}
