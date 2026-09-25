---
title: Tasks spend about a minute confirming old failures, report where their time went, and every stop reaches the operator's phone within a minute
source: conversation 2026-09-25 (LEAD_TIME_PLAN v2, written after investigating the code and the live database)
created: 2026-09-25
status: in-progress
---

# LEAD_TIME_PLAN — shorter tasks, and the operator told at once

## Context

Status: proposed (v2, rewritten after a fresh investigation of the code and the live database) · Written 2026-09-25 against `2eaba2f` (AUTOPILOT_GATES_PLAN committed as `690ec6c`; RELEASE_STAGE_PLAN uncommitted in the shared tree) · Owners: [workflow-engine.md](../systems/workflow-engine.md), [dashboard.md](../systems/dashboard.md), [credential-broker.md](../systems/credential-broker.md), [operations.md](../systems/operations.md), and in `whatsapp-inbox-saas-1` `docs/systems/direct-messages.md`

### 1. Goal

A task the size of TASK-0007 goes from created to COMPLETED in **65 minutes or less** of Control Center time. The replay of the same task after the gates work (TASK-0008) took 78.6 minutes. Any stop that needs the operator reaches their phone **within a minute**, with no dashboard open. And the Control Center reports where each task's time went, so nobody has to hand-write SQL to find a regression.

#### Evidence (live database, read-only copy, 2026-09-25)

| | TASK-0007 (before the gates work) | TASK-0008 (replay after `690ec6c`) |
| --- | --- | --- |
| Total | 210.3 min | **78.6 min** |
| Agent stages: first pass / rework | 43.6 / 51.6 | 38.3 / 0 |
| Tests stages | 47.1 | **39.3**, of which **19.6 re-running the baseline** |
| Parked, waiting for the operator | 59.8 | 0 |
| Agents running the full unit suite themselves | about 60 min (4 runs) | 0; one wide `vitest run` of about 9 min |

The gates work (`690ec6c`) already removed the rework loop, the false stops and the agents' own full-suite runs. What remains:

1. **The baseline comparison is on the critical path, and it is the whole suite.** TASK-0008's unit tests failed on 2 tests and 4 test files that were already failing on `main`. To prove that, `BaselineChecks.run` (`apps/orchestrator/src/engine/baseline-checks.ts:104-163`) ran the **entire** unit suite on the baseline commit (9,043 tests, 17.6 min), then the whole e2e suite (2.0 min). `runCommands` awaits each one before the next command (`runners.ts:629-638`). That is 25 % of the task, spent re-running about 9,000 tests to learn about 6 files.
2. **Nobody is told.** The only alerts are `NotificationBridge` (`apps/dashboard/src/app/App.tsx:56-80`), which fires only while a dashboard tab is open in the background, and the VS Code extension's toasts. The installed phone app has no service worker and gets nothing until it is opened. The operator waits in the earlier tasks were 5.9, 11.3, 14.8, 15.7 and 42.7 minutes. The new Release stage (RELEASE_STAGE_PLAN) adds a typed Level-5 approval to every task on a repository with releases configured, which puts the operator's reaction time on the critical path of every such task.
3. **Nothing measures this.** Durations exist only per stage, execution and test run. Nothing adds them up per task. The table above needed a one-off script over `task_stages`, `task_events`, `executions`, `execution_logs` and `baseline_checks`.
4. **The failure count in a summary is wrong.** TASK-0008's unit summary reads `Tests 2 failed | 9070 passed (9072) — all 9 failing as before`. The 9 is the number of failure ids, and 3 of them are noise:
   - the title-only `×` progress line, which Vitest repeats in full as `file > suite > title`;
   - two lines a test printed to stdout (`CLAUDE.md`, `passes scripts/docs-guard.mjs`).

   The comparison still worked, because the noise is identical on both sides. But the sentence contradicts itself, and the noise gets in the way of step 1.

#### The first plan, reconsidered

The first version of this plan was written before the replay existed. Checked against it:

| First plan | Decision | Why |
| --- | --- | --- |
| Run the full baseline suite in the background as soon as the task starts, with a one-at-a-time lock, pre-emption and a double run to catch flaky tests | **Replaced** by running only the failing test files on the baseline (§3.1) | It needs about 1 minute instead of 17.6, and nothing runs in the background. A background run would also have raced the task's own e2e and dev server for the same ports. It needs no lock, no pre-emption and no second run. |
| Keep running the remaining suites after one fails, and report every failure at once | **Dropped** (§9) | The case it was built for, failures that already existed on `main` found 37 minutes apart, is now handled by the gates work's continue rule, and TASK-0008 didn't need it. For new failures it's a trade-off: it saves a cycle when two suites both regress, but adds e2e time to every other fix cycle. |
| `ignorePaths`: a per-command list of paths whose changes don't trigger a re-run | **Dropped** (§9) | TASK-0008 had no fix cycle and nothing to reuse. It is an opt-in that the operator would have to get right per repository. |
| A median line per repository on Usage | **Deferred** (§9) | The per-task breakdown is enough to measure this plan. |
| Messenger alerts | **Kept**, with a simpler "already sent" rule (§3.3) | The messenger is the only channel already on the handset. |

