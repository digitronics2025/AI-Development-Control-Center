# AUTOPILOT_GATES_PLAN — gates that tell the truth

Status: proposed · Written 2026-09-25 against `b9ce60f` · Evidence: TASK-0007 (tenten-accounting-in, Full Autopilot), monitored end to end, released as `779bbcb` · Owners: [workflow-engine.md](../systems/workflow-engine.md), [chairman.md](../systems/chairman.md), [git.md](../systems/git.md), [checkpoints.md](../systems/checkpoints.md), [operations.md](../systems/operations.md)

## 1. Goal

A Full Autopilot task may only report success when its gates reflect what actually happened:

- **Review and Verify saw the whole change.** In TASK-0007 the reviewer gave PASS after seeing 12 of the 19 changed files. The diff was clipped, and the note saying so was clipped away too.
- **A failed check is compared with the baseline.** In TASK-0007, 1 unit test and 10 e2e tests were already failing on `main`. The task spent a fix cycle, a recovery cycle and about 40 minutes learning that. It also needed the operator to toggle repository-wide commands.
- **A stage runs only when it has something to act on.** Smoke ran after a skipped Staging with nothing to test, failed in 0.4 s, used up two recovery cycles and ended in a hard blocker.
- **The operator's decisions reach the gate.** "Don't gate this task on e2e" could not be expressed at all.
- **Work is isolated and survives restarts.** The task switched the operator's own checkout to its branch for 3.5 hours. Another session restarted the orchestrator in the middle of a stage.
- **Checks don't repeat on unchanged code.** The unit suite (about 14 minutes) ran three times, the last time after a docs-only edit.

Measured in TASK-0007:

- 3 h 30 min wall clock;
- $27.10 in cost, 31 % of it on retries;
- 3 recovery cycles, 2 of them wasted;
- 7 operator interventions.

The target is the same change with no workarounds, **at most one decision**, and no stage that approves what it did not see.

## 2. Scope

**In**

1. **Complete review coverage (A).** The diff is packed by priority, and every file that is not shown is named. Review and Verify must account for every changed file before a PASS counts.
2. **Baseline-aware checks (B).** A failing command is re-run once on the baseline commit. Failures that already existed are classified as pre-existing: they are recorded and reported but do not block. New failures block exactly as today.
3. **Per-task check waiver (C).** A new directive rule, `waive_check`. It is set only by the operator, through explicit controls in the Answer dialog, and it is honoured by the Test stage and the completion gate.
4. **Stage prerequisites and optional-stage failures (D).** A new `requires` field on a workflow stage (Smoke requires Staging). A failed optional stage becomes a report limitation and never starts a recovery. Recovery cycles are counted only when a strategy really starts.
5. **Check-result reuse (E).** A passing result is reused when the working tree, the command and the repository are identical. Agents run targeted tests, not the full suite.
6. **Isolation by default (F).** New repositories use worktree mode. A failed worktree creation stops the task instead of silently falling back to the operator's checkout. Existing repositories get a one-click switch.
7. **Restart guard (G).** Shutdown refuses to run while stages are running unless the operator forces it or chooses drain mode. Drain mode stops each task at its next stage boundary, and tasks resume after the restart.
8. Migration 16, tests, docs updates, and a real replay run on `tenten-accounting-in`.

**Out** (see §9)

- A Release stage (merge to main, watch the deployment, confirm the live bundle). That is §10.
- Detecting how to start the app, signed-in App check, and verification fixtures.
- Task titles taken from attachments.
- Push notifications.
- Choosing only the affected tests.

## 3. Enhanced design and architecture

### A. Complete review coverage

**Root cause.** `diffSince` (`packages/git/src/index.ts:328-351`) produces one string that is cut at 150,000 characters, in git's order. `context.ts:257` then appends `[diff truncated]`, and `clip()` at `context.ts:299` cuts back to 150,000 characters, which removes that note. `{{changed_files}}` drops the +/- stats (`context.ts:259`). Neither prompt says what to do with a partial diff, and nothing checks that the reviewer covered every file.

