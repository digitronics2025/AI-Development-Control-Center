import type { ChairmanActionInput, ChairmanDiagnosis, ChairmanDiagnosisConfidence, ChairmanHealth, ChairmanStrategyKind, FailureCategory, StageDefinition, TaskLimits, WorkflowProfile } from '@acc/shared';
import { hashOf, type FailureSource } from './signatures.js';

/**
 * Deterministic recovery policy (plan §3.10, §5). Pure functions: the
 * supervisor feeds them facts from the database and executes what they
 * return through the Action Gateway. The reasoning model may only choose
 * among the candidates produced here.
 */

export type RecoveryTrigger =
  | 'strategy_exhausted'
  | 'repeated_failure'
  | 'regression'
  | 'verify_repeat'
  | 'plan_mismatch'
  | 'no_fail_route'
  | 'worker_failure'
  | 'provider_blocked'
  | 'completion_gate';

export const TRIGGER_LABEL: Record<RecoveryTrigger, string> = {
  strategy_exhausted: 'local fix attempts exhausted',
  repeated_failure: 'the same failure keeps repeating',
  regression: 'the last change made things worse',
  verify_repeat: 'verification rejected the same behaviour again',
  plan_mismatch: 'the work does not match the request',
  no_fail_route: 'the stage failed and the workflow has no repair route',
  worker_failure: 'the agent kept failing to run',
  provider_blocked: 'the agent is unavailable',
  completion_gate: 'completion checks are not satisfied',
};

export type FailureDecision = { kind: 'local_fix' } | { kind: 'escalate'; trigger: RecoveryTrigger };

export interface FailureFacts {
  source: FailureSource;
  health: ChairmanHealth;
  hasOnFail: boolean;
  fixCycles: number;
  maxFixCycles: number;
  /** Verifier/reviewer text says the work misses the request (first rejection only). */
  pointsAtPlan: boolean;
  /** How many times this exact signature was seen in the current strategy. */
  repeats: number;
}

/** Keep the local fix loop while it is working; escalate as soon as it clearly is not. */
export function decideOnFailure(f: FailureFacts): FailureDecision {
  if (!f.hasOnFail) return { kind: 'escalate', trigger: 'no_fail_route' };
  if (f.health === 'REGRESSING') return { kind: 'escalate', trigger: 'regression' };
  if (f.health === 'STALLED') return { kind: 'escalate', trigger: f.source === 'verify' || f.source === 'review' ? 'verify_repeat' : 'repeated_failure' };
  if (f.source === 'verify' && f.pointsAtPlan && f.repeats <= 1) return { kind: 'escalate', trigger: 'plan_mismatch' };
  if (f.fixCycles >= f.maxFixCycles) return { kind: 'escalate', trigger: 'strategy_exhausted' };
  return { kind: 'local_fix' };
}

export type StrategyKind = ChairmanStrategyKind;

export interface StrategyCandidate {
  id: string;
  kind: StrategyKind;
  /** Plan §3.10 intervention level. */
  level: number;
  label: string;
  description: string;
  actions: ChairmanActionInput[];
  fingerprint: string;
  /** Stage the strategy acts on, and the agent it hands that stage to (change_agent only). */
  targetStageKey: string | null;
  targetAgentId: string | null;
}

export interface CandidateContext {
  trigger: RecoveryTrigger;
  workflow: WorkflowProfile;
  /** Stage whose failure triggered recovery. */
  failingStageKey: string;
  /** Signature hash of the failure being recovered from. */
  signatureHash: string;
  failureMessage: string;
  /** Agent currently assigned to each agent stage. */
  assignments: Record<string, string>;
  /** Enabled, healthy agents that may take over. */
  availableAgents: string[];
  /** Agents that already ran each stage in this task: handing a stage back to one of them is not a new strategy. */
  triedAgents?: Record<string, string[]>;
  triedFingerprints: ReadonlySet<string>;
  /** Checkpoint taken before the change that made things worse, if one exists. */
  rollbackCheckpointId: string | null;
}

const byRole = (wf: WorkflowProfile, role: StageDefinition['role']) => wf.stages.find((s) => s.role === role && s.kind === 'agent') ?? null;

/** Where repairs happen: the failing stage's onFail target, else the workflow's fixer, else its implementer. */
export function repairStage(wf: WorkflowProfile, failingStageKey: string): StageDefinition | null {
  const failing = wf.stages.find((s) => s.key === failingStageKey);
  const target = failing?.onFail ? wf.stages.find((s) => s.key === failing.onFail) : null;
  return target ?? byRole(wf, 'fixer') ?? byRole(wf, 'implementer');
}

const ORDER: Record<RecoveryTrigger, StrategyKind[]> = {
  regression: ['rollback', 'change_agent', 'replan', 'rca'],
  repeated_failure: ['rca', 'replan', 'change_agent', 'rollback'],
  strategy_exhausted: ['rca', 'replan', 'change_agent', 'rollback'],
  no_fail_route: ['rca', 'replan', 'change_agent'],
  verify_repeat: ['rca', 'replan', 'change_agent'],
  plan_mismatch: ['replan', 'rca'],
  worker_failure: ['change_agent', 'retry_stage'],
  provider_blocked: ['change_agent'],
  completion_gate: [],
};