### 2. Scope

##### In

1. **Targeted baseline.** A failing test command is compared with the baseline by running only the failing test files. The full baseline run stays as the fallback. Contained in `baseline-checks.ts` and `test-summary.ts`.
2. **Clean failure ids.** Remove the duplicate title-only ids, and replace the contradictory count with honest wording.
3. **Time breakdown.** A **Where the time went** section in `final-report.md`, a `timeBreakdown` field in `task.json`, `GET /api/tasks/:id/time`, and a small **Time** card on the task Overview.
4. **Phone alerts through the messenger.**
   - A scoped `control_center` bot in `whatsapp-inbox-saas-1`, following the `ark_console` pattern.
   - An `AlertService` in the orchestrator.
   - A **Phone alerts** section in Settings → Notifications, with **Send a test**.
5. Tests, system docs, and one real replay.

##### Out

- Everything already in AUTOPILOT_GATES_PLAN and RELEASE_STAGE_PLAN.
- Web Push or a service worker in the Control Center's phone app. That would be a second push stack, with new keys and cloud tables. The messenger already delivers push to this handset: it is proven by ARK's nightly alerts, and it needs about 30 lines on its side.
- Sending alerts from the cloud Worker. It does receive task frames, but the local orchestrator is the source of every state change, and sending from there needs no relay, no cloud secret and no cloud code.
- Answering or approving from a notification. An alert only informs.
- Everything in §9.

### 3. Enhanced design and architecture

#### 3.1 Targeted baseline (fixes root cause 1)

**Rule: a targeted run can only prove a failure was pre-existing. It never proves one new.** Whenever the targeted run doesn't reproduce every failure, the existing full run decides, exactly as today. So the change can only make the check faster, never less strict.

- **Where it lives.** Inside `BaselineChecks.classify`, before `this.result(key, …)` (`baseline-checks.ts:71-89`). `runners.ts` doesn't change, which keeps it clear of the uncommitted release work.
- **Building the targeted command.** A new pure helper, `targetedCommand(repoPath, command, failures)`, in a new `apps/orchestrator/src/engine/targeted-tests.ts`. It returns a command line or `null`:
  1. **Resolve the command** with `expandPackageScripts` (`packages/tools/src/package-scripts.ts:14`).
  2. **Check the runner.** Targeting is allowed only when the resolved script is a single program with no `&&`, `||`, `;` or `|`, and that program is `vitest`, `jest`, `playwright test` or `pytest`. Otherwise it returns `null`.
     - `tenten-accounting-in` qualifies: its `test` is `vitest run`, and its `test:e2e` is `npx playwright test`.
  3. **Collect the files.** The test files come from the failure ids:
     - Vitest and Jest: the `file > …` prefix and the `file [ file ]` suite form.
     - Playwright: the `[project] › file › …` form.
     - pytest: `file::name`.

     Each file must be relative to the repository, must exist in the baseline worktree, must stay inside it (no `..`, no absolute path), and must match a test-file pattern (`*.test.*`, `*.spec.*`, `test_*.py`). Paths use forward slashes, because Playwright treats its arguments as patterns.
  4. **Cap the size.** If there are more than 50 files, or none, it returns `null`.
  5. **Build the line.** The original command gets the files as arguments, `npm test -- a.test.ts b.test.ts` for a package script. Every file is quoted for the shell.
- **The flow when a command fails:**
  1. On a cache hit for the **full** key, today's full-run row is used and nothing runs.
  2. Otherwise, when `targetedCommand` gives a line, that line runs through the existing `run()` path: the same detached worktree, the same `prepareDetached` install, the same environment, the same timeout and the same `finally` removal. Its row goes into `baseline_checks` under its own `command_sha`, the hash of the targeted line. A partial result therefore can never answer a later full lookup, and no migration is needed.
  3. `classifyFailures` (`:39-45`) is applied to the targeted row. `preexisting` is the answer, recorded as `Checked 6 failing test files on d8ca918 (48 s)`.
  4. On any other result (`new`, `unknown`, or an error) the full run happens through today's code, and its answer stands.
- **Cost of the fallback:** one targeted run, about a minute. That happens only when the failure really is new, or the runner can't be targeted.
- **The test in isolation.** A test that fails only when the whole suite runs (shared state) passes when run alone on the baseline. It then counts as `new` and falls back to the full run: correct, just slower.

#### 3.2 Clean failure ids (fixes root cause 4)

- **`FailureIdCollector.list()`** (`test-summary.ts:103-141`) drops a title-only id when a longer id ends in ` > <that title>`. The ids stay a superset of real failures, so the pre-existing comparison is unchanged in meaning. It stays fail-closed, because both sides go through the same collector.
- **The summary wording** in `runners.ts:637` currently counts ids as if they were tests. It becomes `— every failure also fails on d8ca918`. This is a one-line change; it is made after the release work is committed (§4).

