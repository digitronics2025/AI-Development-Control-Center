import { z } from 'zod';
import type { TaskStatus } from './constants.js';
import type { TaskBlocker } from './types.js';

/**
 * The learning loop (docs/systems/learning.md): after a task finishes, the
 * Chairman reviews what slowed it down and improves the Control Center on its
 * own — lessons for later prompts, skills, reviewed programs — keeping only
 * what stops the problem from recurring.
 */

/** Friction read from what the orchestrator recorded — never from a model. */
export const LEARNING_SIGNAL_KINDS = [
  'tool_missing',
  'command_missing',
  'tool_failures',
  'skill_denied',
  'fix_loops',
  'recovery',
  'stage_timeout',
  'provider_block',
  'completion_limits',
  'slow_stage',
  'task_stuck',
] as const;
export type LearningSignalKind = (typeof LEARNING_SIGNAL_KINDS)[number];

/** Signals that are facts on their own: one is enough evidence to act on. */
export const DEFINITIVE_SIGNAL_KINDS: readonly LearningSignalKind[] = ['tool_missing', 'command_missing'];

export interface LearningSignal {
  /** `s1`, `s2`… — stable within one review; findings cite these. */
  id: string;
  kind: LearningSignalKind;
  /** Normalised subject: a provider id, command, capability, skill, stage key or failure category. */
  key: string;
  /** One line, redacted. */
  summary: string;
  count: number;
  stageKeys: string[];
}

export const FINDING_KINDS = ['missing_tool', 'missing_skill', 'process', 'app_defect'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const LEARNING_SCOPES = ['repository', 'global'] as const;
export type LearningScope = (typeof LEARNING_SCOPES)[number];

export const FINDING_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];

/**
 * Programs the Chairman may install on its own: a reviewed list with exact
 * package ids, installed for the user account only. Nothing outside it is
 * ever installed by the learning loop.
 */
export interface InstallableTool {
  id: string;
  name: string;
  /** Executables it provides, for detection and for matching "command not found". */
  commands: string[];
  /** The tool-layer provider it satisfies, when there is one. */
  providerId: string | null;
  method: { kind: 'winget'; packageId: string } | { kind: 'npm'; packageName: string };
  purpose: string;
}

export const INSTALLABLE_TOOLS: readonly InstallableTool[] = [
  { id: 'gh', name: 'GitHub CLI', commands: ['gh'], providerId: 'gh', method: { kind: 'winget', packageId: 'GitHub.cli' }, purpose: 'Pull requests, issues, releases and Actions from the command line' },
  { id: 'jq', name: 'jq', commands: ['jq'], providerId: null, method: { kind: 'winget', packageId: 'jqlang.jq' }, purpose: 'Read and reshape JSON in scripts' },
  { id: 'yq', name: 'yq', commands: ['yq'], providerId: null, method: { kind: 'winget', packageId: 'MikeFarah.yq' }, purpose: 'Read and reshape YAML in scripts' },
  { id: 'ripgrep', name: 'ripgrep', commands: ['rg'], providerId: null, method: { kind: 'winget', packageId: 'BurntSushi.ripgrep.MSVC' }, purpose: 'Fast text search across a repository' },
  { id: 'uv', name: 'uv', commands: ['uv', 'uvx'], providerId: 'uv', method: { kind: 'winget', packageId: 'astral-sh.uv' }, purpose: 'Python environments and packages' },
  { id: 'adb', name: 'Android platform tools', commands: ['adb', 'fastboot'], providerId: 'adb', method: { kind: 'winget', packageId: 'Google.PlatformTools' }, purpose: 'Install and inspect Android apps on a device' },
  { id: 'wrangler', name: 'Wrangler', commands: ['wrangler'], providerId: 'wrangler', method: { kind: 'npm', packageName: 'wrangler' }, purpose: 'Cloudflare Workers, Pages and D1' },
];

export const INSTALLABLE_TOOL_IDS = INSTALLABLE_TOOLS.map((t) => t.id) as [string, ...string[]];

/** The catalog entry that provides a command or a tool-layer provider, if any. */
export function installableFor(subject: string): InstallableTool | null {
  const s = subject.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
  return INSTALLABLE_TOOLS.find((t) => t.id === s || t.providerId === s || t.commands.includes(s)) ?? null;
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,48}$/;

/** What a finding proposes; a closed union the desk knows how to carry out. */
export const learningProposalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ADD_LESSON'), text: z.string().trim().min(10).max(400) }),
  z.object({
    type: z.literal('USE_SKILL'),
    /** As the CLI names it: `fix-bug` or `plugin:skill`. */
    skill: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    when: z.string().trim().min(5).max(200),
  }),
  z.object({
    type: z.literal('AUTHOR_SKILL'),
    name: z.string().trim().regex(SKILL_NAME, 'lowercase letters, digits and dashes, 2–49 characters'),
    description: z.string().trim().min(10).max(200),
    body: z.string().trim().min(40).max(6000),
  }),
  z.object({ type: z.literal('INSTALL_TOOL'), toolId: z.enum(INSTALLABLE_TOOL_IDS) }),
]);
export type LearningProposal = z.infer<typeof learningProposalSchema>;
export type LearningProposalType = LearningProposal['type'];

export const FINDING_STATUSES = ['open', 'adopted', 'needs_you', 'dismissed', 'failed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export interface LearningFinding {
  id: string;
  fingerprint: string;
  kind: FindingKind;
  scope: LearningScope;
  repositoryId: string | null;
  title: string;
  detail: string;
  proposal: LearningProposal | null;
  confidence: FindingConfidence;
  /** Rests on a definitive recorded signal (a missing program), not only on a model's reading. */
  observed: boolean;
  occurrences: number;
  /** Distinct tasks it was seen in. */
  taskCount: number;
  status: FindingStatus;
  statusReason: string | null;
  improvementId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

export const IMPROVEMENT_KINDS = ['lesson', 'skill_recommendation', 'skill_adopted', 'skill_authored', 'tool_installed'] as const;
export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number];

