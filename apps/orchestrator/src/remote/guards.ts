import { NANOS_PER_USD, POLICY_MODES, type Budget, type PolicyMode, type Repository, type Settings, type WorkflowProfile } from '@acc/shared';
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
  repository: (id: string) => Pick<Repository, 'runtime' | 'autoApproveUpToLevel' | 'policyMode' | 'testSelection'> | null;
  workflow: (id: string) => Pick<WorkflowProfile, 'stages'> | null;
  /** The task works in more than one repository (docs/systems/multi-repository-tasks.md). */
  isMultiRepositoryTask?: (taskId: string) => boolean;
  /** An agent's saved settings, for judging a remote change to them. */
  agent?: (id: string) => { loadUserConfig: boolean } | null;
  /** A saved budget, for judging a remote change to a media budget. */
  budget?: (id: string) => Pick<Budget, 'scopeType' | 'amountNanos' | 'policy' | 'enabled'> | null;
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
      // Which Windows account agents run as is the OS boundary around the data folder (SEC-3): neither
      // direction, nor the account's name, is the cloud's to change.
      if (n.agentIsolation.mode !== settings.agentIsolation.mode || n.agentIsolation.account !== settings.agentIsolation.account) {
        return deny('Agent isolation can only be changed on this machine.');
      }
      if (n.autoApproveUpToLevel > settings.autoApproveUpToLevel) return deny('Raising the auto-approve level can only be done on this machine.');
      if (policyRank(n.execution.policyMode) > policyRank(settings.execution.policyMode)) return deny('A more permissive execution policy can only be chosen on this machine.');
      // Discovery roots register every repository under them: adding one is adding repositories by local path.
      if (n.repositoryAutomation.roots.some((root) => !settings.repositoryAutomation.roots.includes(root))) {
        return deny('Folders to discover repositories in can only be added on this machine.');
      }
      if (settings.repositoryAutomation.ignoredPaths.some((path) => !n.repositoryAutomation.ignoredPaths.includes(path))) {
        return deny('Bringing back a removed repository can only be done on this machine.');
      }
      // Where phone alerts go and which token they carry decide where a credential is sent (LEAD_TIME_PLAN §6):
      // chosen here only. Switching them off (all fields cleared) is always allowed.
      const phone = n.notifications.phone;
      const before = settings.notifications.phone;
      const cleared = !phone.url && !phone.credentialName && !phone.recipientEmail;
      if (!cleared && (phone.url !== before.url || phone.credentialName !== before.credentialName || phone.recipientEmail !== before.recipientEmail)) {
        return deny('Where phone alerts are sent, and with which token, can only be changed on this machine.');
      }
      // Switches that widen what runs without asking are turned on here only; off is always allowed (audit F-50).
      const widened: Array<[boolean, string]> = [
        [n.execution.terminals && !settings.execution.terminals, 'Terminals'],
        [n.execution.exposeToolsToAgents && !settings.execution.exposeToolsToAgents, "Giving agents the Control Center's tools"],
        [n.execution.autoRepair && !settings.execution.autoRepair, 'Automatic repairs'],
        [n.learning.autonomy === 'act' && settings.learning.autonomy !== 'act', 'Letting the Chairman adopt improvements on its own'],
      ];
      const first = widened.find(([on]) => on);
      if (first) return deny(`${first[1]} can only be turned on on this machine.`);
      // Money (docs/systems/design-agent.md): paid generation, a larger task budget or a lower price estimate is chosen here only.
      if (n.media.allowPaidGeneration && !settings.media.allowPaidGeneration) return deny('Paid media generation can only be turned on on this machine.');
      if (n.media.taskBudgetUsd > settings.media.taskBudgetUsd) return deny('Raising the media budget per task can only be done on this machine.');
      const cheaper = Object.entries(settings.media.prices).some(([model, price]) => n.media.prices[model] === undefined || n.media.prices[model]! < price);
      if (cheaper || Object.keys(n.media.prices).some((m) => settings.media.prices[m] === undefined)) return deny('Lowering, removing or adding a media price estimate can only be done on this machine.');
      return allow;
    }
    case 'usage.budgetUpdate':
    case 'usage.budgetRemove': {
      // A media budget that stops paid calls is loosened here only: raised, switched to warn only, disabled or removed.
      const budget = ctx.budget?.(params.id ?? '');
      if (!budget || budget.scopeType !== 'MEDIA') return allow;
      if (op === 'usage.budgetRemove') return deny('A media budget can only be removed on this machine.');
      const raised = typeof b.amountUsd === 'number' && Math.round(b.amountUsd * NANOS_PER_USD) > budget.amountNanos;
      const loosened = (b.policy === 'WARN_ONLY' && budget.policy === 'STOP_NEW_RUNS') || (b.enabled === false && budget.enabled);
      if (raised || loosened) return deny('A media budget can only be raised, set to warn only or disabled on this machine.');
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
      // Running only the affected tests narrows a gate, so only this machine may turn it on (AFFECTED_TESTS_PLAN §3.6).
      if (b.testSelection === 'changed' && repo.testSelection !== 'changed') return deny('Running only affected tests can only be turned on on this machine.');
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
      // Loading the operator's own CLI hooks, plugins and skills into agent runs widens what they may do (audit F-50).
      if (b.loadUserConfig === true && ctx.agent?.(params.id ?? '')?.loadUserConfig === false) return deny("Loading your own CLI customisations into an agent can only be turned on on this machine.");
      return allow;
    case 'workflow.save': {
      const current = ctx.workflow(params.id ?? '');
      // Saving an unknown id creates a workflow: without this, a copy of a built-in with its approval
      // steps removed could be created and then chosen for tasks (audit F-20). Duplicate from here instead.
      if (!current) return deny('New workflows are created on this machine. From here, duplicate an existing workflow and edit the copy.');
      const next = Array.isArray(b.stages) ? b.stages.map(obj) : [];
      for (const stage of current.stages) {
        const kept = next.find((n) => n.key === stage.key);
        if (stage.requiresApproval && kept?.requiresApproval !== true) return deny(`Removing the approval step from "${stage.name}" can only be done on this machine.`);
        // A lower level can drop a stage under the auto-approve line, which skips its approval just the same.
        if (kept && typeof kept.permissionLevel === 'number' && kept.permissionLevel < stage.permissionLevel) return deny(`Lowering the permission level of "${stage.name}" can only be done on this machine.`);
        // A verdict is what the completion gate requires a judge to pass: turning it off removes that judge from the gate.
        if (stage.verdict && kept && kept.verdict === false) return deny(`Making "${stage.name}" advisory can only be done on this machine.`);
      }
      // A condition lets a judge be skipped and not required by the completion gate (DESIGNER_ROUTING_PLAN §5): added or
      // changed here only. Removing one (the stage then always runs) is tightening and stays allowed.
      for (const n of next) {
        if (n.when === undefined || n.when === null) continue;
        const before = current.stages.find((s) => s.key === n.key);
        if (before?.when !== n.when) return deny(`Making "${typeof n.name === 'string' ? n.name : String(n.key)}" run only on a condition can only be done on this machine.`);
      }
      return allow;
    }
    case 'task.start': {
      // The cloud leases one repository per task, so a task across repositories starts on this machine only.
      if (params.id && ctx.isMultiRepositoryTask?.(params.id)) return deny('A task across several repositories can only be started on this machine.');
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
