---
title: A Test stage runs only the unit tests the change can affect, on repositories that opt in, and runs the whole suite whenever that cannot be proven safe
source: conversation 2026-09-26 (investigation of the tests stage after LEAD_TIME_PLAN)
created: 2026-09-26
status: in progress
---

# AFFECTED_TESTS_PLAN — run only the tests a change can affect

## Context

Status: proposed · Written 2026-09-26 against `d1e4d2e` · Owners: [workflow-engine.md](../systems/workflow-engine.md), [dashboard.md](../systems/dashboard.md), [remote-node.md](../systems/remote-node.md)

### What happens today (read from the code, not assumed)

- A `tests` stage (`StageRunners.runCommands`, `apps/orchestrator/src/engine/runners.ts:466`) runs every enabled repository command of its kinds, one after another. The default kinds are `lint, typecheck, test, build` (`packages/shared/src/constants.ts:200`); Full Autopilot adds `e2e` (`workflows/full-autopilot.yaml`). It stops at the first failure that is new in this task.
- The `test` command is always the repository's whole suite. There is no notion of scope anywhere: not on the command (`repositoryCommandSchema`, `packages/shared/src/schemas.ts:113`), the stage (`stageDefinitionSchema`, `:66`) or the repository.
- Narrowing already exists, but only after a failure. `targetedCommand` (`apps/orchestrator/src/engine/targeted-tests.ts`) appends failing test files to an npm script whose body is one `vitest`/`jest`/`playwright test` run, or to such a runner called directly. It is used by the baseline comparison (`baseline-checks.ts`) and by the flaky re-run (`rerunFailingFiles`, `runners.ts:726`).
- A pass is reused only when the same command already passed in this task on exactly the same files (`findReusableRun`, `store.ts:1221`). After an Implement or Fix stage the files differ, so the whole suite runs again.
- The task's changed files are already computed from its Git baseline snapshot by `changesSince` (`packages/git/src/index.ts:288`). That list includes untracked files, the `origin` of each file and its status (added, modified, deleted, renamed). The Git checkpoint (`runners.ts:1094`), the review diff (`context.ts:220`) and the Chairman gate use it.
- The implementer and fixer prompts already tell agents to run only the tests for the files they changed (`prompts/implementer.md:70`, `prompts/fixer.md:61`). Only the orchestrator's own Test stage runs everything.

### Evidence

| Task | What changed | Time in the Test stage |
| --- | --- | --- |
| TASK-0011, the LEAD_TIME_PLAN replay (55.2 min in total) | a normal feature change | **21.2 min**: lint 81 s, **unit 1,075 s (17.9 min, 9,070 tests)**, build 32 s, e2e 80 s |
| TASK-0009 | documentation only | **19 min** per run, 9,269 tests |
| TASK-0008 | 12 of 19 files source | unit suite 17.6 min, and again 17.6 min on the baseline |

Root cause: the `test` command has one size, the whole suite, whatever the change. After LEAD_TIME_PLAN, the unit suite is **about a third of a task's total time**. It is also the largest single part of the Test stage, and each fix cycle pays it again. Lint, typecheck and build together take under 2 minutes. e2e is 80 s, and it tests the running app rather than imports, so an import graph says nothing about which e2e tests a change affects.

### Ideas considered and rejected

| Idea | Decision | Why |
| --- | --- | --- |
| Run affected tests during fix cycles, then the whole suite once at the end | **Rejected** | TASK-0011 had no fix cycle. Its one Test stage is the "end" run, so this saves nothing on the common path. |
| Run the whole suite in the background while Review and Verify run | **Rejected** | LEAD_TIME_PLAN already rejected background runs: they race the task's own e2e run and dev server for ports, and a failed review makes the run stale. |
| The orchestrator passes the changed file list to `vitest related <files>` | **Rejected** | `related` is a subcommand. It cannot be appended to an npm script whose body is `vitest run`, and file paths chosen by an agent would end up on a command line. |
| Append the runner's own `--changed <baseline sha>` to the unchanged command | **Chosen** | It is one validated 40-character hex argument plus a fixed flag, with no paths on the command line. Vitest builds the import graph itself, uses its own `forceRerunTriggers` (package.json, vite/vitest config), and includes staged, unstaged and untracked files: `findChangedFiles` in Vitest 5.0.2 reads `diff <sha>...HEAD`, `diff --cached` and `ls-files --others`. |
| Skip `test` when only documentation changed | **Deferred** (§9) | Tests can read documentation: TASK-0008 had `passes scripts/docs-guard.mjs`, which reads `CLAUDE.md`. |

