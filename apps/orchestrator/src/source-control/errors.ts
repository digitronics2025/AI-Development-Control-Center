import type { SourceControlErrorCode } from '@acc/shared';

/** A Source Control failure with a stable code the API and UI understand. */
export class SourceControlError extends Error {
  constructor(
    readonly code: SourceControlErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SourceControlError';
  }
}

/**
 * HTTP status per code. Remote authentication failures are 502, never 401:
 * the dashboard treats 401 as "its own local token was rejected".
 */
export const SOURCE_CONTROL_HTTP_STATUS: Record<SourceControlErrorCode, number> = {
  NOT_A_REPOSITORY: 409,
  REPOSITORY_UNAVAILABLE: 409,
  GIT_UNAVAILABLE: 503,
  GIT_FAILED: 422,
  GIT_STATE_CHANGED: 409,
  BLOCKED_BY_TASK: 423,
  OPERATION_IN_PROGRESS: 409,
  INDEX_LOCKED: 423,
  CONFLICTS: 409,
  DETACHED_HEAD: 409,
  NO_UPSTREAM: 409,
  UPSTREAM_GONE: 409,
  NOTHING_STAGED: 409,
  NOTHING_TO_STAGE: 409,
  PATH_NOT_CHANGED: 409,
  INVALID_PATH: 400,
  INVALID_INPUT: 400,
  MIXED_CHANGES_UNCONFIRMED: 409,
  SENSITIVE_CONTENT: 422,
  PREFLIGHT_INCOMPLETE: 422,
  HOOK_FAILED: 422,
  IDENTITY_MISSING: 422,
  SIGNING_FAILED: 422,
  COMMIT_FAILED: 422,
  REMOTE_AUTH_FAILED: 502,
  REMOTE_REJECTED: 409,
  NETWORK: 502,
  DIVERGED: 409,
  WORKTREE_DIRTY: 409,
  UNKNOWN_REMOTE: 400,
  DUPLICATE_IN_FLIGHT: 409,
  UNCERTAIN: 409,
  AGENT_UNAVAILABLE: 503,
};
