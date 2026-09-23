import { Pencil, Plus, Trash2, Wallet } from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Meter,
  SegmentedControl,
  Select,
  Skeleton,
  StatusChip,
  Switch,
  BUDGET_STATE_VISUAL,
  formatDateTime,
  useFeedback,
} from '@acc/ui';
import {
  BUDGET_PERIODS,
  BUDGET_PERIOD_LABEL,
  BUDGET_POLICY_LABEL,
  BUDGET_SCOPES,
  BUDGET_SCOPE_LABEL,
  NANOS_PER_USD,
  formatRatio,
  formatUsd,
  type BudgetPeriod,
  type BudgetPolicy,
  type BudgetScope,
  type BudgetStatus,
} from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useAgents, useRepositories } from '../../api/hooks';
import { useBudgets, useUsageMutations } from '../../api/usage';

const POLICY_HELP: Record<BudgetPolicy, string> = {
  WARN_ONLY: 'Shows warning and exceeded states; runs continue.',
  STOP_NEW_RUNS: 'Hard stop: once exceeded, new agent runs in scope wait for you. Nothing is ever switched to a cheaper model.',
};

interface FormState {
  scopeType: BudgetScope;
  scopeId: string;
  period: BudgetPeriod;
  amount: string;
  warning: string;
  critical: string;
  policy: BudgetPolicy;
}

const NEW_BUDGET: FormState = { scopeType: 'GLOBAL', scopeId: '', period: 'month', amount: '', warning: '80', critical: '95', policy: 'WARN_ONLY' };