**Design**

1. **A new pure helper, `packDiff(raw, changedFiles, budget)`** in `packages/git/src/diff-pack.ts`. It splits the raw diff on `diff --git` headers into one chunk per file, orders the files and packs whole files up to the budget. It returns `{ text, shown: string[], omitted: {path, additions, deletions, reason}[] }`. The order is:
   1. source;
   2. tests;
   3. config;
   4. docs;
   5. generated files, lockfiles and binaries.

   The lockfile list is `LOCKFILES` from `worktrees.ts:60`. A binary is a file whose numstat additions are null. A generated file matches `*.generated.*`, `dist/**`, `build/**` or `*.min.*`.

   A file larger than the remaining budget is still shown, cut off at a hunk boundary and marked `partial` in `omitted`, as long as it's the first chunk. That way one giant file can never hide everything else. The raw diff is still collected with a hard ceiling (4× the budget), and anything beyond it simply ends up in `omitted`. `changesSince` is always complete, so the `omitted` list is always complete too.
2. **`workspaceFacts` / `build`** (`context.ts:114`, `:237`) use `packDiff` for both the single-repo and the multi-repo path (a shared budget, split across repositories) and for the staged-diff path. `clip()` is no longer applied to the diff. The packer owns its budget, and its trailer is written after packing, so it can never be clipped away.
3. **New placeholder `{{diff_coverage}}`.** It renders `Diff shows N of M changed files.` and then one line per omitted file: `- path (+a −d, reason) → read: git diff <baseline> -- <path>`. The changed-files list gains `+a −d`.
4. **Prompts.** `reviewer.md` and `verifier.md` get one paragraph: every file listed under "Not shown" must be read from disk before giving a verdict, and the report must name each such file under `## Files reviewed`. `fixer.md` and `implementer.md` get the coverage block for information only.
5. **Coverage check** in `runAgent` (`runners.ts:351-369`), applied only to stages with `def.verdict` and a non-empty `omitted`. A PASS whose report fails to mention an omitted path (full path or unique basename) is **incomplete**:
   - The runner re-runs the same agent once, inside the same stage, with an appended instruction naming the missing files. This is recorded as a second execution; the attempt number stays the same.
   - If the second report still misses files, the stage fails with the new error class `REVIEW_INCOMPLETE`. The Chairman handles it as a failure of that stage (retry or change agent), never as a code defect. **A FAIL verdict is never downgraded.**

### B. Baseline-aware checks

**Root cause.** The baseline records files and HEAD only (`engine.ts:947-990`). `test_runs` stores a one-line summary; failing test ids are parsed only for the Chairman's signature (`chairman/signatures.ts:61-70`, limit 5, with no Playwright pattern). `runCommands` stops at the first failure (`runners.ts:503-510`) and returns `tests_failed`, whatever the baseline looks like.

**Design**

1. **Failure ids.** Move `failingTestIds` into `engine/test-summary.ts`, which both the engine and the Chairman then import. Add a Playwright pattern: the `N failed` block lists `[project] › file:line:col › title`. The runner collects matching lines from the **full** output while the command streams (a bounded set, at most 500 ids), not only from the 80-line tail. Ids are passed through `redact()` and stored in `test_runs.failures` (JSON).
2. **Baseline check.** The first time a given command fails in a task, `BaselineChecks.classify(task, repo, command, failures)` does the following:
   - It looks up `baseline_checks` by `(repository_id, baseline_commit, command_id, command_sha)`. On a miss it creates a **detached** worktree at `task.git.baselineCommit`:
     - The helper `addDetachedWorktree` is extracted from the inline code in the `git.bisect` tool (`packages/tools/src/packs/git.ts:352-379`) into `packages/git/src/worktrees.ts`.
     - The worktree lives under `<dataDir>/baselines/<repoSlug>/<commit12>`.
     - `prepareWorktree` installs dependencies with the frozen lockfile (`tooling.ts:409-417`).
     - The same command runs with the same timeout and environment. The result is stored (status, summary, failures) and the worktree is removed in a `finally`, using `removeWorktree` (`worktrees.ts:25-33`).
   - One result per repository and commit is shared by every task on that commit. Only one baseline run per key is in flight at a time (an in-process promise map).
