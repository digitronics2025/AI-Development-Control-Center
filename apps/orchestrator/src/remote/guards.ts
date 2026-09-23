import { POLICY_MODES, type PolicyMode, type Repository, type Settings } from '@acc/shared';

/**
 * Remote-only restrictions (docs/systems/remote-node.md §Local enforcement).
 * A cloud command may do what the dashboard does, except loosen this
 * machine's own safety settings: those change only from the machine itself.
 * Tightening is always allowed. Everything else is enforced by the local
 * route, the TaskEngine, the approval gate and the command classifier, as
 * for any local request.
 */
export interface GuardContext {
  settings: Settings;
  repository: (id: string) => Pick<Repository, 'runtime' | 'autoApproveUpToLevel' | 'policyMode'> | null;
}

export type GuardResult = { ok: true } | { ok: false; message: string };

const allow: GuardResult = { ok: true };
const deny = (message: string): GuardResult => ({ ok: false, message });

function policyRank(mode: PolicyMode | null | undefined): number {
  return mode ? POLICY_MODES.indexOf(mode) : -1;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function guardRemoteCommand(op: string, params: Record<string, string>, body: unknown, ctx: GuardContext): GuardResult {
  const b = obj(body);
  const { settings } = ctx;
  switch (op) {
    case 'settings.update': {
      if ('billingMode' in b && b.billingMode !== settings.billingMode) return deny('Billing mode can only be changed on this machine (subscription-only guard).');
      if (typeof b.autoApproveUpToLevel === 'number' && b.autoApproveUpToLevel > settings.autoApproveUpToLevel) return deny('Raising the auto-approve level can only be done on this machine.');
      const execution = obj(b.execution);
      if (typeof execution.policyMode === 'string' && policyRank(execution.policyMode as PolicyMode) > policyRank(settings.execution.policyMode)) {
        return deny('A more permissive execution policy can only be chosen on this machine.');
      }
      return allow;
    }
    case 'repository.update': {
      const repo = ctx.repository(params.id ?? '');
      if (!repo) return allow; // the route answers NOT_FOUND
      if ('commands' in b) return deny("A repository's commands can only be changed on this machine.");
      const runtime = obj(b.runtime);
      if ('devCommand' in runtime && runtime.devCommand !== repo.runtime.devCommand) return deny("A repository's dev command can only be changed on this machine.");
      const currentLevel = repo.autoApproveUpToLevel ?? settings.autoApproveUpToLevel;
      if (typeof b.autoApproveUpToLevel === 'number' && b.autoApproveUpToLevel > currentLevel) return deny('Raising the auto-approve level can only be done on this machine.');
      const currentPolicy = repo.policyMode ?? settings.execution.policyMode;
      if (typeof b.policyMode === 'string' && policyRank(b.policyMode as PolicyMode) > policyRank(currentPolicy)) return deny('A more permissive execution policy can only be chosen on this machine.');
      return allow;
    }
    case 'task.create': {
      const repo = typeof b.repositoryId === 'string' ? ctx.repository(b.repositoryId) : null;
      const ceilingLevel = repo?.autoApproveUpToLevel ?? settings.autoApproveUpToLevel;
      if (typeof b.autoApproveUpToLevel === 'number' && b.autoApproveUpToLevel > ceilingLevel) return deny('A remote task cannot auto-approve more than this machine allows.');
      const ceilingPolicy = repo?.policyMode ?? settings.execution.policyMode;
      if (typeof b.policyMode === 'string' && policyRank(b.policyMode as PolicyMode) > policyRank(ceilingPolicy)) return deny('A remote task cannot use a more permissive policy than this machine allows.');
      if (Array.isArray(b.attachments) && b.attachments.length) return deny('Attach files from this machine; remote tasks carry text only.');
      return allow;
    }
    default:
      return allow;
  }
}
