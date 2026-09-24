---
system: prompts
sources:
  - prompts/**
  - packages/shared/src/prompts.ts
  - apps/orchestrator/src/engine/context.ts
  - apps/orchestrator/src/services/prompts.ts
  - apps/orchestrator/src/engine/report.ts
  - apps/orchestrator/src/chairman/signatures.ts
  - apps/dashboard/src/pages/SettingsPage.tsx
verified_at: 8ce8b50
---

# Role prompts

What each agent stage is told, and what the orchestrator reads back from its
reply. The six built-in templates live in [prompts/](../../prompts) (plan:
[ROLE_PROMPTS_PLAN.md](../plans/ROLE_PROMPTS_PLAN.md)); the contract between
them and the code is the placeholder catalog and the marker lines below.

## What a stage receives

[context.ts](../../apps/orchestrator/src/engine/context.ts) `ContextBuilder.build`
assembles, in this order:

1. A header: task id, role, stage key, working directory.
2. `RUN_CONTEXT`, prepended to every template including user-edited ones: the
   agent is a subagent whose reply is a task record (no chat recap or to-do
   block); only its final message is kept; the four marker lines below are
   read by the orchestrator; commits, tests and approvals happen after it.
3. The role template with its placeholders filled.
4. `## Chairman guidance` when a recovery strategy set one ([chairman.md](chairman.md)).
5. `## Lessons from earlier tasks` from the learning loop ([learning.md](learning.md)).
6. The engine's sections ([tooling.ts](../../apps/orchestrator/src/engine/tooling.ts)):
   `## Skills` (how skills and outside tools behave in a run), `## Requested skills`
   when the task or a directive names `/skills`, `## Environment` for the
   investigator, planner and implementer, and `## Control Center tools` when
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
| `repository_name`, `repository_path`, `repository_facts`, `git_status` | the repository record, the task's working directory (its worktree when isolated), `git status` at stage start |
| `attachments` | text attachments inline (≤ 50 KB each, redacted), others by path |
| `directives` | active, non-routing directives for this stage, marked `(constraint)` or `(completion requirement)` |
| `investigation`, `plan`, `implementation_report`, `review`, `verification_report` | artifacts: every investigation, the latest plan, every implementation and fix report (20 KB each), the latest review, the latest `browser-verification.md` |
| `test_results` | the last test stage: each command's status and summary, the failing command's last 80 log lines, a commit the repository's hook rejected |
| `diff`, `changed_files` | against the task baseline for every agent role (150 KB, redacted); a Staged Review task gets the staged diff instead |
| `verification_commands` | enabled lint, typecheck, test and build commands |
| `preexisting_changes` | files with uncommitted user work at task start, or `none` |
| `previous_attempt` | the last FAILED, CANCELLED, INTERRUPTED or PAUSED run of this stage with its last 40 log lines |
| `fix_cycle`, `max_fix_cycles` | `tasks.fix_cycles` (already incremented during a fix stage) and the limit |

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
| first prose line under `## Summary` (else Goal/Findings, else the first prose line) | `summarize` in [runners.ts](../../apps/orchestrator/src/engine/runners.ts) | the stage line in timelines; implementer and fixer lines fill the report's "Changed" |
| `VERDICT: PASS` / `VERDICT: FAIL`, last one wins | `parseVerdict` | routes a `verdict` stage to `next` or `onFail`; missing → the stage fails as `UNKNOWN` |
| `BLOCKED ON OPERATOR: <decision, options, recommendation>` from a work stage (investigator, planner, implementer, fixer) | `extractOperatorBlockers` in [report.ts](../../apps/orchestrator/src/engine/report.ts) | task `WAITING_FOR_USER`, blocker `decision`; a directive answers and re-runs the stage; cut at 600 characters |
| `NEEDS OPERATOR: <item>` from a reviewer or verifier | `extractOperatorItems` | "Needs your decision" in the completion report and `NEEDS_USER_ACTION`; the verifier's list replaces the review's, so the verifier repeats items still open |
| `CAUSE: code` / `CAUSE: plan` with a FAIL | `causeMarker` in [signatures.ts](../../apps/orchestrator/src/chairman/signatures.ts) | `plan` classifies the failure `REQUIREMENT_OR_PLAN` (the Chairman re-plans first); `code` keeps it `CODE_OR_TEST` even when the text names "success criteria"; without the line the word list decides |

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
| Planner | attachments, investigation, verification commands, and on a re-plan the previous plan with what came of it | Summary the operator can approve on, Goal, Scope, Success Criteria (each with its proof), Assumptions and Decisions, Implementation Plan, Verification, Security and Data Check, Irreversible steps and approvals, Completion Report, Found for Later, Next Recommended Task, Skills used |
| Implementer | attachments, plan, investigation, verification commands, and the work so far (diff, test results, review, fix cycles) when a check or review sent the task back | Summary, Changes (with deviations from the plan), Verification performed (each check: ran and passed, failed, or not run), Known limitations, Found for Later, Skills used |
| Reviewer | reports as claims, the previous review, diff, test results, app check | Summary, Previous findings, Issues graded blocking or advisory, Advisory, Skills used, `NEEDS OPERATOR:` lines, `CAUSE:` with a FAIL, `VERDICT:`. Only blocking issues fail |
| Fixer | plan, reports, review, failing checks (incl. a rejected commit hook), app check, diff, verification commands, fix cycle N of M | Summary, Root causes, Fixes, Disputed findings, Verification performed, Remaining concerns, Skills used. Never weakens a check to pass it |
| Verifier | plan, reports as claims, review, diff, test results, app check | Summary, Criteria (met / not met / unverified with named evidence), Review follow-up, Remaining limitations, Skills used, `NEEDS OPERATOR:` (repeating the review's open ones; one for a central criterion nothing can verify), `CAUSE:`, `VERDICT:` |

Level 1 roles (investigator, planner, reviewer, verifier) are told what they
can run: the read tools, read-only Git, and Level 1 Control Center checks
against something already running ([agents.md](agents.md), the `analysis`
profile in [autopilot.md](autopilot.md)). Level 2 roles must run the
verification commands themselves before reporting.

## Prompt artifacts

The rendered prompt of every agent stage is saved as a `stage-output`
artifact before the agent starts (`investigation-prompt.md`,
`plan-prompt.md`, `implementation-prompt.md`, `fix-prompt.md`,
`review-prompt.md`, `verification-prompt.md`; other roles `<stage key>-prompt.md`;
repeats get `-2`, `-3`). [prompts.test.ts](../../apps/orchestrator/test/prompts.test.ts)
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

Last verified: 2026-09-24