## 1. Goal

On a repository that opts in, a tests stage's Vitest `test` command runs only the tests whose import graph reaches a file the task changed. When the orchestrator cannot show that this is safe, it runs the whole suite. Lint, typecheck, build and e2e are unchanged.

Measured by a replay of TASK-0011's change on `tenten-accounting-in-replay` with the setting on:

- the unit command takes **≤ 5 min**, down from 17.9;
- the Test stage takes **≤ 8 min**, down from 21.2;
- the task goes from created to COMPLETED in **≤ 42 min**, down from 55.2, excluding time spent waiting for the operator.

Every repository that does not opt in behaves exactly as it does today.

## 2. Scope

### In

- A repository setting `testSelection: 'full' | 'changed'`. It defaults to `full` for existing and new repositories: API, store, migration, and a switch in the dashboard's Commands panel.
- A fail-closed eligibility check over the task's changed files (`changesSince`).
- Narrowing a Vitest `test` command with `--changed <baselineCommit> --passWithNoTests`, reusing the npm-script and direct-runner parsing in `targeted-tests.ts`.
- If a narrowed run fails in a way nobody can read, the whole suite runs once more in the same stage.
- Recording on each test run whether it ran affected tests or the whole suite, and why: tests log, summary, final report, and the Release approval text.
- A remote guard: only this machine can turn the setting on.
- Unit tests, a real Vitest integration test, an e2e check of the switch in both themes, and system docs.

### Out

- Jest, pytest, Playwright/e2e, and pnpm or yarn scripts. These always run in full (see §9).
- lint, typecheck and build. They are whole-program checks and take under 2 minutes together.
- Changing the completion gate, the Chairman gate, baseline classification, flaky detection or reuse rules. They keep working unchanged on whichever command ran.
- Agent prompts and the workflow YAML files.

## 3. Enhanced design and architecture

### 3.1 Data

- **Migration 18** (additive; never edit 1–17):

  ```sql
  ALTER TABLE repositories ADD COLUMN test_selection TEXT NOT NULL DEFAULT 'full';
  ALTER TABLE test_runs ADD COLUMN selection TEXT;
  ```

- `RepositoryRecord.testSelection: 'full' | 'changed'`. The store maps any value other than `'changed'` to `'full'`, just as `preexisting_failures` is read (`store.ts:386`).
- `TestRun.selection: 'changed' | 'full' | null`. `null` means an older row or a command that could not be narrowed, which means the whole suite ran.
- `updateRepositorySchema.testSelection: z.enum(['full','changed']).optional()`. `createRepository` writes `'full'`.

### 3.2 Selection: a new pure module, `apps/orchestrator/src/engine/test-selection.ts`

```ts
export type Selection =
  | { mode: 'changed'; commandLine: string; baselineCommit: string; files: number }
  | { mode: 'full'; reason: string };

export function selectTests(input: {
  repo: RepositoryRecord; command: RepositoryCommand; stageKind: StageKind;
  baselineCommit: string | null; changed: ChangedFile[] | null; scripts: Record<string, string> | null;
}): Selection;
```

It returns `full` with a plain-language reason at the first rule that fails, checked in this order:

