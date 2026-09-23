import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  aheadBehind,
  branchUpstream,
  changesSince,
  classifyGitOutput,
  commitFileDiff,
  commitFiles,
  commitMeta,
  commitStaged,
  fastForward,
  fetchRemote,
  GitCommandFailure,
  GitError,
  headCommit,
  historyPage,
  hooksInstalled,
  indexLocked,
  lineStats,
  outgoingPatch,
  pathDiff,
  pushRef,
  revParse,
  splitPatch,
  stagedPatch,
  stagePaths,
  statusFromLetter,
  unstagePaths,
  type GitResult,
  type LineStats,
} from '@acc/git';
import { redact, sensitiveFileReason } from '@acc/security';
import {
  TERMINAL_TASK_STATUSES,
  isReadOnlyWorkflow,
  type ChangedFile,
  type CommitAttribution,
  type CommitDetails,
  type GitOperationKind,
  type HistoryCommit,
  type HistoryPage,
  type RepositoryChangedPath,
  type RepositorySyncOutcome,
  type RepositorySyncResult,
  type SourceControlActiveTask,
  type SourceControlDiff,
  type SourceControlDiffMode,
  type SourceControlErrorCode,
  type SourceControlOperationResult,
  type SourceControlSnapshot,
  type SyncOutcome,
} from '@acc/shared';
import type { Bus } from '../bus.js';
import type { RepositoryService } from '../services/repositories.js';
import type { RepositoryCoordinator } from '../services/repository-coordinator.js';
import { toGitOperation, type GitOperationMetadata, type GitOperationRecord, type GitOperationStore } from '../store/git-operations.js';
import { newId, now, type RepositoryRecord, type Store, type TaskRecord } from '../store/store.js';
import { SourceControlError } from './errors.js';
import { preflightFindings } from './preflight.js';
import { readRepoState, scopes, type EntryState, type RepoState } from './state.js';

const SNAPSHOT_TTL_MS = 1_500;
const VERSION_HISTORY = 24;
const MAX_LISTED_CHANGES = 2_000;
const MAX_STATS_PATHS = 2_000;
const MAX_DIFF_BYTES = 1_000_000;
const MAX_PREFLIGHT_BYTES = 20 * 1024 * 1024;
const INDEX_LOCK_WAIT_MS = 2_000;

export interface SourceControlDeps {
  store: Store;
  operations: GitOperationStore;
  repositories: RepositoryService;
  coordinator: RepositoryCoordinator;
  bus: Bus;
}

/** Enriched state: Git state plus attribution and line counts, cached per version. */
interface Enriched {
  state: RepoState;
  attribution: Map<string, ChangedFile['origin']>;
  attributionTaskId: string | null;
  staged: LineStats;
  unstaged: LineStats;
}

interface MutationOutcome {
  status: 'succeeded' | 'failed' | 'uncertain';
  message: string;
  commitSha?: string | null;
  errorCode?: SourceControlErrorCode | null;
  errorSummary?: string | null;
  metadata?: GitOperationMetadata;
  skipped?: Array<{ path: string; reason: string }>;
  sync?: SourceControlOperationResult['sync'];
  remote?: string | null;
  ref?: string | null;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Output of a failed Git command, redacted and bounded, for the journal and the UI. */
function gitOutput(result: GitResult): string {
  return redact(`${result.stderr}\n${result.stdout}`.trim()).slice(0, 2000);
}

/**
 * Repository-level Source Control (docs/systems/source-control.md). Reads
 * come straight from Git; mutations are serialized per repository through
 * the shared coordinator, checked against the version the user acted on,
 * journalled before they touch Git, and never retried blindly.
 */
export class SourceControlService {
  private readonly cache = new Map<string, { at: number; snapshot: SourceControlSnapshot; enriched: Enriched | null }>();
  private readonly inflight = new Map<string, Promise<{ snapshot: SourceControlSnapshot; enriched: Enriched | null }>>();
  /** Recent states by version, for relevant-scope staleness checks. */
  private readonly versions = new Map<string, Map<string, Enriched>>();
  private readonly gitDirs = new Map<string, string>();

  constructor(private readonly d: SourceControlDeps) {
    // Writers starting or stopping change what the page must show.
    d.coordinator.onChange((repositoryId) => this.invalidate(repositoryId));
    // Any orchestrator-controlled change (a finished stage, a task commit) invalidates the cache.
    d.bus.subscribe((message) => {
      if (message.type === 'sourceControl') this.cache.delete(message.repositoryId);
    });
  }

  // ===========================================================================
  // Snapshot
  // ===========================================================================

  /** Drop cached state and tell clients to refetch. */
  invalidate(repositoryId: string): void {
    this.cache.delete(repositoryId);
    this.d.bus.publish({ type: 'sourceControl', repositoryId });
  }

  async snapshot(repositoryId: string, options: { fresh?: boolean } = {}): Promise<SourceControlSnapshot> {
    return (await this.load(repositoryId, options.fresh ?? false)).snapshot;
  }

