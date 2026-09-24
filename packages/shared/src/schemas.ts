import { z } from 'zod';
import { executionSettingsSchema, POLICY_MODES, repositoryRuntimeSchema } from './tools.js';
import { learningSettingsSchema } from './learning.js';
import {
  BILLING_MODES,
  COMMAND_KINDS,
  DEFAULT_AUTO_APPROVE_LEVEL,
  DEFAULT_MAX_FIX_CYCLES,
  ROLES,
  STAGE_KINDS,
  TASK_MODES,
  THEMES,
} from './constants.js';

/** Identifiers that end up in file names, branch names and CLI arguments. */
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes');

/**
 * Model and effort values are passed to provider CLIs as separate argv
 * entries, never through a shell — but they are still restricted to a safe
 * character set so a stored value can never smuggle an extra flag.
 */
export const modelIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/\-[\]]*$/, 'Model IDs may contain letters, digits and . _ : / - [ ]');
export const effortSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[a-z]+$/, 'Effort is a lowercase word such as low, medium or high');
export const agentIdSchema = slugSchema;

export const roleSchema = z.enum(ROLES);
export const permissionLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

/** Agent + model + effort, kept separate so new models need no workflow change. */
export const assignmentSchema = z.object({
  agentId: agentIdSchema,
  model: modelIdSchema.default('default'),
  effort: effortSchema.default('default'),
});
export type Assignment = z.infer<typeof assignmentSchema>;

export const partialAssignmentSchema = z.object({
  agentId: agentIdSchema.optional(),
  model: modelIdSchema.optional(),
  effort: effortSchema.optional(),
});
export type PartialAssignment = z.infer<typeof partialAssignmentSchema>;

export const roleAssignmentsSchema = z.partialRecord(roleSchema, partialAssignmentSchema);
export type RoleAssignments = z.infer<typeof roleAssignmentsSchema>;

export const stageDefinitionSchema = z.object({
  key: slugSchema,
  name: z.string().min(1).max(60),
  role: roleSchema,
  kind: z.enum(STAGE_KINDS).default('agent'),
  /** Optional pin; when absent the stage uses the resolved role assignment. */
  agentId: agentIdSchema.optional(),
  model: modelIdSchema.optional(),
  effort: effortSchema.optional(),
  permissionLevel: permissionLevelSchema.default(1),
  timeoutSec: z.number().int().min(10).max(24 * 3600).default(1800),
  retry: z
    .object({ maxAttempts: z.number().int().min(1).max(5).default(1) })
    .default({ maxAttempts: 1 }),
  requiresApproval: z.boolean().default(false),
  /** Next stage key, or `complete`. */
  next: z.string().min(1),
  /** Transition taken when tests fail or a verdict is FAIL. Counts as a fix cycle. */
  onFail: z.string().min(1).optional(),
  /** Stage output must end with `VERDICT: PASS` or `VERDICT: FAIL`. */
  verdict: z.boolean().default(false),
  /** Command kinds a `tests`/`command` stage runs. */
  commandKinds: z.array(z.enum(COMMAND_KINDS)).optional(),
  /** A `command` stage with nothing configured is skipped instead of blocking. */
  optional: z.boolean().default(false),
  description: z.string().max(300).optional(),
});
export type StageDefinition = z.infer<typeof stageDefinitionSchema>;
export type StageDefinitionInput = z.input<typeof stageDefinitionSchema>;

export const workflowProfileSchema = z.object({
  id: slugSchema,
  name: z.string().min(1).max(60),
  description: z.string().max(200).default(''),
  version: z.number().int().min(1).default(1),
  maxFixCycles: z.number().int().min(0).max(10).default(DEFAULT_MAX_FIX_CYCLES),
  builtin: z.boolean().default(false),
  stages: z.array(stageDefinitionSchema).min(1).max(30),
});
export type WorkflowProfile = z.infer<typeof workflowProfileSchema>;
export type WorkflowProfileInput = z.input<typeof workflowProfileSchema>;

export const repositoryCommandSchema = z.object({
  id: slugSchema,
  name: z.string().min(1).max(60),
  command: z.string().min(1).max(1000),
  kind: z.enum(COMMAND_KINDS),
  enabled: z.boolean().default(true),
  timeoutSec: z.number().int().min(5).max(6 * 3600).default(900),
});
export type RepositoryCommand = z.infer<typeof repositoryCommandSchema>;

/** task-branch: a branch in your working tree; current-branch: no branch; worktree: an isolated copy your working tree never sees. */
export const gitModeSchema = z.enum(['task-branch', 'current-branch', 'worktree']);
export type GitMode = z.infer<typeof gitModeSchema>;