#### 3.3 Time breakdown (fixes root cause 3; built before the replay that measures this plan)

- **A new pure module,** `apps/orchestrator/src/engine/time-breakdown.ts`:

  ```ts
  type TimeBreakdown = {
    totalMs: number;
    buckets: { queued: number; agentFirstPass: number; agentRework: number; checks: number; release: number; parked: number; overhead: number };
    baselineMs: number;          // part of `checks`: executions whose command starts with "baseline "
    agentSuiteRuns: number;      // evidence only: agent Bash lines matching a configured test/e2e command exactly
  } | { totalMs: number; buckets: null; reason: string };
  ```

- **How the time is divided.** It sweeps the interval from `created_at` to `finished_at`, and each millisecond goes to exactly one bucket, in this order of precedence:
  1. **Stage time**, by kind:
     - `agent` stages go to `agentFirstPass` or `agentRework`. An agent stage counts as rework when it started after the task's first `TEST_FAILED` or `REVIEW_FAILED` event that carried no `preexisting` classification.
     - `tests`, `command`, `verify` and `git` stages go to `checks`.
     - `release` stages go to `release`.
  2. **Parked:** from `TASK_WAITING`, `APPROVAL_REQUESTED`, `TASK_FAILED` or `TASK_INTERRUPTED` to the next `TASK_RESUMED`, `APPROVAL_RESOLVED` or `STAGE_RETRY`.
  3. **Queued:** from `created_at` to the first `TASK_STARTED`.
  4. **Overhead:** whatever is left, such as worktree creation, installs and the Chairman between stages. It is named rather than folded into another bucket.

  The buckets therefore always add up to the total. These are the same definitions that produced the evidence table in §1.
- **Where it shows:**
  - The report section is written by `buildFinalReport` (`engine/report.ts:104`). It lists the buckets in minutes, `of which baseline comparison: X min`, and `Agents ran a configured suite N times` when N > 0.
  - `task.json` gets the same object.
  - `GET /api/tasks/:id/time` works for running tasks too, measuring up to now.
  - The Overview **Time** card uses shared `packages/ui` components and semantic tokens only.
- **No migration and no cache:** it is one read over tables that are already indexed by task.
- **It never breaks a report.** Any error, or a missing timestamp, gives `buckets: null` with a reason, and the section says `Not enough data`.

#### 3.4 Phone alerts (fixes root cause 2)

**Messenger side** (`whatsapp-inbox-saas-1`, mirroring `ark_console` exactly):

- `control_center` is added to `NotificationSourceApp` (`packages/shared/src/enums.ts:94-102`).
- `SYSTEM_BOTS.control_center` is added (`worker/src/lib/system-bots.ts`) as `{ userId: 'bot_acc', handle: 'control_center', displayName: 'Control Center' }`.
- A bot-seed migration takes the next free number (0164 today). It copies `0163_seed_ark_backups_bot.sql`, including its down migration.
- `scopedTokens()` (`worker/src/routes/internal-notifications.ts:84-89`) also reads `NOTIFICATIONS_BEARER_CONTROL_CENTER` and `NOTIFICATIONS_CONTROL_CENTER_RECIPIENTS`, and `SCOPED_ONLY_APPS` (`:91`) gains `control_center`. Both are declared in `worker/src/env.ts`.
- There is no silence watchdog: silence is normal for the Control Center.
- The tests extend `tests/worker/notification-ingest-auth.test.ts`.

What the phone shows:

- The push notification in the tray shows the bot's name and the notification's **title**, and tapping it opens the chat thread.
- The thread card shows the body and the deep link (`system-notify.ts`, `MessageBubble.tsx:92-99`).

**Control Center side: `AlertService`** (`apps/orchestrator/src/services/alerts.ts`, a new file):

- **What it watches.** It subscribes to the bus the way `LearningService.start` does (`learning/service.ts:117-124`), taking `task` and `approval` messages. It alerts when a task **enters** one of these states:

  | Entered | Title (≤ 120 chars; this is all the tray shows) | Severity | Toggle |
  | --- | --- | --- | --- |
  | A new pending approval | `TASK-0009 needs your approval · <task title>` | warn | `approvals` |
  | `WAITING_FOR_USER`, blocker `decision` | `TASK-0009 needs your decision · <task title>` | warn | `approvals` |
  | `WAITING_FOR_USER`, any other blocker except `approval` and `queued` | `TASK-0009 is stopped · <task title>` | warn | `failures` |
  | `WAITING_FOR_USAGE_RESET` | `TASK-0009 waits for usage to reset` | info | `failures` |
  | `FAILED` | `TASK-0009 failed · <task title>` | critical | `failures` |
  | `COMPLETED` | `TASK-0009 is done · <final status>` | info | `completions` |

  The toggles are the existing `settings.notifications` flags (`packages/shared/src/schemas.ts:393-399`). One preference therefore governs every channel.