  private async load(repositoryId: string, fresh: boolean): Promise<{ snapshot: SourceControlSnapshot; enriched: Enriched | null }> {
    const cached = this.cache.get(repositoryId);
    if (!fresh && cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached;
    const running = this.inflight.get(repositoryId);
    if (running && !fresh) return running;
    const promise = this.build(repositoryId).finally(() => {
      if (this.inflight.get(repositoryId) === promise) this.inflight.delete(repositoryId);
    });
    this.inflight.set(repositoryId, promise);
    const result = await promise;
    this.cache.set(repositoryId, { at: Date.now(), ...result });
    return result;
  }

  private emptySnapshot(repositoryId: string, error: { code: SourceControlErrorCode; message: string }, available: boolean, isGitRepo: boolean): SourceControlSnapshot {
    return {
      repositoryId,
      version: `error:${error.code}`,
      capturedAt: now(),
      available,
      isGitRepo,
      error,
      branch: { name: null, detached: false, unborn: false, head: null, upstream: null, upstreamGone: false, ahead: null, behind: null, relation: 'unknown' },
      remotes: [],
      state: { clean: true, conflicted: false, operationInProgress: null, indexLocked: false, activeTask: this.activeTask(repositoryId), mutationBlockedReason: error.message, attributionTaskId: null },
      lastFetch: this.lastFetch(repositoryId),
      changes: [],
      changesTruncated: false,
      totals: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    };
  }

  private async readState(repo: RepositoryRecord): Promise<RepoState> {
    try {
      const state = await readRepoState(repo.path, this.gitDirs.get(repo.id));
      this.gitDirs.set(repo.id, state.gitDir);
      return state;
    } catch (error) {
      this.gitDirs.delete(repo.id);
      throw error;
    }
  }

  private async build(repositoryId: string): Promise<{ snapshot: SourceControlSnapshot; enriched: Enriched | null }> {
    const repo = this.d.repositories.record(repositoryId);
    if (!existsSync(repo.path)) {
      return { snapshot: this.emptySnapshot(repositoryId, { code: 'REPOSITORY_UNAVAILABLE', message: `The folder ${repo.path} no longer exists.` }, false, false), enriched: null };
    }
    let state: RepoState;
    try {
      state = await this.readState(repo);
    } catch (error) {
      if (error instanceof GitError) {
        return { snapshot: this.emptySnapshot(repositoryId, { code: 'GIT_UNAVAILABLE', message: 'Git is not installed or could not start. Install Git and refresh.' }, true, false), enriched: null };
      }
      const message = (error as Error).message;
      if (/not a git repository/i.test(message)) {
        return { snapshot: this.emptySnapshot(repositoryId, { code: 'NOT_A_REPOSITORY', message: 'This folder is not a Git repository. Source Control never initialises one for you.' }, true, false), enriched: null };
      }
      return { snapshot: this.emptySnapshot(repositoryId, { code: 'GIT_FAILED', message: redact(message).slice(0, 500) }, true, true), enriched: null };
    }

    const known = this.versions.get(repositoryId)?.get(state.version);
    const enriched: Enriched = known ? { ...known, state } : await this.enrich(repo, state);
    this.remember(repositoryId, enriched);
    return { snapshot: this.toSnapshot(repositoryId, enriched), enriched };
  }

  private remember(repositoryId: string, enriched: Enriched): void {
    let map = this.versions.get(repositoryId);
    if (!map) this.versions.set(repositoryId, (map = new Map()));
    map.delete(enriched.state.version);
    map.set(enriched.state.version, enriched);
    while (map.size > VERSION_HISTORY) map.delete(map.keys().next().value!);
  }

  /** Line counts and task attribution: recomputed only when the version changes. */
  private async enrich(repo: RepositoryRecord, state: RepoState): Promise<Enriched> {
    const small = state.entries.length <= MAX_STATS_PATHS;
    const [staged, unstaged] = small
      ? await Promise.all([
          state.entries.some((e) => e.staged) ? lineStats(state.root, 'staged', { hasHead: state.hasHead }).catch(() => new Map()) : new Map(),
          state.entries.some((e) => e.unstaged) ? lineStats(state.root, 'unstaged', { hasHead: state.hasHead }).catch(() => new Map()) : new Map(),
        ])
      : [new Map(), new Map()];
    const attribution = new Map<string, ChangedFile['origin']>();
    const task = this.attributionTask(repo.id, state.branch.head);
    let attributionTaskId: string | null = null;
    if (task && state.entries.length > 0 && small) {
      const baseline = task.git.baselineSnapshotId ? this.d.store.getSnapshot(task.git.baselineSnapshotId) : null;
      if (baseline) {
        try {
          for (const f of await changesSince(state.root, baseline)) attribution.set(f.path, f.origin);
          attributionTaskId = task.id;
        } catch {
          /* attribution is optional; Git state stands on its own */
        }
      }
    }
    return { state, attribution, attributionTaskId, staged, unstaged };
  }

  /**
   * The task whose baseline explains the current changes: the unfinished task
   * holding the repository, else the latest finished (completed or cancelled)
   * task whose branch is checked out — its changes are still in the working
   * tree. Attribution is only shown when a baseline proves it.
   */
  private attributionTask(repositoryId: string, branch: string | null): TaskRecord | null {
    const tasks = this.d.store.listTasks({ repositoryId, limit: 50 }).filter((t) => t.git.baselineSnapshotId && !isReadOnlyWorkflow(t.workflow));
    return (
      tasks.find((t) => !TERMINAL_TASK_STATUSES.includes(t.status) && t.status !== 'DRAFT') ??
      tasks.find((t) => TERMINAL_TASK_STATUSES.includes(t.status) && branch !== null && (t.git.taskBranch ?? t.git.baselineBranch) === branch) ??
      null
    );
  }

  private activeTask(repositoryId: string): SourceControlActiveTask | null {
    const writers = this.d.coordinator.activeWriters(repositoryId);
    const writer = writers[0];
    if (writer) {
      const task = this.d.store.getTask(writer.taskId);
      if (task) return { id: task.id, title: task.title, status: task.status, stageName: writer.stageName, writing: true };
    }
    const running = this.d.store
      .listTasks({ repositoryId, statuses: ['RUNNING', 'PAUSED', 'WAITING_FOR_USER', 'WAITING_FOR_USAGE_RESET', 'INTERRUPTED', 'FAILED'], limit: 20 })
      .filter((t) => !isReadOnlyWorkflow(t.workflow) && (t.status === 'RUNNING' || t.git.baselineSnapshotId));
    const task = running.find((t) => t.status === 'RUNNING') ?? running[0];
    if (!task) return null;
    const stage = task.currentStageId ? this.d.store.getStage(task.currentStageId) : null;
    return { id: task.id, title: task.title, status: task.status, stageName: stage?.name ?? null, writing: false };
  }

  private lastFetch(repositoryId: string): SourceControlSnapshot['lastFetch'] {
    const ops = this.d.operations.list(repositoryId, 20).filter((o) => o.kind === 'fetch' || o.kind === 'sync');
    const op = ops.find((o) => o.status !== 'started');
    if (!op) return null;
    return { at: op.finishedAt ?? op.startedAt, ok: op.status === 'succeeded', error: op.status === 'succeeded' ? null : op.errorSummary };
  }

  private blockedReason(repositoryId: string, state: RepoState): string | null {
    const writer = this.d.coordinator.activeWriters(repositoryId)[0];
    if (writer) {
      return `${writer.taskId} is running ${writer.stageName} in this repository. Everything stays readable; staging, committing and syncing wait until that stage finishes or you pause the task.`;
    }
    if (state.operation) return `A ${state.operation} is in progress. Finish or abort it in your terminal or editor; Source Control does not change the repository while it is open.`;
    if (state.indexLocked) return "Git's index is locked by another Git process (or one that crashed left .git/index.lock). Try again when it finishes.";
    return null;
  }

  private toSnapshot(repositoryId: string, e: Enriched): SourceControlSnapshot {
    const { state } = e;
    const b = state.branch;
    const upstreamGone = Boolean(b.upstream) && b.ahead === null;
    let relation: SourceControlSnapshot['branch']['relation'] = 'none';
    if (b.upstream && upstreamGone) relation = 'unknown';
    else if (b.upstream && b.ahead !== null && b.behind !== null) {
      relation = b.ahead && b.behind ? 'diverged' : b.ahead ? 'ahead' : b.behind ? 'behind' : 'synced';
    }
    const toPath = (entry: EntryState): RepositoryChangedPath => {
      const stat = (m: LineStats) => {
        const s = m.get(entry.path);
        return s ? { additions: s.additions, deletions: s.deletions } : null;
      };
      const stagedStats = entry.staged ? stat(e.staged) : null;
      const unstagedStats = entry.unstaged ? stat(e.unstaged) : null;
      return {
        path: entry.path,
        originalPath: entry.originalPath,
        indexStatus: entry.conflicted ? 'unmerged' : entry.untracked ? 'untracked' : statusFromLetter(entry.xy[0]),
        worktreeStatus: entry.conflicted ? 'unmerged' : entry.untracked ? 'untracked' : statusFromLetter(entry.xy[1]),
        untracked: entry.untracked,
        conflicted: entry.conflicted,
        conflictCode: entry.conflicted ? entry.xy : null,
        staged: entry.staged,
        unstaged: entry.unstaged,
        stagedStats,
        unstagedStats,
        binary: (stagedStats !== null && stagedStats.additions === null) || (unstagedStats !== null && unstagedStats.additions === null),
        attribution: e.attribution.get(entry.path) ?? null,
        sensitive: sensitiveFileReason(entry.path),
      };
    };
    const conflicted = state.entries.some((x) => x.conflicted);
    const reason = this.blockedReason(repositoryId, state) ?? (conflicted ? 'Resolve the conflicts first. Source Control shows them but never resolves them for you.' : null);
    return {
      repositoryId,
      version: state.version,
      capturedAt: now(),
      available: true,
      isGitRepo: true,
      error: null,
      branch: {
        name: b.head,
        detached: b.detached,
        unborn: !state.hasHead,
        head: b.oid,
        upstream: b.upstream,
        upstreamGone,
        ahead: b.ahead,
        behind: b.behind,
        relation,
      },
      remotes: state.remotes,
      state: {
        clean: state.entries.length === 0,
        conflicted,
        operationInProgress: state.operation,
        indexLocked: state.indexLocked,
        activeTask: this.activeTask(repositoryId),
        mutationBlockedReason: reason,
        attributionTaskId: e.attributionTaskId,
      },
      lastFetch: this.lastFetch(repositoryId),
      changes: state.entries.slice(0, MAX_LISTED_CHANGES).map(toPath),
      changesTruncated: state.entries.length > MAX_LISTED_CHANGES || state.truncated,
      totals: {
        staged: state.entries.filter((x) => x.staged).length,
        unstaged: state.entries.filter((x) => x.unstaged).length,
        untracked: state.entries.filter((x) => x.untracked).length,
        conflicted: state.entries.filter((x) => x.conflicted).length,
      },
    };
  }

  // ===========================================================================
  // Reads
  // ===========================================================================

  private async gitState(repositoryId: string, fresh = false): Promise<Enriched> {
    const loaded = await this.load(repositoryId, fresh);
    if (!loaded.enriched) {
      const error = loaded.snapshot.error!;
      throw new SourceControlError(error.code, error.message);
    }
    return loaded.enriched;
  }

  async diff(repositoryId: string, file: string, mode: SourceControlDiffMode): Promise<SourceControlDiff> {
    const { state } = await this.gitState(repositoryId);
    // Only paths Git reports as changed can be read: nothing else in (or outside) the repository.
    const entry = state.byPath.get(file);
    if (!entry || (mode === 'staged' ? !entry.staged : !(entry.unstaged || entry.untracked || entry.conflicted))) {
      throw new SourceControlError('PATH_NOT_CHANGED', `${file} has no ${mode} changes.`);
    }
    const result = await pathDiff(state.root, {
      path: entry.path,
      originalPath: mode === 'staged' ? entry.originalPath : null,
      mode,
      untracked: entry.untracked,
      hasHead: state.hasHead,
      maxBytes: MAX_DIFF_BYTES,
    });
    return { path: file, mode, diff: redact(result.diff), truncated: result.truncated, binary: result.binary };
  }

  /** Commits known to a task (its Git stage) or to this journal. */
  private attributions(repositoryId: string, shas: string[]): Map<string, CommitAttribution> {
    const map = new Map<string, CommitAttribution>();
    const wanted = new Set(shas);
    for (const task of this.d.store.listTasks({ repositoryId, limit: 1000 })) {
      for (const sha of task.git.commits) if (wanted.has(sha)) map.set(sha, { kind: 'task', taskId: task.id, taskTitle: task.title });
    }
    for (const [sha, op] of this.d.operations.byCommits(repositoryId, shas)) {
      if (!map.has(sha)) map.set(sha, { kind: 'source-control', operationId: op.id, taskId: op.taskId });
    }
    return map;
  }

  async history(repositoryId: string, options: { cursor?: string; limit: number }): Promise<HistoryPage> {
    const { state } = await this.gitState(repositoryId);
    let tips: string[];
    let skip = 0;
    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      tips = decoded.tips;
      skip = decoded.skip;
    } else {
      if (!state.hasHead) return { items: [], nextCursor: null };
      // Pin the tips so later pages stay consistent even if HEAD moves meanwhile.
      const upstream = state.branch.upstream ? await revParse(state.root, '@{upstream}') : null;
      tips = [state.branch.oid!, ...(upstream && upstream !== state.branch.oid ? [upstream] : [])];
    }
    const records = await historyPage(state.root, { tips, skip, limit: options.limit + 1 });
    const page = records.slice(0, options.limit);
    const attribution = this.attributions(repositoryId, page.map((r) => r.sha));
    const items: HistoryCommit[] = page.map((r) => ({ ...r, attribution: attribution.get(r.sha) ?? null }));
    return { items, nextCursor: records.length > options.limit ? encodeCursor({ tips, skip: skip + options.limit }) : null };
  }