export const createRepositorySchema = z.object({
  path: z.string().min(1).max(1000),
  name: z.string().min(1).max(80).optional(),
});

export const updateRepositorySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  defaultWorkflowId: slugSchema.nullable().optional(),
  roleOverrides: roleAssignmentsSchema.optional(),
  commands: z.array(repositoryCommandSchema).max(40).optional(),
  gitMode: gitModeSchema.optional(),
  autoApproveUpToLevel: permissionLevelSchema.nullable().optional(),
  /** Overrides Settings → Execution policy for tasks in this repository. */
  policyMode: z.enum(POLICY_MODES).nullable().optional(),
  runtime: repositoryRuntimeSchema.optional(),
});
export type UpdateRepositoryInput = z.infer<typeof updateRepositorySchema>;

export const taskOverridesSchema = z.object({
  roles: roleAssignmentsSchema.default({}),
  stages: z.record(slugSchema, partialAssignmentSchema).default({}),
});
export type TaskOverrides = z.infer<typeof taskOverridesSchema>;

/** A task works in its repository plus at most this many linked ones (docs/plans/MULTI_REPO_TASKS_PLAN.md). */
export const MAX_LINKED_REPOSITORIES = 7;

export const createTaskSchema = z
  .object({
    title: z.string().max(120).optional(),
    description: z.string().min(1, 'Describe the task').max(20000),
    repositoryId: z.string().min(1, 'Choose a repository'),
    /** Other repositories the task also works in; each gets its own isolated worktree next to the primary's. */
    linkedRepositoryIds: z.array(z.string().min(1)).max(MAX_LINKED_REPOSITORIES, `A task can work in at most ${MAX_LINKED_REPOSITORIES + 1} repositories`).optional(),
    workflowId: slugSchema,
    mode: z.enum(TASK_MODES),
    overrides: taskOverridesSchema.optional(),
    autoApproveUpToLevel: permissionLevelSchema.optional(),
    maxFixCycles: z.number().int().min(0).max(10).optional(),
    attachments: z
      .array(z.object({ name: z.string().min(1).max(200), contentBase64: z.string().max(14_000_000) }))
      .max(10)
      .optional(),
    start: z.boolean().default(true),
    /** Chairman supervision; defaults to on for Autopilot tasks when enabled in Settings. */
    supervised: z.boolean().optional(),
    /** Execution policy for this task; defaults to the repository's, then Settings. */
    policyMode: z.enum(POLICY_MODES).optional(),
    /** Run in an isolated worktree even if the repository uses a task branch. */
    worktree: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    const linked = input.linkedRepositoryIds ?? [];
    if (!linked.length) return;
    if (linked.includes(input.repositoryId)) {
      ctx.addIssue({ code: 'custom', path: ['linkedRepositoryIds'], message: 'The task repository is already included; choose other repositories to also work in' });
    }
    if (new Set(linked).size !== linked.length) {
      ctx.addIssue({ code: 'custom', path: ['linkedRepositoryIds'], message: 'Each repository can be added only once' });
    }
    if (input.worktree === false) {
      ctx.addIssue({ code: 'custom', path: ['worktree'], message: 'A task across several repositories always runs in isolated worktrees' });
    }
  });
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(20000).optional(),
  workflowId: slugSchema.optional(),
  mode: z.enum(TASK_MODES).optional(),
  overrides: taskOverridesSchema.optional(),
});

export const directiveSchema = z.object({
  text: z.string().trim().min(1, 'Directive text is required').max(4000),
  pause: z.boolean().default(false),
});

export const rerouteSchema = z.object({
  stageKey: slugSchema.optional(),
  agentId: agentIdSchema,
  model: modelIdSchema.optional(),
  effort: effortSchema.optional(),
  reason: z.string().max(300).optional(),
  /** Also reassign later stages that share this stage's role. */
  applyToRole: z.boolean().default(false),
  /**
   * Also move every other stage of this task still assigned to the stage's
   * current agent — for a provider that is out of credits or signed out,
   * where each of its stages would stop in turn.
   */
  applyToAgent: z.boolean().default(false),
});

export const assignmentChangeSchema = z.object({
  stageKey: slugSchema,
  agentId: agentIdSchema.optional(),
  model: modelIdSchema.optional(),
  effort: effortSchema.optional(),
});

export const retrySchema = z.object({ stageKey: slugSchema.optional() });