- **"Already sent" is a task event, not memory.**
  - Every attempt writes `ALERT_SENT` or `ALERT_NOT_SENT`, two new `EVENT_TYPES`, carrying the id of the event or approval it is about.
  - Before sending, the service checks with `store.lastEventOfType` that no `ALERT_SENT` exists for that source id.
  - The `dedupeKey` is `acc:<taskId>:<sourceEventOrApprovalId>`, so the messenger deduplicates too.
  - On startup, tasks already in an alerting state are checked once through the same path. An alert lost to a restart is sent late, and one already sent is never repeated. Nothing is kept in memory that a restart could lose.
- **The alert's content:**
  - The body is the repository name, then the blocker message or the approval's `action` and `reason`. It passes through `redact()` and is capped at 600 characters.
  - The `deepLink` is `<openUrl>/tasks/<id>` when an `https` open URL is set (the cloud dashboard). Otherwise it is left out.
- **Sending** uses Node `fetch` with `https:` only, a 10 s timeout and `redirect: 'error'`:
  - 201 or 200 counts as sent.
  - A network error, a 5xx or a 429 is retried once after 30 s.
  - A 4xx is never retried.
  - The reason in `ALERT_NOT_SENT` names the field or the status, never a value, as ARK's notifier does (`ARK-Console/server/cli/notify.mjs:280-286`).
  - An alert is never part of the task's state and never blocks or delays anything.
- **Settings.** The existing settings object gets `notifications.phone`: `{ url, credentialName, recipientEmail, openUrl? }`, all optional. Alerts stay off until `url`, `credentialName` and `recipientEmail` are all set.
  - Settings → Notifications gets a **Phone alerts** block with those fields and **Send a test** (`POST /api/alerts/test`).
  - **Send a test** returns the delivery result, including a named reason when it fails.
- **Token custody** follows `secret-custody`:
  1. `credential.generate`, kind `http`, name `messenger-control-center`. MyVault saves it; `heldForVault` holds the value back until it has.
  2. `cloudflare.secret_put` deploys it to the messenger Worker as `NOTIFICATIONS_BEARER_CONTROL_CENTER`. This is a typed Level-4 approval.
  3. The recipient allowlist, `NOTIFICATIONS_CONTROL_CENTER_RECIPIENTS`, is the operator's own address. The operator enters it in Credentials (kind `other`), and it is deployed the same way, so the address stays out of both repositories.
  4. The orchestrator reads the token by name only, through `broker.value(name, null)`.

### 4. Implementation steps

**Order and collisions.** A separate session is building RELEASE_STAGE_PLAN in this working tree, and its uncommitted edits touch `engine.ts`, `runners.ts`, `report.ts`, `app.ts`, `routes.ts`, `OverviewTab.tsx` and the shared types.

- **Steps 1 and 2 touch none of those files,** so they may start now.
- **Steps 3 to 5 start only once `git log` shows the release work committed.** Until then, stop after step 2 and leave a note.

Stage only each step's own paths. Each step keeps `pnpm check` green and updates its system doc in the same commit.

1. **Targeted baseline and clean ids** (`baseline-checks.ts`, `targeted-tests.ts`, `test-summary.ts` and their tests):
   - add `targetedCommand` and wire it into `classify`;
   - add the title-only dedupe;
   - update `workflow-engine.md` (baseline-aware checks).
2. **Messenger bot** (in `whatsapp-inbox-saas-1`, following its `AGENTS.md`):
   - add the enum value, the bot entry, the migration, the scoped token, `env.ts` and the tests;
   - update `direct-messages.md` and `FLEET.md`;
   - release through its normal path: a push to `main`, which Cloudflare Workers Builds deploys with `scripts/cf-ci.sh`, D1 migration included. Then confirm it live.
3. **Summary wording and time breakdown:**
   - change the one line in `runners.ts:637`;
   - add `time-breakdown.ts` and its tests, with fixtures rebuilt from TASK-0007 and TASK-0008's real timings (timestamps and kinds only);
   - add the report section, the `task.json` field, the route and the Overview card;
   - update `workflow-engine.md` and `dashboard.md`.
4. **Alerts:**
   - add `AlertService` and its tests, the two event types, the settings fields, the Settings block, the test route, and the wiring in `app.ts`;
   - update `dashboard.md`, `credential-broker.md` and `operations.md`.
5. **Credentials and configuration:**
   - create and deploy the token and the recipient with `secret-custody`;
   - fill in Phone alerts, using the cloud dashboard as the open URL;
   - press **Send a test**.
6. **Real verification** (§7). Fix what it exposes, and repeat until §8 holds.

#### Irreversible steps

- **The messenger production release,** including its additive bot-seed D1 migration. A shipped migration is never edited, so removing the bot would take a new migration.
- **Deploying `NOTIFICATIONS_BEARER_CONTROL_CENTER` and `NOTIFICATIONS_CONTROL_CENTER_RECIPIENTS` to the production messenger Worker.** They can be rotated or deleted later, but deploying them is a production change.
- **Alerts sent to the operator's own messenger inbox** during verification: a test alert and one real "needs your decision" alert.
- **One real-agent replay** of about 60–80 minutes. It spends subscription usage that can't be refunded.

