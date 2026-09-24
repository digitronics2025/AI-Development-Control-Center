import { POLICY_MODE_LABEL, type PermissionLevel, type PolicyMode } from '@acc/shared';
import type { ToolRisk } from './sdk.js';

/**
 * Autopilot policy (V2 plan §33–34). One pure function decides every tool
 * call, so the rules are testable and identical for agents, the engine and
 * the dashboard.
 */

export { POLICY_MODES, POLICY_MODE_LABEL, POLICY_MODE_DESCRIPTION, type PolicyMode } from '@acc/shared';

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
  /**
   * A read-only session (docs/systems/ask.md): only capabilities on its
   * allow-list, and only calls that cannot change anything. Levels are
   * recorded but not compared: the level scale mixes "remote" with "writes",
   * and a production read is still a read.
   */
  readOnly?: { allowed: boolean };
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

  // Fails closed: not on the list, not declared a read, or dangerous is refused, never escalated.
  if (input.readOnly) {
    if (!input.readOnly.allowed) return { decision: 'deny', reason: 'Not available in a read-only conversation.' };
    if (risk.writes !== false) return { decision: 'deny', reason: `${why}: this could change something, and this conversation is read-only.` };
    if (risk.risk === 'dangerous') return { decision: 'deny', reason: `${why}: refused in a read-only conversation.` };
    return { decision: 'allow', reason: `Read-only: ${why}` };
  }

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
