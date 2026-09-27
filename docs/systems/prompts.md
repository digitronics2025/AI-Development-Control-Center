---
system: prompts
sources:
  - prompts/**
  - packages/shared/src/prompts.ts
  - apps/orchestrator/src/engine/context.ts
  - apps/orchestrator/src/engine/stage-team.ts
  - apps/orchestrator/src/services/prompts.ts
  - apps/orchestrator/src/engine/report.ts
  - apps/orchestrator/src/chairman/signatures.ts
  - apps/dashboard/src/pages/SettingsPage.tsx
verified_at: 57af61a
---

# Role prompts

What each agent stage is told, and what the orchestrator reads back from its
reply. The nine built-in templates live in [prompts/](../../prompts) (plan:
[ROLE_PROMPTS_PLAN.md](../plans/ROLE_PROMPTS_PLAN.md)); the contract between
them and the code is the placeholder catalog and the marker lines below.

## What a stage receives

[context.ts](../../apps/orchestrator/src/engine/context.ts) `ContextBuilder.build`
assembles, in this order:

1. A header: task id, role, stage key, working directory.
2. `RUN_CONTEXT`, prepended to every template including user-edited ones: the
   agent is a subagent whose reply is a task record (no chat recap or to-do
   block); only its final message is kept; the `BLOCKED ON OPERATOR:`,
   `NEEDS OPERATOR:`, `CAUSE:` and `VERDICT:` lines below are read by the
   orchestrator; commits, tests and approvals happen after it.
3. The role template with its placeholders filled, then the stage's own
   `instructions` from the workflow as `## Stage instructions (from the
   workflow)` (up to 2,000 characters), so two stages of one role can be told
   different things without a new role.
4. `## Chairman guidance` when a recovery strategy set one ([chairman.md](chairman.md)).
5. `## Lessons from earlier tasks` from the learning loop ([learning.md](learning.md)).
6. The engine's sections ([tooling.ts](../../apps/orchestrator/src/engine/tooling.ts)):
   `## Skills` (how skills and outside tools behave in a run), `## Requested skills`
   when the task or a directive names `/skills` or the stage lists `skills`
   (installed ones only), `## Environment` for the investigate, plan and write
   role classes (`ROLE_CLASS` in [constants.ts](../../packages/shared/src/constants.ts)) except
   the fixer, and `## Control Center tools` when
   the MCP bridge is on.

Templates never repeat 4–6; each adds only what the generic text cannot know
(which kind of skill fits the role) and asks for `## Skills used` in the report.

## Placeholders

`PROMPT_PLACEHOLDERS` in [packages/shared/src/prompts.ts](../../packages/shared/src/prompts.ts)
is the catalog: name and one-line meaning. The builder's variables are typed
against it, so every name is filled for every agent stage; a value that is
empty for this stage renders as `(none)`, and the templates say what that
means where it matters ("no earlier work yet"). `PUT /api/prompts/:role`
refuses a body with a name outside the catalog (400, naming them), and the
Settings editor lists the catalog and flags unknown names before saving.
Templates saved before the check keep rendering `(none)` for unknown names.

| Placeholder | Filled from |
|---|---|
| `task_id`, `title`, `request` | the task; `request` is the title as `#` heading plus the description |
| `role`, `stage_name`, `workflow_name` | the stage definition and the task's workflow snapshot |
| `repository_name`, `repository_path`, `repository_facts`, `git_status` | the repository record, the task's working directory (its worktree when isolated — `repository_facts`' `- Path:` too, so an isolated task's agents are never pointed at the operator's checkout), `git status` at stage start. A Stage Team write worker's prompt has every spelling of the task worktree and of the operator's checkout rewritten to its own checkout ([stage-teams.md](stage-teams.md)) |
| `attachments` | text attachments inline (≤ 50 KB each, redacted), others by path; the investigator, planner, implementer, designer, art director, visual critic, reviewer and verifier templates use it |
| `screenshots` | the task's `screenshot`, `image` and `video` artifacts (browser checks, the visual matrix, generated media, pictures from MCP servers), newest 30, as `name (type, stage, size): path`; the designer, art director, visual critic, reviewer and verifier templates use it |
| `design_context` | the repository's design standard and design memory by path and size: `design.md`, `DESIGN.md`, `docs/design.md`, a Tailwind config, every file in `design/`, with `design/brief.md` inline (8 KB, redacted) ([design-agent.md](design-agent.md)) |
| `directives` | active, non-routing directives for this stage, marked `(constraint)` or `(completion requirement)` |
| `investigation`, `plan`, `implementation_report`, `review`, `verification_report` | artifacts: every investigation, the latest plan, every implementation and fix report (20 KB each), the latest review — for a reviewing judge (reviewer, visual critic) the latest review written by its own role, so the code review never reads the critique as its previous review — the latest `browser-verification.md` |
| `test_results` | the last test stage: each command's status and summary, the failing command's last 80 log lines, a commit the repository's hook rejected; failures the baseline commit already had are listed apart under "Already failing before this task — do not fix unless asked" |
| `diff`, `changed_files` | against the task baseline for every agent role, packed by priority into 150 KB (redacted; `changed_files` carries `+a −d`); a Staged Review task gets the staged diff instead |
| `diff_coverage` | "Diff shows N of M changed files in full" and one line per file not shown with its reason and how to read it. An added or changed image or video (shown in the diff only as "Binary files … differ") counts as not shown: when a changed `manifest.json` names it (and its SHA-256 matches when the manifest gives one) it is listed under "Generated media named by an asset manifest" with its size, weight and use, and needs no line; otherwise it must be viewed (`media.image.view`) and named ([design-agent.md](design-agent.md#design-memory-and-learning)). Pre-existing user work the task never touched, media included, is never required. A verdict stage (reviewer, visual critic, verifier) must name each under `## Files reviewed`, or a PASS is asked again once and then fails `REVIEW_INCOMPLETE`; a user-edited template without the placeholder gets the block appended |
| `verification_commands` | enabled lint, typecheck, test and build commands |
| `check_costs` | each enabled lint, typecheck, test, build and e2e command with its typical duration in this repository, the slow-check rule and the e2e Test-stage-only rule ([below](#check-costs)); `(none)` without such commands |
| `preexisting_changes` | files with uncommitted user work at task start, or `none` |
| `previous_attempt` | the last FAILED, CANCELLED, INTERRUPTED or PAUSED run of this stage with its last 40 log lines |
| `fix_cycle`, `max_fix_cycles` | `tasks.fix_cycles` (already incremented during a fix stage) and the limit |
| `team_stages` | adaptive Stage Team stages of the workflow (not Fix) with key and worker limit, each stage's specialties and the labelling rule (`teamStagesText`); the planner may then end its plan with an `acc-work-units` manifest ([stage-teams.md](stage-teams.md#specialists)) |

## Versions

[prompts.ts](../../apps/orchestrator/src/services/prompts.ts): every save is
a new `prompt_templates` row; tasks record the version each role used
(`tasks.prompt_versions`). At start the built-in file is seeded as a new
version only for a role whose latest row is still built-in; a role edited in
Settings keeps its edit until **Restore built-in**, which inserts the file as
a new built-in version. Roles without a file (deployer, reporter) use
`GENERIC_TEMPLATE`.

## What the orchestrator reads back

| Line | Read by | Effect |
|---|---|---|
| first prose line under `## Summary` (else Goal/Findings, else the first prose line) | `summarize` in [runners.ts](../../apps/orchestrator/src/engine/runners.ts) | the stage line in timelines; write roles (implementer, fixer, designer: `WRITE_ROLES`) fill the report's "Changed" |
| `VERDICT: PASS` / `VERDICT: FAIL`, last one wins | `parseVerdict` | routes a `verdict` stage to `next` or `onFail`; missing → the stage fails as `UNKNOWN` |
| `BLOCKED ON OPERATOR: <decision, options, recommendation>` from a work stage (any role outside the judge class: investigator, planner, art director, implementer, fixer, designer) | `extractOperatorBlockers` in [report.ts](../../apps/orchestrator/src/engine/report.ts) | task `WAITING_FOR_USER`, blocker `decision`; a directive answers and re-runs the stage; cut at 600 characters |
| `NEEDS OPERATOR: <item>` from a judge-class role (reviewer, visual critic, verifier) | `extractOperatorItems` | "Needs your decision" in the completion report and `NEEDS_USER_ACTION`; the verifier's list replaces the reviews', so the verifier repeats items still open; without a verification the latest review of each review stage counts (`latestOperatorItems`), so a visual critique's items are not hidden by the code review after it |
| `CAUSE: code` / `CAUSE: plan` with a FAIL | `causeMarker` in [signatures.ts](../../apps/orchestrator/src/chairman/signatures.ts) | `plan` classifies the failure `REQUIREMENT_OR_PLAN` (the Chairman re-plans first); `code` keeps it `CODE_OR_TEST` even when the text names "success criteria"; without the line the word list decides |
| `WINNER: <key>`, last one wins, from a Stage Team variants judge (asked for by the orchestrator's judge section, not a template) | `parseWinner` in [stage-team.ts](../../apps/orchestrator/src/engine/stage-team.ts) | only that variant is kept; no line or a key that is not a finished variant fails the stage ([stage-teams.md](stage-teams.md#variants)) |

Marker lines may be bold or listed; `summarize` never returns a verdict or
cause line.

## The v4 templates

Every template: read the repository's own rules first (`AGENTS.md`,
`CLAUDE.md`, `docs/systems/`), cite `path:line`, mark observed against
inferred against claimed, never write a secret into a file, log or report,
treat a refused tool or skill as an operator decision, and end with exactly
the headings it lists.

| Role | Gets, beyond the request | Must report |
|---|---|---|
| Investigator | attachments, Git status, earlier investigations (a second opinion checks the first), and on a root-cause return the plan, diff, review and test results | Summary, Findings, Relevant files, Repository rules that apply, Risks, Open questions (with defaults), Recommended approach, Found for Later, Skills used |
| Planner | attachments, investigation, verification commands and their costs, and on a re-plan the previous plan with what came of it | Summary the operator can approve on, Goal, Scope, Success Criteria (each with its proof), Assumptions and Decisions, Implementation Plan, Verification, Security and Data Check, Irreversible steps and approvals, Completion Report, Found for Later, Next Recommended Task, Skills used |
| Implementer | attachments, plan, investigation, verification commands and their costs, and the work so far (diff, test results, review, fix cycles) when a check or review sent the task back | Summary, Changes (with deviations from the plan), Verification performed (each check: ran and passed, failed, or not run), Known limitations, Found for Later, Skills used |
| Reviewer | reports as claims, the previous review, diff and its coverage, test results, app check, screenshots and attachments (opened for a visual change) | Summary, Previous findings, Issues graded blocking or advisory, Advisory, Files reviewed (each file the diff did not show), Skills used, `NEEDS OPERATOR:` lines, `CAUSE:` with a FAIL, `VERDICT:`. Only blocking issues fail |
| Fixer | plan, reports, review, failing checks (incl. a rejected commit hook), app check, diff, verification commands and their costs, fix cycle N of M | Summary, Root causes, Fixes, Disputed findings, Verification performed, Remaining concerns, Skills used. Never weakens a check to pass it |
| Designer ([design-agent.md](design-agent.md)) | attachments (reference images: open each), design standard and memory, approved art direction, directions explored, reports, screenshots, verification commands and their costs, work so far, app check; mode by the `Stage:` line: `assets` = media only (the one stage allowed to pay for generation), any other key = build | Summary, Design decisions (the standard that binds), Assets, Spend, Changes, Visual verification, Verification performed, Known limitations, Found for Later, Skills used. Its report is saved as `design-report.md` (type `implementation-report`); a build keeps `design/brief.md` (design memory) when the repository has `design/` or it proposed the standard |
| Art director ([design-agent.md](design-agent.md)) | attachments (open each), design standard and memory, directions explored with the style tiles kept so far (screenshots), repository facts, and on a re-plan the previous direction with what came of it. Plan class: its report is saved as `art-direction.md` (type `plan`) and read by later stages as `{{plan}}`; Discuss First stops after it for plan review | Summary the operator can approve on, Direction, Design values (both themes, with contrast), Components and pages, Asset list, Media budget, Success Criteria, Decisions, Found for Later, Skills used |
| Visual critic ([design-agent.md](design-agent.md)) | approved direction, design standard and memory, reports as claims, the previous review, diff and its coverage, test results, app check, screenshots. Judge class with the reviewer's verdict kind: its report is saved as `visual-review.md` (type `review`); the completion gate asks each judge role to pass on its own, so its PASS never stands for the code review | Summary, What I looked at (each picture and check, with width and scheme), Issues graded blocking or advisory, Advisory, Files reviewed, Skills used, `NEEDS OPERATOR:`, `CAUSE:` with a FAIL, `VERDICT:` |
| Verifier | plan, reports as claims, review, diff and its coverage, test results, app check, screenshots and attachments (a visual criterion is met only by a picture or browser check it names) | Summary, Criteria (met / not met / unverified with named evidence), Review follow-up, Files reviewed, Remaining limitations, Skills used, `NEEDS OPERATOR:` (repeating the review's open ones; one for a central criterion nothing can verify), `CAUSE:`, `VERDICT:` |

Level 1 roles (investigator, planner, art director, reviewer, visual critic,
verifier) can use the read tools and, when the run lists Control Center tools,
its read-only Git tools and Level 1 checks against something already running
([agents.md](agents.md), the `analysis` profile in [tool-system.md](tool-system.md#profiles-profilests)).
Claude Code has no shell at Level 1, so the investigator and planner templates
say the stage "may have no shell" and forbid tests, builds and installs
outright. Level 2 roles (implementer, fixer, designer) run targeted checks before
reporting and a configured check in full only when `check_costs` marks it
neither slow nor Test stage only (e2e, which they never run at all); the planner
names targeted checks and never orders a slow full run, an e2e run or a wait for
another run.

## Check costs

`{{check_costs}}` (`checkCosts` in [context.ts](../../apps/orchestrator/src/engine/context.ts))
keeps agents from running, or waiting on, whole suites the Test stage runs
anyway: on the big repository that cost 54–69 min over seven tasks
(TASK-0007..0019), one plan even ordering the implementer to wait for other
runs and then run `npm test`. It is a prompt rule, not a tool deny rule (an
exact `Bash(npm test)` deny misses `npm run test` and `npx vitest run`).

- **Which commands:** each repository's enabled `lint`, `typecheck`, `test`,
  `build` and `e2e` commands (a multi-repository task: each folder's, prefixed
  `folder/`).
- **Typical duration:** the median of the last 5 runs of that exact command
  line in that repository, from `test_runs` of its 40 most recently updated
  tasks (a single-repository task's rows carry no repository id: they count for
  its primary one). A run counts when it timed the whole command: `passed`, or
  `failed` only on what the baseline or a re-run explained (`preexisting`,
  `flaky`; the suite still ran to its end). Affected-only (`selection =
  changed`), reused (`reused_from`), stopped and newly failing runs do not; a
  narrowed re-run of failing files has another command line and never matches,
  and neither does history from before the command was edited.
- **Slow** is a median over 2 minutes. The block lists every command with
  `about <duration> (median of N recent runs)` or `not timed yet`, then
  `**Test stage only**` (e2e) or `**slow**`, and
  `no later stage of this task runs it` when no tests or command stage of
  the workflow runs that kind (the tests stage's kinds plus the task's extra and
  required kinds, less waived ones).
- **The rule:** with a slow command, `**Slow here (typically over 2 minutes):
  …**` — do not run it in full, do not start or wait for another run of it, run
  targeted checks (the covering test files, lint on changed files, a scoped
  typecheck), even when a plan says otherwise; a slow check no later stage runs
  is reported as not run in full. Without one: "None is slow here … running
  them in full is fine", or with no timed run at all "None of them has been
  timed in this repository yet, so running them in full is fine" — fast
  repositories keep the cheap early catch. Where the repository also has e2e,
  these lines say "other than the end-to-end tests" / "apart from the
  end-to-end tests", and a repository with only e2e gets no "fine" line.
- **E2e is Test stage only**, however quick (`TEST_STAGE_ONLY_KINDS`):
  `**End-to-end tests are left to the Test stage, however quick they are.**` —
  do not run the e2e command, in full or for one spec file, nor start or wait
  for another run; use a Control Center browser check when the run lists one,
  otherwise report e2e as not run. An e2e suite usually starts the app on a
  fixed port with a reused server (the big repository: port 8788,
  `reuseExistingServer`, about two minutes), so an agent's run beside another
  task's own e2e check would have one side test the other worktree's files, and
  in the bad direction corrupt that check's verdict. The Test stage re-runs
  failing spec files itself. `verification_commands` still lists only the
  default verify kinds, never e2e.
- **Templates:** implementer, fixer and planner carry it under `## What each
  check costs here`; their step "Prove it" (the planner: "What a good plan
  does", and `## Verification` names targeted checks first) points at it. A user-edited implementer, fixer or planner template without the
  placeholder gets the block appended, like `diff_coverage`, and so do the
  designer and art director templates (`CHECK_COST_ROLES`), which leave it out.

## Prompt artifacts

The rendered prompt of every agent stage is saved as a `stage-output`
artifact before the agent starts (`investigation-prompt.md`,
`plan-prompt.md`, `implementation-prompt.md`, `fix-prompt.md`,
`review-prompt.md`, `verification-prompt.md`, `design-prompt.md`,
`art-direction-prompt.md`, `visual-review-prompt.md`; other roles `<stage key>-prompt.md`;
repeats get `-2`, `-3`). A Stage Team stage saves one prompt per run instead,
before that run starts ([stage-teams.md](stage-teams.md#outcome-and-artifacts)):
`<role prompt base>-<unit>.md` for each worker (`implementation-prompt-alpha.md`,
`review-prompt-correctness.md`), `<role prompt base>-integration.md` for the
lead's pass, `<role prompt base>-judge.md` for a variants judge,
`<stage key>-decomposition-prompt.md` for a Fix decomposition and
`<role prompt base>-<unit>-coverage.md` for a primary reviewer's coverage
follow-up — numbered the same way on repeats. A reused unit or reused split is
not a run and saves no prompt. [prompts.test.ts](../../apps/orchestrator/test/prompts.test.ts)
reads them to prove the loop context: the fixer sees the review and the checks
to run, a second review sees the first, the verifier sees the reports, a Quick
Change implementer sees the failing test output, a second investigator sees
the first report.

## Not covered here

The Chairman's own prompts (recovery choice, chat, learning review) are built
in code and validated as JSON, not editable templates:
[chairman.md](chairman.md#reasoning) and [learning.md](learning.md#flow).

## Gotchas

- A template is Markdown that contains Markdown: the diff placeholders sit in
  ```` ```diff ```` fences, so a diff containing a fence line ends the block
  early. Harmless for the agent, worth knowing when reading a saved prompt.
- `previous_attempt` covers failed, cancelled, interrupted and paused runs of
  the same stage only; a successful run the workflow routed back to (Quick
  Change) is visible through the diff, test results and review blocks instead.
- The completion report shows the verifier's `NEEDS OPERATOR:` lines only; its
  "Remaining limitations" section stays in `verification.md`.
- The multi-repository plan will give each repository its own facts and diff
  block under the same placeholder names.

Last verified: 2026-09-27