export const IMPROVEMENT_STATUSES = ['trial', 'active', 'ineffective', 'reverted', 'failed'] as const;
export type ImprovementStatus = (typeof IMPROVEMENT_STATUSES)[number];

/** Improvements that reach prompts and runs. */
export const LIVE_IMPROVEMENT_STATUSES: readonly ImprovementStatus[] = ['trial', 'active'];

export interface LearningImprovement {
  id: string;
  findingId: string | null;
  fingerprint: string;
  kind: ImprovementKind;
  scope: LearningScope;
  repositoryId: string | null;
  title: string;
  /** Lesson text; skill name; tool id. */
  content: string;
  /** Where it came from: `chairman`, `marketplace:<m>/<plugin>`, `winget:<id>`, `npm:<name>`. */
  source: string;
  contentHash: string | null;
  status: ImprovementStatus;
  trial: { target: number; seen: number; recurrences: number };
  reason: string;
  createdAt: string;
  updatedAt: string;
  revertedAt: string | null;
  revertedBy: 'chairman' | 'user' | null;
}

export const REVIEW_STATUSES = ['pending', 'running', 'done', 'skipped', 'failed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface LearningReview {
  taskId: string;
  repositoryId: string | null;
  status: ReviewStatus;
  reviewer: 'model' | 'rules' | null;
  signals: LearningSignal[];
  findingIds: string[];
  summary: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface LearningLogEntry {
  id: number;
  at: string;
  kind: 'review' | 'finding' | 'adopted' | 'needs_you' | 'trial' | 'reverted' | 'dismissed' | 'failed';
  taskId: string | null;
  findingId: string | null;
  improvementId: string | null;
  message: string;
}

export interface LearningOverview {
  settings: LearningSettings;
  counts: { improvementsLive: number; findingsOpen: number; needsYou: number; reviewed: number; actionsToday: number };
  improvements: LearningImprovement[];
  findings: LearningFinding[];
  reviews: Array<LearningReview & { taskTitle: string | null }>;
  log: LearningLogEntry[];
  /** Why the reviewer cannot use a model right now (rules only), or null. */
  reviewerUnavailable: string | null;
}

export const learningSettingsSchema = z.object({
  /** Review finished tasks. */
  enabled: z.boolean().default(true),
  /** act: the Chairman adopts improvements on its own; propose: it records them for you. */
  autonomy: z.enum(['act', 'propose']).default('act'),
  /** Use the Chairman's reasoning agent for reviews; off = rules only. */
  reviewWithModel: z.boolean().default(true),
  maxActionsPerDay: z.number().int().min(0).max(20).default(3),
  /** Later tasks an improvement is tried on before it is kept or reverted. */
  trialTasks: z.number().int().min(1).max(20).default(3),
});
export type LearningSettings = z.infer<typeof learningSettingsSchema>;

export const learningTaskParamSchema = z.object({ id: z.string().min(1).max(200) });

export const FINDING_KIND_LABEL: Record<FindingKind, string> = {
  missing_tool: 'Missing program',
  missing_skill: 'Missing skill',
  process: 'Way of working',
  app_defect: 'Control Center defect',
};

export const IMPROVEMENT_KIND_LABEL: Record<ImprovementKind, string> = {
  lesson: 'Lesson',
  skill_recommendation: 'Skill recommended',
  skill_adopted: 'Skill added',
  skill_authored: 'Skill written',
  tool_installed: 'Program installed',
};

export const IMPROVEMENT_STATUS_LABEL: Record<ImprovementStatus, string> = {
  trial: 'On trial',
  active: 'Kept',
  ineffective: 'Did not help — undone',
  reverted: 'Undone',
  failed: 'Failed',
};

export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'Watching',
  adopted: 'Acted on',
  needs_you: 'Needs you',
  dismissed: 'Dismissed',
  failed: 'Could not act',
};

export const SIGNAL_KIND_LABEL: Record<LearningSignalKind, string> = {
  tool_missing: 'Program not installed',
  command_missing: 'Command not found',
  tool_failures: 'Tool kept failing',
  skill_denied: 'Skill refused',
  fix_loops: 'Several fix rounds',
  recovery: 'Chairman recovery',
  stage_timeout: 'Stage timed out',
  provider_block: 'Agent blocked',
  completion_limits: 'Finished with unmet checks',
  slow_stage: 'Slow stage',
  task_stuck: 'Task got stuck',
};

/** Blockers that mean the work itself got stuck — worth learning from before anyone resumes it. */
const STUCK_BLOCKERS: ReadonlyArray<TaskBlocker['kind']> = ['hard_blocker', 'limit', 'fix_limit', 'error', 'decision', 'usage'];

/**
 * Whether a task is ready for a learning review: it completed, or it is
 * stuck on something only a change or a person can fix. Waiting for an
 * approval, a sign-in or a restart is not stuck.
 */
export function reviewTrigger(task: { status: TaskStatus; blocker: TaskBlocker | null }): 'completed' | 'stuck' | null {
  if (task.status === 'COMPLETED') return 'completed';
  if (task.status === 'FAILED') return 'stuck';
  if ((task.status === 'WAITING_FOR_USER' || task.status === 'WAITING_FOR_USAGE_RESET') && task.blocker && STUCK_BLOCKERS.includes(task.blocker.kind)) return 'stuck';
  return null;
}
