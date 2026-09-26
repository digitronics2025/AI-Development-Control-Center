---
system: stage-teams
sources:
  - apps/orchestrator/src/engine/stage-team.ts
  - apps/orchestrator/src/engine/work-units.ts
  - packages/git/src/team.ts
  - packages/shared/src/stage-teams.ts
verified_at: cabbcec
---

# Stage Teams

One agent stage run by a bounded team of Control Center workers
([STAGE_TEAMS_PLAN.md](../plans/STAGE_TEAMS_PLAN.md)). The orchestrator owns
the team: every worker is its own agent run through `AgentRegistry.launch`
(subscription guard, usage ledger), with its own execution, log, tool session
and artifact. Provider-native sub-agents stay off (Claude Code's `Agent` tool
is not in the closed tool set, [agents.md](agents.md)); a worker never starts
another worker. The stage still returns one `StageOutcome`, so transitions,
fix cycles, approvals, the Chairman and the completion gate work as before.

## Configuration

`StageDefinition.team` ([schemas.ts](../../packages/shared/src/schemas.ts)),
validated by `teamIssues` in [workflow.ts](../../packages/shared/src/workflow.ts):

| Field | Meaning |
|---|---|
| `mode: fixed` | the listed `workers` (2–4) run side by side. Level 1 stages only — fixed workers own no paths. A verdict stage names exactly one `primary` reviewer |
| `mode: adaptive` | work units come from the plan's manifest (or, for a `fixer`, a decomposition run). No worker list, no verdict stages |
| `maxWorkers` | 2–4 per stage; also capped machine-wide by Settings → `execution.teamWorkerLimit` (default 3, a semaphore across every task) |

Never on non-agent stages or at Level 4/5. Absent `team` = the stage exactly
as before. Worker assignment: a fixed worker's own `agentId/model/effort`, else
the stage's resolved assignment; a task reroute of the stage (a stage override
with an agent) moves every worker. Adaptive workers inherit the stage's.

Built-in: **Architecture** ([architecture.yaml](../../workflows/architecture.yaml))
— fixed Codex + Claude assessment (replaces the old serial second assessment),
adaptive Implement (max 3), fixed review (primary correctness + risk reviewer),
adaptive Fix (max 2). **Full Autopilot**
([full-autopilot.yaml](../../workflows/full-autopilot.yaml)) — fixed investigation
(one worker on the stage's agent, one pinned to Claude Code), adaptive Implement
(max 3, two attempts so a crashed worker's siblings are reused), fixed review
(primary correctness + risk), adaptive Fix (max 2); Test, App check, Verify, Git
checkpoint, staging and Release unchanged. Other built-ins have no teams.

## Manifest

The planner prompt lists adaptive team stages in `{{team_stages}}`
([prompts.md](prompts.md)) and may end the plan with one fenced
` ```acc-work-units ` JSON block (`workUnitManifestSchema`,
[stage-teams.ts](../../packages/shared/src/stage-teams.ts)): `version: 1`,
`stage` (must equal the team stage's key), ≤6 `units` with slug `key`, `title`,
`goal`, `dependsOn` (known, acyclic), `pathPrefixes` (repository-relative; no
`/`, `..`, `.`, `.git`, `//`, drive or shell text) and `checks`.
[work-units.ts](../../apps/orchestrator/src/engine/work-units.ts) reads only the
last valid block for the stage (≤20 000 chars) and hashes it canonically.

A **Fix** stage never reuses the plan's manifest: one read-only (Level 1)
decomposition run (unit kind `decomposer`) reads the fresh test and review
evidence and answers with a manifest; its report is `<stage>-decomposition.md`.

## Falling back to one agent

`StageTeamRunner.run` returns null — the stage runs as one agent, with a
`STAGE_TEAM` event "… runs as one agent: <reason>" — when: no or invalid
manifest; fewer than two units; independent units claiming overlapping paths
(`independentOverlaps`); every unit depends on the previous one; a write team
in a task that is not isolated in a worktree, spans several repositories, or is
a fixed team above Level 1; the decomposition run fails. A fallback is never a
task failure.

## Running

Units are persisted (`stage_work_units`, all `QUEUED`) before any starts.
Waves: the ready units (dependencies done) up to the stage cap; the prompt is
rebuilt per wave so a later wave sees what earlier waves integrated. Each
worker's prompt is the stage prompt plus "## Your work unit" (goal or focus,
owned paths, other workers, rules: stay in your paths, no commit/push, no
package installs, no sub-agents; primary vs specialist reviewer).

- **Read-only** (Level 1): workers share the task's working tree.
- **Write** (Level 2–3, isolated single-repository task): per wave a hidden
  checkpoint `refs/acc/team/<task>/<stage>/w<n>-base` of the task worktree;
  each worker gets a detached child checkout of it
  (`<dataDir>/team-worktrees/<task>/<stage8>-<unit>`, `core.autocrlf=false` so
  bytes match) as its cwd and only tool root; the task folder's path in the
  prompt is rewritten to the child's. `node_modules` folders (≤3 levels) are
  shared by directory junctions, removed — never followed — before the child
  is deleted. The result is captured as `…/<unit>` and diffed against the base
  (`changedPathsBetween`, renames as D+A); any path outside the unit's
  prefixes fails it (`SCOPE_VIOLATION`, stage error `UNKNOWN`).

After a wave: a stop cancels everything (units `CANCELLED`, nothing
integrated); `BLOCKED ON OPERATOR` from a work unit → `needs_operator`, nothing
integrated; any failed unit → the stage fails with that unit's class (a
blocking class such as `USAGE_LIMIT` wins), later units `SKIPPED`, nothing from
the wave integrated. Otherwise the units' changes are combined in a private
index into `…/w<n>-combined` (two units touching one path is a conflict) and
written to the task worktree with `restoreCheckpoint` — only if the task's
working tree still equals the wave base (`applyIfUnchanged`); else nothing is
written and the stage fails. No forced checkout or reset.

