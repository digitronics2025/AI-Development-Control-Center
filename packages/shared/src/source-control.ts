import { z } from 'zod';
import type { PermissionLevel, TaskStatus } from './constants.js';
import type { ChangedFile, Iso } from './types.js';

/**
 * Repository-level Source Control (docs/plans/source-control-center/PLAN.md).
 *
 * Two models meet here and are kept apart on purpose:
 *  - Git state: what is staged, unstaged, untracked or conflicted right now,
 *    and how the branch relates to its upstream. Read from native Git.
 *  - Task attribution: whether a change came from a task or was the user's
 *    work before it (`ChangedFile['origin']`). Only present when a task
 *    baseline proves it.
 */

/** One side (index or worktree) of a porcelain v2 status entry. */
export type GitFileStatus =
  | 'unmodified'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'untracked'
  | 'unmerged';

export interface RepositoryChangedPath {
  path: string;
  /** Source path of a staged rename or copy. */
  originalPath: string | null;
  indexStatus: GitFileStatus;
  worktreeStatus: GitFileStatus;
  untracked: boolean;
  conflicted: boolean;
  /** Two-letter unmerged code (UU, AA, DU…) when conflicted. */
  conflictCode: string | null;
  staged: boolean;
  unstaged: boolean;
  /** Line counts for the staged and unstaged sides; null when binary or not computed. */
  stagedStats: { additions: number | null; deletions: number | null } | null;
  unstagedStats: { additions: number | null; deletions: number | null } | null;
  binary: boolean;
  /** Proven task attribution, or null when no task baseline covers this path. */
  attribution: ChangedFile['origin'] | null;
  /** Why this path must never be committed as is (e.g. an environment file), or null. */
  sensitive: string | null;
}

export type BranchRelation = 'none' | 'synced' | 'ahead' | 'behind' | 'diverged' | 'unknown';

export type GitOperationInProgress = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export interface SourceControlActiveTask {
  id: string;
  title: string;
  status: TaskStatus;
  stageName: string | null;
  /** True while a stage that can change files is running: Git mutations wait. */
  writing: boolean;
}

export interface SourceControlSnapshot {
  repositoryId: string;
  /** Fingerprint of the Git state; every mutation sends the version it acted on. */
  version: string;
  capturedAt: Iso;
  available: boolean;
  isGitRepo: boolean;
  /** Set when the snapshot could not be read (folder missing, Git missing, Git failed). */
  error: { code: SourceControlErrorCode; message: string } | null;

  branch: {
    name: string | null;
    detached: boolean;
    /** The branch has no commits yet. */
    unborn: boolean;
    head: string | null;
    upstream: string | null;
    /** The configured upstream no longer exists on the remote. */
    upstreamGone: boolean;
    ahead: number | null;
    behind: number | null;
    relation: BranchRelation;
  };

  remotes: string[];

  state: {
    clean: boolean;
    conflicted: boolean;
    operationInProgress: GitOperationInProgress | null;
    indexLocked: boolean;
    activeTask: SourceControlActiveTask | null;
    /** Why Git mutations are unavailable right now, or null. */
    mutationBlockedReason: string | null;
    /** Task whose baseline supplies `attribution`, when there is one. */
    attributionTaskId: string | null;
  };

  lastFetch: { at: Iso; ok: boolean; error: string | null } | null;

  changes: RepositoryChangedPath[];
  /** More changed paths exist than are listed. */
  changesTruncated: boolean;
  totals: { staged: number; unstaged: number; untracked: number; conflicted: number };
}

export type SourceControlDiffMode = 'staged' | 'unstaged';

export interface SourceControlDiff {
  path: string;
  mode: SourceControlDiffMode;
  diff: string;
  truncated: boolean;
  binary: boolean;
}

export interface CommitRef {
  name: string;
  kind: 'head' | 'branch' | 'remote' | 'tag';
}

