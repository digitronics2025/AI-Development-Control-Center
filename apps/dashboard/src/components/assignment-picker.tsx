import { useId } from 'react';
import { Select, cn } from '@acc/ui';
import type { AgentInfo, PartialAssignment } from '@acc/shared';
import { useAgents } from '../api/hooks';

const INHERIT = '__inherit__';

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Agent, model and effort are chosen separately (PLAN §8) so a new model
 * never needs a workflow change. `inheritLabel` adds a "use default" choice
 * for override layers.
 */
export function AssignmentPicker({
  value,
  onChange,
  inheritLabel,
  label,
  disabled,
  className,
}: {
  value: PartialAssignment;
  onChange: (value: PartialAssignment) => void;
  /** e.g. "Default (Codex)". Omit when a concrete agent is required. */
  inheritLabel?: string;
  /** Accessible name prefix, e.g. "Implementer". */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const agents = useAgents();
  const id = useId();
  const list: AgentInfo[] = agents.data ?? [];
  const agent = list.find((a) => a.id === value.agentId);
  const models = agent?.models ?? [];
  const model = models.find((m) => m.modelId === value.model);
  const efforts = model?.efforts ?? models[0]?.efforts ?? ['low', 'medium', 'high'];

  const agentOptions = [
    ...(inheritLabel ? [{ value: INHERIT, label: inheritLabel }] : []),
    ...list.map((a) => ({ value: a.id, label: a.name, description: a.health.state === 'connected' ? undefined : a.health.message })),
  ];

  return (
    <div className={cn('grid gap-2 sm:grid-cols-3', className)} role="group" aria-label={`${label} assignment`}>
      <Select
        id={`${id}-agent`}
        aria-label={`${label} agent`}
        value={value.agentId ?? (inheritLabel ? INHERIT : undefined)}
        disabled={disabled}
        onValueChange={(v) => onChange(v === INHERIT ? {} : { agentId: v, model: 'default', effort: value.effort ?? 'default' })}
        options={agentOptions}
        placeholder="Agent"
      />
      <Select
        aria-label={`${label} model`}
        value={value.agentId ? (value.model ?? 'default') : undefined}
        disabled={disabled || !value.agentId}
        onValueChange={(v) => onChange({ ...value, model: v })}
        placeholder="Model"
        options={[{ value: 'default', label: 'CLI default' }, ...models.map((m) => ({ value: m.modelId, label: m.label, description: m.description ?? undefined }))]}
      />
      <Select
        aria-label={`${label} effort`}
        value={value.agentId ? (value.effort ?? 'default') : undefined}
        disabled={disabled || !value.agentId}
        onValueChange={(v) => onChange({ ...value, effort: v })}
        placeholder="Effort"
        options={[{ value: 'default', label: 'Default effort' }, ...efforts.map((e) => ({ value: e, label: titleCase(e) }))]}
      />
    </div>
  );
}