/**
 * Materially different next strategies, smallest intervention first,
 * excluding any already tried against this failure (loop prevention §5.3).
 */
export function recoveryCandidates(ctx: CandidateContext): StrategyCandidate[] {
  const wf = ctx.workflow;
  const repair = repairStage(wf, ctx.failingStageKey);
  const failing = wf.stages.find((s) => s.key === ctx.failingStageKey) ?? null;
  const out: StrategyCandidate[] = [];
  const add = (kind: StrategyKind, level: number, target: string, agent: string, label: string, description: string, actions: ChairmanActionInput[]) => {
    const fingerprint = hashOf(`${ctx.signatureHash}|${kind}|${target}|${agent}`);
    if (ctx.triedFingerprints.has(fingerprint)) return;
    out.push({ id: `${kind}:${target}${agent ? `:${agent}` : ''}`, kind, level, label, description, actions, fingerprint, targetStageKey: target, targetAgentId: kind === 'change_agent' ? agent : null });
  };
  const failure = ctx.failureMessage.length > 300 ? `${ctx.failureMessage.slice(0, 299)}…` : ctx.failureMessage;

  for (const kind of ORDER[ctx.trigger]) {
    switch (kind) {
      case 'rca': {
        const stage = byRole(wf, 'investigator');
        if (!stage) break;
        add('rca', 3, stage.key, '', `Root-cause analysis in ${stage.name}`, 'Stop patching symptoms: re-investigate why the failure happens, then plan and implement from that finding.', [
          { type: 'RETURN_TO_STAGE', params: { stageKey: stage.key, guidance: `Root-cause analysis requested by the Chairman. The failure "${failure}" survived the previous repair strategy. Find the underlying cause before any further code change, and say explicitly what the previous attempts got wrong.` } },
        ]);
        break;
      }
      case 'replan': {
        const stage = byRole(wf, 'planner');
        if (!stage) break;
        add('replan', 4, stage.key, '', `Re-plan in ${stage.name}`, 'The current plan does not lead to a passing result; produce a different plan that addresses the failure.', [
          { type: 'REPLAN', params: { guidance: `The Chairman asked for a new plan. The previous plan led to "${failure}". Produce a materially different approach and state how it avoids that failure.` } },
        ]);
        break;
      }
      case 'change_agent': {
        const stage = ctx.trigger === 'worker_failure' || ctx.trigger === 'provider_blocked' ? failing : repair;
        if (!stage || stage.kind !== 'agent') break;
        const current = ctx.assignments[stage.key];
        const alternative = ctx.availableAgents.find((a) => a !== current && !(ctx.triedAgents?.[stage.key] ?? []).includes(a));
        if (!alternative) break;
        add('change_agent', 5, stage.key, alternative, `Hand ${stage.name} to ${alternative}`, `${current ?? 'The current agent'} has not been able to resolve this; a different agent gets the full context and the failure history.`, [
          { type: 'CHANGE_AGENT', params: { stageKey: stage.key, agentId: alternative } },
          { type: 'RETURN_TO_STAGE', params: { stageKey: stage.key, guidance: `You are taking over ${stage.name} from another agent that could not resolve: "${failure}". Read the history and take a different approach.` } },
        ]);
        break;
      }
      case 'rollback': {
        if (!ctx.rollbackCheckpointId || !repair) break;
        add('rollback', 6, repair.key, '', 'Roll back the last change', 'The last change increased failures; restore the checkpoint taken before it and repair from there.', [
          { type: 'ROLLBACK_CHECKPOINT', params: { checkpointId: ctx.rollbackCheckpointId } },
          { type: 'RETURN_TO_STAGE', params: { stageKey: repair.key, guidance: `The previous change made things worse and was rolled back by the Chairman. Do not repeat it. Original failure: "${failure}".` } },
        ]);
        break;
      }
      case 'retry_stage': {
        if (!failing) break;
        add('retry_stage', 1, failing.key, ctx.assignments[failing.key] ?? '', `Retry ${failing.name}`, 'The failure looks transient; run the stage once more.', [
          { type: 'RETRY_STAGE', params: { stageKey: failing.key } },
        ]);
        break;
      }
    }
  }
  return out.sort((a, b) => ORDER[ctx.trigger].indexOf(a.kind) - ORDER[ctx.trigger].indexOf(b.kind));
}

const CATEGORY_TEXT: Record<FailureCategory, string> = {
  CODE_OR_TEST: 'The code or its tests are wrong',
  REQUIREMENT_OR_PLAN: 'The work does not match the request',
  WORKER_OR_TOOL: 'The agent process failed, not the code',
  ENVIRONMENT: 'A command or permission in the environment failed',
  AUTH_OR_EXTERNAL: "The agent's provider is unavailable",
  WORKFLOW_STATE: "The task does not yet meet the workflow's checks",
  UNKNOWN: 'The cause is not clear from the evidence',
};

