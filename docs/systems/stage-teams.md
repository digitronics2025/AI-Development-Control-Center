---
system: stage-teams
sources:
  - apps/orchestrator/src/engine/stage-team.ts
  - apps/orchestrator/src/engine/work-units.ts
  - packages/git/src/team.ts
  - packages/shared/src/stage-teams.ts
verified_at: 57af61a
---

# Stage Teams

One agent stage run by a bounded team of Control Center workers
([STAGE_TEAMS_PLAN.md](../plans/STAGE_TEAMS_PLAN.md)). The orchestrator owns
the team: every worker is its own agent run through `AgentRegistry.launch`
(subscription guard, usage ledger), with its own execution, log, tool session
and artifact. Provider-native sub-agents stay off (Claude Code's `Agent` tool
is not in the closed tool set, [agents-claude-code.md](agents-claude-code.md)); a worker never starts
another worker. The stage still returns one `StageOutcome`, so transitions,
fix cycles, approvals, the Chairman and the completion gate work as before.

## Configuration

`StageDefinition.team` ([schemas.ts](../../packages/shared/src/schemas.ts)),
validated by `teamIssues` in [workflow.ts](../../packages/shared/src/workflow.ts):

| Field | Meaning |
|---|---|
| `mode: fixed` | the listed `workers` (2–4) run side by side. Level 1 stages only — fixed workers own no paths. A verdict stage names exactly one `primary` reviewer |
| `mode: adaptive` | work units come from the plan's manifest (or, for a `fixer`, a decomposition run). No worker list, no verdict stages |
| `mode: variants` | the listed `workers` (2–4, each an approach) each do the **whole** stage; a judge keeps one ([Variants](#variants)). Level 1–3 work stages, never a verdict stage or a judge-class role, no `primary`; optional `judge` pin (`agentId`/`model`/`effort`, else the stage's) |
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
(primary correctness + risk), adaptive Fix (max 2); Test, App check, the
conditional Visual critique and Design fix ([design-agent.md](design-agent.md#in-full-autopilot)),
Verify, Git checkpoint, staging and Release run as one agent or as system stages. **Frontend Design**
([frontend-design.yaml](../../workflows/frontend-design.yaml)) — fixed Design
brief (three Claude Code workers, bold, calm and contrarian directions, each
drawing a style tile). Other built-ins have no teams, and none uses variants.

## Variants

[stage-team-variants.md](../plans/stage-team-variants.md). At Level 1 the
variants run side by side in the task's tree (read-only). At Level 2–3 each
runs in its own child checkout of the wave base, exactly as a write unit
does, but owning the whole repository: no `SCOPE_VIOLATION`, because only one
variant is ever integrated. Each is told it is one of N competing variants,
its approach, and to do the complete work (`variantSection`).

A failed variant is one approach fewer, not a failed stage; the stage fails
only when every variant failed. A lone finished variant is kept without a
judge. Otherwise one **judge** unit (kind `judge`, key `judge`) runs read-only
at Level 1 in the task's tree, which no variant touched. It gets the stage
context with `Role: judge`, and each finished variant's approach, agent,
changed files, diff against its base (40 KB each, 100 KB in all, redacted)
and report (12 KB). It must end with `WINNER: <key>` (`parseWinner`: the last
such line); naming no finished variant fails the stage (`UNKNOWN`). Prompt
`<role prompt>-judge.md`, answer `<role report>-judge.md`.

Then only the winner is integrated (`integrate` with that one unit,
byte-exact against its wave base; no integration pass) or, at Level 1,
becomes the stage's result. The role's report is the winner's report plus
"Variant kept", the variants it was kept over, and the judge's reasons. The
others stay `SUCCESS` with "Not chosen:" in their summary, their reports as
unit artifacts and their results as hidden refs. The stage summary reads "N
variants (k failed); kept X: …", and the completion event's `team` data
carries `variants: { chosen, finished, judgeMs }`.

Not yet: a running app per variant, so a judge could open each build in a
browser (the App runtime starts one app per task worktree). Choosing an agent
or model by specialty is deferred until per-worker outcome data exists (the
plan's gate); choosing a role is [Specialists](#specialists).

## Manifest

The planner prompt lists adaptive team stages in `{{team_stages}}`
([prompts.md](prompts.md)) and may end the plan with one fenced
` ```acc-work-units ` JSON block (`workUnitManifestSchema`,
[stage-teams.ts](../../packages/shared/src/stage-teams.ts)): `version: 1`,
`stage` (must equal the team stage's key), ≤6 `units` with slug `key`, `title`,
`goal`, `dependsOn` (known, acyclic), `pathPrefixes` (repository-relative; no
`/`, `..`, `.`, `.git`, `//`, drive or shell text) and `checks`.
[work-units.ts](../../apps/orchestrator/src/engine/work-units.ts) reads only the
last valid block for the stage (≤20 000 chars), folds keys and `specialty` to
slugs, and hashes it canonically.

## Specialists

Plan: [DESIGNER_ROUTING_PLAN.md](../plans/DESIGNER_ROUTING_PLAN.md) §6. An
adaptive team may list `specialists` (`stageSpecialistSchema`: `specialty`,
`description`, `role`, optional `toolProfile`, `instructions`); validation
allows them only on a Level 2 write stage that is not a fixer, with write-class
roles and unique specialties, so a routed unit can never reach a Level 3 (paid)
tool. `{{team_stages}}` (`teamStagesText` in [context.ts](../../apps/orchestrator/src/engine/context.ts))
tells the planner each stage's specialties and the rule: label a unit whose
work a specialty covers, and write the block even for one unit.

A specialist changes what the worker is told and shown, never who runs it:
`routedStage` ([stage-teams.ts](../../packages/shared/src/stage-teams.ts))
takes the specialist's role, instructions and tool profile and keeps the
stage's key, level, timeout, retries, transitions and agent pin; the unit's
agent is the stage's (a reroute moves it). A routed unit's prompt is built from
that definition (template, `{{design_context}}`, tools, `Role:` header, "You do
it as the Designer"), and its run uses it for the tool session and the usage
role; artifact and prompt names, reuse, limits, the aggregate and the
integration pass stay the stage's own. Prompts are built once per route in a
wave (the stage's own, each specialist's — keyed by specialty, since two
specialists may share a role). Unit rows record `role` (null = the stage's) and `specialty`
(migration 23). A label no specialist has is said on the timeline ("… is
labelled with a specialty this stage does not have; the implementer does it").

When the team does not run, `soloRoute` reads the plan's block: if every unit
carries the same specialty, the one agent runs as that specialist
(`task_stages.routed_role`, "Implement runs as the designer: the plan's work
is frontend work"); mixed labels that could not run in parallel stay with the
stage's own role ("… its work units need different specialists and cannot run
in parallel"), so routing never adds a run. Full Autopilot's Implement lists
`frontend → Designer` ([design-agent.md](design-agent.md#in-full-autopilot)).

A **Fix** stage never reuses the plan's manifest: one read-only (Level 1)
decomposition run (unit kind `decomposer`) reads the fresh test and review
evidence and answers with a manifest; its report is `<stage>-decomposition.md`.
The decomposer's `manifest_hash` holds a hash of the stage, its level and the
active directive ids. When the run of the Fix just before this one was
stopped rather than failed (`CANCELLED` — parked at a limit or rerouted —
`PAUSED` or `INTERRUPTED`), with no other stage in between and the same
directives, its split is reused (decomposer `REUSED`, its report copied to
this run's `<stage>-decomposition.md`). The failures are the same, and a fresh
split would name its units differently, so none of that run's units could be
reused. A failed run's split is never reused.

## Falling back to one agent

`StageTeamRunner.run` returns null — the stage runs as one agent, with a
`STAGE_TEAM` event "… runs as one agent: <reason>" — when: no or invalid
manifest; fewer than two units; independent units claiming overlapping paths
(`independentOverlaps`); every unit depends on the previous one (mixed specialties included: routing never adds a run); a write team
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
- **Write** (Level 2–3, isolated single-repository task): per wave
  `createWaveBase` ([team.ts](../../packages/git/src/team.ts)) records a hidden
  commit `refs/acc/team/<task>/<stage>/w<n>-base` of the task worktree **as a
  commit would record it** (`committableTree`: the repository's own autocrlf
  and attributes, parent = the task's HEAD), plus the byte-exact tree of the
  same files (`workingTreeTree`, kept in memory as `exactTree`). Each worker
  gets a detached child checkout of that commit
  (`<workDir>/team-worktrees/<task>/<stage8>-<unit>`, in the work root outside
  the data folder, checked out with the
  repository's normal line-ending settings) as its cwd and only tool root.
  Every spelling of the task folder **and of the operator's checkout** in the
  prompt is rewritten to the child's (`rewritePaths`, one pass, longest
  first). `node_modules` folders (≤3 levels) are shared by directory
  junctions, removed — never followed — before the child is deleted. The
  result is captured the same normalised way (`captureResult` →
  `…/<unit>`, parent = the base) and diffed against the base
  (`changedPathsBetween`, renames as D+A); any path outside the unit's
  prefixes fails it (`SCOPE_VIOLATION`, stage error `UNKNOWN`).

**Line endings.** With `core.autocrlf=true` (Git for Windows) the task's files
are CRLF on disk and LF in Git. A byte-exact base (the design before
TASK-0018) put CRLF blobs into every child: `git ls-files --eol` said `i/crlf`,
`git diff --stat` listed every file, and workers "fixed" line endings and
reported the repository as committed with CRLF. Now a child's `git status` is
clean at the start, `git ls-files --eol` shows `i/lf w/crlf` for text, and a
file that differs only in its line endings is no change. Only the "task
unchanged since the base" check compares byte-exact trees, with each other;
read-only reuse and the integration pass record `committableTree`. A
byte-exact tree is seeded from the task's real index. A plain `git status` in
the task folder refreshes that index, and the byte-exact tree then changes
even though no file did (measured with `core.autocrlf=true`). The
committable tree stays the same.

After a wave: a stop cancels everything (units `CANCELLED`, nothing
integrated); `BLOCKED ON OPERATOR` from a work unit → `needs_operator`, nothing
integrated; any failed unit → the stage fails with that unit's class (a
blocking class such as `USAGE_LIMIT` wins), later units `SKIPPED`, nothing from
the wave integrated. Otherwise the units' changes are combined in a private
index into `…/w<n>-combined` (two units touching one path is a conflict) and
written to the task worktree by `applyIfUnchanged` — only if the task's files
are still byte for byte the wave's `exactTree`; else nothing is written and
the stage fails. The write is a checkout of exactly the changed paths with
line-ending conversion on (text in the task's usual convention, binary byte
for byte); deleted paths are removed. No forced checkout or reset, and the
task's index and HEAD are not touched.

After two or more write units were integrated, one **integration pass** (unit
kind `integration`) runs on the task worktree with the stage's assignment: it
reconciles interfaces between units, runs targeted checks, and writes the
stage's report, told to credit each change to its unit and name its own
reconciliation edits. Its `base_commit`/`result_commit` hold the task's
`committableTree` before and after it (trees, not commits — normalised so an
index refresh or a line-ending rewrite by the lead is no change); the paths
between them are its own edits, counted in its finish event. An edit outside
the union of the integrated units' paths is kept (reconciling across units is
its job) and reported as a `STAGE_TEAM` warning (`data.warning:
'integration_outside_scope'`). The Test stage stays authoritative after it.

| Unit kind | `base_commit` | `result_commit` |
|---|---|---|
| `worker`, read-only | the task's `committableTree` it read (reuse key) | — |
| `worker`, write | the wave base commit (normalised); for a unit reused because its result is already in the task, the base that result was made on | its captured result commit |
| `integration` | `committableTree` before the pass | `committableTree` after it |
| `decomposer` | — | — |

Unit titles are the worker focus or manifest title, cut at a word boundary to
60 characters with an ellipsis (`clipTitle`); built-in worker focuses are
≤ 60 characters (a test loads every built-in workflow to hold that).

## Outcome and artifacts

Each worker writes `<role-artifact>-<unit>.md` (type `stage-output`); the
stage's usual artifact (`investigation.md`, `review.md`, …) is the aggregate:
`## Integration (lead, <agent>)`, then every worker's report (≤30 000 chars
each). Every team run saves the prompt it read before it starts, as a
`stage-output` artifact ([prompts.md](prompts.md#prompt-artifacts)):
`<role prompt>-<unit>.md` for a worker (`implementation-prompt-alpha.md`),
`<role prompt>-integration.md`, `<stage>-decomposition-prompt.md`, and
`<role prompt>-<unit>-coverage.md` for a coverage follow-up; repeats are
numbered by the artifact service. A team stage writes no stage-level
`<role>-prompt.md`.

The stage summary is composed from the units — `Team of N (k reused): <unit>:
<its summary>; …; integration: <the lead's summary>` (each ≤100, all ≤500
characters) — so the lead is never credited with the workers' work.

Verdict teams: every worker must end with a VERDICT; any FAIL → FAIL; a PASS
needs the primary reviewer to account for the diff's unshown files — one
follow-up run of the primary (the aggregate is rewritten with it), then
`REVIEW_INCOMPLETE`. A FAIL emits `REVIEW_FAILED` "<stage> requested changes
(<titles of the reviewers that failed>)" with `{ verdict, durationMs, team }`
— a single-agent verdict stage's FAIL carries `durationMs` too.
`STAGE_COMPLETED` (and `REVIEW_FAILED`) carry
`team: { workers, reused, wallMs, agentMs, decomposeMs, integrationMs, integrated }`:
`wallMs` runs from before planning (so it includes the decomposition) to the
end; `agentMs` is the summed execution time of this stage's workers
(a coverage follow-up counts to its worker); `decomposeMs` and
`integrationMs` are the decomposer's and the lead's execution time, `null` when
that run did not happen. No savings are claimed beyond these numbers.

`WORK_UNIT` events: a worker "`<title>` finished · N files changed" or
"failed: …", a reuse ("`<title>`: reused its earlier result (same files, same
instructions)", "… (already in the task's files)", for a split "… (the same
failures, split before the run stopped)"); the decomposer "Split the fix finished · N units: a, b"
(or "· found one repair", "· no usable split (…)", "failed: …", "stopped");
the lead "Integration finished · no changes" / "· N files changed" (or
"failed: …", "stopped").

## Retry, restart, limits

- **Reuse:** a unit whose earlier run (same task, stage key, unit key, and
  `manifest_hash` — a hash of the manifest or team config, the stage level and
  the active directive ids) succeeded is `REUSED` instead of run. A read-only
  unit is reused when the files it read are the same (its `base_commit` holds
  their `committableTree`). A write unit is reused when its result still lies
  within its paths (a variant owns the whole repository, so it has none to
  check) and one of two things holds:
  - its base commit's tree equals the new base tree, so its result is
    integrated with this wave; or
  - it ran in the run of this stage just before this one, that run ended
    without finishing (`CANCELLED`, `PAUSED`, `INTERRUPTED` or `FAILED`), and
    the new base already holds its result at every path it changed. That run
    integrated the result before it stopped, so nothing is written again
    ("already in the task's files"). The unit still counts as integrated for
    the lead's pass.

  A reused report comes from the run that produced it, never from an empty
  reused row. Failed, stopped and interrupted units rerun, and so does a unit
  that changed nothing when its base has moved. A variants judge is never
  reused: it runs again whenever two or more variants finished, reused or not.
- **Restart:** `engine.recover()` marks `RUNNING` units `FAILED`/`INTERRUPTED`
  and `QUEUED` ones `CANCELLED`; leftover processes are stopped by the
  existing leftover-execution pass; `team.sweep()` deletes every child checkout
  under `team-worktrees` — the work root's, and the data folder's from before
  it existed — (links first) and prunes worktrees. A partial checkout
  is never integrated.
- **Cleanup:** completion and cancel delete `refs/acc/team/<task>/` and the
  task's child folder.
- **Limits:** every worker, decomposer, integration, judge and coverage
  follow-up run is an `agent` execution, so the Chairman's run and runtime
  counts include them. A supervised team checks the **task's own** `task.limits` (what
  `beforeStage` checks, extended when the operator resumes past a limit) with
  the Chairman's `limitReached`, before the decomposer, before each wave
  (counting every unit of the wave that must run — reused units do not — plus,
  for a write team's last wave, the lead's pass or the variants judge that
  follows), before the integration pass, before a variants judge and before a
  coverage follow-up. When the runs would not
  fit, no run of that step starts: its units are `CANCELLED`, the stage
  `CANCELLED` ("Paused at a limit: …"), and the task parks `WAITING_FOR_USER`
  with blocker `limit` and a `TASK_WAITING` event, as the Chairman parks it
  before a stage (the message is the Chairman's "Agent run limit reached (n of
  m)." or "Agent run limit reached for <stage>: it needs k more agent runs, and
  j of m are left."). Resume extends the limits and runs the stage again. What
  is still valid is reused: read-only units on the same files, write units not
  yet integrated whose base is unchanged, write units whose results are
  already in the task (including every wave integrated before the park, in a
  multi-wave team, and a last wave integrated before the lead's check hit the
  runtime limit), and a Fix's split. Only the work that had not run yet runs
  after the resume (tested: a three-unit Fix parked after its first wave
  resumes with the split, alpha and beta `REUSED`, and runs gamma and the
  lead). The watchdog checks every running execution of a task, naming the unit. The
  Chairman snapshot carries `team` (latest team stage, unit statuses and
  errors, as EVIDENCE text).

## Visibility

`GET /api/tasks/:id/work-units` (remote `task.workUnits`), `TaskDetail.workUnits`,
realtime `workUnit` (live-only to the cloud, [remote-node.md](remote-node.md)),
`executions.work_unit_id`, `usage_events.work_unit_key` (the ledger links
attempts per unit, so siblings are not retries; the task usage flow lists
`workUnits` per stage), events `STAGE_TEAM` and `WORK_UNIT`. Migration 19 is
additive; old rows read NULL. The Stage Timeline's team line counts workers
only (`teamSummary`, [team.ts](../../apps/dashboard/src/pages/task/team.ts)):
`Team 2/3 running`, `Team of 3 · 1 failed`, `Team of 3 · judging` while a
variants judge runs and no variant failed, `· integrating`, `· done`.

## Parallel-safe checks

`RepositoryCommand.parallelSafe` (absent = false). In a `tests` stage,
consecutive commands that are marked, of kind lint/typecheck/test/build/e2e,
and classified Level ≤2, non-production and not always-approve run together (at
most 4, each with its own execution and test run, via `childControl`). The first
real failure (after baseline and flaky classification) cancels the rest of the
batch: their runs are `not_run`, "Stopped: <name> failed first".

No repair runs inside a batch: an `npm ci` would replace `node_modules` under
the checks still running, and freeing a port could stop a sibling's server. A
failure `tooling.plan` has a repair for (install, locked or not; free the
task's port; back off) is not a failure of the batch and cancels nothing: the
job returns `repair`, its run is `not_run` "Needs a repair (…): runs again
alone once the rest of its batch is done" (event `TEST_STARTED`,
`data.deferredRepair` = the strategy). When the batch is over, each such job,
in order, is picked up again alone. It goes straight to the normal repair loop
with the failure it had (no extra failing run first), unless that failure may
be out of date: another job's repair has run since it failed (`repairsRun`
against its `repairsBefore`; even a failed install changes `node_modules`), or
`tooling.plan` no longer has a repair for it. Then it runs once more first,
and that fresh result goes through the repair loop. So one install fixes
several put-off jobs without a second install, and a job whose repair is no
longer planned (an undeclared bin such as `run-p` once `node_modules` exists)
is never failed on its stale output. A real failure there, or in the batch,
leaves the rest `not_run` as above. A job that runs alone repairs exactly as
before.

Reuse, affected tests, baseline classification, flaky re-runs and the release
tree proof are unchanged; everything unmarked runs one at a time, in order. The
e2e baseline warm-up ([workflow-engine.md](workflow-engine.md#gates-that-tell-the-truth))
runs beside the checks before the stage's first e2e, and every e2e check, in a
batch or not, waits for it to end before it starts.

## Known limitations

- Write teams need an isolated single-repository task; multi-repository write
  teams run as one agent.
- Only `node_modules` is shared into child checkouts; ignored files such as
  `.env` are not there.
- A restart in the middle of writing a combined result can leave the task
  worktree partly updated; the stage reruns from that state (no reuse, since the
  base differs).
- After an interrupted run, a write unit is reused as "already in the task"
  only when every path it changed still holds its result. If a later wave of
  that run, the operator or the lead changed one of those paths, the unit
  reruns on top of the current files.
- A restart between writing the kept variant into the task and completing
  the stage leaves the winner in the task's files: on the next run it is
  reused as "already in the task", while the other variants run again on
  files that hold it, and the judge may then keep one of those on top of it.
- A **failed** Fix run's split is not reused. The next run splits the failures
  again, and its units are reused only if the new split is identical, which is
  rare.
- Parking at a limit mid-team records no Chairman decision (the Chairman's
  `decide` is not reachable from the team runner); the blocker, the stage
  summary and the `TASK_WAITING`/`STAGE_TEAM` events say why.
- The "task unchanged since the wave base" check compares byte-exact trees
  (`workingTreeTree`), which are seeded from the task's real index. A plain
  `git status` in the task folder during a write wave, for example from an
  editor opened on it, makes identical files read as changed. The check fails
  safe: nothing is integrated and the stage fails. The stage's next run
  reuses that wave's units (the committable base is the same) and integrates
  them.

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

Last verified: 2026-09-27