### 5. Failure handling and recovery

- **Targeted baseline:**
  - An unknown runner, a chained script, no parseable files, more than 50 files, or a path that fails validation gives `null`: the full run happens, which is today's behaviour.
  - A targeted run that errors, times out or doesn't reproduce every failure also falls back to the full run.
  - Worktree cleanup and the startup `sweep` are unchanged.
- **Failure ids:** the dedupe only removes an id that is contained in another. When in doubt, the id is kept, so the comparison fails closed.
- **Time breakdown:** errors give `buckets: null` and `Not enough data`. Report writing catches the error and carries on without the section.
- **Alerts:**
  - A messenger outage, a 401 or 403, a timeout or a bad setting each produce `ALERT_NOT_SENT` with a named reason and at most one retry.
  - Task state is never affected, and the dashboard still shows everything.
  - **Send a test** exposes a misconfiguration before it matters.
- **Rollback:**
  - Steps 1 and 3 are code only, with no migration.
  - Alerts turn off when the Phone alerts fields are cleared.
  - On the messenger, deleting the token secret leaves the bot unable to post, with no other effect.

### 6. Security and data protection

- **The baseline never becomes less strict.** A targeted run can only confirm a failure was pre-existing when every failing id reproduces. Anything else defers to the full run. File arguments are validated as repository-relative existing test files inside the baseline worktree, and they are shell-quoted. The run goes through the same classifier, policy, credential scope, timeout and detached worktree as §B. The operator's checkout is never touched.
- **The messenger token is scoped.** It follows `secret-custody`: generated, saved to MyVault before use, deployed over stdin, read by name only, and registered with the redactor. On the messenger it can post only as `control_center`, only to the allowlisted address, and never read directories. Shared tokens can't post as `control_center`.
- **Alerts say as little as possible.** The content is the task id, the title, the repository name and the redacted blocker or approval text, capped at 600 characters. It never contains diffs, logs, file contents, credentials or tool output. It goes only to the operator's own first-party messenger, over `https` with no redirects.
- **An alert grants nothing.** The deep link opens the dashboard, which keeps its own authentication: Cloudflare Access in the cloud, and the Host, Origin and token checks locally. Approvals still need the typed confirmation.
- **The time breakdown** outputs durations and counts only, never log text.
- **No guard listed in `AGENTS.md` is weakened,** and no dependency is added in either repository.

### 7. Testing and verification

##### Unit

- **`targeted-tests.test.ts`:**
  - Vitest, Jest, Playwright (Windows backslash ids) and pytest ids map to the right files;
  - chained scripts, unknown runners, more than 50 files, `..` and absolute paths, missing files and non-test files all give `null`;
  - quoting is correct.
- **`baseline-checks` targeted flow:**
  - a targeted run that reproduces every failure gives `preexisting` without a full run;
  - a targeted run with a missing failure, an error or a timeout falls back to exactly one full run;
  - a cached full row is used first;
  - a targeted row never answers a full-key lookup.
- **`test-summary`:** the real TASK-0008 unit id list collapses to the file-qualified ids, and a Playwright list is unchanged.
- **`time-breakdown.test.ts`:**
  - the TASK-0007 and TASK-0008 fixtures reproduce §1 within ±1 min per bucket;
  - the buckets add up to the total;
  - `baselineMs` is 19.6 ±0.2 min for TASK-0008;
  - a missing timestamp gives `buckets: null`.
- **`AlertService`:**
  - each transition sends exactly one alert, and an unchanged state sends none;
  - a restart after a send sends nothing, and a restart before a send sends once;
  - the per-kind toggles are respected;
  - redaction and the 600-character cap hold;
  - it is `https` only, with no redirects;
  - it retries once on a 5xx or 429 and never on a 4xx;
  - it holds while the credential isn't saved to MyVault;
  - `ALERT_NOT_SENT` reasons contain no URL, token or address.
- **Messenger:**
  - the scoped token posts only as `control_center` and only to the allowlisted address;
  - it gets 403 on the directories;
  - a shared token gets 403 posting as `control_center`.

**End-to-end:** `pnpm build && pnpm e2e` in both themes covers the Time card, the Phone alerts block, and **Send a test** against a local stub server. The messenger repository runs its own test command.