After two or more write units were integrated, one **integration pass** (unit
kind `integration`) runs on the task worktree with the stage's assignment: it
reconciles interfaces between units, runs targeted checks, and writes the
stage's report. The Test stage stays authoritative after it.

## Outcome and artifacts

Each worker writes `<role-artifact>-<unit>.md` (type `stage-output`); the
stage's usual artifact (`investigation.md`, `review.md`, …) is the aggregate:
the integration report, then every worker's report (≤30 000 chars each). Verdict
teams: every worker must end with a VERDICT; any FAIL → FAIL; a PASS needs the
primary reviewer to account for the diff's unshown files — one follow-up run of
the primary, then `REVIEW_INCOMPLETE`. `STAGE_COMPLETED` carries
`team: { workers, reused, wallMs, agentMs, integrated }` (agent time is the sum
of worker durations; no savings are claimed beyond those two numbers).

## Retry, restart, limits

- **Reuse:** a unit whose earlier run (same task, stage key, unit key, and
  `manifest_hash` — a hash of the manifest or team config, the stage level and
  the active directive ids) succeeded is `REUSED` instead of run: read-only when
  the working tree it read (its `base_commit` holds that tree) is identical;
  write when its base commit's tree equals the new base tree and its result
  still lies within its paths. Failed, stopped and interrupted units rerun.
- **Restart:** `engine.recover()` marks `RUNNING` units `FAILED`/`INTERRUPTED`
  and `QUEUED` ones `CANCELLED`; leftover processes are stopped by the
  existing leftover-execution pass; `team.sweep()` deletes every child checkout
  under `team-worktrees` (links first) and prunes worktrees. A partial checkout
  is never integrated.
- **Cleanup:** completion and cancel delete `refs/acc/team/<task>/` and the
  task's child folder.
- **Limits:** every worker, decomposer and integration run is an `agent`
  execution, so the Chairman's `maxAgentRuns` and runtime count them; a
  supervised team starts no worker once the run limit is reached (the stage
  fails `PERMISSION_DENIED`). The watchdog checks every running execution of a
  task, naming the unit. The Chairman snapshot carries `team` (latest team
  stage, unit statuses and errors, as EVIDENCE text).

## Visibility

`GET /api/tasks/:id/work-units` (remote `task.workUnits`), `TaskDetail.workUnits`,
realtime `workUnit` (live-only to the cloud, [remote-node.md](remote-node.md)),
`executions.work_unit_id`, `usage_events.work_unit_key` (the ledger links
attempts per unit, so siblings are not retries; the task usage flow lists
`workUnits` per stage), events `STAGE_TEAM` and `WORK_UNIT`. Migration 19 is
additive; old rows read NULL.

## Parallel-safe checks

`RepositoryCommand.parallelSafe` (absent = false). In a `tests` stage,
consecutive commands that are marked, of kind lint/typecheck/test/build/e2e,
and classified Level ≤2, non-production and not always-approve run together (at
most 4, each with its own execution and test run, via `childControl`). The first
real failure (after baseline and flaky classification) cancels the rest of the
batch: their runs are `not_run`, "Stopped: <name> failed first". Repairs are
serialised. Reuse, affected tests, baseline classification and the release
tree proof are unchanged; everything unmarked runs one at a time, in order.

## Known limitations

- Write teams need an isolated single-repository task; multi-repository write
  teams run as one agent.
- Only `node_modules` is shared into child checkouts; ignored files such as
  `.env` are not there.
- A restart in the middle of writing a combined result can leave the task
  worktree partly updated; the stage reruns from that state (no reuse, since the
  base differs).

## Observed with real agents (2026-09-26)

Two Architecture tasks on a disposable two-folder repository, on a separate
orchestrator instance (own data folder), Codex 0.156.1 + Claude Code 2.1.283:

| | TASK-0001 | TASK-0002 |
|---|---|---|
| Assessment (Codex ∥ Claude) | wall 77 s, agent 121 s, overlap 49 s | wall 98 s, agent 146 s, overlap 51 s |
| Implement | one agent — the planner's manifest had `api_discount` keys and commands as `checks` | 2 writers in separate checkouts (overlap 36 s), 4 files integrated, integration pass; wall 73 s, agent 103 s |
| Review (2 reviewers) | FAIL, Fix (decomposed, then one agent), PASS | PASS, wall 59 s, agent 93 s |
| Result | COMPLETED · READY, 7.8 min | COMPLETED · READY, 5.3 min |

The first run's fallback led to `normalize` in
[work-units.ts](../../apps/orchestrator/src/engine/work-units.ts) (keys folded
to slugs, unknown check kinds dropped) and a stricter planner prompt; the second
run used the same planner output shape successfully. Both operator checkouts
stayed on `main`, clean; no `refs/acc/team/*` or child folders remained. The
task times are single runs, not a controlled comparison: they show the
assessment and review stages taking less wall time than their summed agent
time, not a general speed-up.

Last verified: 2026-09-26