  async commit(repositoryId: string, sha: string): Promise<CommitDetails> {
    const { state } = await this.gitState(repositoryId);
    const meta = await commitMeta(state.root, sha);
    if (!meta) throw new SourceControlError('INVALID_INPUT', `Commit ${sha} was not found in this repository.`);
    const { files, truncated } = await commitFiles(state.root, meta.sha, 1000);
    const attribution = this.attributions(repositoryId, [meta.sha]).get(meta.sha) ?? null;
    return { ...meta, attribution, files, filesTruncated: truncated };
  }

  async commitDiff(repositoryId: string, sha: string, file: string): Promise<SourceControlDiff> {
    const { state } = await this.gitState(repositoryId);
    const meta = await commitMeta(state.root, sha);
    if (!meta) throw new SourceControlError('INVALID_INPUT', `Commit ${sha} was not found in this repository.`);
    const { files } = await commitFiles(state.root, meta.sha, 5000);
    const change = files.find((f) => f.path === file);
    if (!change) throw new SourceControlError('PATH_NOT_CHANGED', `${file} is not part of commit ${meta.sha.slice(0, 10)}.`);
    const result = await commitFileDiff(state.root, { sha: meta.sha, path: change.path, originalPath: change.originalPath, maxBytes: MAX_DIFF_BYTES });
    return { path: file, mode: 'staged', diff: redact(result.diff), truncated: result.truncated, binary: result.binary || (change.additions === null && change.status !== 'deleted') };
  }