3. **Classification** (a pure function, `classifyFailures(task, baseline)`):
   - `preexisting`: the baseline also failed, and every task failure id appears in the baseline failures.
   - `new`: the baseline passed, or at least one task failure id is absent from the baseline.
   - `unknown`: ids couldn't be parsed on either side. This is treated as `new`, so the check fails closed.
4. **Gate behaviour** in `runCommands`:
   - A failure that is entirely `preexisting` is recorded with status `failed` and classification `preexisting`, and the stage **continues** with the remaining commands.
   - Any `new` or `unknown` failure keeps today's path (`tests_failed`, fix route).
   - `stageCommands` ordering and the repair loop don't change.
   - `tests.log` shows each class, for example: `✕ e2e tests — 10 failed, all pre-existing on d8ca918`.
5. **Consumers**:
   - The completion gate (`chairman/gate.ts:69-84`) and `verificationCoverage` (`tooling.ts:489-516`) count a `preexisting` run as "not a regression, not a pass". The final report adds the limitation *"N pre-existing failures in `<command>` were left as they were"*, and the status stays COMPLETED.
   - Prompts (`testResults`, `context.ts:165-185`) list pre-existing failures separately under **Already failing before this task — do not fix unless asked**.
6. **Repository setting** `preexistingFailures: 'allow' | 'block'`, default `'allow'`, stored in the existing `commands`-adjacent JSON settings. `'block'` keeps today's strict behaviour for repositories that want it.

### C. Per-task check waiver

**Root cause.** `DirectiveRule` can only add requirements (`packages/shared/src/chairman.ts:60-69`). The Answer dialog is free text (`dialogs.tsx:50-82`), and `deriveRule` cannot express "don't gate on X".

**Design**

1. Add the rule `{ type: 'waive_check', kinds: CommandKind[] }` to `DirectiveRule`. It is **never** derived from text (`deriveRule` stays unchanged). It is set only through `directiveSchema.rule`, an optional field accepted only on the operator directive route (`routes.ts:182`). The Chairman gateway and agent tools can't create it (§6).
2. Add `waivedKinds(store, taskId)` next to `requiredKinds` (`runners.ts:134-138`):
   - `runCommands` subtracts waived kinds after adding extra and required ones (`runners.ts:378-379`).
   - `configuredKinds` in the completion gate (`chairman.ts:621`) also subtracts them.
   - A waived kind that is also required is a conflict. The waiver wins because it is the later operator decision, and the report says so.
3. The Answer and Add directive dialogs get a **Don't gate this task on** row of checkboxes, one per enabled command kind that has failed in this task. The directive text stays free, and the checkboxes add the rule.
4. The final report and the task's Tests tab list waived kinds with the directive text as the reason.

### D. Stage prerequisites and optional-stage failures

**Root cause.**

- `handleOutcome` treats `skipped` like `success` and moves on to `def.next` (`engine.ts:1116-1139`), so Smoke runs after Staging was skipped.
- A failed optional command stage returns `error` / `COMMAND_FAILURE` (`runners.ts:528-530`). That goes through `supervisor.onError` to `recover('worker_failure')`, labelled "the agent kept failing to run" (`policy.ts:29`), and ends in a hard blocker (`chairman.ts:566-576`).
- Resuming after a hard blocker clears the tried strategies (`chairman.ts:674-677`), and a cycle is counted for every candidate tried (`chairman.ts:480-491`).

**Design**

