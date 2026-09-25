import type {
  CommandKind,
  ErrorClass,
  PermissionLevel,
  Role,
  StageStatus,
  TaskMode,
  TaskStatus,
} from './constants.js';

/** Human-facing copy shared by the dashboard, the WebView and the VS Code status bar. */

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  DRAFT: 'Draft',
  QUEUED: 'Queued',
  RUNNING: 'Running',
  PAUSED: 'Paused',
  WAITING_FOR_USER: 'Waiting for user',
  WAITING_FOR_USAGE_RESET: 'Waiting for usage reset',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  COMPLETED: 'Completed',
  INTERRUPTED: 'Interrupted',
};

export const STAGE_STATUS_LABEL: Record<StageStatus, string> = {
  PENDING: 'Pending',
  READY: 'Ready',
  STARTING: 'Starting',
  RUNNING: 'Running',
  SUCCESS: 'Passed',
  FAILED: 'Failed',
  RETRYING: 'Retrying',
  WAITING_APPROVAL: 'Waiting for approval',
  PAUSED: 'Paused',
  CANCELLED: 'Cancelled',
  INTERRUPTED: 'Interrupted',
  SKIPPED: 'Skipped',
};

export const ROLE_LABEL: Record<Role, string> = {
  investigator: 'Investigator',
  planner: 'Planner',
  implementer: 'Implementer',
  tester: 'Tester',
  reviewer: 'Reviewer',
  fixer: 'Fixer',
  verifier: 'Verifier',
  deployer: 'Deployer',
  reporter: 'Reporter',
};

/** Present-participle form for "Codex Investigating" style status text. */
export const ROLE_ACTIVITY: Record<Role, string> = {
  investigator: 'Investigating',
  planner: 'Planning',
  implementer: 'Implementing',
  tester: 'Testing',
  reviewer: 'Reviewing',
  fixer: 'Fixing',
  verifier: 'Verifying',
  deployer: 'Deploying',
  reporter: 'Reporting',
};

export const MODE_LABEL: Record<TaskMode, string> = {
  discuss: 'Discuss First',
  autopilot: 'Autopilot',
};

export const MODE_HELP: Record<TaskMode, string> = {
  discuss:
    'The task stops after planning so you can review the plan. Implementation starts only after you approve it.',
  autopilot:
    'The task runs investigation, planning, implementation, tests, review and verification without stopping. Levels above your approval threshold still wait for you.',
};

export const PERMISSION_LEVEL_INFO: Record<PermissionLevel, { name: string; description: string }> = {
  1: { name: 'Analyze', description: 'Read the repository, inspect Git, investigate and plan. No file changes.' },
  2: { name: 'Develop', description: 'Edit files, install dependencies, run local commands, tests and builds.' },
  3: { name: 'Git', description: 'Create branches and commits. Push and pull requests only with Git permission.' },
  4: { name: 'Infrastructure', description: 'Staging deploys, staging migrations and cloud resource changes.' },
  5: { name: 'Production', description: 'Production deploys, production migrations and destructive operations.' },
};

export const ERROR_CLASS_LABEL: Record<ErrorClass, string> = {
  AUTH_FAILURE: 'Authentication failed',
  USAGE_LIMIT: 'Usage limit reached',
  COMMAND_FAILURE: 'Command failed',
  MODEL_UNAVAILABLE: 'Model unavailable',
  TIMEOUT: 'Timed out',
  PROCESS_CRASH: 'Process crashed',
  TEST_FAILURE: 'Tests failed',
  CONTEXT_FAILURE: 'Context could not be built',
  PERMISSION_DENIED: 'Permission denied',
  REVIEW_INCOMPLETE: 'Review left changed files unread',
  UNKNOWN: 'Unknown error',
};

export const COMMAND_KIND_LABEL: Record<CommandKind, string> = {
  lint: 'Lint',
  typecheck: 'Typecheck',
  test: 'Unit tests',
  build: 'Build',
  e2e: 'End-to-end tests',
  smoke: 'Smoke test',
  'deploy-staging': 'Staging deploy',
  other: 'Other',
};