  operations(repositoryId: string, limit = 30) {
    this.d.repositories.record(repositoryId);
    return this.d.operations.list(repositoryId, limit).map(toGitOperation);
  }

  // ===========================================================================
  // Mutations
  // ===========================================================================

  /**
   * The mutation protocol: replay an already-seen idempotency key; otherwise,
   * inside the repository's exclusive section, refuse while a task writes,
   * re-read Git, check the version the user acted on, journal the start,
   * act, re-read, journal the result. The repository always wins over the
   * journal: nothing is retried or "repaired" on assumption.
   */
  private async mutate(
    repositoryId: string,
    kind: GitOperationKind,
    request: { idempotencyKey: string; expectedVersion?: string },
    options: { scope?: (s: RepoState) => string; allowWhileWriting?: boolean },
    act: (e: Enriched, op: GitOperationRecord) => Promise<MutationOutcome>,
    prepare?: (e: Enriched) => Promise<{ remote?: string | null; ref?: string | null }> | { remote?: string | null; ref?: string | null },
  ): Promise<SourceControlOperationResult> {
    this.d.repositories.record(repositoryId);
    const replay = this.replay(repositoryId, kind, request.idempotencyKey);
    if (replay) return { ...replay, snapshot: await this.snapshot(repositoryId, { fresh: true }) };

    return this.d.coordinator.runMutation(repositoryId, kind, async () => {
      const again = this.replay(repositoryId, kind, request.idempotencyKey);
      if (again) return { ...again, snapshot: await this.snapshot(repositoryId, { fresh: true }) };
      if (!options.allowWhileWriting) {
        const writer = this.d.coordinator.activeWriters(repositoryId)[0];
        if (writer) {
          throw new SourceControlError('BLOCKED_BY_TASK', `${writer.taskId} is running ${writer.stageName} in this repository. Pause the task or wait for the stage to finish, then try again.`, {
            taskId: writer.taskId,
          });
        }
      }

      let current = await this.gitState(repositoryId, true);
      if (request.expectedVersion !== undefined && request.expectedVersion !== current.state.version) {
        const seen = this.versions.get(repositoryId)?.get(request.expectedVersion);
        if (!seen || !options.scope || options.scope(seen.state) !== options.scope(current.state)) {
          throw new SourceControlError('GIT_STATE_CHANGED', 'The repository changed since this view was loaded. Review the refreshed state and try again.', {
            currentVersion: current.state.version,
          });
        }
      }
      if (current.state.indexLocked) current = await this.waitForIndex(repositoryId, current);

      const target = (await prepare?.(current)) ?? {};
      const started = this.d.operations.start({
        id: newId(),
        repositoryId,
        idempotencyKey: request.idempotencyKey,
        kind,
        startedAt: now(),
        preHead: current.state.branch.oid,
        preStateVersion: current.state.version,
        remote: target.remote ?? null,
        ref: target.ref ?? null,
      });

      let outcome: MutationOutcome;
      try {
        outcome = await act(current, started);
      } catch (error) {
        const failure =
          error instanceof SourceControlError
            ? error
            : error instanceof GitCommandFailure
              ? new SourceControlError(error.code === 'GIT_FAILED' ? 'GIT_FAILED' : error.code, gitOutput(error.result) || error.message)
              : new SourceControlError('GIT_FAILED', redact((error as Error).message).slice(0, 2000));
        this.finishSafely(started.id, { status: 'failed', finishedAt: now(), errorCode: failure.code, errorSummary: failure.message });
        this.invalidate(repositoryId);
        throw new SourceControlError(failure.code, failure.message, { ...failure.details, operationId: started.id });
      }

      const after = await this.load(repositoryId, true);
      const finished = this.finishSafely(started.id, {
        status: outcome.status,
        finishedAt: now(),
        postHead: after.enriched?.state.branch.oid ?? null,
        postStateVersion: after.snapshot.version,
        commitSha: outcome.commitSha ?? null,
        errorCode: outcome.errorCode ?? null,
        errorSummary: outcome.errorSummary ?? null,
        metadata: { ...outcome.metadata, message: outcome.message, ...(outcome.skipped?.length ? { skipped: outcome.skipped } : {}) },
      });
      // The snapshot was read before the journal entry closed; show this action's result in it.
      after.snapshot = { ...after.snapshot, lastFetch: this.lastFetch(repositoryId) };
      this.invalidate(repositoryId);
      if (outcome.status === 'failed' && outcome.errorCode) {
        throw new SourceControlError(outcome.errorCode, outcome.errorSummary ?? outcome.message, { operationId: started.id });
      }
      return {
        operation: toGitOperation(finished ?? started),
        snapshot: after.snapshot,
        ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
        ...(outcome.sync ? { sync: outcome.sync } : {}),
      };
    });
  }