export const approvalDecisionSchema = z.object({
  note: z.string().max(2000).optional(),
  /** Typed confirmation phrase required for level 5 / dangerous approvals. */
  confirmation: z.string().max(200).optional(),
});

/** Per-agent configuration, stored with the agent record rather than in global settings. */
export const agentSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  executablePath: z.string().max(1000).nullable().default(null),
  /** Load the user's own CLI customisations (hooks, skills, plugins). Personal MCP servers are never loaded. */
  loadUserConfig: z.boolean().default(true),
});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;

/** Chairman supervisor defaults (docs/systems/chairman.md). */
export const chairmanSettingsSchema = z.object({
  /** Supervise new Autopilot tasks. Existing tasks keep the mode they were created with. */
  enabled: z.boolean().default(true),
  /** Agent that answers chat and chooses recovery strategies; runs read-only. */
  agentId: agentIdSchema.default('claude'),
  model: modelIdSchema.default('default'),
  effort: effortSchema.default('default'),
  /** Off = deterministic policy only (no model calls). */
  useReasoning: z.boolean().default(true),
  maxRecoveryCycles: z.number().int().min(0).max(20).default(3),
  /** Agent and command time a task may accumulate before it pauses for you. */
  maxTaskRuntimeMinutes: z.number().int().min(10).max(7 * 24 * 60).default(480),
  /** Agent runs a task may use; a proxy for cost, since subscriptions report none. */
  maxAgentRuns: z.number().int().min(5).max(1000).default(60),
  /** A running execution with no output for this long is stopped and recovered. */
  stallMinutes: z.number().int().min(2).max(24 * 60).default(30),
  /** Resume interrupted supervised tasks automatically after a restart. */
  resumeAfterRestart: z.boolean().default(true),
});
export type ChairmanSettings = z.infer<typeof chairmanSettingsSchema>;

/** An absolute local folder path (Windows drive or UNC, or POSIX). */
const absolutePathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((p) => !p.includes('\0'), 'Invalid path')
  .refine((p) => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p), 'Use a full folder path, for example C:\\Users\\you');

/** Repository automation (docs/systems/repository-automation.md). */
export const repositoryAutomationSettingsSchema = z.object({
  /** Register new Git repositories found under `roots`. */
  discover: z.boolean().default(true),
  /** Folders searched for repositories. Empty means the user's home folder. */
  roots: z.array(absolutePathSchema).max(20).default([]),
  /** How many folder levels below each root are searched. */
  maxDepth: z.number().int().min(1).max(4).default(2),
  /** Never registered automatically: repositories you removed, or listed here by hand. */
  ignoredPaths: z.array(absolutePathSchema).max(1000).default([]),
  /** Download new commits in the background: fetch, then fast-forward a clean branch that is only behind. Never pushes. */
  sync: z.boolean().default(true),
  intervalMinutes: z.number().int().min(5).max(24 * 60).default(15),
});
export type RepositoryAutomationSettings = z.infer<typeof repositoryAutomationSettingsSchema>;

export const settingsSchema = z.object({
  billingMode: z.enum(BILLING_MODES).default('subscription'),
  theme: z.enum(THEMES).default('dark'),
  roleDefaults: roleAssignmentsSchema,
  autoApproveUpToLevel: permissionLevelSchema.default(DEFAULT_AUTO_APPROVE_LEVEL),
  defaultWorkflowId: slugSchema.default('normal-development'),
  defaultMode: z.enum(TASK_MODES).default('discuss'),
  notifications: z
    .object({
      approvals: z.boolean().default(true),
      failures: z.boolean().default(true),
      completions: z.boolean().default(true),
    })
    .default({ approvals: true, failures: true, completions: true }),
  developerMode: z.boolean().default(false),
  chairman: chairmanSettingsSchema.default(chairmanSettingsSchema.parse({})),
  repositoryAutomation: repositoryAutomationSettingsSchema.default(repositoryAutomationSettingsSchema.parse({})),
  execution: executionSettingsSchema.default(executionSettingsSchema.parse({})),
  /** The learning loop (docs/systems/learning.md). */
  learning: learningSettingsSchema.default(learningSettingsSchema.parse({})),
});
export type Settings = z.infer<typeof settingsSchema>;

export const updateSettingsSchema = settingsSchema.partial();
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const updateAgentSchema = agentSettingsSchema.partial();

export const modelInputSchema = z.object({
  modelId: modelIdSchema,
  label: z.string().min(1).max(80).optional(),
  efforts: z.array(effortSchema).max(10).optional(),
});

export const promptTemplateUpdateSchema = z.object({
  body: z.string().min(1).max(50000),
});