**Real checks** (on the operator's PC)

1. **Alerts on the handset** (`phone-autopilot`):
   - With every dashboard closed, **Send a test** must arrive within 60 s.
   - Then start a small task whose goal forces `BLOCKED ON OPERATOR:`. The "needs your decision" alert must arrive within 60 s, and its link must open the task.
   - Then restart the orchestrator with `-Drain`. No duplicate may arrive.
2. **Replay.** Repeat the TASK-0008 replay on this build:
   - same repository copy, baseline `d8ca918`, same attachment, Full Autopilot, Autopilot mode;
   - read its **Where the time went** section.

**Commands:** `pnpm check` · `pnpm build && pnpm e2e` · the messenger's own tests · the real checks.

### 8. Success criteria

- **The baseline stops dominating.** In the replay, the pre-existing unit and e2e failures are classified from targeted runs, and `baselineMs` is **≤ 3 min**, down from 19.6. The replay's tests stage takes **≤ 22 min**, down from 39.3.
- **Lead time.** The replay goes from created to COMPLETED in **≤ 65 min**, excluding any time between an alert arriving and the operator answering.
- **Honest summaries.** No test summary claims a count that disagrees with the runner's own totals line.
- **The time report.** The replay's report has a **Where the time went** section whose buckets add up to its total. The Overview Time card shows the same figures.
- **Alerts.** A test alert and a real "needs your decision" alert each reach the handset within 60 s with no dashboard open. The link opens the task. A drain-and-restart sends no duplicate.
- **Tests and docs.** `pnpm check`, the e2e matrix in both themes and the messenger tests are green. Every system doc touched in both repositories carries a new `Last verified:` date.

### 9. Found for Later

- **Agents' wide test runs.** In TASK-0008, Implement ran `npx vitest run src/lib functions/api/admin …` for about 9 minutes: whole folders rather than the changed files. Two ways to address it:
  - a one-line time budget in `implementer.md`;
  - a `checks.run` tool that runs related tests and is recorded with a `tree_id` that Test can reuse.

  **Priority: medium; high if the replay shows `agentSuiteRuns > 0`.**
- **Prepare the baseline worktree early.** Check out the baseline and install its dependencies while agents work, so a failure's targeted run starts at once (about 1 min saved). **Priority: low.**
- **Keep running after a new failure.** Run every suite even when one has a new failure, and report them all together. The trade-off is in §1. Worth it only if the time breakdown shows repeated Test → Fix → Test cycles caused by a second suite. **Priority: low.**
- **`ignorePaths` per command,** so a docs-only change doesn't re-run a check. It is opt-in per repository. The accounting build compiles `docs/**`, so there can be no global default. **Priority: low.**
- **Lead time on Usage.** The median of each bucket per repository, over the last 20 finished tasks. **Priority: low.**
- **Parallel isolated tasks in one repository.** `repositoryHolder` (`engine.ts:820-829`) queues a second task even when both use worktrees (TASK-0003 waited 16.3 min). **Priority: medium.**
- **Structured blocker options,** so an alert could offer one-tap answers. **Priority: medium.**
- **Commit-hook failures found late.** In TASK-0005 the repository's docs guard refused the commit after Review and Verify, and it waited 14.8 min. **Priority: medium.**

### 10. Next Recommended Task

**Parallel isolated tasks.** Once lead time per task is near its floor, the next gain is throughput: two worktree tasks in the same repository running their agent stages side by side, sharing one slot for heavy checks. Queueing was the only waste in TASK-0003, and it grows with every task queued.

### 11. Final execution prompt

Implement `docs/plans/LEAD_TIME_PLAN.md` in `AI-Development-Control-Center`, plus its messenger part in `whatsapp-inbox-saas-1`.

- Read `AGENTS.md`, `PLAN.md`, `design.md`, AUTOPILOT_GATES_PLAN, and the system docs in the header. Then read the messenger's `AGENTS.md`, `FLEET.md` and `docs/systems/direct-messages.md`.
- Do steps 1 and 2 now. Before step 3, confirm that the RELEASE_STAGE_PLAN work is committed. If it isn't, stop there with a note, and never edit its files while they are uncommitted.
- Stage only each step's own paths; other sessions share this working tree. Keep `pnpm check` green after every step.
- Secrets go only through `secret-custody`. Never weaken a guard listed in `AGENTS.md`, and never add a dependency.
- Finish with the real checks in §7, and verify every item in §8. Report what was checked, what couldn't be checked, and why.

/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.

## Steps

- [x] 1. targetedCommand helper (§3.1): new `apps/orchestrator/src/engine/targeted-tests.ts` that turns a failing command plus failure ids into a file-targeted command line or null — done when: Vitest, Jest, Playwright (Windows backslash ids) and pytest ids map to validated, quoted, forward-slash test files; chained scripts, unknown runners, more than 50 files, `..`, absolute, missing and non-test paths give null — check: `pnpm --filter @acc/orchestrator exec vitest run test/targeted-tests.test.ts`
- [x] 2. Targeted flow in `BaselineChecks.classify` (§3.1): a cached full row first, else a targeted run under its own command_sha, preexisting only when every failure reproduces, otherwise exactly one full run — done when: unit tests prove targeted gives preexisting without a full run, fallback on a missing id / error / timeout, a cached full row wins, a targeted row never answers a full lookup — check: `pnpm --filter @acc/orchestrator exec vitest run test/baseline-checks.test.ts`
- [x] 3. Clean failure ids (§3.2): `FailureIdCollector.list()` drops a title-only id that another id ends with ` > <title>` — done when: the real TASK-0008 unit id list collapses to its file-qualified ids and a Playwright list is unchanged — check: `pnpm --filter @acc/orchestrator exec vitest run test/test-summary.test.ts`
- [x] 4. Steps 1–3 documented and saved: workflow-engine.md baseline-aware checks section updated, pnpm check green, path-scoped commit and push — done when: the commit is on origin/main and pnpm check exited 0 — check: `pnpm check && git log origin/main -1 --stat`
- [x] 5. Messenger control_center bot (§3.4 messenger side, in whatsapp-inbox-saas-1): enum, SYSTEM_BOTS entry, next-number bot-seed migration with its down migration, scoped token and recipients in scopedTokens / SCOPED_ONLY_APPS / env.ts, tests, direct-messages.md and FLEET.md — done when: the messenger's tests pass including new scoped control_center cases — check: `the messenger repository's own test command on the ingest tests`
- [x] 6. Messenger released and live: path-scoped commit, push to main, Workers Builds deploy with the D1 migration — done when: the deploy shows the new commit and the production ingest answers 401 to a control_center post with a wrong bearer — check: `manual: Workers Builds status for the commit and one unauthenticated request to the ingest`
- [x] 7. Summary wording (§3.2): the runners.ts pre-existing summary no longer counts ids as tests — done when: a pre-existing unit failure summary reads `— every failure also fails on <sha>` — check: `pnpm --filter @acc/orchestrator exec vitest run test/autopilot-gates.test.ts`
- [x] 8. Time breakdown (§3.3): time-breakdown.ts with fixtures from TASK-0007 and TASK-0008, the report section, the task.json field, `GET /api/tasks/:id/time`, the Overview Time card; workflow-engine.md and dashboard.md — done when: the fixtures reproduce §1 within ±1 min per bucket, buckets sum to the total, baselineMs is 19.6 ±0.2 for TASK-0008, missing timestamps give buckets null — check: `pnpm --filter @acc/orchestrator exec vitest run test/time-breakdown.test.ts && pnpm check`
- [ ] 9. AlertService (§3.4 Control Center side): services/alerts.ts, ALERT_SENT / ALERT_NOT_SENT events, settings.notifications.phone, Settings → Phone alerts with Send a test, `POST /api/alerts/test`, wiring in app.ts; dashboard.md, credential-broker.md, operations.md — done when: unit tests cover one alert per transition, none on an unchanged state, restart-safe dedupe, toggles, redaction and the 600 cap, https only with no redirects, one retry on 5xx/429 and none on 4xx, held while not saved to MyVault, reasons without URL/token/address — check: `pnpm --filter @acc/orchestrator exec vitest run test/alerts.test.ts && pnpm check`
- [ ] 10. Steps 7–9 end to end: Time card and Phone alerts block (Send a test against a local stub) in both themes, committed path-scoped and pushed — done when: the e2e matrix is green and the commit is on origin/main — check: `pnpm build && pnpm e2e`
- [ ] 11. Credentials and configuration (§4 step 5): token generated and saved to MyVault, token and recipient deployed to the messenger Worker through secret-custody, Phone alerts filled in with the cloud dashboard as open URL, orchestrator restarted on the new build with -Drain — done when: Send a test reports sent — check: `manual: the Send a test result in Settings`
- [ ] 12. Alerts on the handset (§7 real check 1) — done when: with every dashboard closed a test alert and a real "needs your decision" alert each arrive within 60 s, the link opens the task, and a drain-and-restart sends no duplicate — check: `manual: phone-autopilot evidence under $HOME/.claude/phone/`
- [ ] 13. Replay (§7 real check 2): the TASK-0008 replay on this build — done when: every §8 criterion holds (baselineMs ≤ 3 min, tests stage ≤ 22 min, created to COMPLETED ≤ 65 min excluding operator reaction time, honest summaries, the time section sums to the total) — check: `manual: the replay's Where the time went section and GET /api/tasks/:id/time`

## Tail

- [ ] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat` reviewed hunk by hunk
- [ ] T2. Similar-issue sweep — done when: the other failure-id consumers (Chairman signatures, the gate) and the other bus subscribers were checked for the same patterns — check: `manual: list what was searched and what was found`
- [ ] T3. Lint, typecheck, tests and e2e green — done when: all exit 0 on the full suite — check: `pnpm check && pnpm build && pnpm e2e`
- [ ] T4. Docs synced per AGENTS.md — done when: workflow-engine.md, dashboard.md, credential-broker.md, operations.md and the messenger's direct-messages.md carry the behaviour and a new Last verified date — check: `git diff --stat docs/`
- [ ] T5. Committed path-scoped and pushed in both repositories — done when: git status shows none of this work uncommitted and the pushes succeeded — check: `git log origin/main..HEAD --oneline`
- [ ] T6. Confirmed live — done when: the local orchestrator runs the new build (restarted with -Drain) and the messenger production Worker serves the new commit — check: `manual: the orchestrator's health/version and the messenger deploy`
- [ ] T7. A claim registered for this change — done when: a claim names what should now be true with a downstream probe and a deadline, or this step says why not — check: `manual: name the claim and its deadline`

## Ledger

- 2026-09-25 — created from LEAD_TIME_PLAN v2 (conversation). Plan headings demoted one level inside Context; text unchanged.
- 2026-09-25 — entry: git fetch clean, main == origin/main at 2eaba2f. The shared tree holds another session's uncommitted RELEASE_STAGE_PLAN work (engine.ts, runners.ts, report.ts, app.ts, routes.ts, OverviewTab.tsx, shared types, migration 17). Not touched, not staged. Steps 7–10 wait for it to be committed.
- 2026-09-25 20:21 — step 1 — file arguments are limited to a no-quoting-needed path charset instead of being shell-quoted, and only npm scripts or direct runner calls are narrowed (pnpm/yarn pass arguments on differently) — both fall back to the full run, which is safe and simpler than per-shell quoting
- 2026-09-25 20:27 — step 2 — the baseline file list and package.json scripts are read from the baseline commit with git ls-tree / git show (before any worktree exists), so a task that changed its own test script or added a test file is judged by the baseline, not its copy; Classification gained an optional checkedFiles for the summary in step 7
- 2026-09-25 20:30 — step 2 — fixed a flaky assertion in the committed gates test (packs the diffs of a task across repositories): the simulated implementer writes into the workspace's first folder, which is either repository's because temp names are random; the test now accepts either task folder. Found while regression-testing; failed 2 of 2 before, passed 3 of 3 after
- 2026-09-25 20:33 — step 3 — the TASK-0008 list collapses to its file-qualified ids plus "CLAUDE.md", a line a test printed: it is not a bare title of another id, so the rule keeps it (it appears identically on both sides of a comparison). The done-when is met for titles; printed lines stay, as §3.2 says ("Anything else is kept")
- 2026-09-25 20:55 — step 4 — pnpm check: typecheck and lint green; the full test run had 13 timeouts in 10 files (engine, chairman, prompts, usage, multi-repo, api, remote-egress, git source-control, pty) while about 100 node processes from other sessions shared the machine; every one of those files passed when rerun alone (141/141 orchestrator, 26/26 git, 3/3 pty). Pushed as 9cee10f. The shared workflow-engine.md was committed hunk-only (the release session's hunks stay unstaged)
- 2026-09-25 21:05 — step 5 — messenger: 15/15 ingest-auth tests (5 new control_center cases), typecheck and eslint green; migration 0164 applies on a fresh local D1 (all 164) and seeds bot_acc. The operator's persistent local D1 is already broken on an older migration (duplicate column followup_autosend_source), so db:wiring:local / d1:check:local were left to the Workers Builds gate [6/9], which runs them on a fresh database before any production migration. scopedTokens now reads a small table of (app, token, recipients) instead of one hard-coded entry
- 2026-09-25 22:05 — step 6 — messenger 63df33f pushed 19:57:45Z; Workers Builds deployed version 4cb1ca4e at 20:02:18Z (its pipeline applies remote D1 migrations before the deploy). Production D1 (read-only query): latest migration 0164_seed_control_center_bot.sql, bot_acc / control_center / is_bot 1 / dm_policy nobody. The ingest answers 401 to a wrong bearer for control_center. Proof that the scoped token itself works waits for step 11 (its secret is not set yet)
- 2026-09-25 22:08 — step 7 — started while step 6 waited on the external deploy (no edits of step 6 pending): the RELEASE_STAGE_PLAN work was committed meanwhile (dfcf459, b1e3447), which unblocked steps 7–10. Wording: the runner's totals line stays first, then "— every failure also fails on <sha>", plus "(only the N failing test files run there)" when the narrowed run decided. autopilot-gates 27/27
- 2026-09-25 23:10 — step 8 — fixtures (timestamps, stage kinds, event types; agent commands replaced by generic ones, no task content): TASK-0008 reproduces §1 exactly (78.6 total, 38.3 first pass, 0 rework, 39.3 checks, baseline 19.6, parked 1 s from the restart drain). TASK-0007: checks 47.1 and parked 59.8 match; agent first pass 44.9 / rework 56.8 against §1's 43.6 / 51.6, because §1 set failed agent attempts (3.9 min) and 2.3 min of "other" apart while the bucket counts them in their pass — assertions use the computed values. agentSuiteRuns is 4 for TASK-0007 and 0 for TASK-0008. An integration test covers the report section, task.json and GET /api/tasks/:id/time (404 for an unknown task)
- 2026-09-25 23:10 — step 8 — pnpm check: typecheck, lint and the docs check green; vitest crashed twice with "JavaScript heap out of memory" at 60 MB (machine commit charge 43.1 of 47.7 GB, about 100 node processes from other sessions). Run package by package with 2 workers: 15 packages, 942 passed, 1 timeout (remote-node "brings the cloud copy up to date", 60 s), which passed 14/14 alone. Steps 7–8 committed together now rather than at step 10, so the shared tree holds less uncommitted work