  /** A journal write that fails after Git acted leaves the entry `started`; restart reconciliation settles it. */
  private finishSafely(id: string, patch: Parameters<GitOperationStore['finish']>[1]): GitOperationRecord | null {
    try {
      return this.d.operations.finish(id, patch);
    } catch (error) {
      console.error(`[source-control] journal update for ${id} failed; it will be reconciled on restart: ${(error as Error).message}`);
      return null;
    }
  }

  private replay(repositoryId: string, kind: GitOperationKind, key: string): Omit<SourceControlOperationResult, 'snapshot'> | null {
    const existing = this.d.operations.byIdempotencyKey(repositoryId, key);
    if (!existing) return null;
    if (existing.kind !== kind) throw new SourceControlError('INVALID_INPUT', 'This idempotency key was already used for a different action.');
    if (existing.status === 'started') throw new SourceControlError('DUPLICATE_IN_FLIGHT', 'This action is already running.', { operationId: existing.id });
    if (existing.status === 'failed') {
      throw new SourceControlError((existing.errorCode as SourceControlErrorCode) ?? 'GIT_FAILED', existing.errorSummary ?? 'This action already failed.', { operationId: existing.id, replay: true });
    }
    const m = existing.metadata;
    return {
      operation: toGitOperation(existing),
      ...(m.skipped ? { skipped: m.skipped } : {}),
      ...(m.syncOutcome ? { sync: { outcome: m.syncOutcome as SyncOutcome, ahead: m.ahead ?? null, behind: m.behind ?? null } } : {}),
    };
  }

  /** A held index.lock usually means a Git command is finishing: wait briefly, never delete it. */
  private async waitForIndex(repositoryId: string, current: Enriched): Promise<Enriched> {
    const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(100);
      if (!indexLocked(current.state.gitDir)) return this.gitState(repositoryId, true);
    }
    throw new SourceControlError('INDEX_LOCKED', "Git's index is locked by another Git process. If no Git command is running, a crashed one left .git/index.lock behind; remove it yourself once you are sure.");
  }

  private assertNoOperation(state: RepoState): void {
    if (state.operation) throw new SourceControlError('OPERATION_IN_PROGRESS', `A ${state.operation} is in progress. Finish or abort it first; Source Control does not change the repository while it is open.`);
  }

  private assertNoConflicts(state: RepoState): void {
    if (state.entries.some((e) => e.conflicted)) throw new SourceControlError('CONFLICTS', 'Resolve the conflicts first. Source Control never resolves them for you.');
  }

  private assertBranch(state: RepoState, action: string): string {
    if (state.branch.detached || !state.branch.head) throw new SourceControlError('DETACHED_HEAD', `HEAD is detached. Check out a branch before you ${action}.`);
    return state.branch.head;
  }

  async stage(repositoryId: string, request: { idempotencyKey: string; expectedVersion: string; paths?: string[]; all?: true; confirmMixed?: string[] }): Promise<SourceControlOperationResult> {
    const all = request.all === true;
    return this.mutate(repositoryId, 'stage', request, { scope: all ? scopes.worktree : scopes.paths(request.paths ?? []) }, async (e) => {
      const { state } = e;
      this.assertNoOperation(state);
      const skipped: Array<{ path: string; reason: string }> = [];
      let paths: string[];
      if (all) {
        const eligible: string[] = [];
        for (const entry of state.entries) {
          if (!(entry.unstaged || entry.untracked)) continue;
          if (entry.conflicted) {
            skipped.push({ path: entry.path, reason: 'conflicted' });
            continue;
          }
          const sensitive = sensitiveFileReason(entry.path);
          if (sensitive) {
            skipped.push({ path: entry.path, reason: `looks like ${sensitive}; stage it on its own if you really mean to` });
            continue;
          }
          eligible.push(entry.path);
        }
        if (eligible.length === 0) throw new SourceControlError('NOTHING_TO_STAGE', 'There is nothing Stage All may stage.', { skipped });
        const confirmed = new Set(request.confirmMixed ?? []);
        const mixed = eligible.filter((p) => e.attribution.get(p) === 'both');
        const unconfirmed = mixed.filter((p) => !confirmed.has(p));
        if (unconfirmed.length) {
          throw new SourceControlError('MIXED_CHANGES_UNCONFIRMED', `${unconfirmed.length} file${unconfirmed.length === 1 ? ' mixes' : 's mix'} your earlier work with task changes. Confirm the exact list to include them.`, {
            paths: unconfirmed,
          });
        }
        paths = eligible;
      } else {
        paths = [...new Set(request.paths ?? [])];
        for (const p of paths) {
          const entry = state.byPath.get(p);
          if (entry?.conflicted) throw new SourceControlError('CONFLICTS', `${p} is conflicted. Resolve it in your editor first.`, { path: p });
          if (!entry || !(entry.unstaged || entry.untracked)) throw new SourceControlError('PATH_NOT_CHANGED', `${p} has no unstaged changes.`, { path: p });
        }
      }
      const result = await stagePaths(state.root, paths);
      if (result.code !== 0) throw new SourceControlError(mapFailure(result), gitOutput(result) || 'git add failed');
      return { status: 'succeeded', message: `Staged ${paths.length} file${paths.length === 1 ? '' : 's'}`, metadata: { pathCount: paths.length }, skipped };
    });
  }

