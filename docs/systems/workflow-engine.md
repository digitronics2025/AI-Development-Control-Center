---
system: workflow-engine
sources:
  - apps/orchestrator/src/engine/**
  - packages/shared/src/workflow.ts
  - workflows/**
  - prompts/**
verified_at: 2d516aa
---

# Workflow engine

[engine.ts](../../apps/orchestrator/src/engine/engine.ts) runs one loop per
active task; [runners.ts](../../apps/orchestrator/src/engine/runners.ts) runs
individual stages. The database is authoritative: every transition is written
before the next step, and every write goes through
[publisher.ts](../../apps/orchestrator/src/engine/publisher.ts) so clients see
the same sequence.

## Profiles

Built-ins live in [workflows/](../../workflows) and are loaded at start
(read-only; duplicate to customise). A stage has `key, name, role, kind
(agent|tests|command|git|verify), agentId/model/effort (optional pin),
permissionLevel, timeoutSec, retry.maxAttempts, requiresApproval, next, onFail,
verdict, commandKinds, optional`. Validation
([workflow.ts](../../packages/shared/src/workflow.ts)): unique keys,
resolvable transitions, every stage reachable, reaches `complete`, and the
`next` edges alone are acyclic — loops exist only through `onFail`, bounded by
`maxFixCycles`. Each task stores a snapshot of its profile.

A `tests` stage runs the repository's enabled commands of its `commandKinds`,
by default `lint, typecheck, test, build`. Full Autopilot adds `e2e`, so an
end-to-end pass is observed by the orchestrator rather than taken from an
agent's report; the other built-ins keep the fast default.

A `verify` stage (Full Autopilot's **App check**, after Test) starts the app
from the repository runtime (Repositories → a repository → App runtime),
waits until it answers, opens each configured path in Chromium at desktop and
phone widths (or checks HTTP status for APIs/Workers), fails on console
errors, page errors, failed same-origin requests or horizontal scrolling,
saves screenshots and `browser-verification.md`, stops the app, and on
failure goes to `onFail` like a test failure. It is skipped when no runtime
address is configured (`skipsForLackOfCommands`).

Test stages repair environment failures before failing
([recovery.md](recovery.md)). Every stage runs in the task's working
directory — its worktree when isolated ([checkpoints.md](checkpoints.md#worktrees)).
Agent stages get a scoped Control Center tool session over MCP
([mcp.md](mcp.md)); before the first stage the environment is discovered
([tool-system.md](tool-system.md#environment-discovery)). The execution policy
([autopilot.md](autopilot.md)) caps the auto-approve level for stage gates and
command approvals. Background processes stop whenever the loop exits in a
state other than running or queued; completion and cancellation also close
terminals, remove the worktree and add "Verification coverage" and
"Execution" sections to the report.

Assignment precedence: global role default → workflow stage pin → repository
role override → task role override → task stage override.

## Statuses

Task: `DRAFT, QUEUED, RUNNING, PAUSED, WAITING_FOR_USER,
WAITING_FOR_USAGE_RESET, FAILED, CANCELLED, COMPLETED, INTERRUPTED`.
Stage instances (one row per run): `STARTING, RUNNING, SUCCESS, FAILED, PAUSED,
WAITING_APPROVAL, CANCELLED, INTERRUPTED, SKIPPED`.

## Outcome handling

| Outcome | Result |
|---|---|
| success / skipped | go to `next`; in Discuss First mode a successful planner stage creates a `plan_review` approval first |
| verdict FAIL / tests failed / commit rejected by a hook (git stage with `onFail`) | go to `onFail` and count a fix cycle; at `maxFixCycles` → `WAITING_FOR_USER` (fix_limit). Resume grants one more cycle |
| `USAGE_LIMIT` | `WAITING_FOR_USAGE_RESET`, stage PAUSED — never a paid fallback |
| `AUTH_FAILURE`, `MODEL_UNAVAILABLE`, `PERMISSION_DENIED`, `CONTEXT_FAILURE` | `WAITING_FOR_USER` with the reason |
| other errors | automatic retry up to `retry.maxAttempts`, then `FAILED` |

**Supervised tasks** (Autopilot with the Chairman on) differ: a test or
verdict failure asks the Chairman, which keeps the local fix loop while it
progresses ("Fix attempt N of M") and otherwise starts a recovery cycle
instead of `fix_limit`; exhausted retries and provider blocks go to it too.
They end in `WAITING_FOR_USER` with blocker `hard_blocker` or `limit`, never
`FAILED`, and `complete` passes the Chairman's completion gate first. See
[chairman.md](chairman.md).

Completion writes `git-diff.patch`, `final-report.md` and `task.json` — all
before `COMPLETED` is published, so clients never see a report without its
task record. A reviewer/verifier stage with `verdict: false` still records an
advisory verdict (it does not route); a FAIL makes the report
`NEEDS_USER_ACTION` (used by the built-in Staged Review workflow). The final
status is `READY` only when the last test stage passed (not skipped), the last
review/verification passed, and no file mixes pre-existing user work with task
changes; otherwise `NEEDS_USER_ACTION`. Lines starting `NEEDS OPERATOR:` in the
latest verification (or, when none ran, the latest review) — things only the operator can settle, which
those roles are told not to fail for — are listed as "Needs your decision"
and also make it `NEEDS_USER_ACTION` ([report.ts](../../apps/orchestrator/src/engine/report.ts)).

An optional `command` stage with no matching command configured is skipped
without asking for approval (`skipsForLackOfCommands`).

## Live control

- **Pause** cancels the running execution; the stage is PAUSED and re-runs on resume.
- **Reroute** writes a stage override; if that stage is running it is stopped and re-run with the new agent in the same loop (no restart from zero — the prompt carries the previous attempt).
- **Directives** are persisted immediately and applied when the next agent stage builds its prompt.
- **Retry** re-queues the chosen stage; pending approvals are withdrawn.
- **Redirect** (Chairman/chat): `redirect()` stops the running loop, waits for it
  to exit, then writes the new stage and re-queues — never two loops per task.
  `pauseAfterStage` pauses at the next boundary. A stop between two commands of
  a tests stage is a stop, not a pass.
- Tests stages also run `extra_check_kinds` (one-shot requests) and the kinds
  active `require_check` directives name.

## Scheduling

At most one task works in a repository: a queued task waits while another task
there is running or has started changing files (has a Git baseline) and is not
finished. The blocker says which task holds it. Read-only workflows (every
stage an `agent` at Level 1, e.g. `staged-review`) neither wait nor hold.
A stage with permission level ≥ 2 registers as a writer with the shared
[RepositoryCoordinator](../../apps/orchestrator/src/services/repository-coordinator.ts):
it waits for a Source Control mutation in flight, and Source Control refuses
mutations while it runs ([source-control.md](source-control.md)).

## Restart recovery

On start, executions/stages left `running` are marked interrupted and
`RUNNING` tasks become `INTERRUPTED` with an explanation; queued tasks keep
waiting. Supervised tasks interrupted this way are then resumed by the
Chairman ([chairman.md](chairman.md#restart)). A task parked on a stage approval for a stage that would now be
skipped (its command was removed) has the approval withdrawn and continues. Graceful shutdown does the same for work in progress.

## Prompts

Role templates ([prompts/](../../prompts)) are versioned in the database; each
edit is a new version and tasks record which version each role used. The
context builder ([context.ts](../../apps/orchestrator/src/engine/context.ts))
gives each role only what it needs (e.g. the reviewer gets the diff and test
results, bounded to 150 KB). Every prompt, including user-edited ones, is
prefixed with `RUN_CONTEXT`: the agent is a subagent whose reply is a task
record, so it writes no chat-style recap or to-do block.

Stage summaries in timelines and reports come from the agent's **Summary**
section (or Goal/Findings), else its first prose line — never a heading,
table row or verdict line (`summarize`). Verification commands record their
runner's totals line, e.g. `Tests 429 passed | 1 skipped (430)`
([test-summary.ts](../../apps/orchestrator/src/engine/test-summary.ts)).

Last verified: 2026-09-23