export type CommitAttribution =
  | { kind: 'task'; taskId: string; taskTitle: string }
  | { kind: 'source-control'; operationId: string; taskId: string | null };

export interface HistoryCommit {
  sha: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAt: Iso;
  committedAt: Iso;
  refs: CommitRef[];
  attribution: CommitAttribution | null;
}

export interface HistoryPage {
  items: HistoryCommit[];
  nextCursor: string | null;
}

export interface CommitFileChange {
  path: string;
  originalPath: string | null;
  status: GitFileStatus;
  additions: number | null;
  deletions: number | null;
}

export interface CommitDetails extends HistoryCommit {
  body: string;
  committerName: string;
  committerEmail: string;
  files: CommitFileChange[];
  filesTruncated: boolean;
}

/** `sync` is the composite fetch → push or fast-forward action; its steps are in its metadata. */
export const GIT_OPERATION_KINDS = ['stage', 'unstage', 'commit', 'fetch', 'fast_forward', 'push', 'publish', 'sync'] as const;
export type GitOperationKind = (typeof GIT_OPERATION_KINDS)[number];

export const GIT_OPERATION_STATUSES = ['started', 'succeeded', 'failed', 'uncertain'] as const;
export type GitOperationStatus = (typeof GIT_OPERATION_STATUSES)[number];

/** Audit record of one Source Control mutation. Holds no diffs, sources or credentials. */
export interface GitOperation {
  id: string;
  repositoryId: string;
  taskId: string | null;
  executionId: string | null;
  kind: GitOperationKind;
  status: GitOperationStatus;
  startedAt: Iso;
  finishedAt: Iso | null;
  preHead: string | null;
  postHead: string | null;
  remote: string | null;
  ref: string | null;
  commitSha: string | null;
  errorCode: string | null;
  errorSummary: string | null;
  /** Short human summary of what happened. */
  message: string | null;
}

export type SyncOutcome = 'up-to-date' | 'pushed' | 'fast-forwarded' | 'diverged' | 'behind-dirty' | 'blocked';

export interface SourceControlOperationResult {
  operation: GitOperation;
  snapshot: SourceControlSnapshot;
  /** Paths left out of a stage-all, with the reason. */
  skipped?: Array<{ path: string; reason: string }>;
  sync?: { outcome: SyncOutcome; ahead: number | null; behind: number | null };
}

export interface CommitMessageSuggestion {
  subject: string;
  body: string;
  agentId: string;
  model: string;
}

export interface StagedReviewStarted {
  taskId: string;
}

/**
 * Error codes of the Source Control API. Remote failures never use 401,
 * which the dashboard reserves for its own local token.
 */
export const SOURCE_CONTROL_ERROR_CODES = [
  'NOT_A_REPOSITORY',
  'REPOSITORY_UNAVAILABLE',
  'GIT_UNAVAILABLE',
  'GIT_FAILED',
  'GIT_STATE_CHANGED',
  'BLOCKED_BY_TASK',
  'OPERATION_IN_PROGRESS',
  'INDEX_LOCKED',
  'CONFLICTS',
  'DETACHED_HEAD',
  'NO_UPSTREAM',
  'UPSTREAM_GONE',
  'NOTHING_STAGED',
  'NOTHING_TO_STAGE',
  'PATH_NOT_CHANGED',
  'INVALID_PATH',
  'INVALID_INPUT',
  'MIXED_CHANGES_UNCONFIRMED',
  'SENSITIVE_CONTENT',
  'PREFLIGHT_INCOMPLETE',
  'HOOK_FAILED',
  'IDENTITY_MISSING',
  'SIGNING_FAILED',
  'COMMIT_FAILED',
  'REMOTE_AUTH_FAILED',
  'REMOTE_REJECTED',
  'NETWORK',
  'DIVERGED',
  'WORKTREE_DIRTY',
  'UNKNOWN_REMOTE',
  'DUPLICATE_IN_FLIGHT',
  'UNCERTAIN',
  'AGENT_UNAVAILABLE',
] as const;
export type SourceControlErrorCode = (typeof SOURCE_CONTROL_ERROR_CODES)[number];