  async unstage(repositoryId: string, request: { idempotencyKey: string; expectedVersion: string; paths?: string[]; all?: true }): Promise<SourceControlOperationResult> {
    const all = request.all === true;
    return this.mutate(repositoryId, 'unstage', request, { scope: all ? scopes.index : scopes.paths(request.paths ?? []) }, async ({ state }) => {
      this.assertNoOperation(state);
      const entries = all ? state.entries.filter((x) => x.staged) : [...new Set(request.paths ?? [])].map((p) => state.byPath.get(p));
      if (!all) {
        (request.paths ?? []).forEach((p, i) => {
          const entry = entries[i];
          if (!entry || !entry.staged) throw new SourceControlError('PATH_NOT_CHANGED', `${p} has nothing staged.`, { path: p });
        });
      }
      if (entries.length === 0) throw new SourceControlError('NOTHING_STAGED', 'Nothing is staged.');
      // Unstaging a rename must also restore its source path, or its deletion would stay staged.
      const paths = [...new Set(entries.flatMap((x) => (x!.originalPath ? [x!.path, x!.originalPath] : [x!.path])))];
      const result = await unstagePaths(state.root, paths, { hasHead: state.hasHead });
      if (result.code !== 0) throw new SourceControlError(mapFailure(result), gitOutput(result) || 'git restore failed');
      return { status: 'succeeded', message: `Unstaged ${entries.length} file${entries.length === 1 ? '' : 's'}`, metadata: { pathCount: entries.length } };
    });
  }

  async commitStaged(repositoryId: string, request: { idempotencyKey: string; expectedVersion: string; message: string }): Promise<SourceControlOperationResult> {
    return this.mutate(repositoryId, 'commit', request, { scope: scopes.index }, async ({ state }, op) => {
      this.assertNoOperation(state);
      this.assertNoConflicts(state);
      this.assertBranch(state, 'commit');
      const staged = state.entries.filter((x) => x.staged);
      if (staged.length === 0) throw new SourceControlError('NOTHING_STAGED', 'Nothing is staged. Stage the files to commit first.');

      const { patch, truncated } = await stagedPatch(state.root, { hasHead: state.hasHead, maxBytes: MAX_PREFLIGHT_BYTES });
      if (truncated) throw new SourceControlError('PREFLIGHT_INCOMPLETE', 'The staged changes are too large to check for secrets (over 20 MB). Commit them from a terminal after checking them yourself.');
      const findings = preflightFindings(staged.map((x) => x.path), patch);
      if (findings.length) throw new SourceControlError('SENSITIVE_CONTENT', 'The staged changes include secret material. Unstage these files or remove the secrets, then commit again.', { findings });

      const message = request.message.replace(/\r\n/g, '\n').trim();
      this.d.operations.note(op.id, { messageHash: sha256(message), pathCount: staged.length });
      const result = await commitStaged(state.root, message);
      if (result.code !== 0) {
        const code = mapFailure(result);
        const hooked = code === 'GIT_FAILED' && (await hooksInstalled(state.root, ['pre-commit', 'commit-msg', 'prepare-commit-msg']));
        const final: SourceControlErrorCode = code === 'GIT_FAILED' ? (hooked ? 'HOOK_FAILED' : 'COMMIT_FAILED') : code;
        const lead = final === 'HOOK_FAILED' ? 'A Git hook rejected the commit; the staged changes are untouched.' : 'The commit failed; the staged changes are untouched.';
        throw new SourceControlError(final, `${lead}\n${gitOutput(result)}`.trim());
      }
      const sha = await headCommit(state.root);
      if (!sha || sha === state.branch.oid) throw new SourceControlError('COMMIT_FAILED', 'Git reported success but HEAD did not move.');
      return { status: 'succeeded', message: `Committed ${staged.length} file${staged.length === 1 ? '' : 's'} as ${sha.slice(0, 10)}`, commitSha: sha };
    });
  }

  /** The remote Fetch and Sync use: the upstream's, else `origin`, else the only remote. */
  private async fetchTarget(state: RepoState): Promise<string> {
    if (state.branch.head) {
      const upstream = await branchUpstream(state.root, state.branch.head);
      if (upstream) return upstream.remote;
    }
    if (state.remotes.includes('origin')) return 'origin';
    if (state.remotes.length === 1) return state.remotes[0]!;
    throw new SourceControlError('UNKNOWN_REMOTE', state.remotes.length ? 'This branch has no upstream and there is no "origin" remote to fetch.' : 'This repository has no remote.');
  }

  async fetch(repositoryId: string, request: { idempotencyKey: string; expectedVersion?: string }): Promise<SourceControlOperationResult> {
    let remote = '';
    return this.mutate(
      repositoryId,
      'fetch',
      request,
      // Fetch only updates remote-tracking refs; it is safe while a task edits files.
      { scope: scopes.branch, allowWhileWriting: true },
      async ({ state }) => {
        const result = await fetchRemote(state.root, remote);
        if (result.code !== 0) throw new SourceControlError(mapFailure(result), gitOutput(result) || `git fetch ${remote} failed`);
        return { status: 'succeeded', message: `Fetched ${remote}` };
      },
      async ({ state }) => {
        remote = await this.fetchTarget(state);
        return { remote };
      },
    );
  }

