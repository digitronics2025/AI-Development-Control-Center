import type { GitOperation, GitOperationKind, GitOperationStatus } from '@acc/shared';
import type { Db } from '../db/database.js';

/**
 * Operational metadata kept with a journal entry. Bounded and free of
 * secrets: counts, outcomes and hashes, never paths lists of unbounded size,
 * diffs, command lines or remote URLs.
 */
export interface GitOperationMetadata {
  /** Short human summary shown in the UI and reused for idempotent replays. */
  message?: string;
  /** sha256 of the commit message, to recognise the commit during recovery. */
  messageHash?: string;
  pathCount?: number;
  syncOutcome?: string;
  ahead?: number | null;
  behind?: number | null;
  skipped?: Array<{ path: string; reason: string }>;
  /** Commit a push is about to deliver; written before pushing so recovery can check the remote. */
  pushedSha?: string;
  /** Commit a fast-forward is about to move HEAD to; written before moving. */
  fastForwardTo?: string;
}

export interface GitOperationRecord extends GitOperation {
  idempotencyKey: string;
  preStateVersion: string | null;
  postStateVersion: string | null;
  metadata: GitOperationMetadata;
}

type Row = Record<string, any>;

const MAX_METADATA_CHARS = 16_000;
const MAX_SUMMARY_CHARS = 2_000;

function toRecord(r: Row): GitOperationRecord {
  let metadata: GitOperationMetadata = {};
  try {
    metadata = JSON.parse(r.metadata_json) as GitOperationMetadata;
  } catch {
    /* keep empty */
  }
  return {
    id: r.id,
    repositoryId: r.repository_id,
    taskId: r.task_id,
    executionId: r.execution_id,
    idempotencyKey: r.idempotency_key,
    kind: r.kind,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    preHead: r.pre_head,
    postHead: r.post_head,
    preStateVersion: r.pre_state_version,
    postStateVersion: r.post_state_version,
    remote: r.remote,
    ref: r.ref,
    commitSha: r.commit_sha,
    errorCode: r.error_code,
    errorSummary: r.error_summary,
    message: metadata.message ?? null,
    metadata,
  };
}

function encodeMetadata(metadata: GitOperationMetadata): string {
  const text = JSON.stringify(metadata);
  if (text.length <= MAX_METADATA_CHARS) return text;
  // Drop the only unbounded field first; the rest is small by construction.
  const { skipped, ...rest } = metadata;
  return JSON.stringify({ ...rest, skippedCount: skipped?.length ?? 0 });
}

/** Public projection: the idempotency key and state versions stay server-side. */
export function toGitOperation(r: GitOperationRecord): GitOperation {
  return {
    id: r.id,
    repositoryId: r.repositoryId,
    taskId: r.taskId,
    executionId: r.executionId,
    kind: r.kind,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    preHead: r.preHead,
    postHead: r.postHead,
    remote: r.remote,
    ref: r.ref,
    commitSha: r.commitSha,
    errorCode: r.errorCode,
    errorSummary: r.errorSummary,
    message: r.message,
  };
}

/** The Source Control operation journal (`git_operations`, migration 3). */
export class GitOperationStore {
  constructor(private readonly db: Db) {}

  /** Insert a `started` entry. Throws on a duplicate idempotency key (UNIQUE index). */
  start(input: {
    id: string;
    repositoryId: string;
    idempotencyKey: string;
    kind: GitOperationKind;
    startedAt: string;
    preHead: string | null;
    preStateVersion: string | null;
    remote?: string | null;
    ref?: string | null;
    taskId?: string | null;
    metadata?: GitOperationMetadata;
  }): GitOperationRecord {
    this.db
      .prepare(
        `INSERT INTO git_operations (id, repository_id, task_id, execution_id, idempotency_key, kind, status, started_at, pre_head, pre_state_version, remote, ref, metadata_json)
         VALUES (?, ?, ?, NULL, ?, ?, 'started', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.repositoryId,
        input.taskId ?? null,
        input.idempotencyKey,
        input.kind,
        input.startedAt,
        input.preHead,
        input.preStateVersion,
        input.remote ?? null,
        input.ref ?? null,
        encodeMetadata(input.metadata ?? {}),
      );
    return this.get(input.id)!;
  }

  finish(
    id: string,
    patch: {
      status: Exclude<GitOperationStatus, 'started'>;
      finishedAt: string;
      postHead?: string | null;
      postStateVersion?: string | null;
      commitSha?: string | null;
      errorCode?: string | null;
      errorSummary?: string | null;
      metadata?: GitOperationMetadata;
    },
  ): GitOperationRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Git operation ${id} not found`);
    this.db
      .prepare(
        `UPDATE git_operations SET status = ?, finished_at = ?, post_head = ?, post_state_version = ?, commit_sha = ?, error_code = ?, error_summary = ?, metadata_json = ? WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.finishedAt,
        patch.postHead ?? current.postHead,
        patch.postStateVersion ?? current.postStateVersion,
        patch.commitSha ?? current.commitSha,
        patch.errorCode ?? null,
        patch.errorSummary ? patch.errorSummary.slice(0, MAX_SUMMARY_CHARS) : null,
        encodeMetadata({ ...current.metadata, ...patch.metadata }),
        id,
      );
    return this.get(id)!;
  }

  /** Record intent before a risky step (the commit a push delivers), so a crash can be reconciled. */
  note(id: string, metadata: GitOperationMetadata): void {
    const current = this.get(id);
    if (!current) return;
    this.db.prepare('UPDATE git_operations SET metadata_json = ? WHERE id = ?').run(encodeMetadata({ ...current.metadata, ...metadata }), id);
  }

  get(id: string): GitOperationRecord | null {
    const row = this.db.prepare('SELECT * FROM git_operations WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  byIdempotencyKey(repositoryId: string, key: string): GitOperationRecord | null {
    const row = this.db.prepare('SELECT * FROM git_operations WHERE repository_id = ? AND idempotency_key = ?').get(repositoryId, key) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** Entries a crash may have left open. */
  open(): GitOperationRecord[] {
    return (this.db.prepare("SELECT * FROM git_operations WHERE status IN ('started', 'uncertain') ORDER BY started_at").all() as Row[]).map(toRecord);
  }

  list(repositoryId: string, limit = 50): GitOperationRecord[] {
    return (this.db.prepare('SELECT * FROM git_operations WHERE repository_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(repositoryId, limit) as Row[]).map(toRecord);
  }

  latest(repositoryId: string, kind: GitOperationKind): GitOperationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM git_operations WHERE repository_id = ? AND kind = ? AND status != 'started' ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(repositoryId, kind) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** Journal entries that produced one of these commits. */
  byCommits(repositoryId: string, shas: string[]): Map<string, GitOperationRecord> {
    const map = new Map<string, GitOperationRecord>();
    if (!shas.length) return map;
    const placeholders = shas.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM git_operations WHERE repository_id = ? AND commit_sha IN (${placeholders}) AND kind = 'commit'`)
      .all(repositoryId, ...shas) as Row[];
    for (const row of rows) map.set(row.commit_sha, toRecord(row));
    return map;
  }
}
