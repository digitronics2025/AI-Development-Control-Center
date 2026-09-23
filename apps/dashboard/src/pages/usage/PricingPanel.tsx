import { Calculator, Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, DataTable, Dialog, Disclosure, Field, Input, Select, formatDateTime, useFeedback, type Column } from '@acc/ui';
import { PRICING_VERIFICATION, type PricingVersion, type PricingVerification } from '@acc/shared';
import { errorMessage } from '../../api/client';
import { usePricing, useUsageMutations } from '../../api/usage';

/** Nano-dollars per token back to dollars per million tokens, as providers publish prices. */
const perMillion = (nanos: number | null) => (nanos === null ? '—' : `$${(nanos / 1000).toLocaleString('en-US', { maximumFractionDigits: 4 })}`);

const columns: Column<PricingVersion>[] = [
  {
    key: 'model',
    header: 'Model',
    primary: true,
    cell: (p) => (
      <div className="flex min-w-0 flex-col">
        <span className="font-mono text-small font-semibold text-fg">{p.providerModelId}</span>
        <span className="text-small text-fg-secondary">{p.provider}</span>
      </div>
    ),
  },
  { key: 'input', header: 'Input / M', align: 'right', cell: (p) => <span className="tabular">{perMillion(p.inputNanos)}</span> },
  { key: 'output', header: 'Output / M', align: 'right', cell: (p) => <span className="tabular">{perMillion(p.outputNanos)}</span> },
  { key: 'read', header: 'Cache read / M', align: 'right', cell: (p) => <span className="tabular">{perMillion(p.cacheReadNanos)}</span> },
  {
    key: 'write',
    header: 'Cache write / M (5 min · 1 h)',
    align: 'right',
    cell: (p) => (
      <span className="tabular">
        {perMillion(p.cacheWriteNanos)} · {perMillion(p.cacheWrite1hNanos)}
      </span>
    ),
  },
  {
    key: 'effective',
    header: 'In force',
    cell: (p) => (
      <span className="text-small text-fg-secondary">
        {formatDateTime(p.effectiveFrom)} → {p.effectiveTo ? formatDateTime(p.effectiveTo) : 'now'}
      </span>
    ),
  },
  { key: 'verification', header: 'Verification', cell: (p) => <Badge title={p.source}>{p.verification}</Badge> },
  { key: 'source', header: 'Source', cell: (p) => <span className="text-small text-fg-secondary">{p.source}</span>, className: 'max-w-[260px]', hideStacked: true },
];

const EMPTY = { provider: '', providerModelId: '', input: '', output: '', cacheRead: '', cacheWrite: '', cacheWrite1h: '', source: '', verification: 'documented' as PricingVerification };

function AddPriceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const { addPricing } = useUsageMutations();
  const { toast } = useFeedback();
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = () => {
    setError(null);
    addPricing.mutate(
      {
        provider: form.provider.trim(),
        providerModelId: form.providerModelId.trim(),
        inputPerMillion: Number(form.input),
        outputPerMillion: Number(form.output),
        cacheReadPerMillion: num(form.cacheRead),
        cacheWritePerMillion: num(form.cacheWrite),
        cacheWrite1hPerMillion: num(form.cacheWrite1h),
        source: form.source.trim(),
        verification: form.verification,
      },
      {
        onSuccess: () => {
          toast('Price added. It applies from now on; earlier runs keep their price.', 'success');
          setForm(EMPTY);
          onOpenChange(false);
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a price version"
      description="Prices per million tokens, as the provider publishes them. The new version applies from now; runs already costed keep the price that was in force."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={addPricing.isPending} onClick={submit} disabled={!form.provider || !form.providerModelId || !form.input || !form.output || form.source.trim().length < 3}>
            Add price
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Provider" helper="e.g. anthropic, openai">
          <Input value={form.provider} onChange={set('provider')} />
        </Field>
        <Field label="Model id" helper="As usage reports it, e.g. claude-sonnet-5">
          <Input value={form.providerModelId} onChange={set('providerModelId')} />
        </Field>
        <Field label="Input $ / million">
          <Input inputMode="decimal" value={form.input} onChange={set('input')} />
        </Field>
        <Field label="Output $ / million">
          <Input inputMode="decimal" value={form.output} onChange={set('output')} />
        </Field>
        <Field label="Cache read $ / million" optional>
          <Input inputMode="decimal" value={form.cacheRead} onChange={set('cacheRead')} />
        </Field>
        <Field label="Cache write $ / million (5 min)" optional>
          <Input inputMode="decimal" value={form.cacheWrite} onChange={set('cacheWrite')} />
        </Field>
        <Field label="Cache write $ / million (1 hour)" optional>
          <Input inputMode="decimal" value={form.cacheWrite1h} onChange={set('cacheWrite1h')} />
        </Field>
        <Field label="Verification">
          <Select value={form.verification} onValueChange={(v) => setForm({ ...form, verification: v as PricingVerification })} options={PRICING_VERIFICATION.map((v) => ({ value: v, label: v }))} />
        </Field>
        <Field label="Source" helper="Where the price comes from (link or document)" className="sm:col-span-2">
          <Input value={form.source} onChange={set('source')} />
        </Field>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-body text-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** The versioned price list (secondary, design.md §7.10). */
export function PricingPanel() {
  const pricing = usePricing();
  const { recalculate } = useUsageMutations();
  const { toast } = useFeedback();
  const [adding, setAdding] = useState(false);
  return (
    <Disclosure title="Price list" description="Versioned prices used when a provider reports no cost. Runs keep the price in force when they ran.">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button icon={Plus} onClick={() => setAdding(true)}>
            Add price version
          </Button>
          <Button
            icon={Calculator}
            loading={recalculate.isPending}
            onClick={() =>
              recalculate.mutate(undefined, {
                onSuccess: (r) => toast(r.recalculated ? `Priced ${r.recalculated} attempt(s); ${r.stillUnknown} still unknown` : `No unknown cost could be priced (${r.stillUnknown} still unknown)`, 'success'),
                onError: (e) => toast(errorMessage(e), 'info'),
              })
            }
          >
            Price unknown attempts
          </Button>
        </div>
        <DataTable caption="Price versions" columns={columns} rows={pricing.data ?? []} rowKey={(p) => p.id} stackedBelow={1200} />
      </div>
      <AddPriceDialog open={adding} onOpenChange={setAdding} />
    </Disclosure>
  );
}