  /**
   * Safe Sync (plan §3.6): fetch, then push when only ahead, fast-forward
   * when only behind with clean tracked files, and stop — without merging or
   * rebasing — when diverged, dirty, conflicted or without an upstream.
   */
  async sync(repositoryId: string, request: { idempotencyKey: string; expectedVersion: string }): Promise<SourceControlOperationResult> {
    return this.mutate(repositoryId, 'sync', request, { scope: scopes.branch }, async ({ state }, op) => {
      this.assertNoOperation(state);
      this.assertNoConflicts(state);
      const branch = this.assertBranch(state, 'sync');
      if (!state.hasHead) throw new SourceControlError('NO_UPSTREAM', 'This branch has no commits yet.');
      const upstream = await branchUpstream(state.root, branch);
      if (!upstream || !state.branch.upstream) throw new SourceControlError('NO_UPSTREAM', `${branch} has no upstream. Publish the branch to choose where it goes.`);

      const fetched = await fetchRemote(state.root, upstream.remote);
      if (fetched.code !== 0) throw new SourceControlError(mapFailure(fetched), gitOutput(fetched) || `git fetch ${upstream.remote} failed`);
      const upstreamSha = await revParse(state.root, '@{upstream}');
      if (!upstreamSha) throw new SourceControlError('UPSTREAM_GONE', `${state.branch.upstream} no longer exists on ${upstream.remote}. Publish the branch again or choose another upstream in a terminal.`);
      const counts = await aheadBehind(state.root, 'HEAD', '@{upstream}');
      if (!counts) throw new SourceControlError('GIT_FAILED', 'Could not compare the branch with its upstream.');
      const { ahead, behind } = counts;
      const result = (outcome: SyncOutcome, message: string, extra: Partial<MutationOutcome> = {}): MutationOutcome => ({
        status: 'succeeded',
        message,
        metadata: { syncOutcome: outcome, ahead, behind, ...extra.metadata },
        sync: { outcome, ahead, behind },
        ...extra,
      });

      if (ahead === 0 && behind === 0) return result('up-to-date', `Fetched ${upstream.remote}; ${branch} is up to date with ${state.branch.upstream}`);
      if (ahead > 0 && behind > 0) {
        return result('diverged', `${branch} and ${state.branch.upstream} have diverged (${ahead} local, ${behind} remote commits). Sync never merges or rebases: reconcile them in a terminal or editor.`);
      }
      if (behind > 0) {
        const dirty = state.entries.some((x) => x.staged || x.unstaged);
        if (dirty) {
          return result('behind-dirty', `Fetched ${upstream.remote}: ${behind} new commit${behind === 1 ? '' : 's'} on ${state.branch.upstream}. Your uncommitted changes were left alone; commit them, then sync to fast-forward.`);
        }
        this.d.operations.note(op.id, { fastForwardTo: upstreamSha });
        const ff = await fastForward(state.root, upstreamSha);
        if (ff.code !== 0) throw new SourceControlError(mapFailure(ff), gitOutput(ff) || 'Fast-forward failed');
        return result('fast-forwarded', `Fast-forwarded ${branch} by ${behind} commit${behind === 1 ? '' : 's'}`);
      }
      // Only ahead: push without any force option, after the secret preflight.
      await this.pushPreflight(state.root, 'HEAD', '@{upstream}');
      const pushedSha = state.branch.oid!;
      this.d.operations.note(op.id, { pushedSha });
      const push = await pushRef(state.root, { remote: upstream.remote, localBranch: branch, remoteRef: upstream.mergeRef, setUpstream: false });
      if (push.code !== 0) throw new SourceControlError(mapFailure(push), gitOutput(push) || 'Push failed');
      return result('pushed', `Pushed ${ahead} commit${ahead === 1 ? '' : 's'} to ${state.branch.upstream}`, { remote: upstream.remote, ref: upstream.mergeRef });
    }, (e) => ({ remote: null, ref: e.state.branch.upstream }));
  }

  /**
   * Background sync (docs/systems/repository-automation.md): fetch, then
   * fast-forward only when the branch is purely behind its upstream, its
   * tracked files are clean, no task is writing and no unfinished task works
   * on this branch. Never pushes, merges or rebases. The fetch only moves
   * remote-tracking refs and is not journalled; a fast-forward is, as
   * `fast_forward`, so restart recovery can settle it.
   */
  async backgroundSync(repositoryId: string): Promise<RepositorySyncResult> {
    const repo = this.d.repositories.record(repositoryId);
    const at = now();
    const result = (outcome: RepositorySyncOutcome, message: string, counts?: { ahead: number; behind: number }): RepositorySyncResult => ({
      repositoryId,
      outcome,
      message,
      ahead: counts?.ahead ?? null,
      behind: counts?.behind ?? null,
      at,
    });
    if (!existsSync(repo.path)) return result('skipped', 'The folder no longer exists.');
    let state: RepoState;
    try {
      state = await this.readState(repo);
    } catch {
      return result('skipped', 'Not a Git repository.');
    }
    const branch = state.branch.head;
    if (!branch) return result('skipped', 'HEAD is detached; there is no branch to update.');
    if (!state.hasHead) return result('skipped', `${branch} has no commits yet.`);
    const upstream = await branchUpstream(state.root, branch);
    if (!upstream || !state.branch.upstream) return result('skipped', `${branch} has no upstream to download from.`);

    try {
      // Serialized with Source Control actions; safe while a task edits files.
      const fetched = await this.d.coordinator.runMutation(repositoryId, 'fetch', () => fetchRemote(state.root, upstream.remote, { unattended: true }));
      if (fetched.code !== 0) return result('failed', `Could not fetch ${upstream.remote}: ${gitOutput(fetched).split('\n')[0] || 'git fetch failed'}`);
      if (!(await revParse(state.root, '@{upstream}'))) return result('failed', `${state.branch.upstream} no longer exists on ${upstream.remote}.`);
      const counts = await aheadBehind(state.root, 'HEAD', '@{upstream}');
      if (!counts) return result('failed', `Could not compare ${branch} with ${state.branch.upstream}.`);
      const { ahead, behind } = counts;
      if (ahead === 0 && behind === 0) return result('up-to-date', `${branch} matches ${state.branch.upstream}.`, counts);
      if (ahead > 0 && behind > 0) return result('diverged', `${branch} and ${state.branch.upstream} have diverged; background sync never merges or rebases.`, counts);
      if (ahead > 0) return result('ahead', `${ahead} local commit${ahead === 1 ? '' : 's'} not uploaded. Uploading is never automatic: use Sync in Source Control.`, counts);

      if (state.operation) return result('skipped', `A ${state.operation} is in progress.`, counts);
      if (state.entries.some((e) => e.staged || e.unstaged || e.conflicted)) {
        return result('behind-dirty', `${behind} new commit${behind === 1 ? '' : 's'} on ${state.branch.upstream}; left alone because of uncommitted changes.`, counts);
      }
      const blocker = this.branchBlocker(repositoryId, branch);
      if (blocker) return result('skipped', blocker, counts);
      const done = await this.fastForwardUpstream(repositoryId);
      return result('fast-forwarded', done.operation.message ?? `Fast-forwarded ${branch} by ${behind}.`, counts);
    } catch (error) {
      if (error instanceof SourceControlError && (error.code === 'BLOCKED_BY_TASK' || error.code === 'GIT_STATE_CHANGED' || error.code === 'WORKTREE_DIRTY')) {
        return result('skipped', error.message);
      }
      return result('failed', redact((error as Error).message).slice(0, 500));
    } finally {
      this.invalidate(repositoryId);
    }
  }

