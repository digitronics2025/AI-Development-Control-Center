---
system: chairman
sources:
  - apps/orchestrator/src/chairman/**
  - apps/orchestrator/src/engine/supervision.ts
  - packages/shared/src/chairman.ts
  - apps/dashboard/src/pages/task/ChairmanDrawer.tsx
verified_at: 892299f
---

# Chairman supervisor

A task-scoped supervisor for Autopilot tasks plus a chat with it
([plan](../plans/chairman-supervisor.md)). **The orchestrator owns task state;
agents do work; the Chairman supervises and recovers — and changes nothing
except through the Action Gateway.** One `Chairman` instance
([chairman.ts](../../apps/orchestrator/src/chairman/chairman.ts)) serves every
task; one session row per task powers both background supervision and chat.

## Which tasks

`tasks.supervised` is fixed at creation: `mode = autopilot` and Settings →
Chairman → *Supervise new Autopilot tasks* (default on), or `supervised` in
`POST /api/tasks`. Discuss First tasks and every task created before migration 2
are unsupervised and behave exactly as before (the engine never calls the
hooks). Chat works for all tasks.

## Engine hooks ([supervision.ts](../../apps/orchestrator/src/engine/supervision.ts))

| Hook | When | Effect |
|---|---|---|
| `beforeStage` | after the Git baseline, before a stage instance | limits check (→ `limit` blocker); checkpoint before every write-capable agent stage |
| `onFailure` | tests failed / verdict FAIL | records the failure signature, classifies progress, then `local_fix` (normal onFail route, "Fix attempt N of M") or a recovery cycle |
| `onError` | `blocked`: usage/model/auth → hand the stage to another healthy agent, else legacy wait; `exhausted`: retries used → recovery cycle |
| `beforeComplete` | loop reaches `complete` | completion gate; remediable failures start a cycle, else complete with the unmet checks as limitations |
| `extendedLimits` / `onTerminal` | resume past a limit / completed or cancelled | extend limits for this task / prune checkpoint refs |

## Recovery ([policy.ts](../../apps/orchestrator/src/chairman/policy.ts))

`decideOnFailure`: regression → escalate; stall → escalate
(`repeated_failure`, or `verify_repeat` for review/verify); a verifier saying
the work misses the request → `plan_mismatch`; local budget used →
`strategy_exhausted`; otherwise keep the local fix loop.

A **recovery cycle** increments `tasks.recovery_cycle`, resets `fix_cycles`
(fresh local budget), takes a checkpoint and executes one candidate strategy:

| Trigger | Candidate order |
|---|---|
| regression | rollback → change agent → re-plan → root-cause |
| repeated / exhausted | root-cause (back to Investigate) → re-plan → change agent → rollback |
| verify_repeat | root-cause → re-plan → change agent |
| plan_mismatch | re-plan → root-cause |
| worker_failure | change agent → retry once |
| provider_blocked | change agent (not a recovery cycle) |

Candidates whose fingerprint `hash(signature|kind|stage|agent)` was already
tried are excluded, and a stage is never handed back to an agent that already
ran it. No candidate left → **hard blocker** (`WAITING_FOR_USER`, blocker
`hard_blocker`). Limits (`tasks.limits`: recovery cycles, work minutes = sum of
execution time, agent runs) → blocker `limit`; *Resume* extends them for that
task. Neither is ever reported as `FAILED`.

The strategy's guidance is stored in the session and appended to every later
prompt as "## Chairman guidance" ([context.ts](../../apps/orchestrator/src/engine/context.ts)).

## Failure signatures and progress

[signatures.ts](../../apps/orchestrator/src/chairman/signatures.ts) normalises
(ids, paths, timings, numbers stripped) and hashes; counts are kept apart.
[progress.ts](../../apps/orchestrator/src/chairman/progress.ts): fewer failures →
PROGRESSING, more → REGRESSING, same hash 3× (tests) or 2× (review/verify) →
STALLED, else STABLE/UNKNOWN. Stored in `failure_signatures` per recovery cycle.

## Reasoning ([reasoner.ts](../../apps/orchestrator/src/chairman/reasoner.ts))

Settings → Chairman agent (default Claude Code), run read-only (level 1) in the
task's artifact folder, 4-minute timeout. Prompts carry the fresh snapshot
([snapshot.ts](../../apps/orchestrator/src/chairman/snapshot.ts)); agent, log and
repository text goes inside `<untrusted_evidence>` fences that cannot be closed
from within. The model only **chooses a candidate id** (recovery) or replies
(chat); output is Zod-validated, repaired once, then the rules decide. No
model, or a failed call → `degraded` ("rules only"). Each call is launched
through `AgentRegistry.launch`, so its usage and cost are recorded against the
task with step `chairman` ([usage.md](usage.md)).

## Action Gateway ([gateway.ts](../../apps/orchestrator/src/chairman/gateway.ts))

Every action (supervisor, chat, `POST /api/tasks/:id/chairman/actions`):
schema → initiator permission → task not terminal → version check (stale
decisions rejected) → per-task lock (the loop's own in-loop calls skip it; a
pending stop supersedes them) → idempotency key → `chairman_actions` audit row →
engine command. Only the **user** may add/remove directives; only chairman or
system may mark a hard blocker. Running work is stopped with
`engine.redirect/stopAndApply`: the loop exits first, then the new state is
written, so two workers never run for one task.

Actions: CONTINUE, PAUSE_TASK (now / after stage), RESUME_TASK,
CANCEL_ACTIVE_STAGE, RETRY_STAGE, RETURN_TO_STAGE, REPLAN, ADD/REMOVE_DIRECTIVE,
CHANGE_AGENT/MODEL/EFFORT (deferred — the running stage keeps its agent),
RUN_TARGETED_TESTS / RUN_FULL_TESTS / RUN_E2E (next tests stage runs the extra
kinds; immediate if the task is stopped), CREATE/ROLLBACK_CHECKPOINT,
MARK_HARD_BLOCKER, COMPLETE_TASK (only if the gate passes).

## Chat ([chat.ts](../../apps/orchestrator/src/chairman/chat.ts), [intent.ts](../../apps/orchestrator/src/chairman/intent.ts))

Messages persist at once (`client_message_id` dedupes) and are processed one
at a time per task. Deterministic ask-vs-act first: questions (incl. "Would
rollback help?", "Could Claude review this?") never act and the model is
offered no actions; `/status /blockers /directives` answer from the snapshot;
commands map to actions; "Do not …" → constraint directive (interrupts a
running write stage, which re-runs under it; new contract version); "Run E2E
before finishing" → requirement directive; "Use Claude for review" → deferred
routing. Unclear sentences become an instruction directive unless the model
reads them differently — and a model may only add non-destructive actions, with
directive text pinned to the user's own words. Cancelling a task is never done
from chat.

Directives ([rules.ts](../../apps/orchestrator/src/chairman/rules.ts)): scope
`CURRENT_TASK` or `NEXT_RELEVANT_STAGE`; state `active/removed/superseded`;
checkable rules `protect_paths` (from paths or known nouns: migrations, schema,
tests, lockfiles) and `require_check` (e2e, full suite).

## Completion gate ([gate.ts](../../apps/orchestrator/src/chairman/gate.ts))

Objective only: last tests after the last change passed, last review and
verification PASS after it, required check kinds passed in the last tests
stage, no task-owned file matching a protected pattern. `READY` needs the gate.

## Checkpoints ([checkpoints.ts](../../apps/orchestrator/src/chairman/checkpoints.ts))

See [checkpoints.md](checkpoints.md) (types `git`, `database`, `deployment`,
each with metadata; the tool layer and the Execution tab share this service)
and [git.md](git.md#checkpoints). All of it works on the task's working
directory — its worktree when isolated. "Roll back the last change" restores the
checkpoint taken before the latest write stage; a safety checkpoint is taken
first. Files dirty at the baseline are never touched; across a commit it
refuses.

## Watchdog ([watchdog.ts](../../apps/orchestrator/src/chairman/watchdog.ts))

Every 15 s: a `RUNNING` task with no loop is reconciled to `INTERRUPTED` and,
if supervised, resumed. For supervised tasks, a worker whose pid is gone on two
checks, that ran 2 minutes past its stage timeout, or that was silent for
`stallMinutes` is stopped; the stage fails as `TIMEOUT` into normal recovery.

## Restart

`services.recover()` = `engine.recover()` then `chairman.onStartup()`: every
supervised task `INTERRUPTED` with an `interrupted` blocker is resumed through
the gateway (setting *Resume after a restart*), and unanswered chat messages
are answered — never re-executed if they already produced an action.

## Tables (migration 2)

`task_contracts` (versioned goal/criteria/constraints), `chairman_sessions`,
`chairman_messages`, `chairman_decisions`, `chairman_actions`,
`failure_signatures`, `task_checkpoints`; new `tasks` columns `version,
supervised, recovery_cycle, limits, pause_after_stage, extra_check_kinds`;
new `task_directives` columns `scope, kind, state, normalized_rule,
source_message_id, removed_at, superseded_by`. `tasks.version` increments on
material changes only (status, stage, overrides, cycles, pause flags).

## API and realtime

`GET /api/tasks/:id/chairman` (state, contract, messages, decisions, actions,
checkpoints) · `GET|POST /api/tasks/:id/chairman/messages` (202 new, 200
duplicate) · `POST /api/tasks/:id/chairman/actions {action, idempotencyKey}`
(409 when rejected/failed). WebSocket: `chairman`, `chairman.message`,
`chairman.decision`, `chairman.action`, `checkpoint`.

## Gotchas

- Tests: `[sim:chairman-down]`, `[sim:chairman-bad-json]`,
  `[sim:verify-plan-mismatch]` steer the simulated agent; role `chairman` gets JSON.
- No token/cost data exists for subscription CLIs: the cost limit is agent runs.
- Checkpoint refs live under `refs/acc/checkpoints/<task>/` and are deleted when
  the task finishes; `.gitattributes` EOL rules may make a restore byte-different.

Last verified: 2026-09-23