1. **The stage schema** (`packages/shared/src/schemas.ts:66-92`) gets an optional `requires: string[]`, the stage keys that must have ended SUCCESS in the current cycle. The engine checks it before running a stage. If a requirement didn't succeed, the stage is SKIPPED with `Skipped: <name> did not run`. In `workflows/full-autopilot.yaml`, Smoke gets `requires: [staging]` and the workflow version is bumped. Custom workflows without `requires` behave exactly as today.
2. **Optional failures.** In `runCommands`, when `def.optional` is set and the stage fails, the runner returns a new outcome, `{ kind: 'optional_failed', message }`. `handleOutcome` records the stage as FAILED, emits `STAGE_OPTIONAL_FAILED`, appends the message to the task's limitations and moves to `def.next`. It never calls the supervisor.
3. **Recovery accounting** (`chairman.ts:480-491`):
   - `recoveryCycle` is incremented only after `applyInLoop` confirms the strategy started. Candidates that are rejected before starting don't count.
   - `onResume` clears `strategyFingerprints` only when a directive or rule was added after the block (compare the directive `createdAt` with the block time). Otherwise the tried strategies are kept.
   - The trigger label for a command-stage failure becomes "the check command failed", separate from "the agent kept failing to run".

### E. Check-result reuse

**Root cause.** Every tests stage re-runs every command (`runners.ts:456-511`). `workingTreeTree` (`packages/git/src/index.ts:398-403`, private index plus `write-tree`) exists but is only used for checkpoints.

**Design**

1. Before each command, compute `treeId = workingTreeTree(workdir)` once per stage and repository, and store it in `test_runs.tree_id`.
2. **Reuse rule.** A previous run in the **same task** with the same `repository_id`, `tree_id`, `command` text and status `passed` is reused. A new `TestRun` is written with status `passed`, the summary `Reused: same files as <stage> at <time>`, `duration_ms` 0 and the new column `reused_from`. Failed runs are never reused. The rule stays inside one task, so the environment can't drift between tasks without being noticed.
3. The reuse also feeds D3: a Chairman `retry_stage` for a command stage whose tree and command are unchanged since the failure is rejected as a no-op. That turns into a limitation for optional stages, or a hard blocker with an honest message for required ones.
4. **Prompts.** `implementer.md` and `fixer.md` get one line: the orchestrator runs the full configured checks after this stage, so run only the tests for the files you changed. This is a prompt-snapshot test.

### F. Isolation by default

**Root cause.** New repositories get `gitMode: 'task-branch'` (`services/repositories.ts:206`). A task is isolated only in worktree mode (`engine.ts:206`), and `ensureBaseline` silently sets `isolated: false` when `createWorktree` returns null (`engine.ts:971`).

**Design**

1. **New repositories** get `gitMode: 'worktree'`. The DB column default stays as it is, because the service always sets the value explicitly.
2. **`createWorktree` returns `{ ok: false, reason }`** instead of null. For a Git repository, `ensureBaseline` blocks the task with a hard blocker: *"Couldn't create an isolated worktree: <reason>. Your working folder was not touched."* A non-Git folder still runs in place: it has no branch to switch, so nothing changes for it.
3. **Existing repositories** keep their mode. On a repository whose mode is not worktree, `RepositoryDetailPage` shows a callout: *"Tasks run in your working folder"*, with a **Use isolated worktrees** button. The button uses the existing PATCH.
4. The task header shows the folder the task works in, from `task.git.worktreePath ?? repo.path`.

### G. Restart guard

**Root cause.** `POST /api/service/shutdown` shuts down immediately, whatever is running (`http/server.ts:77-81`). The stop script force-kills after 15 s. There is no drain mode.

**Design**

1. The route accepts `{ mode?: 'refuse' | 'drain' | 'force' }`, default `'refuse'`:
   - `refuse`: while any stage is RUNNING, answer 409 with the running task ids and stage names.
   - `drain`: set `engine.draining = true`. Answer 202 with `{ waitingFor: [...] }`.
   - `force`: today's behaviour.
