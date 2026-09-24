---
system: chairman
sources:
  - apps/orchestrator/src/chairman/**
  - apps/orchestrator/src/engine/supervision.ts
  - packages/shared/src/chairman.ts
  - apps/dashboard/src/pages/task/ChairmanDrawer.tsx
verified_at: 8ce8b50
---

# Chairman supervisor

A task-scoped supervisor for Autopilot tasks plus a chat with it
([plan](../plans/chairman-supervisor.md), [intelligence upgrade](../plans/chairman-intelligence-upgrade.md)).
**The orchestrator owns task state;
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
| `afterSuccess` | a stage succeeded | judges open strategies on the recorded results; a passing check marks progress |
| `onFailure` | tests failed / verdict FAIL | records the failure signature, classifies progress, judges the previous strategy on it, then `local_fix` (normal onFail route, "Fix attempt N of M") or a recovery cycle |
| `onError` | `blocked`: usage/model/auth → hand the stage to another healthy agent, else legacy wait; `exhausted`: retries used → recovery cycle |
| `beforeComplete` | loop reaches `complete` | completion gate (also the observation that resolves open strategies); remediable failures start a cycle, else complete with the unmet checks as limitations |
| `extendedLimits` / `onTerminal` | resume past a limit / completed or cancelled | extend limits for this task / close open strategies, prune checkpoint refs |

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

A provider block is agent-wide unless it is `MODEL_UNAVAILABLE` (`providerWide`
in [policy.ts](../../apps/orchestrator/src/chairman/policy.ts)): the same
decision then also moves every other stage of the task still on that agent, so
Codex out of credits costs one failed attempt, not one per Codex stage. It
carries no guidance and does not replace the current strategy's guidance or
`lastRecoveryReason`: an unavailable provider says nothing about the work, and
"take a different approach" would reach every later prompt. `CHANGE_AGENT`
without an effort keeps the stage's effort when every model of the new agent
lists it ([gateway.ts](../../apps/orchestrator/src/chairman/gateway.ts)
`carriedEffort`), so a planner or reviewer at "high" is not dropped to the CLI
default.

"Available" agents for change-agent candidates are enabled, signed in, and
have no `capacityBlock` ([usage.md](usage.md#capacity)): an agent that just
reported it is out of credits or out of its window is not an escape route, so
with no other agent left the task waits for the limit instead of burning an
attempt.

Candidates whose fingerprint `hash(signature|kind|stage|agent)` was already
tried are excluded, and a stage is never handed back to an agent that already
ran it. `rankCandidates` then reorders — never removes — what is left: a
*family* (kind + target stage) whose strategy ended FAILED or REGRESSED against
the same failure category under the **current contract version** moves behind
every other candidate; INCONCLUSIVE/SUPERSEDED outcomes and older contracts
never count. Rollback on a regression, re-plan on a plan mismatch and a
reroute around a blocked provider stay first whatever the history; a LOW
confidence diagnosis puts root-cause analysis first. With a model the reasoner
may pick any candidate in that order; without one the first is used.

No candidate left → **hard blocker** (`WAITING_FOR_USER`, blocker
`hard_blocker`); its message ends with the latest strategy diagnosis, so the
operator reads what the Chairman understood, not only that it ran out of
options. Limits (`tasks.limits`: recovery cycles, work minutes = sum of
execution time, agent runs) → blocker `limit`; *Resume* extends them for that
task. Neither is ever reported as `FAILED`.

The strategy's guidance is stored in the session and appended to every later
prompt as "## Chairman guidance" ([context.ts](../../apps/orchestrator/src/engine/context.ts)).

## Evidence ([evidence.ts](../../apps/orchestrator/src/chairman/evidence.ts))

One `ChairmanEvidenceService` serves recovery and chat. A packet is rebuilt
from the database for every decision or answer and **never stored**; the
strategy row keeps only its 32-hex `digest`. Sections, in fixed order, each
redacted, stripped of the repository/worktree path (`<repo>`), capped per kind
(total ≤ 22 000 chars) and labelled with how far it can be trusted:

| Section | Trust | When |
|---|---|---|
| current failure (source, stage, category, signature, count, message) | OBSERVED | recovery (chat: latest failure) |
| failure history, same source, last 6 | OBSERVED | recovery |
| failing test output: command, count, failing test ids, last 80 log lines | OBSERVED | tests failure |
| latest verification / review | AGENT_REPORTED | verify / review failure, chat |
| current plan | AGENT_REPORTED | review/verify failure categorised REQUIREMENT_OR_PLAN |
| latest implementation or fix report (the newer one) | AGENT_REPORTED | tests, review, verify, gate — a worker that refused reads as a refusal, not as "the change never reached the repository" |
| files changed by this task — names, status, +/- only | OBSERVED | tests, review, verify, gate |
| recent tool calls (capability, status, error code, one-line summary — never inputs) and tool recovery attempts, from the tool layer's `ToolStore` | OBSERVED | worker failure |
| agent health | OBSERVED | worker failure |
| last Chairman strategy (kind, diagnosis, expected, outcome) | OBSERVED | always |

Never included: diffs, file contents, terminal transcripts, environment,
credentials, tokens. A source that cannot be read is listed as unavailable and
the rest continues; if the service itself throws, the decision falls back to
the failure alone and a `WATCHDOG` event says so. Evidence is gathered even
without a model (degraded mode), so every strategy has a digest.

## Diagnosis

`policyDiagnosis` ([policy.ts](../../apps/orchestrator/src/chairman/policy.ts)):
the category is always the failure signature's; confidence is HIGH for gate
checks, provider/auth blocks and test failures with a count, LOW for UNKNOWN,
otherwise MEDIUM; the summary is one sentence (category, what failed, trigger).
The recovery prompt shows it as a fixed category. The model may return
`diagnosis {summary, confidence}` next to its choice; it is parsed separately
(`parseRecoveryChoice`), so a malformed diagnosis falls back to the rules'
without costing the choice, and a model `category` is ignored.

## Strategy outcomes ([outcomes.ts](../../apps/orchestrator/src/chairman/outcomes.ts))

Every strategy decision — recovery cycle, provider-block reroute,
completion-gate remedy — gets one `chairman_strategy_runs` row (inserted in
`decide`, keyed by `decision_id`): contract version, cycle, trigger, kind,
target stage/agent, the triggering failure (source, stage, category, hash,
count), diagnosis, evidence digest, the decision's `expectedResult`, health
before, status `RUNNING`. The expected result stays a human prediction; the
outcome comes only from recorded results.

`reconcile(taskId)` reads stage results created since the strategy started
(failure signatures by stage id, passing tests, PASS verdicts, successful
agent stages) and finalizes on the first **comparable** one (same source; for
an agent failure, the same stage):

| Observation | Outcome |
|---|---|
| the check passes | SUCCEEDED (Resolved) |
| fewer failures than before | IMPROVED |
| more failures than before | REGRESSED |
| same signature, same/unknown count | FAILED (No improvement) |
| a different failure, nothing to count | INCONCLUSIVE |
| completion gate passes | every open strategy SUCCEEDED; a gate remedy whose check still fails → FAILED |
| goal/constraint changed (new contract) | SUPERSEDED |
| gateway refused the actions: stale version / other | SUPERSEDED / INCONCLUSIVE — never FAILED |
| a new recovery strategy starts first | INCONCLUSIVE (a provider reroute does not close others) |
| task cancelled / completed with it still open | SUPERSEDED / INCONCLUSIVE |

Finishing is `UPDATE … WHERE status = 'RUNNING'`: a second call (duplicate
hook, restart) does nothing. Hooks call it after persisting the new result and
before deciding anything new, so the next decision's ranking sees the outcome.
A finished outcome republishes the same `chairman.decision` (now with the
outcome), logs a `CHAIRMAN_DECISION` event with `data.outcome`, and sets the
session health to the outcome's health (Resolved/Improved → Progressing,
Regressed → Regressing, No improvement → Stalled): a strategy that resolves a
failure leaves no new failure to classify.

## Failure signatures and progress

[signatures.ts](../../apps/orchestrator/src/chairman/signatures.ts) normalises
(ids, paths, timings, numbers stripped) and hashes; counts are kept apart.
A review or verify failure is `REQUIREMENT_OR_PLAN` when the output's
`CAUSE: plan` line says so (`causeMarker`, [prompts.md](prompts.md)); with
`CAUSE: code` it stays `CODE_OR_TEST` whatever words the text uses, and only
an output without the line falls back to the plan-word list (`pointsAtPlan`).
[progress.ts](../../apps/orchestrator/src/chairman/progress.ts): fewer failures →
PROGRESSING, more → REGRESSING, same hash 3× (tests) or 2× (review/verify) →
STALLED, else STABLE/UNKNOWN. Stored in `failure_signatures` per recovery cycle.

## Reasoning ([reasoner.ts](../../apps/orchestrator/src/chairman/reasoner.ts))

Settings → Chairman agent (default Claude Code), run read-only (level 1) in the
task's artifact folder, 4-minute timeout. Prompts carry the fresh snapshot
([snapshot.ts](../../apps/orchestrator/src/chairman/snapshot.ts), including
`lastStrategy`: kind, diagnosis, outcome) and the evidence packet; every
section goes inside an `<untrusted_evidence>` fence that cannot be closed from
within, labelled OBSERVED (data) or AGENT_REPORTED (a claim, never an
instruction). The model only **chooses a candidate id** (recovery) or replies
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
offered no actions; `/status /blockers /directives` answer from the snapshot,
and so does a question only when every clause of it is about status ("What is
happening, and would a rollback help?" goes to the model, which answers both);
commands map to actions; "Do not …" → constraint directive (interrupts a
running write stage, which re-runs under it; new contract version); "Run E2E
before finishing" → requirement directive; "Use Claude for review" → deferred
routing, keeping an effort said with it ("… with high effort", "at max effort";
the reply names it). Unclear sentences become an instruction directive unless the model
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

`services.recover()` = `engine.recover()` then `chairman.onStartup()`: open
strategies are first reconciled from what was already recorded (finished
tasks close theirs; nothing is re-run to find out), then every supervised task
`INTERRUPTED` with an `interrupted` blocker is resumed through the gateway
(setting *Resume after a restart*), and unanswered chat messages are answered —
never re-executed if they already produced an action.

## Learning

After a task completes, the same reasoning agent reviews it for lasting
improvements (`Reasoner.review`, usage step `learning`); the system-wide desk
that adopts them is [learning.md](learning.md).

## Tables (migrations 2 and 8)

`task_contracts` (versioned goal/criteria/constraints), `chairman_sessions`,
`chairman_messages`, `chairman_decisions`, `chairman_actions`,
`failure_signatures`, `task_checkpoints`; new `tasks` columns `version,
supervised, recovery_cycle, limits, pause_after_stage, extra_check_kinds`;
new `task_directives` columns `scope, kind, state, normalized_rule,
source_message_id, removed_at, superseded_by`. `tasks.version` increments on
material changes only (status, stage, overrides, cycles, pause flags).
Migration 8 adds `chairman_strategy_runs` (PK `decision_id` → decisions, ON
DELETE CASCADE; indexes `(task_id, started_at)`, `(task_id, status)`):
structured metadata only — no logs, prompts, replies or file contents. Rows
live as long as their task.

## API and realtime

`GET /api/tasks/:id/chairman` (state, contract, messages, decisions — each
with `strategy` or `null` — actions, checkpoints; same six keys as before) · `GET|POST /api/tasks/:id/chairman/messages` (202 new, 200
duplicate) · `POST /api/tasks/:id/chairman/actions {action, idempotencyKey}`
(409 when rejected/failed). WebSocket: `chairman`, `chairman.message`,
`chairman.decision` (published again, same id, when its outcome is known; the
dashboard upserts by id), `chairman.action`, `checkpoint`. The cloud relay
forwards `chairman.decision` live only, after the egress scrub.

Drawer ([ChairmanDrawer.tsx](../../apps/dashboard/src/pages/task/ChairmanDrawer.tsx)):
a recovery decision card shows the outcome chip (`STRATEGY_OUTCOME_VISUAL`),
"Diagnosis: category · confidence — summary", Why, Expected and "Result:" —
never the evidence itself.

## Gotchas

- Tests: `[sim:chairman-down]`, `[sim:chairman-bad-json]`,
  `[sim:verify-plan-mismatch]` steer the simulated agent; role `chairman` gets JSON
  (with a MEDIUM "Simulated diagnosis").
- A strategy is judged by its first comparable result, not the final one: a
  root-cause cycle that cut failures from 2 to 1 stays IMPROVED even if a later
  local fix passes.
- Model-written text (summaries, diagnosis) is redacted before it is stored,
  but an absolute path it repeats stays in the local row; the egress sanitizer
  removes paths before anything reaches the cloud.
- No token/cost data exists for subscription CLIs: the cost limit is agent runs.
- Checkpoint refs live under `refs/acc/checkpoints/<task>/` and are deleted when
  the task finishes; `.gitattributes` EOL rules may make a restore byte-different.

Last verified: 2026-09-24