/**
 * Risk of each Source Control action in the product's permission model
 * (PERMISSION_LEVEL_INFO). Reads are Level 1; everything that writes the
 * index, a ref or a remote is Level 3 (Git). `remote` marks actions that
 * reach outside this machine.
 */
export const SOURCE_CONTROL_ACTIONS: Record<GitOperationKind | 'read', { level: PermissionLevel; remote: boolean; label: string }> = {
  read: { level: 1, remote: false, label: 'Read status, history and diffs' },
  stage: { level: 3, remote: false, label: 'Stage' },
  unstage: { level: 3, remote: false, label: 'Unstage' },
  commit: { level: 3, remote: false, label: 'Commit' },
  fetch: { level: 3, remote: true, label: 'Fetch' },
  fast_forward: { level: 3, remote: false, label: 'Fast-forward' },
  push: { level: 3, remote: true, label: 'Push' },
  publish: { level: 3, remote: true, label: 'Publish branch' },
  sync: { level: 3, remote: true, label: 'Sync' },
};

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * A repository-relative path as Git prints it. The server additionally
 * requires every path to be one Git currently reports as changed, so a
 * syntactically valid path still cannot reach anything else.
 */
export const repoPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), 'Invalid path')
  .refine((p) => !/^[/\\]/.test(p) && !/^[A-Za-z]:/.test(p), 'Paths must be relative to the repository')
  .refine((p) => !p.split(/[/\\]/).includes('..'), 'Paths may not contain ".."');

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid idempotency key');

const versionSchema = z.string().min(1).max(128);

const mutationBase = {
  expectedVersion: versionSchema,
  idempotencyKey: idempotencyKeySchema,
};

export const stageRequestSchema = z.union([
  z.object({ ...mutationBase, paths: z.array(repoPathSchema).min(1).max(5000) }),
  z.object({
    ...mutationBase,
    all: z.literal(true),
    /** Mixed task/user paths the user saw and confirmed; Stage All refuses others. */
    confirmMixed: z.array(repoPathSchema).max(5000).default([]),
  }),
]);
export type StageRequest = z.input<typeof stageRequestSchema>;

export const unstageRequestSchema = z.union([
  z.object({ ...mutationBase, paths: z.array(repoPathSchema).min(1).max(5000) }),
  z.object({ ...mutationBase, all: z.literal(true) }),
]);
export type UnstageRequest = z.input<typeof unstageRequestSchema>;

export const commitRequestSchema = z.object({
  ...mutationBase,
  message: z
    .string()
    .max(20_000)
    .refine((m) => m.trim().length > 0, 'Write a commit message')
    .refine((m) => !m.includes('\0'), 'Invalid commit message'),
});
export type CommitRequest = z.input<typeof commitRequestSchema>;

export const fetchRequestSchema = z.object({
  expectedVersion: versionSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type FetchRequest = z.input<typeof fetchRequestSchema>;

export const syncRequestSchema = z.object(mutationBase);
export type SyncRequest = z.input<typeof syncRequestSchema>;

export const remoteNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Invalid remote name');

export const publishRequestSchema = z.object({ ...mutationBase, remote: remoteNameSchema });
export type PublishRequest = z.input<typeof publishRequestSchema>;

export const diffQuerySchema = z.object({
  path: repoPathSchema,
  mode: z.enum(['staged', 'unstaged']),
});

export const historyQuerySchema = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});

export const shaSchema = z.string().regex(/^[0-9a-f]{7,64}$/, 'Invalid commit id');

export const commitDiffQuerySchema = z.object({ path: repoPathSchema });

export const reviewStagedRequestSchema = z.object({
  expectedVersion: versionSchema,
  purpose: z.string().trim().max(4000).optional(),
});

export const suggestMessageRequestSchema = z.object({
  expectedVersion: versionSchema,
});