export interface DiagnosisFacts {
  category: FailureCategory;
  source: FailureSource;
  trigger: RecoveryTrigger;
  message: string;
  failureCount: number | null;
}

/**
 * The rules' diagnosis (plan §3.5): the category is the failure signature's;
 * confidence reflects how objective the evidence is. The model may reword the
 * summary and state its own confidence, never change the category.
 */
export function policyDiagnosis(f: DiagnosisFacts): ChairmanDiagnosis {
  let confidence: ChairmanDiagnosisConfidence;
  if (f.category === 'UNKNOWN') confidence = 'LOW';
  else if (f.source === 'gate' || f.category === 'AUTH_OR_EXTERNAL' || (f.source === 'tests' && f.failureCount !== null)) confidence = 'HIGH';
  else confidence = 'MEDIUM';
  const first = f.message.split('\n')[0]!.trim();
  const detail = first.length > 160 ? `${first.slice(0, 159)}…` : first;
  const what = f.source === 'tests' && f.failureCount !== null ? `${f.failureCount} failing test${f.failureCount === 1 ? '' : 's'}` : detail;
  return { category: f.category, confidence, summary: `${CATEGORY_TEXT[f.category]}: ${what || 'no detail recorded'} — ${TRIGGER_LABEL[f.trigger]}.`, source: 'policy' };
}

export interface RankingFacts {
  trigger: RecoveryTrigger;
  /**
   * Strategy families (kind + target stage) that ended FAILED or REGRESSED
   * against this failure category under the current contract version.
   * INCONCLUSIVE and SUPERSEDED outcomes are never listed: they say nothing
   * about the strategy.
   */
  failedFamilies: Array<{ kind: string; targetStageKey: string | null }>;
  /** Confidence of the rules' diagnosis. */
  confidence: ChairmanDiagnosisConfidence;
}

/** The safety preference that outcome history never overrides (§3.11). */
const PREFERRED_FIRST: Partial<Record<RecoveryTrigger, StrategyKind>> = {
  regression: 'rollback',
  plan_mismatch: 'replan',
  provider_blocked: 'change_agent',
};

/**
 * Outcome-aware ordering (plan §3.11), applied after `recoveryCandidates`:
 * a family that already made no progress (or made things worse) moves
 * behind every other safe candidate — never out of the list, so ranking can
 * reorder but never hard-block. A low-confidence diagnosis puts
 * investigation before heavier interventions. Rollback on regression,
 * re-plan on a plan mismatch and rerouting a blocked provider stay first.
 */
export function rankCandidates(candidates: StrategyCandidate[], facts: RankingFacts): StrategyCandidate[] {
  const preferred = PREFERRED_FIRST[facts.trigger];
  const failed = (c: StrategyCandidate) => c.kind !== preferred && facts.failedFamilies.some((f) => f.kind === c.kind && f.targetStageKey === c.targetStageKey);
  const ordered = [...candidates.filter((c) => !failed(c)), ...candidates.filter(failed)];
  if (facts.confidence === 'LOW' && !preferred) {
    const investigate = ordered.find((c) => c.kind === 'rca' && !failed(c));
    if (investigate) return [investigate, ...ordered.filter((c) => c !== investigate)];
  }
  return ordered;
}

export interface UsageFacts {
  recoveryCycle: number;
  agentRuns: number;
  workMs: number;
}

/** Hard limits (§5.4). Returns the exact reason when one is reached. */
export function limitReached(limits: TaskLimits | null, usage: UsageFacts, opts: { startingRecovery?: boolean } = {}): string | null {
  if (!limits) return null;
  if (opts.startingRecovery && usage.recoveryCycle >= limits.maxRecoveryCycles) {
    return `Recovery cycle limit reached (${limits.maxRecoveryCycles}). Every strategy so far failed; resuming allows one more cycle.`;
  }
  if (usage.workMs >= limits.maxRuntimeMinutes * 60_000) {
    return `Runtime limit reached: agents and commands have worked ${Math.round(usage.workMs / 60_000)} of ${limits.maxRuntimeMinutes} minutes allowed for this task.`;
  }
  if (usage.agentRuns >= limits.maxAgentRuns) {
    return `Agent run limit reached (${usage.agentRuns} of ${limits.maxAgentRuns}).`;
  }
  return null;
}

/** What resuming a limit-blocked task grants. */
export function extendLimits(limits: TaskLimits, usage: UsageFacts): TaskLimits {
  return {
    maxRecoveryCycles: Math.max(limits.maxRecoveryCycles, usage.recoveryCycle + 1),
    maxRuntimeMinutes: Math.max(limits.maxRuntimeMinutes, Math.ceil(usage.workMs / 60_000) + 60),
    maxAgentRuns: Math.max(limits.maxAgentRuns, usage.agentRuns + 10),
  };
}
