import { POLICY_MODES, type PolicyMode, type Repository, type Settings, type WorkflowProfile } from '@acc/shared';
import { mergeSettings } from '../services/settings.js';

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
  workflow: (id: string) => Pick<WorkflowProfile, 'stages'> | null;
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
      // Judge the settings exactly as they would be saved, not just the fields that were sent.
      let n: Settings;
      try {
        n = mergeSettings(settings, body);
      } catch {
        return allow; // the route answers with the validation error
      }
      if (n.billingMode !== settings.billingMode) return deny('Billing mode can only be changed on this machine (subscription-only guard).');
      if (n.autoApproveUpToLevel > settings.autoApproveUpToLevel) return deny('Raising the auto-approve level can only be done on this machine.');
      if (policyRank(n.execution.policyMode) > policyRank(settings.execution.policyMode)) return deny('A more permissive execution policy can only be chosen on this machine.');
      // Discovery roots register every repository under them: adding one is adding repositories by local path.
      if (n.repositoryAutomation.roots.some((root) => !settings.repositoryAutomation.roots.includes(root))) {
        return deny('Folders to discover repositories in can only be added on this machine.');
      }
      if (settings.repositoryAutomation.ignoredPaths.some((path) => !n.repositoryAutomation.ignoredPaths.includes(path))) {
        return deny('Bringing back a removed repository can only be done on this machine.');
      }
      return allow;
    }
    case 'repository.update': {
      const repo = ctx.repository(params.id ?? '');
      if (!repo) return allow; // the route answers NOT_FOUND
      if ('commands' in b) return deny("A repository's commands can only be changed on this machine.");
      const runtime = obj(b.runtime);
      if ('devCommand' in runtime && runtime.devCommand !== repo.runtime.devCommand) return deny("A repository's dev command can only be changed on this machine.");
      // Effective values: `null` clears the repository's override and falls back to Settings, which may be looser.
      const currentLevel = repo.autoApproveUpToLevel ?? settings.autoApproveUpToLevel;
      if ('autoApproveUpToLevel' in b) {
        const nextLevel = typeof b.autoApproveUpToLevel === 'number' ? b.autoApproveUpToLevel : settings.autoApproveUpToLevel;
        if (nextLevel > currentLevel) return deny('Raising the auto-approve level can only be done on this machine.');
      }
      const currentPolicy = repo.policyMode ?? settings.execution.policyMode;
      if ('policyMode' in b) {
        const nextPolicy = typeof b.policyMode === 'string' ? (b.policyMode as PolicyMode) : settings.execution.policyMode;
        if (policyRank(nextPolicy) > policyRank(currentPolicy)) return deny('A more permissive execution policy can only be chosen on this machine.');
      }
      return allow;
    }
    case 'agent.update':
      // Choosing which program runs as an agent is choosing what executes on this machine.
      if ('executablePath' in b) return deny("An agent's program can only be chosen on this machine.");
      return allow;
    case 'workflow.save': {
      const current = ctx.workflow(params.id ?? '');
      if (!current) return allow;
      const next = Array.isArray(b.stages) ? b.stages.map(obj) : [];
      for (const stage of current.stages) {
        if (!stage.requiresApproval) continue;
        const kept = next.find((n) => n.key === stage.key);
        if (kept?.requiresApproval !== true) return deny(`Removing the approval step from "${stage.name}" can only be done on this machine.`);
      }
      return allow;
    }
    case 'task.create': {
      const repo = typeof b.repositoryId === 'string' ? ctx.repository(b.repositoryId) : null;
      const ceilingLevel = repo?.autoApproveUpToLevel ?? settings.autoApproveUpToLevel;
      if (typeof b.autoApproveUpToLevel === 'number' && b.autoApproveUpToLevel > ceilingLevel) return deny('A remote task cannot auto-approve more than this machine allows.');
      const ceilingPolicy = repo?.policyMode ?? settings.execution.policyMode;
      if (typeof b.policyMode === 'string' && policyRank(b.policyMode as PolicyMode) > policyRank(ceilingPolicy)) return deny('A remote task cannot use a more permissive policy than this machine allows.');
      if (Array.isArray(b.attachments) && b.attachments.length) return deny('Attach files from this machine; remote tasks carry text only.');
      // A task across repositories is created on this machine only (docs/plans/MULTI_REPO_TASKS_PLAN.md): the cloud leases one repository.
      if (Array.isArray(b.linkedRepositoryIds) && b.linkedRepositoryIds.length) return deny('A task across several repositories can only be created on this machine.');
      return allow;
    }
    default:
      return allow;
  }
}