  /** Why an unfinished task makes moving `branch` unsafe: its diff is measured against that branch. */
  private branchBlocker(repositoryId: string, branch: string): string | null {
    const task = this.d.store
      .listTasks({ repositoryId, statuses: ['QUEUED', 'RUNNING', 'PAUSED', 'WAITING_FOR_USER', 'WAITING_FOR_USAGE_RESET', 'INTERRUPTED', 'FAILED'], limit: 50 })
      .find((t) => (t.git.taskBranch ?? t.git.baselineBranch) === branch);
    return task ? `${task.id} is unfinished on ${branch}; finish or cancel it before its branch moves.` : null;
  }

  /** The journalled half of background sync. Re-checks everything inside the repository's exclusive section. */
  private fastForwardUpstream(repositoryId: string): Promise<SourceControlOperationResult> {
    return this.mutate(repositoryId, 'fast_forward', { idempotencyKey: `auto-ff-${newId()}` }, { scope: scopes.branch }, async ({ state }, op) => {
      this.assertNoOperation(state);
      this.assertNoConflicts(state);
      const branch = this.assertBranch(state, 'fast-forward');
      const upstreamSha = await revParse(state.root, '@{upstream}');
      if (!upstreamSha) throw new SourceControlError('UPSTREAM_GONE', `${state.branch.upstream ?? 'The upstream'} no longer exists.`);
      const counts = await aheadBehind(state.root, 'HEAD', '@{upstream}');
      if (!counts || counts.ahead > 0 || counts.behind === 0) throw new SourceControlError('GIT_STATE_CHANGED', `${branch} changed before it could be fast-forwarded.`);
      if (state.entries.some((e) => e.staged || e.unstaged)) throw new SourceControlError('WORKTREE_DIRTY', `${branch} has uncommitted changes; it was left alone.`);
      this.d.operations.note(op.id, { fastForwardTo: upstreamSha });
      const ff = await fastForward(state.root, upstreamSha);
      if (ff.code !== 0) throw new SourceControlError(mapFailure(ff), gitOutput(ff) || 'Fast-forward failed');
      const { behind } = counts;
      return {
        status: 'succeeded',
        message: `Downloaded ${behind} commit${behind === 1 ? '' : 's'} from ${state.branch.upstream} (automatic fast-forward)`,
        metadata: { syncOutcome: 'fast-forwarded', ahead: 0, behind, automatic: true },
        sync: { outcome: 'fast-forwarded', ahead: 0, behind },
      };
    }, (e) => ({ remote: null, ref: e.state.branch.upstream }));
  }

  async publish(repositoryId: string, request: { idempotencyKey: string; expectedVersion: string; remote: string }): Promise<SourceControlOperationResult> {
    return this.mutate(repositoryId, 'publish', request, { scope: scopes.branch }, async ({ state }, op) => {
      this.assertNoOperation(state);
      const branch = this.assertBranch(state, 'publish');
      if (!state.hasHead) throw new SourceControlError('INVALID_INPUT', 'Commit something before publishing the branch.');
      if (!state.remotes.includes(request.remote)) throw new SourceControlError('UNKNOWN_REMOTE', `There is no remote named "${request.remote}".`);
      const existing = await branchUpstream(state.root, branch);
      if (existing && state.branch.ahead !== null) throw new SourceControlError('INVALID_INPUT', `${branch} is already published to ${state.branch.upstream}. Use Sync.`);
      await this.pushPreflight(state.root, 'HEAD', null);
      this.d.operations.note(op.id, { pushedSha: state.branch.oid! });
      const push = await pushRef(state.root, { remote: request.remote, localBranch: branch, remoteRef: `refs/heads/${branch}`, setUpstream: true });
      if (push.code !== 0) throw new SourceControlError(mapFailure(push), gitOutput(push) || 'Publish failed');
      return { status: 'succeeded', message: `Published ${branch} to ${request.remote}/${branch}` };
    }, (e) => ({ remote: request.remote, ref: e.state.branch.head ? `refs/heads/${e.state.branch.head}` : null }));
  }

  private async pushPreflight(root: string, tip: string, exclude: string | null): Promise<void> {
    const { patch, truncated } = await outgoingPatch(root, { tip, exclude, maxBytes: MAX_PREFLIGHT_BYTES });
    if (truncated) throw new SourceControlError('PREFLIGHT_INCOMPLETE', 'The commits to push are too large to check for secrets (over 20 MB). Push them from a terminal after checking them yourself.');
    const findings = preflightFindings(splitPatch(patch).files, patch);
    if (findings.length) {
      throw new SourceControlError('SENSITIVE_CONTENT', 'The commits to push include secret material. Remove it from those commits (outside Source Control) before pushing.', { findings });
    }
  }

  // ===========================================================================
  // For AI assistance
  // ===========================================================================

  /** Current state for callers that read the index (commit message, staged review). */
  async stagedContext(repositoryId: string, expectedVersion: string): Promise<RepoState> {
    const { state } = await this.gitState(repositoryId, true);
    if (expectedVersion !== state.version) {
      const seen = this.versions.get(repositoryId)?.get(expectedVersion);
      if (!seen || scopes.index(seen.state) !== scopes.index(state)) {
        throw new SourceControlError('GIT_STATE_CHANGED', 'The staged changes changed since this view was loaded. Review them and try again.', { currentVersion: state.version });
      }
    }
    if (!state.entries.some((e) => e.staged)) throw new SourceControlError('NOTHING_STAGED', 'Nothing is staged.');
    return state;
  }
}

function mapFailure(result: GitResult): SourceControlErrorCode {
  return classifyGitOutput(result);
}

function encodeCursor(cursor: { tips: string[]; skip: number }): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): { tips: string[]; skip: number } {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { tips?: unknown; skip?: unknown };
    const tips = Array.isArray(value.tips) ? value.tips.filter((t): t is string => typeof t === 'string' && /^[0-9a-f]{40,64}$/.test(t)) : [];
    const skip = typeof value.skip === 'number' && Number.isInteger(value.skip) && value.skip >= 0 && value.skip <= 10_000_000 ? value.skip : -1;
    if (!tips.length || tips.length > 4 || skip < 0) throw new Error('bad cursor');
    return { tips, skip };
  } catch {
    throw new SourceControlError('INVALID_INPUT', 'Invalid history cursor.');
  }
}