function BudgetDialog({ budget, open, onOpenChange }: { budget: BudgetStatus | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [form, setForm] = useState<FormState>(
    budget
      ? {
          scopeType: budget.scopeType,
          scopeId: budget.scopeId ?? '',
          period: budget.period,
          amount: String(budget.amountNanos / NANOS_PER_USD),
          warning: String(Math.round(budget.warningThreshold * 100)),
          critical: String(Math.round(budget.criticalThreshold * 100)),
          policy: budget.policy,
        }
      : NEW_BUDGET,
  );
  const [error, setError] = useState<string | null>(null);
  const repositories = useRepositories();
  const agents = useAgents();
  const { createBudget, updateBudget } = useUsageMutations();
  const { toast } = useFeedback();
  const pending = createBudget.isPending || updateBudget.isPending;
  const done = (message: string) => {
    toast(message, 'success');
    onOpenChange(false);
  };
  const submit = () => {
    setError(null);
    const amountUsd = Number(form.amount);
    const warningThreshold = Number(form.warning) / 100;
    const criticalThreshold = Number(form.critical) / 100;
    if (!(amountUsd > 0)) return setError('Enter an amount above zero.');
    if (budget) {
      updateBudget.mutate({ id: budget.id, patch: { amountUsd, warningThreshold, criticalThreshold, policy: form.policy } }, { onSuccess: () => done('Budget saved'), onError: (e) => setError(errorMessage(e)) });
    } else {
      createBudget.mutate(
        { scopeType: form.scopeType, scopeId: form.scopeType === 'GLOBAL' ? null : form.scopeId.trim() || null, period: form.scopeType === 'TASK' ? 'total' : form.period, amountUsd, warningThreshold, criticalThreshold, policy: form.policy, enabled: true },
        { onSuccess: () => done('Budget added'), onError: (e) => setError(errorMessage(e)) },
      );
    }
  };
  const scopeInput = () => {
    switch (form.scopeType) {
      case 'PROJECT':
        return <Select value={form.scopeId || undefined} placeholder="Choose a repository" onValueChange={(v) => setForm({ ...form, scopeId: v })} options={(repositories.data ?? []).map((r) => ({ value: r.id, label: r.name }))} />;
      case 'AGENT':
        return <Select value={form.scopeId || undefined} placeholder="Choose an agent" onValueChange={(v) => setForm({ ...form, scopeId: v })} options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))} />;
      case 'PROVIDER':
        return (
          <Select
            value={form.scopeId || undefined}
            placeholder="Choose a provider"
            onValueChange={(v) => setForm({ ...form, scopeId: v })}
            options={[
              { value: 'anthropic', label: 'Anthropic (Claude Code)' },
              { value: 'openai', label: 'OpenAI (Codex)' },
              { value: 'simulated', label: 'Simulated agents' },
            ]}
          />
        );
      default:
        return <Input value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })} placeholder={form.scopeType === 'MODEL' ? 'e.g. claude-opus-5' : 'e.g. TASK-0042'} />;
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={budget ? `Edit budget: ${budget.scopeLabel}` : 'Add a budget'}
      description="Budgets are your own spending limits, separate from provider quotas. Attempts with an unknown cost are counted and shown, not added as zero."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            {budget ? 'Save budget' : 'Add budget'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {!budget ? (
          <>
            <Field label="Scope">
              <Select value={form.scopeType} onValueChange={(v) => setForm({ ...form, scopeType: v as BudgetScope, scopeId: '', period: v === 'TASK' ? 'total' : form.period === 'total' ? 'month' : form.period })} options={BUDGET_SCOPES.map((s) => ({ value: s, label: BUDGET_SCOPE_LABEL[s] }))} />
            </Field>
            {form.scopeType !== 'GLOBAL' ? <Field label={BUDGET_SCOPE_LABEL[form.scopeType]}>{scopeInput()}</Field> : <div />}
            <Field label="Period">
              <Select
                value={form.scopeType === 'TASK' ? 'total' : form.period}
                disabled={form.scopeType === 'TASK'}
                onValueChange={(v) => setForm({ ...form, period: v as BudgetPeriod })}
                options={BUDGET_PERIODS.filter((p) => (form.scopeType === 'TASK' ? p === 'total' : p !== 'total')).map((p) => ({ value: p, label: BUDGET_PERIOD_LABEL[p] }))}
              />
            </Field>
          </>
        ) : null}
        <Field label="Amount in US dollars">
          <Input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label="Warn at (% used)">
          <Input inputMode="numeric" value={form.warning} onChange={(e) => setForm({ ...form, warning: e.target.value })} />
        </Field>
        <Field label="Critical at (% used)">
          <Input inputMode="numeric" value={form.critical} onChange={(e) => setForm({ ...form, critical: e.target.value })} />
        </Field>
        <Field label="When exceeded" helper={POLICY_HELP[form.policy]} className="sm:col-span-2">
          <SegmentedControl<BudgetPolicy>
            label="When exceeded"
            value={form.policy}
            onValueChange={(v) => setForm({ ...form, policy: v })}
            options={[
              { value: 'WARN_ONLY', label: BUDGET_POLICY_LABEL.WARN_ONLY },
              { value: 'STOP_NEW_RUNS', label: BUDGET_POLICY_LABEL.STOP_NEW_RUNS },
            ]}
          />
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

export function BudgetsTab() {
  const budgets = useBudgets();
  const { updateBudget, deleteBudget } = useUsageMutations();
  const { toast } = useFeedback();
  const [editing, setEditing] = useState<BudgetStatus | 'new' | null>(null);
  const [removing, setRemoving] = useState<BudgetStatus | null>(null);
  if (budgets.isLoading) return <Skeleton className="h-48" />;
  const list = budgets.data ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-body text-fg-secondary">Spend limits you set for all usage, a provider, a repository, a model, an agent or one task. They are not provider quotas.</p>
        <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
          Add budget
        </Button>
      </div>
      {!list.length ? (
        <EmptyState icon={Wallet} title="No budgets yet" description="Add a monthly budget to see how much is left and get warnings before it runs out." />
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
          {list.map((b) => (
            <li key={b.id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-body font-semibold text-fg">{b.scopeLabel}</span>
                  <span className="text-small text-fg-secondary">
                    {BUDGET_PERIOD_LABEL[b.period]} · {BUDGET_POLICY_LABEL[b.policy]}
                    {b.periodStart ? ` · ${formatDateTime(b.periodStart)} to ${formatDateTime(b.periodEnd)}` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {b.enabled ? <StatusChip visual={BUDGET_STATE_VISUAL[b.state]} size="compact" /> : <span className="text-small text-fg-secondary">Paused</span>}
                  <Switch
                    checked={b.enabled}
                    aria-label={`${b.enabled ? 'Pause' : 'Resume'} budget ${b.scopeLabel}`}
                    onCheckedChange={(enabled) => updateBudget.mutate({ id: b.id, patch: { enabled } }, { onError: (e) => toast(errorMessage(e), 'info') })}
                  />
                  <IconButton icon={Pencil} label={`Edit budget ${b.scopeLabel}`} onClick={() => setEditing(b)} />
                  <IconButton icon={Trash2} label={`Delete budget ${b.scopeLabel}`} onClick={() => setRemoving(b)} />
                </div>
              </div>
              <Meter ratio={b.usedRatio} warning={b.warningThreshold} critical={b.criticalThreshold} />
              <div className="flex flex-wrap justify-between gap-2 text-small text-fg-secondary">
                <span className="tabular">
                  {formatUsd(b.spentNanos)} of {formatUsd(b.amountNanos)} spent ({formatRatio(b.usedRatio)}) · {formatUsd(b.remainingNanos)} left
                </span>
                {b.unknownCostEvents ? <span>{b.unknownCostEvents} attempt(s) with unknown cost not counted</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing ? <BudgetDialog key={editing === 'new' ? 'new' : editing.id} budget={editing === 'new' ? null : editing} open onOpenChange={(open) => !open && setEditing(null)} /> : null}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Delete this budget?"
        description={removing ? `${removing.scopeLabel} (${BUDGET_PERIOD_LABEL[removing.period]}). Usage history is not affected.` : ''}
        confirmLabel="Delete budget"
        destructive
        busy={deleteBudget.isPending}
        onConfirm={() => {
          if (!removing) return;
          deleteBudget.mutate(removing.id, {
            onSuccess: () => {
              toast('Budget deleted', 'success');
              setRemoving(null);
            },
            onError: (e) => toast(errorMessage(e), 'info'),
          });
        }}
      />
    </div>
  );
}
