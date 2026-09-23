import { COMPLETE, type Role } from './constants.js';
import {
  workflowProfileSchema,
  type PartialAssignment,
  type RoleAssignments,
  type StageDefinition,
  type TaskOverrides,
  type WorkflowProfile,
} from './schemas.js';
import type { ResolvedAssignment } from './types.js';

export interface WorkflowIssue {
  /** Stage index the issue belongs to, or null for profile-level issues. */
  stageIndex: number | null;
  field: string;
  message: string;
}

/**
 * Semantic validation beyond the Zod shape: transitions must resolve, keys
 * must be unique, every stage must be reachable, and the `next` edges alone
 * must form a DAG. Loops are only legal through `onFail`, which the engine
 * bounds with `maxFixCycles` — so a saved workflow can never spin forever.
 */
export function validateWorkflow(input: unknown): { profile: WorkflowProfile | null; issues: WorkflowIssue[] } {
  const parsed = workflowProfileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      profile: null,
      issues: parsed.error.issues.map((issue) => {
        const [first, index, ...rest] = issue.path;
        const stageIndex = first === 'stages' && typeof index === 'number' ? index : null;
        const field = (stageIndex === null ? issue.path : rest).map(String).join('.') || 'profile';
        return { stageIndex, field, message: issue.message };
      }),
    };
  }
  const profile = parsed.data;
  const issues: WorkflowIssue[] = [];
  const keys = new Map<string, number>();

  profile.stages.forEach((stage, index) => {
    if (keys.has(stage.key)) {
      issues.push({ stageIndex: index, field: 'key', message: `Stage key "${stage.key}" is used twice` });
    }
    keys.set(stage.key, index);
  });

  profile.stages.forEach((stage, index) => {
    for (const field of ['next', 'onFail'] as const) {
      const target = stage[field];
      if (target === undefined) continue;
      if (target !== COMPLETE && !keys.has(target)) {
        issues.push({ stageIndex: index, field, message: `"${target}" is not a stage in this workflow` });
      }
      if (target === stage.key) {
        issues.push({ stageIndex: index, field, message: 'A stage cannot transition to itself' });
      }
    }
    if (stage.kind === 'agent' && stage.commandKinds?.length) {
      issues.push({ stageIndex: index, field: 'commandKinds', message: 'Agent stages do not run repository commands' });
    }
    if ((stage.kind === 'tests' || stage.kind === 'command' || stage.kind === 'git') && stage.agentId) {
      issues.push({ stageIndex: index, field: 'agentId', message: 'System stages are not assigned to an agent' });
    }
    if (stage.kind === 'command' && !stage.commandKinds?.length) {
      issues.push({ stageIndex: index, field: 'commandKinds', message: 'Command stages must name the command kinds they run' });
    }
    if (stage.kind === 'git' && stage.permissionLevel < 3) {
      issues.push({ stageIndex: index, field: 'permissionLevel', message: 'Git stages need permission level 3 (Git)' });
    }
    if (stage.verdict && stage.kind !== 'agent') {
      issues.push({ stageIndex: index, field: 'verdict', message: 'Only agent stages can return a verdict' });
    }
    if (stage.onFail && !stage.verdict && stage.kind !== 'tests' && stage.kind !== 'git') {
      issues.push({
        stageIndex: index,
        field: 'onFail',
        message: 'A failure transition needs a verdict, tests or Git stage',
      });
    }
  });

  if (issues.length > 0) return { profile: null, issues };

  // The `next` graph must be acyclic.
  const state = new Map<string, 'visiting' | 'done'>();
  const byKey = new Map(profile.stages.map((s) => [s.key, s]));
  const visit = (key: string): boolean => {
    if (key === COMPLETE) return true;
    const mark = state.get(key);
    if (mark === 'done') return true;
    if (mark === 'visiting') return false;
    state.set(key, 'visiting');
    const ok = visit(byKey.get(key)!.next);
    state.set(key, 'done');
    return ok;
  };
  profile.stages.forEach((stage, index) => {
    if (!visit(stage.key)) {
      issues.push({
        stageIndex: index,
        field: 'next',
        message: 'This creates a loop without a failure transition; loops must go through "on fail"',
      });
    }
  });

  // Every stage must be reachable from the first, and the first must reach `complete`.
  const reachable = new Set<string>();
  const queue = [profile.stages[0]!.key];
  let reachesComplete = false;
  while (queue.length) {
    const key = queue.shift()!;
    if (key === COMPLETE) {
      reachesComplete = true;
      continue;
    }
    if (reachable.has(key)) continue;
    reachable.add(key);
    const stage = byKey.get(key)!;
    queue.push(stage.next);
    if (stage.onFail) queue.push(stage.onFail);
  }
  profile.stages.forEach((stage, index) => {
    if (!reachable.has(stage.key)) {
      issues.push({ stageIndex: index, field: 'key', message: 'No transition leads to this stage' });
    }
  });
  if (!reachesComplete) {
    issues.push({ stageIndex: null, field: 'stages', message: 'The workflow never reaches "complete"' });
  }

  return issues.length ? { profile: null, issues } : { profile, issues: [] };
}

