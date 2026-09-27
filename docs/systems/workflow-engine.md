---
system: workflow-engine
sources:
  - apps/orchestrator/src/engine/**
  - packages/shared/src/workflow.ts
  - workflows/**
  - prompts/**
verified_at: 57af61a
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
(agent|tests|command|git|verify|release), agentId/model/effort (optional pin),
permissionLevel, timeoutSec, retry.maxAttempts, requiresApproval, next, onFail,
verdict, commandKinds, optional, requires`, and for agent stages `instructions`
(appended to the role prompt), `toolProfile` (the capability profile the
stage's tool list is built from, never `operator`; the level still decides
what runs) and `skills` (installed skills the stage should run); the three are
refused on other kinds. `requires` names stages whose latest
run must have ended SUCCESS; otherwise the stage is SKIPPED before any approval
is asked (`Skipped: Staging deploy did not run` — Full Autopilot's Smoke
requires Staging). Validation
([workflow.ts](../../packages/shared/src/workflow.ts)): unique keys,
resolvable transitions and `requires` keys, every stage reachable, reaches `complete`, and the
`next` edges alone are acyclic — loops exist only through `onFail`, bounded by
`maxFixCycles`. Each task stores a snapshot of its profile.

A stage's `team` may be fixed, adaptive or `variants` (competing attempts, a
read-only judge keeps one; [stage-teams.md](stage-teams.md#variants)).

Frontend Design ([design-agent.md](design-agent.md)) runs a designer role
twice: Assets at Level 3 with approval on every attempt and one attempt (the
only stage the paid Level 3 `media.*` tools can run in, still behind the spend
gate) and Build at Level 2, which every
`onFail` returns to, so a fix loop never pays for media. Its Design brief is
a fixed team of three directions, its Art direction an `art-director` stage
and its Visual critique a `visual-critic` stage before the Code review.

The engine reads roles by class (`ROLE_CLASS` in
[constants.ts](../../packages/shared/src/constants.ts)): investigate, plan
(planner, art director), write (implementer, fixer, designer), judge
(reviewer, visual critic, verifier), test, deploy, report. A judge's verdict
kind is `verify` for the verifier and `review` for the others.

A `tests` stage runs the repository's enabled commands of its `commandKinds`,
by default `lint, typecheck, test, build`. Full Autopilot and Frontend Design add `e2e`, so an
end-to-end pass is observed by the orchestrator rather than taken from an
agent's report; the other built-ins keep the fast default.

A `verify` stage (the **App check** after the tests stage in Full Autopilot and
Frontend Design) starts the app
from the repository runtime (Repositories → a repository → App runtime),
waits until it answers, opens each configured path in Chromium at the
runtime's widths (`verifyViewports`, desktop and phone by default; up to all
five: phone, tablet, narrow-desktop 1024, desktop 1280, wide 1440) and colour
schemes (`verifyColorSchemes`: empty = light only, or light and dark, each a
separate pass) (or checks HTTP status for APIs/Workers), fails on console
errors, page errors, failed same-origin requests or horizontal scrolling,
saves screenshots and `browser-verification.md`, stops the app, and on
failure goes to `onFail` like a test failure. It is skipped when no runtime
address is configured (`skipsForLackOfCommands`).

A `release` stage (Full Autopilot's **Release**, after Smoke) sends the
task's tested commit live after a typed Level 5 approval and proves it
([release.md](release.md)). Validation requires Level 5, `requiresApproval`
and `optional`, and no `onFail`. It is skipped before any approval when the
repository has no release set up, the task spans several repositories or
nothing was committed. The loop takes no writer lock for it; only Live is a
success, anything else is an optional failure. A test stage records on each
run the tree a commit of its files would have (`committableTree`), which is
how a release proves it sends the version the checks passed on.

Test stages repair environment failures before failing
([recovery.md](recovery.md)). Every stage runs in the task's working
directory — its worktree when isolated ([checkpoints.md](checkpoints.md#worktrees)).
Agent stages get a scoped Control Center tool session over MCP
([mcp.md](mcp.md)); before the first stage the environment is discovered
([tool-system.md](tool-system.md#environment-discovery)). The execution policy
([autopilot.md](autopilot.md)) caps the auto-approve level for stage gates and
command approvals. Background processes stop, and browser pages the task left open
close ([browser-and-web.md](browser-and-web.md)), whenever the loop exits in a
state other than running or queued; completion and cancellation also close
terminals, remove the worktree and add "Verification coverage" (the checks
the project type calls for, plus any browser, HTTP or device evidence the
orchestrator observed; a succeeded `verify.web`, `browser.check_page`,
`browser.run_flow`, `browser.visual_matrix` or `browser.accessibility` is
browser evidence) and
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
| success / skipped | go to `next`; in Discuss First mode a successful plan-class stage (planner, art director) creates a `plan_review` approval first |
| verdict FAIL / tests failed / commit rejected by a hook (git stage with `onFail`) | go to `onFail` and count a fix cycle; at `maxFixCycles` → `WAITING_FOR_USER` (fix_limit). Resume grants one more cycle |
| `USAGE_LIMIT` | `WAITING_FOR_USAGE_RESET`, stage PAUSED — never a paid fallback |
| `AUTH_FAILURE`, `MODEL_UNAVAILABLE`, `PERMISSION_DENIED`, `CONTEXT_FAILURE` | `WAITING_FOR_USER` with the reason (an exceeded `STOP_NEW_RUNS` budget arrives as `PERMISSION_DENIED`, [usage.md](usage.md#budgets)) |
| other errors | automatic retry up to `retry.maxAttempts`, then `FAILED` |
| an optional stage fails (`optional_failed`) | stage FAILED, event `STAGE_OPTIONAL_FAILED`, the message (or the outcome's own `limitation`, as a release gives) becomes a report limitation, go to `next` — never a fix cycle or a recovery |
| a release stage finds its target branch moved (`goto`) | the task is updated from it in its worktree and continues at the tests stage; the release asks again ([release.md](release.md)) |
| a `stage_permission` approval for a `release` stage is denied | stage SKIPPED "Release declined", event `RELEASE_DECLINED`, go to `next` (every other denied approval fails the task) |
| `REVIEW_INCOMPLETE` (a verdict stage passed twice without naming files the diff did not show) | an error like any other: retried, then (supervised) the Chairman retries or changes agent; never a code fix |
| a work stage (any role outside the judge class) ends with `BLOCKED ON OPERATOR:` lines | `WAITING_FOR_USER`, blocker `decision` carrying the question(s); the stage is PAUSED and runs again on resume. Supervised or not, no tests, fix loop or recovery run around it |

**Supervised tasks** (Autopilot with the Chairman on) differ: a test or
verdict failure asks the Chairman, which keeps the local fix loop while it
progresses ("Fix attempt N of M") and otherwise starts a recovery cycle
instead of `fix_limit`; exhausted retries and provider blocks go to it too.
They end in `WAITING_FOR_USER` with blocker `hard_blocker` or `limit`, never
`FAILED`, and `complete` passes the Chairman's completion gate first. See
[chairman.md](chairman.md).

Completion writes `git-diff.patch`, `final-report.md` and `task.json` — all
before `COMPLETED` is published, so clients never see a report without its
task record. `git-diff.patch` ([git.md](git.md#applicable-patches)) is
written after the final commit: an isolated repository is diffed commit to
commit (baseline → task branch), so it is exactly what the branch holds even
when a pre-commit hook rewrote a file; an in-place task's working tree is
diffed against the baseline. It is Git's own bytes, so `git apply` takes it
back — reversed out of the task's checkout or forward onto the baseline —
including changes to CRLF-committed files. Binary files, and any file that is
not plain UTF-8 text, carry only their full object ids ("Binary files …
differ"), resolved from the task's own repository; no binary content ever
enters the artifact. A file holding secret-shaped content (its text, a
binary file's content in any common encoding, a private key, or a file named
like secret material such as `.env`) is replaced by a `[withheld from
git-diff.patch: …]` line and the rest still applies. A multi-repository patch
puts each repository's paths under its folder (a rename shows as a deletion
plus an addition); its text applies from the folder holding the
repositories, and with a binary change each repository applies its share from
there with `git --git-dir=<folder>/.git --work-tree=. apply
--include='<folder>/*' git-diff.patch`. Files past 5,000,000 bytes per
repository, files Git cannot diff and binary files whose content the
repository cannot supply are left out whole and named on a `[not included in
git-diff.patch: …]` line. Both carry **Where the time went**
([time-breakdown.ts](../../apps/orchestrator/src/engine/time-breakdown.ts),
also `GET /api/tasks/:id/time`, measured up to now for a running task): every
millisecond from creation to the end in exactly one bucket, by precedence
stage → parked → queued → overhead, so the buckets add up to the total. Agent
stages count as rework once a tests stage failed with anything not
pre-existing, or a review failed; `tests`/`command`/`verify`/`git` stages are
checks (`baseline …` executions shown as the part spent comparing with the
baseline), `release` stages are release; parked runs from `TASK_WAITING`,
`APPROVAL_REQUESTED`, `TASK_FAILED` or `TASK_INTERRUPTED` to the next
`TASK_RESUMED`, `APPROVAL_RESOLVED`, `STAGE_RETRY`, `TASK_COMPLETED` or
`TASK_CANCELLED`. It also counts agents' Bash calls that ran a configured
test or e2e command in full (evidence only). Computed on demand, no table;
an error gives "Not enough data" and never stops the report. The report lists any `browser-recheck-*.md` re-checks under
Verification coverage as operator-observed evidence, never as a pass
([connected-apps.md](connected-apps.md)). A judge-class stage with `verdict: false` still records an
advisory verdict (it does not route); a FAIL makes the report
`NEEDS_USER_ACTION` (used by the built-in Staged Review workflow). The final
status is `READY` only when the last *finished* test stage (a cancelled or
interrupted instance does not count) passed with at least one passing command
and came after the last successful write-class stage (implementer, fixer,
designer), the latest review verdict (reviewer or visual critic) and the
latest verification did not fail, and no file mixes pre-existing user work with task
changes; otherwise `NEEDS_USER_ACTION` with the reason (`No test stage ran.`,
`Tests have not run since the last change.` …) — the rule the supervised
completion gate applies too, where each judge role with a verdict stage must
have passed since the last change, so a visual critique's PASS never stands
for the code review ([report.ts](../../apps/orchestrator/src/engine/report.ts),
[gate.ts](../../apps/orchestrator/src/chairman/gate.ts),
[chairman.md](chairman.md#completion-gate)). Lines starting `NEEDS OPERATOR:` in the
latest verification (or, when none ran, the latest review of each review stage) — things only the operator can settle, which
those roles are told not to fail for — are listed as "Needs your decision"
and also make it `NEEDS_USER_ACTION` ([report.ts](../../apps/orchestrator/src/engine/report.ts)).

**Decisions** ([report.ts](../../apps/orchestrator/src/engine/report.ts)
`extractOperatorBlockers`, [runners.ts](../../apps/orchestrator/src/engine/runners.ts)).
The investigator, planner, art director, implementer, fixer and designer prompts tell the agent to
change nothing and end with `BLOCKED ON OPERATOR: <decision, options,
recommendation>` when the goal cannot be met correctly without the operator —
contradictory requirements or tests, a forbidden action, missing access. The
task stops on blocker `decision`; adding a directive (the answer: task page
**Answer**, the directive dialog, or plain words to the Chairman) resumes it at
once and the stage runs again with it. Found in a real run: before this, an
implementer that honestly refused "reported success" with no change, and the
supervised task spent two recovery cycles and 13 agent runs to end on a
generic hard blocker; now it stops at Investigate after one run with the
question and options.

An optional `command` stage with no matching command configured is skipped
without asking for approval (`skipsForLackOfCommands`).

An agent stage with a `team` runs as a **Stage Team** — several workers, write
workers in their own checkouts, one outcome — or falls back to one agent
([stage-teams.md](stage-teams.md)); the built-in Architecture, Full Autopilot
and Frontend Design workflows use teams. A tests stage runs consecutive commands the
repository marked `parallelSafe` together, stopping the batch at the first
real failure; a check whose failure a repair would fix is repaired and run
again alone once the rest of its batch is done
([stage-teams.md](stage-teams.md#parallel-safe-checks)); everything else runs
one at a time, in order.

## Gates that tell the truth

What [AUTOPILOT_GATES_PLAN.md](../plans/AUTOPILOT_GATES_PLAN.md) added, found
in TASK-0007 (a PASS on 12 of 19 files, failures that were already on `main`,
Smoke after a skipped Staging, the unit suite run three times):

- **Review coverage.** `packDiff` ([diff-pack.ts](../../packages/git/src/diff-pack.ts))
  splits the diff per file and packs whole files into 150 000 characters in the
  order source, tests, config, docs, then generated files, lockfiles and
  binaries (a first file too big for the budget is shown in part, cut at a hunk
  boundary). Every changed file not shown in full is listed in
  `{{diff_coverage}}` with its `+a −d`, the reason and how to read it; a task
  across repositories packs every repository into one budget, and a staged
  review packs its staged diff. The changed-files list carries `+a −d`. An
  added or changed image or video, which the diff shows only as "Binary files
  … differ", counts as not shown: one a changed `manifest.json` names (its
  SHA-256 checked when the entry gives one) is listed as generated media that
  need not be named; any other must be viewed and named
  ([design-agent.md](design-agent.md#design-memory-and-learning)).
  Pre-existing user work the task never touched is never listed. A PASS
  from a `verdict` stage must name every listed file (full path, or a
  basename no other changed file shares, `unreviewedFiles`): otherwise the
  runner asks the same agent once more inside the same stage (a second
  execution, same attempt); a second miss fails the stage `REVIEW_INCOMPLETE`.
  A FAIL is never second-guessed. When packing cannot run, every changed file
  must be named.
- **Baseline-aware checks** ([baseline-checks.ts](../../apps/orchestrator/src/engine/baseline-checks.ts)).
  Failing test ids are read from the whole output while it streams
  (Vitest/Jest/Mocha/TAP/pytest lines and Playwright's `N failed` block; line
  numbers and timings dropped, at most 500; a bare `× title` that another id
  names in full as `file > … > title` is dropped) into `test_runs.failures`. The
  first failure of a command in a tests stage runs the same command once on the
  task's baseline commit, in a detached worktree under
  `<dataDir>/baselines/` (dependencies from the lockfile through the tool
  policy; removed in a `finally`; leftovers swept at start). One result per
  repository, commit and command (`baseline_checks`) is shared by every task,
  one run per key at a time. Unless the full result is already known, only the
  failing test files run first
  ([targeted-tests.ts](../../apps/orchestrator/src/engine/targeted-tests.ts)):
  files read from the ids that exist at the baseline commit (safe relative
  paths — route folders like `[id]` allowed and passed in double quotes; looked
  up with literal pathspecs — test-file names, at most 50), appended to an npm script whose body is
  one `vitest`/`jest`/`playwright test` run, or to such a runner called
  directly (`npm test -- a.test.ts`); never pytest, whose files can fail alone
  and pass in the suite. File paths never start with `.` or `-`, and
  Playwright ids relative to a `testDir` below the root are not found at the
  baseline, so those fall back to the full run. That narrowed run is kept under its own
  command sha and can only prove `preexisting`; when any failure does not
  reproduce, or it cannot be built or finish, the full run decides as before
  (TASK-0008: 17.6 min for the whole unit suite, for 6 failing files).
  A kept full result can be out of date for a test that depends on the clock or
  the machine, so when it leaves failures unexplained (`new`), their files run
  once more on the baseline, now (not from the cache; the row is replaced), and
  failures that reproduce there are `preexisting` too. Found in the TASK-0010
  replay: a time-of-day test failed at night on the baseline, but not in the
  full run kept from the afternoon, and the task stopped for a decision.
  `preexisting` (the baseline failed and every
  failing id is among its failures) is recorded, shown apart ("Already failing
  before this task — do not fix unless asked" in prompts, a report limitation)
  and the stage goes on. A failure the baseline does not explain, with its ids
  read, gets its failing test files run once more on exactly the task's files
  (the same narrowing, `rerunFailingFiles` in
  [runners.ts](../../apps/orchestrator/src/engine/runners.ts), its own test run
  "<name> · failing files again", summary `Re-run: …`). All passing → `flaky`:
  not blocking, like `preexisting`, and a report limitation naming the tests
  ("a flaky test, worth fixing separately"); failing again, or a command that
  cannot be narrowed, keeps it `new`/`unknown`, which block as before. Found in
  TASK-0009: a docs-only change failed a different one of 9,269 tests on each
  19-minute run. `nonBlockingFailure()` (shared) is the one test for both. A
  repository set to `preexistingFailures: 'block'` skips the comparison and the
  re-run.
- **Baseline warm-up** ([runners.ts](../../apps/orchestrator/src/engine/runners.ts)
  `runCommands`, `BaselineChecks.warm`). Found in TASK-0014: on
  tenten-accounting-in the e2e baseline run (118.8–135.1 s, plus about 9 s of
  cleanup) sat on the critical path after the task's own e2e failed with
  failures that were already there. When a tests stage starts, before any
  command runs, the full baseline run of its first `e2e` command starts beside
  the checks before it, only when all of these hold:
  - the e2e is not in the stage's first batch (something runs before it; a
    check in its own parallel batch starts with it), the repository does not
    `block` pre-existing failures, the e2e would not be reused on the current
    tree, and the task has a baseline commit;
  - no usable (non-`error`) `baseline_checks` row for the command
    (`command_id`) exists at this commit yet, full or narrowed;
  - the newest row (`created_at`) that says whether the command fails on a
    baseline says it does. Such a row is a run of the whole command as it reads
    now (`command_sha`), or a `failed` narrowed run, whose failing files fail
    the whole suite too. A narrowed run that passed says nothing about the
    rest, and `error` rows prove nothing. The warm-up keeps its own row, so
    once the baseline passes again the next warm-up is the last. On
    tenten-accounting-in (failed narrowed e2e rows from TASK-0014, suite fixed
    on 09-26) that means one more warm-up, then none;
  - it is expected to end within the head start: the typical time until the
    e2e would start anyway. That is the sum, over the batches before the e2e's,
    of each batch's longest check, using the median of the check's last 5
    whole runs in the repository's last 40 tasks (passed or non-blocking, not
    reused, not affected-only), timed as `{{check_costs}}` times them. A check
    with no timing, one running only the affected tests, or one that will be
    reused counts as 0. The expected duration of the warm-up is the newest
    whole run's `duration_ms`. Without one, it is the newest narrowed row's
    (worktree, install and those files) plus the e2e's own typical duration;
    neither known means no warm-up. So a `[lint, e2e]` stage whose lint takes
    seconds is never warmed.

  It is an ordinary baseline run (same key and `inflight` dedup, lockfile
  install through the tool policy, `node_modules` never linked in); event
  `TEST_STARTED` with `data.baselineWarmup`, `data.expectedMs` and
  `data.headStartMs`. Every e2e command of the stage waits for it to end before
  starting, since a fixed port with `reuseExistingServer` would otherwise test
  the baseline's server: summary "Waiting for the baseline check started with
  this stage to finish (both may use the same port)", event
  `data.waitingFor: 'baseline'`; a stop ends the wait. `classify` first awaits
  an in-flight run of its own key, so a failure is classified from the warmed
  result instead of starting a second run. When the stage ends before its e2e
  ran (a real failure, a stop), the warm-up is cancelled unless another caller
  waits on it: the command is killed, while an install already under way
  finishes first; the `error` row it leaves is tried again later. A warm-up
  that cannot start leaves the stage as it was. How often it fires on real
  tasks has not been measured with this rule. The time breakdown still counts
  its whole duration as "comparing failures with the baseline", although it
  overlaps other checks.
- **Waivers.** An operator directive with rule `waive_check` (the Answer and
  Add directive dialogs' **Don't gate this task on** checkboxes) removes those
  kinds from this task's tests stages and its completion gate; it wins over a
  `require_check` of the same kind and the report lists it. Only the operator
  route accepts it ([chairman.md](chairman.md#directives)).
- **Reuse.** Before each command the tree of the files it runs on
  (`committableTree`) is recorded as `test_runs.tree_id`. A command that
  already passed in this task, in the same repository, on the same tree is not
  run again: the new row is `passed`, `Reused: same files as <stage> at <time>`,
  `reused_from` set. Failures are never reused; a command that changed files
  records no tree. Implementer and fixer prompts say to run only the tests for
  the files they changed.

## Affected tests only

What [AFFECTED_TESTS_PLAN.md](../plans/AFFECTED_TESTS_PLAN.md) added: a
repository set to `testSelection: 'changed'` (Repositories → a repository →
Commands → **Run only affected unit tests**; `full` by default, and for every
repository that existed before migration 18) runs, in a tests stage, only the
unit tests whose imports reach a file the task changed.

- **Which command.** Only a `test`-kind command of a `tests` stage, and only a
  Vitest run: an npm script whose body is one `vitest` run, or `vitest` called
  directly (`runnerInvocation`/`narrowCommand` in
  [targeted-tests.ts](../../apps/orchestrator/src/engine/targeted-tests.ts),
  the same parser the targeted baseline uses). It gets
  `--changed <baseline commit> --passWithNoTests`: the only text added is the
  commit id (40 or 64 lowercase hex), and Vitest reads the changes from Git
  itself and builds the import graph. Lint, typecheck, build and e2e, Jest,
  pytest, Playwright and pnpm/yarn scripts always run in full.
- **When the whole suite runs anyway**
  ([test-selection.ts](../../apps/orchestrator/src/engine/test-selection.ts),
  first rule that fails, reason in the summary): no baseline commit; the
  changes cannot be read or there are none; a file was deleted or renamed; a
  changed file is not `.js/.jsx/.ts/.tsx/.mjs/.cjs/.mts/.cts` (JSON fixtures,
  snapshots, `.env`, `tsconfig.json`, lockfiles, docs: tests read them without
  importing them); a changed file is test infrastructure (a name with
  `setup`, `global-setup`, `teardown` or `config` as a word, or a folder named
  `__mocks__`, `__fixtures__`, `fixtures`, `test-utils` or `testing`, in any
  case); an npm script with a `pre`/`post` hook (npm runs it around the tests,
  and it may write or delete files); or the command is not one Vitest run, or
  already watches or selects its own files. The selection is made before the
  stage's commands run (so the approval gate classifies both the narrowed and
  the original line) and made again right before a narrowed test command runs,
  so a file an earlier command in the stage wrote or deleted is seen.
  The changes are read with `pathStatusSince` (packages/git) against the
  baseline commit, so a deletion committed at a Git checkpoint still counts;
  pre-existing user work in the folder is included too.
- **Fallback.** A narrowed run that failed with no failing test ids and no
  totals line never ran a test (an old Vitest, no Git, a config error): its
  row becomes `not_run`, `Superseded: …`, and `<name> · whole suite` runs the
  original command once in the same stage and decides. A superseded row is
  neither a pass nor a failure for the report or the release's tested trees. A
  narrowed failure with test ids is a real failure: the baseline comparison
  and the flaky re-run use the **original** command (a `--changed` run on the
  baseline would select nothing), narrowed to the failing files as before.
- **Recorded.** `test_runs.selection`: `changed`, `full` (the repository asked,
  but the whole suite ran; the summary says why) or null (as always). Summaries
  start `Affected by the change (N changed files): …`, `No test imports the N
  changed files`, `Whole suite — <reason>: …` or `Whole suite (the affected
  tests could not run): …`. Reuse matches the command line, so a run of
  affected tests is never reused as a whole-suite pass. The final report's
  Verification coverage says `Unit tests (`npm test`): only the tests affected
  by the change ran …` (information, not a limitation), and a Release approval
  of such a commit says so. Only this machine can turn the setting on
  ([remote-node.md](remote-node.md)).

## Live control

- **Pause** cancels the running execution; the stage is PAUSED and re-runs on resume.
- **Reroute** writes a stage override; if that stage is running it is stopped and re-run with the new agent in the same loop (no restart from zero — the prompt carries the previous attempt).
  `applyToRole` also sets the role override; `applyToAgent` also moves every other
  agent stage of the task still resolved to the stage's current agent (same
  model, each stage keeps its effort unless one is given), and the `REROUTED`
  event names them (`· also Review, Verify`). The dialog offers it whenever other
  stages use that agent and ticks it by default when the blocker is `usage` or
  `auth` — a provider out of credits would otherwise stop each of its stages in turn.
- **Directives** are persisted immediately and applied when the next agent stage builds its prompt.
- **Retry** re-queues the chosen stage; pending approvals are withdrawn.
- **Approvals and attempts.** An approval for a stage with `requiresApproval`
  (or a Level 5 stage) covers one attempt: once an instance of that stage has
  started after the approval, a retry, a fix cycle or a recovery that reaches it
  asks again. A command approval that needed a typed confirmation (dangerous,
  Level 5, production) is bound to the stage instance it was asked in. Other
  approvals (a stage or command above the auto-approve level) hold for the task.
  A command is classified with its package scripts expanded and with the
  release gate (`stageCommandRisk`, SEC-1): one whose script pushes to a
  release branch of the task's repositories or a production-named branch, or
  merges a pull request, is Level 5 production and waits for a typed approval
  — an agent can edit the script a later stage runs
  ([tool-system.md](tool-system.md#the-execution-door-servicets)).
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
A task across repositories holds all of them and waits for any task sharing
one; its tests, App check, Git checkpoint, completion and cancel run per
repository ([multi-repository-tasks.md](multi-repository-tasks.md)).
A stage with permission level ≥ 2 registers as a writer with the shared
[RepositoryCoordinator](../../apps/orchestrator/src/services/repository-coordinator.ts):
it waits for a Source Control mutation in flight, and Source Control refuses
mutations while it runs ([source-control.md](source-control.md)).

## Restart recovery

On start, executions/stages left `running` are marked interrupted and
`RUNNING` tasks become `INTERRUPTED` with an explanation; queued tasks keep
waiting. Supervised tasks interrupted this way are then resumed by the
Chairman ([chairman.md](chairman.md#restart)). A task parked on a stage approval for a stage that would now be
skipped (its command was removed) has the approval withdrawn and continues.

`POST /api/service/shutdown` takes `{ mode }`: `refuse` (default) answers 409
with the running task ids and stage names while any loop runs; `drain` stops
starting work and lets each task stop at its next stage boundary
(`INTERRUPTED`, "Stopped between stages for a restart", nothing cut off), then
shuts down; `force` interrupts running stages now, as before
([operations.md](operations.md)).

## Prompts

Role templates ([prompts/](../../prompts)) are versioned in the database; each
edit is a new version and tasks record which version each role used. The
context builder ([context.ts](../../apps/orchestrator/src/engine/context.ts))
fills a fixed placeholder catalog for every agent stage, prefixes every
prompt with `RUN_CONTEXT`, and saves each stage's rendered prompt as an
artifact. The catalog, the marker lines the engine reads back (`VERDICT:`,
`BLOCKED ON OPERATOR:`, `NEEDS OPERATOR:`, `CAUSE:`) and what each role is
told are in [prompts.md](prompts.md).

Stage summaries in timelines and reports come from the agent's **Summary**
section (or Goal/Findings), else its first prose line — never a heading,
table row, verdict or cause line (`summarize`). Verification commands record their
runner's totals line, e.g. `Tests 429 passed | 1 skipped (430)`, or for
`node --test` (which prints `# pass 2` / `ℹ pass 2`, one total per line)
a composed `1 failed | 2 passed (3)`
([test-summary.ts](../../apps/orchestrator/src/engine/test-summary.ts)).
The final report's Tests line counts commands, not tests
(`1 command passed · 0 failed · 0 not run`), and each passing or failing
row carries that totals line (`- ✓ unit tests (4.2s) — 12 passed (12)`)
([report.ts](../../apps/orchestrator/src/engine/report.ts)). A supervised
task's `Fix attempts` counts fixer runs and designer runs started in a fix
cycle (a design workflow's rebuilds), as the learning `fix_loops` signal does.

Last verified: 2026-09-27