2. **Drain in the run loop.** At the stage boundary (`engine.ts:800`), where `pauseAfterStage` is already checked, a draining engine stops the task through the existing `stopped(task, 'shutdown')` path. That sets INTERRUPTED with the `interrupted` blocker. New tasks don't start while draining. When no stage is running, lifecycle shuts down. On the next start, `chairman.onStartup` already resumes supervised INTERRUPTED tasks (`chairman.ts:709-725`). Unsupervised tasks show **Resume** as today.
3. **`stop-control-center.ps1`** gains `-Drain` and `-Force`. With neither, it calls `refuse`, prints the running tasks and exits non-zero. The 15 s kill applies only with `-Force`. `operations.md` documents that restarting after a new build uses `-Drain`.

### Data model: migration 16 (`apps/orchestrator/src/db/migrations.ts`)

```sql
ALTER TABLE test_runs ADD COLUMN failures TEXT;          -- JSON string[] (redacted, ≤500)
ALTER TABLE test_runs ADD COLUMN classification TEXT;    -- 'new' | 'preexisting' | 'unknown' | NULL
ALTER TABLE test_runs ADD COLUMN tree_id TEXT;
ALTER TABLE test_runs ADD COLUMN reused_from TEXT;
CREATE TABLE baseline_checks (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  baseline_commit TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_sha TEXT NOT NULL,
  status TEXT NOT NULL,            -- passed | failed | error
  summary TEXT, failures TEXT, duration_ms INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (repository_id, baseline_commit, command_id, command_sha)
);
```

All the changes are additive. Existing rows keep NULL, which reads as today's behaviour. The shared `TestRun` type gains the four optional fields.

## 4. Implementation steps

Each step is one self-contained update with its own tests and docs. `pnpm check` must stay green after every step.

1. **Coverage, A.**
   - Add `packDiff` and its tests.
   - Wire it into `workspaceFacts` / `build` for single-repo, multi-repo and staged diffs, and add `{{diff_coverage}}` with stats in the changed-files list.
   - Update the reviewer, verifier, fixer and implementer prompts.
   - Add the coverage check and the single in-stage follow-up in `runAgent`, plus the `REVIEW_INCOMPLETE` error class.
   - Update `workflow-engine.md`.
2. **Stage semantics, D.**
   - Add `requires` to the schema and the engine, and to `full-autopilot.yaml` (version bump).
   - Add the `optional_failed` outcome.
   - Count recovery cycles only on start, keep fingerprints across a resume, and split the trigger label.
   - Update `workflow-engine.md` and `chairman.md`.
3. **Migration 16 and failure ids, the start of B.**
   - Apply migration 16 and extend the store and the types.
   - Move `failingTestIds` and add the Playwright pattern.
   - Collect ids while output streams.
   - Keep the Chairman's signature code on the moved helper, with the same limit of 5 for signatures.
4. **Baseline checks, B.**
   - Extract `addDetachedWorktree`.
   - Add the `BaselineChecks` service: cache, single flight, `finally` cleanup.
   - Add the classification step in `runCommands` and continue after pre-existing failures.
   - Update the gate and coverage consumers, the prompt section, the report limitation and the repository setting.
   - Show the classification on the dashboard's Tests tab (semantic tokens, shared components).
   - Update `workflow-engine.md` and `chairman.md`.
5. **Waiver, C.**
   - Add the rule type, the optional `rule` on the operator directive route, and `waivedKinds`.
   - Subtract waived kinds in `runCommands` and the completion gate.
   - Add the checkbox row to the dialogs, and show waivers in the report and the Tests tab.
   - Update `chairman.md`.
6. **Reuse, E.**
   - Add `tree_id` capture, the reuse rule and `reused_from`.
   - Reject no-op retries.
   - Add the prompt lines.
   - Update `workflow-engine.md`.
