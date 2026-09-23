import type { PermissionLevel } from '@acc/shared';
import type { ToolRisk } from './sdk.js';

/**
 * Autopilot policy (V2 plan §33–34). One pure function decides every tool
 * call, so the rules are testable and identical for agents, the engine and
 * the dashboard.
 */

export const POLICY_MODES = ['safe', 'autopilot', 'full'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const POLICY_MODE_LABEL: Record<PolicyMode, string> = {
  safe: 'Safe',
  autopilot: 'Autopilot',
  full: 'Full Autopilot+',
};

export const POLICY_MODE_DESCRIPTION: Record<PolicyMode, string> = {
  safe: 'Reads, analysis, local tests and low-risk edits run on their own; anything above Level 2 asks first.',
  autopilot: 'Investigates, edits, installs project dependencies, tests, repairs and commits on its own up to the auto-approve level.',
  full: 'Also runs pre-authorised infrastructure work (Level 4). Production and destructive actions still ask.',
};

/** Who is asking. Agents cannot wait for an approval mid-run; everyone else can. */
export type CallOrigin = 'agent' | 'engine' | 'operator' | 'chairman';

export type PolicyDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'escalate'; reason: string }
  | { decision: 'approval'; reason: string; typedConfirmation: boolean }
  | { decision: 'deny'; reason: string };

export interface PolicyInput {
  risk: ToolRisk;
  mode: PolicyMode;
  /** The task's auto-approve level (V1 setting). */
  autoApproveUpToLevel: PermissionLevel;
  /** The stage's own permission level; operator sessions pass the ceiling. */
  stageLevel: PermissionLevel;
  /** The capability is in the stage's profile. */
  inProfile: boolean;
  origin: CallOrigin;
}

/** The highest level that runs without asking, for a mode and auto-approve level. */
export function policyCeiling(mode: PolicyMode, autoApproveUpToLevel: PermissionLevel): PermissionLevel {
  if (mode === 'safe') return Math.min(2, autoApproveUpToLevel) as PermissionLevel;
  if (mode === 'full') return 4;
  return Math.min(4, autoApproveUpToLevel) as PermissionLevel;
}

export function decide(input: PolicyInput): PolicyDecision {
  const { risk, origin } = input;
  const ceiling = policyCeiling(input.mode, input.autoApproveUpToLevel);
  const why = risk.reasons.length ? risk.reasons.join(', ') : `Level ${risk.level}`;

  // Irreversible or production-facing: a person decides, with a typed confirmation.
  if (risk.risk === 'dangerous' || risk.level >= 5 || risk.production) {
    const reason = `${why}: needs your approval (Level 5${risk.production ? ', production' : ''})`;
    return origin === 'agent'
      ? { decision: 'deny', reason: `${reason}. Agents cannot run this; report it as an operator decision.` }
      : { decision: 'approval', reason, typedConfirmation: true };
  }
  // A stage never exceeds its own level: an Analyze stage does not write.
  if (risk.level > input.stageLevel) {
    return { decision: 'deny', reason: `${why}: needs Level ${risk.level}, and this stage is Level ${input.stageLevel}.` };
  }
  if (risk.level > ceiling) {
    const reason = `${why}: Level ${risk.level} is above what ${POLICY_MODE_LABEL[input.mode]} runs on its own (up to Level ${ceiling})`;
    return origin === 'agent'
      ? { decision: 'deny', reason: `${reason}. Report it as an operator decision, or ask for the task to be run with a higher policy.` }
      : { decision: 'approval', reason, typedConfirmation: false };
  }
  if (!input.inProfile) return { decision: 'escalate', reason: `Enabled outside the stage's profile: ${why} is within Level ${input.stageLevel}` };
  return { decision: 'allow', reason: why };
}
