# Plan — Chairman AI Supervisor + Direct Control Chat

Status: implemented 2026-09-23. System reference: [docs/systems/chairman.md](../systems/chairman.md).

## Goal (from the operator's plan)

A task-scoped **Chairman** that supervises Full Autopilot, keeps recoverable
work moving, and is available to the user through a chat on the task page.
Principle: *the orchestrator owns state, agents do work, the Chairman owns
supervision and recovery, and the user can guide it without bypassing safety
or workflow integrity.* Every automatic or chat action goes through one typed,
validated Action Gateway; the Chairman is never a second orchestrator.

## Mapping to the real codebase

| Plan concept | Where it lives |
|---|---|
| Source of truth, transitions | `TaskEngine` (unchanged role); new `redirect`, `stopAndApply`, `pauseAfterStage`, `block`, `setAssignment`, `requestChecks`, `watchdogStop`, `reconcileGhost` |
| "Fix N of 3" | `tasks.fix_cycles` / `max_fix_cycles` — now the *local* budget of one strategy |
| Where retries became terminal | `handleOutcome` (fix limit → `WAITING_FOR_USER`) and `handleError` (→ `FAILED`); supervised tasks now ask the Chairman there |
| Task Contract | `task_contracts` (versioned; new version on goal change or constraint) |
| Chairman session | `chairman_sessions` (status, health, strategy, tried fingerprints) |
| Event model | existing `task_events` + new types `CHAIRMAN_DECISION`, `CHAIRMAN_ACTION`, `RECOVERY_CYCLE`, `TASK_REDIRECTED`, `CHECKPOINT_CREATED`, `ROLLBACK_COMPLETED`, `DIRECTIVE_REMOVED`, `WATCHDOG` |
| Directives | existing `task_directives`, extended (scope, kind, state, rule) |
| Model routing | existing task stage overrides; Chairman changes them deferred |
| Reasoning adapter | existing `AgentAdapter` contract, read-only run |
| Git checkpoints | new `createCheckpoint` / `restoreCheckpoint` in `@acc/git` |
| Lease / concurrency | engine loop per task (one worker) + gateway per-task lock + `tasks.version` stale check |
| HARD_BLOCKED / PAUSED_LIMIT | `WAITING_FOR_USER` with blocker kind `hard_blocker` / `limit` (no new task status, so every client keeps working) |
| SUCCEEDED | `COMPLETED` with `finalStatus = READY`, which now also requires the Chairman's completion gate |

## Decisions and deviations

- **No new task statuses.** Hard blockers and limits are blocker kinds of
  `WAITING_FOR_USER`: VS Code, the task list and notifications already treat it
  as "needs you". Neither is ever reported as `FAILED`.
- **Cost limit = agent runs.** Subscription CLIs report no reliable cost; the
  runtime limit counts agent and command time, not wall-clock waiting.
- **Provider blocks reroute** to another enabled, healthy subscription agent
  (never to paid API billing); otherwise the existing usage/auth waits apply.
- **Supervision is fixed at task creation.** Old tasks (migration default 0) and
  Discuss First tasks behave exactly as before.
- **Chat cannot cancel a task** (irreversible); the UI's confirmed Cancel stays.
- **RUN_TARGETED_TESTS** re-runs the configured test stage: repository commands
  have no finer targeting.

## Verification

Unit, integration, migration and end-to-end tests: see
`apps/orchestrator/test/chairman*.test.ts`, `migrations.test.ts`,
`packages/git/test/git.test.ts`, `apps/dashboard/e2e/chairman.spec.ts`.
Scenarios A–G of the plan, chat (question, directive, redirect, routing,
hypothetical and real rollback, pause boundary), prompt injection, restart,
stale decision and idempotency each have a named test.

## Found for later

1. Global Chairman console across tasks (medium).
2. Cross-task learning of which strategies/agents work (medium; needs data).
3. Dynamic specialist agents (low–medium).
4. Workspace-wide permanent directives (medium).
5. Semantic failure clustering (low; signatures suffice so far).
6. Chairman performance dashboard — recovery success rate, cycles, runs (medium; next recommended task).
7. Voice control (low).
8. Workflow profiles that loop through `onFail` from a stage without a verdict
   cannot be expressed; the Chairman covers `no_fail_route` instead.
9. Checkpoints respect `.gitattributes` EOL rules on restore; a byte-exact
   restore for such files would need `--no-filters` plumbing.