7. **Isolation, F.**
   - Default new repositories to worktree mode.
   - Make `createWorktree` return a reason, and block instead of falling back.
   - Add the repository callout and show the task's working folder.
   - Update `git.md`, `checkpoints.md` and `dashboard.md`.
8. **Restart guard, G.**
   - Add the shutdown modes, drain in the run loop and the script switches.
   - Update `operations.md`.
9. **Real replay** (§7). Fix anything it exposes and repeat until every success criterion holds.

## 5. Failure handling and recovery

- **Packing fails** (git error, parse error): fall back to today's single-string diff, with the coverage block saying `Diff coverage unknown — read every changed file listed above`. The coverage check then requires every changed file to be named. That fails closed.
- **Baseline run cannot run**: the worktree can't be created, the install fails, the command times out, or the baseline commit is missing. The failure is classified `unknown`, so it is treated as new, and today's fix route runs. The event says why the baseline run was unavailable. Nothing is marked pre-existing without evidence.
- **Baseline passed but the task failed**: the failure is `new`, as today.
- **Baseline cleanup fails**: `removeWorktree` already falls back to `rm` plus `prune`. Anything left under `<dataDir>/baselines` is swept at startup. Only paths under that folder are ever deleted, and the orchestrator never creates junctions there, so no recursive delete can follow one.
- **Coverage follow-up still incomplete**: `REVIEW_INCOMPLETE` goes to the Chairman as a stage failure: it retries or changes agent, and if that doesn't work it raises a hard blocker that names the unreviewed files. Code is never "fixed" over a review gap.
- **A `requires` stage key doesn't exist**: workflow validation (`packages/shared/test/workflow.test.ts`) rejects it when the workflow is saved.
- **Reuse lookup fails**: run the command as normal. Reuse is only an optimisation.
- **Worktree creation is blocked**: the task stops before any file is touched. After a fix, the operator presses **Resume**, which retries `ensureBaseline`.
- **Drain never finishes**, for example because a stage hangs: the operator can still call `force`. The stage then becomes INTERRUPTED, exactly as it does today.
- **Rollback**: every step is code plus an additive migration. Reverting the code leaves the new columns and table unused and harmless. Migration 16 is never edited once shipped.

## 6. Security and data protection

- **Waivers are operator-only.** The `waive_check` rule is accepted only on the authenticated operator route (`/api/tasks/:id/directives`, with the Host, Origin and token checks unchanged). The Chairman gateway, chat intent (`intent.ts`) and `ToolService.invoke` must not be able to create or change it. A test proves that an agent-originated directive carrying `rule` is refused.
- **Pre-existing failures never hide new ones.** Classification is by test id, and `unknown` counts as `new`. A repository can require strict mode with `preexistingFailures: 'block'`. The report always lists what was allowed through.
- **Baseline runs go through the same pipeline.** Same command classifier, tool policy and path confinement; the same credential broker scoping, where the baseline run gets exactly the task command's environment; the same timeout. The run is read-only for the operator's checkout, because it uses a detached worktree under `<dataDir>`. It never pushes and never changes branches.
- **Redaction.** Failure ids and summaries pass through `redact()` before storage. Omitted-file lists contain paths only, never content.
- **Isolation fails closed.** Instead of falling back, a task stops before touching the operator's folder.
- **Shutdown** keeps the existing authentication. `force` is an explicit choice, and nothing in the refuse mode reveals task content beyond ids and stage names.
- **No new dependencies.** No guard listed in AGENTS.md is weakened. Each changed guard path gets a test proving the new behaviour.

## 7. Testing and verification

**Unit** (`apps/orchestrator/test/`, `packages/git/test/`, `packages/shared/test/`)

- `diff-pack.test.ts`:
  - ordering by class;
  - the budget, and a giant first file shown as partial;
  - untracked files;
  - binaries and lockfiles pushed last;
  - an `omitted` list that is always complete;
  - the trailer never clipped.
