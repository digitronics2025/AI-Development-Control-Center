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
(agent|tests|command|git), agentId/model/effort (optional pin),
permissionLevel, timeoutSec, retry.maxAttempts, requiresApproval, next, onFail,
verdict, commandKinds, optional`. Validation
([workflow.ts](../../packages/shared/src/workflow.ts)): unique keys,
resolvable transitions, every stage reachable, reaches `complete`, and the
`next` edges alone are acyclic — loops exist only through `onFail`, bounded by
`maxFixCycles`. Each task stores a snapshot of its profile.

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
| verdict FAIL / tests failed | go to `onFail` and count a fix cycle; at `maxFixCycles` → `WAITING_FOR_USER` (fix_limit). Resume grants one more cycle |
| `USAGE_LIMIT` | `WAITING_FOR_USAGE_RESET`, stage PAUSED — never a paid fallback |
| `AUTH_FAILURE`, `MODEL_UNAVAILABLE`, `PERMISSION_DENIED`, `CONTEXT_FAILURE` | `WAITING_FOR_USER` with the reason |
| other errors | automatic retry up to `retry.maxAttempts`, then `FAILED` |

Completion writes `git-diff.patch`, `final-report.md` and `task.json`. The final
status is `READY` only when the last test stage passed (not skipped), the last
review/verification passed, and no file mixes pre-existing user work with task
changes; otherwise `NEEDS_USER_ACTION`. Lines starting `NEEDS OPERATOR:` in the
latest review or verification — things only the operator can settle, which
those roles are told not to fail for — are listed as "Needs your decision"
and also make it `NEEDS_USER_ACTION` ([report.ts](../../apps/orchestrator/src/engine/report.ts)).

An optional `command` stage with no matching command configured is skipped
without asking for approval (`skipsForLackOfCommands`).

## Live control

- **Pause** cancels the running execution; the stage is PAUSED and re-runs on resume.
- **Reroute** writes a stage override; if that stage is running it is stopped and re-run with the new agent in the same loop (no restart from zero — the prompt carries the previous attempt).
- **Directives** are persisted immediately and applied when the next agent stage builds its prompt.
- **Retry** re-queues the chosen stage; pending approvals are withdrawn.

## Scheduling

At most one task works in a repository: a queued task waits while another task
there is running or has started changing files (has a Git baseline) and is not
finished. The blocker says which task holds it.

## Restart recovery

On start, executions/stages left `running` are marked interrupted and
`RUNNING` tasks become `INTERRUPTED` with an explanation; queued tasks keep
waiting. A task parked on a stage approval for a stage that would now be
skipped (its command was removed) has the approval withdrawn and continues. Graceful shutdown does the same for work in progress.

## Prompts

Role templates ([prompts/](../../prompts)) are versioned in the database; each
edit is a new version and tasks record which version each role used. The
context builder ([context.ts](../../apps/orchestrator/src/engine/context.ts))
gives each role only what it needs (e.g. the reviewer gets the diff and test
results, bounded to 150 KB).

Stage summaries in timelines and reports come from the agent's **Summary**
section (or Goal/Findings), else its first prose line — never a heading,
table row or verdict line (`summarize`). Verification commands record their
runner's totals line, e.g. `Tests 429 passed | 1 skipped (430)`
([test-summary.ts](../../apps/orchestrator/src/engine/test-summary.ts)).

Last verified: 2026-09-23