/** Stages on the `next` chain from the first stage — the path a passing task takes. */
export function workflowHappyPath(profile: WorkflowProfile): StageDefinition[] {
  const byKey = new Map(profile.stages.map((s) => [s.key, s]));
  const path: StageDefinition[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = profile.stages[0]?.key;
  while (cursor && cursor !== COMPLETE && !seen.has(cursor)) {
    const stage = byKey.get(cursor);
    if (!stage) break;
    seen.add(cursor);
    path.push(stage);
    cursor = stage.next;
  }
  return path;
}

/**
 * Ordered "happy path" through a workflow: follow `next` from the first stage.
 * Used for timelines and progress rails; fix stages reachable only via
 * `onFail` are appended in declaration order so they remain visible.
 */
export function workflowPath(profile: WorkflowProfile): StageDefinition[] {
  const byKey = new Map(profile.stages.map((s) => [s.key, s]));
  const path: StageDefinition[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = profile.stages[0]?.key;
  while (cursor && cursor !== COMPLETE && !seen.has(cursor)) {
    const stage = byKey.get(cursor);
    if (!stage) break;
    seen.add(cursor);
    path.push(stage);
    cursor = stage.next;
  }
  const offPath = profile.stages.filter((s) => !seen.has(s.key));
  return [...path, ...offPath];
}

export interface AssignmentLayers {
  roleDefaults: RoleAssignments;
  repositoryOverrides?: RoleAssignments;
  taskOverrides?: TaskOverrides;
}

const FALLBACK: ResolvedAssignment = { agentId: 'claude', model: 'default', effort: 'default' };

function apply(base: ResolvedAssignment, layer: PartialAssignment | undefined): ResolvedAssignment {
  if (!layer) return base;
  // A different agent invalidates the previous layer's model/effort unless the layer sets its own.
  const agentChanged = layer.agentId !== undefined && layer.agentId !== base.agentId;
  return {
    agentId: layer.agentId ?? base.agentId,
    model: layer.model ?? (agentChanged ? 'default' : base.model),
    effort: layer.effort ?? (agentChanged ? 'default' : base.effort),
  };
}

/**
 * Configuration precedence (PLAN §7): global role default → workflow stage
 * pin → repository role override → task role override → task stage override.
 */
export function resolveAssignment(stage: StageDefinition, layers: AssignmentLayers): ResolvedAssignment {
  const role: Role = stage.role;
  let resolved = apply(FALLBACK, layers.roleDefaults[role]);
  resolved = apply(resolved, { agentId: stage.agentId, model: stage.model, effort: stage.effort });
  resolved = apply(resolved, layers.repositoryOverrides?.[role]);
  resolved = apply(resolved, layers.taskOverrides?.roles?.[role]);
  resolved = apply(resolved, layers.taskOverrides?.stages?.[stage.key]);
  return resolved;
}

/**
 * A workflow whose every stage is Level 1 (Analyze) never changes the
 * repository, so it neither waits for nor blocks the one task per
 * repository that may edit files (e.g. the built-in Staged Review).
 */
export function isReadOnlyWorkflow(profile: WorkflowProfile): boolean {
  return profile.stages.every((stage) => stage.permissionLevel === 1 && stage.kind === 'agent');
}