- **Context:** `ContextBuilder.build` for a fixture larger than 150 KB renders `{{diff_coverage}}` with every missing file, in the single-repo, multi-repo and staged-diff cases. This fills today's gap in `ContextBuilder` test coverage.
- **Runner:**
  - a PASS that doesn't name an omitted file triggers exactly one follow-up;
  - a second miss gives `REVIEW_INCOMPLETE`;
  - a FAIL is never downgraded.
- `test-summary.test.ts`: Playwright, Vitest, Jest and pytest failure-id fixtures, including the real TASK-0007 e2e summary block. The bounded collector stops at 500.
- **Baseline classification:** the table cases (all pre-existing, one new, baseline passed, ids unparseable, baseline unavailable). Also the cache hit, single flight, and worktree removal on success, failure and timeout.
- **runCommands:**
  - after a pre-existing failure the stage continues with the next commands;
  - a new failure stops as today;
  - waived kinds are skipped;
  - a waived kind that is also required is reported.
- **Gate:** a `preexisting` run is not a pass, a waived kind is not required, and the limitations text is right.
- **Workflow:**
  - `requires` validation;
  - Smoke is SKIPPED after a skipped Staging;
  - `optional_failed` moves on without calling the supervisor.
- **Chairman:**
  - recovery cycles are counted only on start;
  - fingerprints are kept across a resume with no new directive and cleared when there is one;
  - a no-op command retry is rejected.
  - Replay the real TASK-0007 event sequence and assert at most 1 recovery cycle.
- **Reuse:** a same-tree pass is reused, a changed file forces a re-run, a failure is never reused, and a different task never reuses.
- **Isolation:** new repositories default to worktree mode. A forced `createWorktree` failure blocks the task and leaves the operator folder untouched (branch and status compared before and after).
- **Shutdown:**
  - refuse gives 409 with ids;
  - drain stops at the boundary, then shuts down;
  - force behaves as today;
  - startup resumes the drained supervised tasks.
- **Security:** an agent- or gateway-originated `waive_check` is refused. Failure ids are redacted.

**End-to-end and visual**

- `pnpm build && pnpm e2e`, in both themes:
  - the Tests tab shows pre-existing, waived and reused states;
  - the Answer dialog has the **Don't gate this task on** row;
  - the repository callout;
  - the task header's working folder.
- The dashboard is checked in the operator's browser (Playwright MCP), at desktop and phone width.

**Real replay** (the proof; it uses real agents, about 1–2 hours)

1. Bring the orchestrator up on the new build with `stop-control-center.ps1 -Drain`, then start it again.
2. Switch `tenten-accounting-in` to isolated worktrees using the new callout.
3. Create a task from the TASK-0007 attachment on a branch at `d8ca9188`, so the same pre-existing failures are present. Use the Full Autopilot workflow in Autopilot mode.
4. Watch it end to end and record every check against §8.

**Commands**

`pnpm check` · `pnpm build && pnpm e2e` · `pnpm verify:agents` · the replay.

## 8. Success criteria

The work is finished only when all of these hold. The code-only items are checked by the tests in §7; the rest are checked in the replay.

- In the replay, the operator's `tenten-accounting-in` checkout never changes branch or status. The task runs in a worktree, and the worktree is removed when the task finishes.
- The first Test run classifies the Partners unit test and the 10 e2e failures as **pre-existing on `d8ca918`**. No fix cycle and no recovery cycle is spent on them, and they appear as a limitation in the final report.
- Review and Verify either see every changed file in the diff or name every file on the Not shown list under `## Files reviewed`. A PASS that leaves a file out never counts.
- Smoke is SKIPPED ("Staging deploy did not run"). No recovery cycle is spent on it.
- No command runs twice on an identical tree within the task. A docs-only change doesn't re-run the unit suite.
- The task finishes as COMPLETED, with at most **one** operator decision and **zero** repository-setting toggles. It needs fewer recovery cycles than TASK-0007's 3 and costs less than TASK-0007's $27.10.
- `stop-control-center.ps1` with no switch refuses while the replay is running. `-Drain` stops the task at a stage boundary, and the task resumes by itself after the start.
- The waiver checkboxes, when used on a test task, stop the waived kind for that task only. A second task on the same repository still runs it.
- `pnpm check` and the e2e matrix are green in both themes. Every system doc touched has updated content and a new `Last verified:` date.
- Migration 16 applies to a copy of the live database (v15) without errors, and existing tasks still load.