1. The repository's `testSelection` is `'full'`, the stage is not a `tests` stage, or the command's kind is not `test`. (No reason is shown for these: this is today's behaviour.)
2. There is no baseline commit, or it is not `/^[0-9a-f]{40}$/` or `/^[0-9a-f]{64}$/`. Reason: "No Git baseline".
3. The changed-file list could not be read (`changed === null`), or it is empty. Reason: "Could not read the task's changes" / "Nothing changed".
4. A file was deleted or renamed. A test that imports a removed file is no longer in any import graph. Reason: "A file was deleted or renamed (`path`)".
5. A file is not JavaScript/TypeScript source: its extension is not `.js .jsx .ts .tsx .mjs .cjs .mts .cts`. This catches JSON fixtures, snapshots, `.env`, `tsconfig.json`, lockfiles, documentation and SQL, which tests read without importing. Reason: "`path` is not source code; tests may read it".
6. A file is test infrastructure: a basename matching `/(^|[.\-_])(setup|global-setup|globalsetup|teardown|config)([.\-_]|$)/i`, or any path segment `__mocks__`, `__fixtures__`, `fixtures`, `test-utils` or `testing`. Reason: "`path` configures or supports every test".
7. `narrowCommand(command.command, scripts)` returns null, because the command is not an npm script whose body is one Vitest run, nor Vitest called directly; or the body already has `--changed`, `related`, `--watch` or `-w`. Reason: "Only Vitest commands can run affected tests".

Otherwise it returns `changed`: the same command line, extended the same way `targetedCommand` extends it:

- npm script: `npm test -- --changed <sha> --passWithNoTests`
- direct call: `npx vitest run --changed <sha> --passWithNoTests`

The rules read every changed file whatever its origin, pre-existing user work included, because the runner's own Git read includes those files too.

`targeted-tests.ts` gets one small refactor. The npm-script and runner detection it already has (`NPM_SCRIPT`, `isRunner`) moves into an exported `runnerInvocation(commandLine, scripts): { runner: 'vitest'|'jest'|'playwright'; append(args: string[]): string } | null`. Both `targetedCommand` and `narrowCommand` use it, so there is one parser, and `targetedCommand`'s behaviour and tests stay unchanged.

### 3.3 Wiring it into `runCommands` (`runners.ts`)

For each job, before its `test_runs` row is inserted:

- Compute the changed files once per unit (repository) and stage: `changesSince(unit.workdir, <the unit's baseline snapshot, as the Git checkpoint gets it at runners.ts:1094>)`. On an error, use `null`. Read `package.json` scripts as `rerunFailingFiles` does.
- Call `selectTests`. With `changed`, run an **effective command**: `{ ...command, command: selection.commandLine }`. Its `test_runs.command` stores the narrowed line and `selection` is `'changed'`. With `full`, the command is unchanged and `selection` is `'full'` when a reason was given, `null` otherwise.
- The effective command is used for `executeCommand` and the repair loop. The **original** command still goes to `baselines.classify` and `rerunFailingFiles`. On the baseline commit, `--changed <baseline>` would select nothing. Failure ids from a narrowed run name real test files, so the file-narrowed baseline check and the flaky re-run work exactly as today.
- Reuse needs no change. `findReusableRun` matches on the command string, and the narrowed string contains the baseline sha. So a run of affected tests is never reused as a whole-suite pass, or the other way round.
- The summary starts with the scope. A narrowed run that ran no tests (`--passWithNoTests`, no totals line) passes with the summary "No test imports the N changed files".
  - "Affected by the change (N files): Tests 41 passed (41)"
  - "Whole suite — `path` is not source code; tests may read it: Tests 9070 passed (9070)"

### 3.4 Fallback to the whole suite

A narrowed run that **failed**, was **not** cancelled or timed out, and produced **no failure ids and no totals line** did not run tests at all. Examples: an old Vitest without `--changed`, no Git available, or a config error. In that case the original command runs once in the same stage as a second row, "<name> · whole suite", with `selection` `'full'`. That run decides, exactly as today, baseline comparison included. A narrowed run whose failure has ids is a real test failure and goes through the normal path.

### 3.5 Where it is shown

- **`tests.log` and the Tests tab:** the summary lines above. The tab already shows `summary`, so no UI change is needed.
- **Final report, "Verification coverage":** one line per unit whose last test stage ran affected tests only: "Unit tests (`npm test`): only tests affected by the change ran (Vitest `--changed <sha7>`); the whole suite did not run." This is information, not a limitation. The operator chose it for the repository, and it does not change `READY`.
- **Release approval** (`release/service.ts`): when a tested tree's `test` run has `selection === 'changed'`, the approval reason adds "Unit tests on this commit covered only the tests affected by the change." The operator's typed Level 5 decision is then an informed one.
- **Dashboard:** Repositories → a repository → Commands panel. A `Switch` from `packages/ui`, using semantic tokens only, labelled **Run only affected unit tests**, with the help text "Vitest `test` commands in npm scripts. The whole suite still runs when configuration, data, test setup, or deleted or renamed files change. Lint, typecheck, build and end-to-end always run in full." It is saved with the rest of the draft through the existing `PATCH /api/repositories/:id`.

### 3.6 Remote guard (`apps/orchestrator/src/remote/guards.ts`, `repository.update`)

Changing `testSelection` from `full` to `changed` is denied from the cloud: "Running only affected tests can only be turned on on this machine." Turning it off is allowed. This matches how the guard treats the auto-approve level and the execution policy.

## 4. Implementation steps

Each step keeps `pnpm check` green, updates its system doc in the same commit, and stages only its own paths (other sessions may share the tree).

1. **Parser refactor** (`targeted-tests.ts` and its test): extract `runnerInvocation` and add `narrowCommand`. Every existing `targeted-tests.test.ts` case passes unchanged. New cases:
   - `npm test`, `npm run test:unit` and direct `npx vitest run` get the args appended;
   - jest, playwright, pytest, pnpm, compound, `--watch`, `related` and existing `--changed` give null;
   - a sha that is not hex gives null.
2. **`test-selection.ts`** and `test/test-selection.test.ts`: every rule in §3.2, with the reason text asserted.
3. **Data:**
   - migration 18;
   - store mapping for `testSelection` and `selection`;
   - schema and types;
   - `createRepository` default;
   - migration test for an existing database, where every repository reads `full` and old test runs read `null`.
4. **Runner wiring and fallback** (`runners.ts`, §3.3–3.4), with integration tests in `test/autopilot-gates.test.ts` or a new `test/affected-tests.test.ts`, using the simulated command scripts those tests already use:
   - a `full` repository runs byte-identical commands and rows;
   - a `changed` repository runs the narrowed line and records `selection`;
   - a narrowed failure with ids goes to `baselines.classify` and `rerunFailingFiles` with the **original** command;
   - a narrowed failure with no ids runs "· whole suite" once;
   - lint, typecheck, build and e2e rows are unchanged;
   - there is no reuse across modes;
   - in a multi-repository task each unit decides on its own.
5. **Real Vitest proof:** `test/affected-tests.real.test.ts` uses the workspace's own `vitest` binary and adds no dependency. It builds a temporary Git repository with `a.ts`, `b.ts`, `a.test.ts`, `b.test.ts` and a `package.json` whose `test` script is `vitest run`, commits it as the baseline, then asserts on real output:
   - changing `a.ts` runs `a.test.ts` only;
   - a new **untracked** `c.test.ts` that imports `a.ts` runs;
   - changing `package.json` runs both;
   - a change no test imports passes with no tests.
6. **Report, Release text and remote guard** (`report.ts`, `release/service.ts`, `remote/guards.ts`) and their tests: `report` coverage line, the release approval reason, and the guard denying cloud enable while allowing cloud disable.
7. **Dashboard switch** (`RepositoryDetailPage.tsx`) following `design.md`, plus an e2e check that turns it on, saves, reloads and still sees it, in both themes and at phone width, with axe clean.
8. **Docs:**
   - `workflow-engine.md`: the tests stage, selection rules, fallback and report line;
   - `dashboard.md`: the switch;
   - `remote-node.md`: the guard;
   - a new `Last verified` date on each.
9. **Real replay** (§7): turn the setting on for `tenten-accounting-in-replay` and replay TASK-0011's request with Full Autopilot on this build. Fix anything it exposes and repeat until §8 holds.

### Irreversible steps

None. The migration only adds columns with safe defaults, and the setting is off unless someone turns it on.

## 5. Failure handling and recovery

- **The changed files can't be read** (a Git error, no baseline, a repository that isn't Git): the whole suite runs, with the reason in the summary.
- **The narrowed run can't start or can't read its arguments** (an old Vitest, Git missing, a config error): one "· whole suite" run decides (§3.4). A timeout or cancel of the narrowed run is handled as today; it does not fall back.
- **The narrowed run fails with test ids:** the normal path: baseline comparison with the original command, then flaky re-run, then fix cycle.
- **Stop, pause or restart mid-stage:** unchanged. A stop between commands is a stop, and the stage runs again from the start on resume, computing the selection again.
- **A wrong "affected" answer** (a dependency Vitest's graph cannot see): the operator turns the setting off for that repository, and the next Test stage runs the whole suite. The report and tests log always say which scope ran, so a doubtful result can be traced. Per-repository extra full-run patterns are listed in §9.
- **Rollback:** set `testSelection` to `full`. The columns stay; nothing reads them when the setting is off.

## 6. Security and data protection

- The only text added to a command line is a 40- or 64-character lowercase hex sha, checked by regex, plus two fixed flags. Paths from agents or the working tree never reach the shell, which is stricter than `targetedCommand`.
- The command still goes through `gateCommand` and the classifier (`expandPackageScripts`) before it runs. The tool policy, the approvals and the subscription-only environment (`sanitizeEnv`) are unchanged.
- The gate is loosened only where a repository opts in, and every loosening is covered by a test (AGENTS.md). Enabling is refused from the cloud (§3.6).
- `test_runs.command` and summaries still go through `redact`. No secrets, file contents or credentials are added anywhere.
- No new dependency, route or process-spawning path.

## 7. Testing and verification

### Unit and integration (§4 steps 1–6)

- `pnpm --filter @acc/orchestrator exec vitest run test/targeted-tests.test.ts test/test-selection.test.ts test/affected-tests.test.ts test/affected-tests.real.test.ts test/baseline-checks.test.ts test/autopilot-gates.test.ts test/release.test.ts`
- The migration test and the remote-guard test.
- `pnpm check` green.

### End to end

`pnpm build && pnpm e2e`: the whole matrix, both themes, including the new switch check.

### Real

- **The replay** (§4 step 9). Record:
  - the unit row's summary, `selection` and duration;
  - the Test stage duration;
  - `GET /api/tasks/:id/time`;
  - the Verification coverage line.
- **A control:** one task on the same repository with the setting **off** runs the whole suite as before.
- **A fallback check:** one task whose change edits a JSON fixture runs the whole suite, with the reason shown.

## 8. Success criteria

- With the setting off, every existing test passes unchanged. A task's commands, `test_runs` rows and report are the same as before, apart from the new `selection` column being `null`.
- With the setting on, in the TASK-0011 replay:
  - the unit command ran affected tests only;
  - it took ≤ 5 min;
  - the Test stage took ≤ 8 min;
  - created to COMPLETED took ≤ 42 min, excluding operator wait;
  - the report says only affected tests ran.
- Every fallback rule in §3.2 and §3.4 is proven by a test. The real Vitest test proves the import-graph selection, the untracked-file case and the `package.json` trigger.
- Enabling from the cloud is refused, and disabling from the cloud works.
- `pnpm check` and the e2e matrix pass in both themes. `workflow-engine.md`, `dashboard.md` and `remote-node.md` are updated with a new `Last verified` date.

## 9. Found for Later

- **Jest.** `--changedSince=<sha> --passWithNoTests` through the same `runnerInvocation`, once a real test can prove its untracked-file behaviour without adding Jest as a dependency here. **Priority: medium.**
- **pnpm and yarn scripts.** They pass arguments on differently (the reason `targetedCommand` supports npm only). **Priority: medium,** because this repository itself uses pnpm.
- **Per-repository full-run patterns** (for example `src/i18n/**`) added to the built-in rule 6, and an `ignorePaths` list so a documentation-only change can skip `test`. **Priority: low.**
- **A per-task "run the whole suite" directive,** next to the existing waive and require directives. **Priority: low.**
- **Require the whole suite before Release,** as an option on the release setting, instead of the informational line. **Priority: medium,** if the replay or live use shows an escape.
- **Playwright `--only-changed`** for e2e, which needs Playwright 1.46 or later and says little for browser tests. **Priority: low.**
- **Run lint and typecheck in parallel** (about 1 min per Test stage). **Priority: low.**
- **Give implementer and fixer prompts the exact affected-tests command,** so the agents' own runs match the Test stage. **Priority: low.**

## 10. Next Recommended Task

**A whole-suite safety net off the critical path.** Once tasks run only affected tests, run the whole suite of each opted-in repository once per merge to `main` (or nightly), outside any task. When it finds a new failure, open a normal task naming the commit that introduced it. This keeps the speed and restores the full-suite guarantee, without making any task wait for it.

## 11. Final execution prompt

Implement `docs/plans/AFFECTED_TESTS_PLAN.md` in `AI-Development-Control-Center`.

- Read `AGENTS.md`, `PLAN.md`, `design.md` (for step 7), `docs/systems/workflow-engine.md` and LEAD_TIME_PLAN §3.1 first.
- Confirm every "What happens today" statement against the current code before changing it, and record any difference in a Ledger at the end of this file.
- Follow §4 in order, staging only each step's own paths, and keep `pnpm check` green after every step.
- Never weaken a guard listed in `AGENTS.md` without a test, and never add a dependency. Existing repositories must stay on `full`.
- Finish with the real checks in §7 and verify every item in §8. Report what was checked, what couldn't be checked, and why.

/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.

## Ledger

- 2026-09-26 — steps 1–8 implemented in one change on `claude/workflow-tests-optimization-uu6skg` (restarted from `main` at 977d16c after PR #2 merged). Every "What happens today" statement was re-checked against the code first; all held.
- step 1 — `runnerInvocation` now returns the runner's `body` as well, so `narrowCommand` can refuse a Vitest run that already watches or selects its own files (`--watch`/`-w`, `--changed`, `--related`, `vitest watch|dev|related|bench|list|init|typecheck`). `targetedCommand`'s tests are unchanged and pass.
- step 2 — deviation: the changes are read with a new `pathStatusSince(cwd, commit)` in packages/git (`git diff --name-status --no-renames <commit>` plus untracked files), not `changesSince`. `changesSince` takes each file's status from `git status` (the working tree against HEAD), so after a Git checkpoint commit a committed deletion read as "modified" and rule 4 would have missed it. Renames arrive as a deletion plus an addition, so rule 4 still sees them.
- step 4 — deviation: a narrowed run that falls back to the whole suite ends `not_run` with a summary starting `Superseded: ` (`supersededRun()` in packages/shared), not `failed`. The report and the release's `testedTrees` leave it out; otherwise a task whose whole-suite fallback passed would have read as failing. A `[sim:source-only]` marker was added to the simulated agent (it changes `sim-output.ts` instead of `sim-output.md`) so the engine-level tests can reach the narrowed path; the default simulation exercises rule 5.
- step 4 — not written: a multi-repository integration case. The selection is computed per job from that job's own repository, working folder and baseline commit (`withSelections` keys its reads by working folder); single-repository engine tests plus the unit rules cover it.
- step 6 — the release approval text comes from `affectedOnly()`: the last passing Test stage's `test` rows for that repository, all `selection = 'changed'`.
- step 9 — not done here: this session runs in a cloud container with no live orchestrator and no `tenten-accounting-in-replay` checkout, so the TASK-0011 replay (§7 Real, §8 timing criteria) and the on/off/fixture comparison tasks are still to be run on the operator's machine: turn the switch on for that repository, replay the task on this build, and record the unit row's summary, `selection` and duration, the Test stage duration and `GET /api/tasks/:id/time`.