## 9. Found for later

- **Release stage.** A per-repository release setting (`merge-to-main` fast-forward, `command` or `none`) and an approved Release stage after Git checkpoint. It confirms the same commit that passed Test, pushes, waits for the deployment and confirms that the live bundle changed. Note that `wrangler pages deployment list` shows a building deployment as "Active", so success must be confirmed against the live bundle. **Priority: high** (§10).
- **App check that can actually run.** `detectTooling` recognises only `scripts.dev` (`repositories.ts:92-97`), and repositories added before detection existed have `runtime: {}`. Prefer Playwright `webServer.command` and `url`, then `dev:full`. Sign in through the repository's own passwordless contract (`.agent/browser-auth.json`) and confirm `expectedWorkspace`. Also add a per-repository fixture hook so UI numbers can be checked on seeded data. In TASK-0007 the automation workspace had no banks, and its user couldn't create one. **Priority: high.**
- **Task title.** A title is currently taken from the first sentence of the description (`engine.ts:165`, `:1422-1429`), which gave "Read the attachment" as the title, branch name and commit message. Use the attachment's first heading instead, or the investigator's summary before the branch is created. **Priority: medium.**
- **Targeted baseline re-runs.** Re-run only the failing test files on the baseline when the runner is known (Vitest, Playwright), to cut the one-off baseline cost from about 14 minutes to seconds. **Priority: medium.**
- **Structured decision options on blockers.** Blockers are text only (`types.ts:39-47`). Structured options with a default would let the operator answer with one click. **Priority: medium.**
- **Push notifications for blockers and completion,** so the operator doesn't have to poll. **Priority: medium.**
- **No total prompt budget.** Only individual sections are capped (`context.ts`), and attachments are 50 KB each with no count limit. **Priority: low.**
- **Worktrees of FAILED or INTERRUPTED tasks are never cleaned up automatically.** Add an age-based sweep with backup refs. **Priority: low.**
- **The accounting repository's out-of-date e2e suite** is that repository's own work. It is already listed in its `docs/follow-ups.md`.

## 10. Next recommended task

**RELEASE_STAGE_PLAN**: a per-repository release setting and an approved **Release** stage that turns "committed on a branch" into "confirmed live". It checks that the commit is the one that passed Test, fast-forwards and pushes (or runs the configured release command), waits for the deployment and confirms the live site serves the new build, then reports **Live** only after that confirmation. It's approval-gated by default and tested against a local bare remote. TASK-0007 showed this is the step the operator had to do by hand.

## 11. Final execution prompt

Implement `docs/plans/AUTOPILOT_GATES_PLAN.md` in `AI-Development-Control-Center`.

- Read `AGENTS.md`, `PLAN.md`, `design.md` and the system docs named in the header before changing anything.
- Follow §4 in order. Each step is a separate, tested update that keeps `pnpm check` green.
- Keep every guard AGENTS.md protects. Where a guard path changes, add a test that proves the new behaviour.
- The only schema change is additive migration 16. Never edit a shipped migration.
- Update the owning `docs/systems/*.md` in the same step as the behaviour it describes.
- Finish with the real replay in §7 and verify every item in §8. The replay must never touch the operator's `tenten-accounting-in` working folder.
- Report which criteria were checked, which could not be checked, and why.

/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.
