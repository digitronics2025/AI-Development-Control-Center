---
system: learning
sources:
  - apps/orchestrator/src/learning/**
  - apps/orchestrator/src/http/learning-routes.ts
  - packages/shared/src/learning.ts
  - packages/tools/src/packs/installer.ts
  - apps/dashboard/src/pages/learning/**
  - apps/dashboard/src/api/learning.ts
verified_at: 25d74b5
---

# Learning loop

After a task completes, the Chairman looks back at what slowed it down and
improves how later tasks run — on its own, within fixed rules — then keeps
each change only if the problem stops recurring
([plan](../plans/learning-loop.md)). One `LearningService`
([service.ts](../../apps/orchestrator/src/learning/service.ts)) per
orchestrator; reviews run one at a time in the background and never hold up
the engine.

## Flow

1. **Trigger** (`reviewTrigger` in [learning.ts](../../packages/shared/src/learning.ts)):
   a `task` bus message for a task that **completed**, or is **stuck** —
   FAILED, or waiting with a `hard_blocker`, `limit`, `fix_limit`, `error`,
   `decision` or `usage` blocker — queues a review when it has none. A task
   reviewed while stuck is reviewed again when it completes (it counts once
   towards trials). Waiting for an approval, a sign-in or a restart, and
   cancelled tasks, are never reviewed. Startup re-queues rows left
   `pending`/`running` by a restart.
2. **Signals** ([signals.ts](../../apps/orchestrator/src/learning/signals.ts)),
   from recorded rows only:

   | Signal | Read from |
   |---|---|
   | `tool_missing` | `tool_executions.error_code = NOT_INSTALLED` (not origin `chairman`); key = provider |
   | `command_missing` | agent log lines matching "command not found" / "is not recognized" (bash, cmd, PowerShell) |
   | `tool_failures` | one capability failing ≥ 2 times (not NOT_INSTALLED / INVALID_INPUT / CANCELLED) |
   | `skill_denied` | log `permission denied: Skill <name>` |
   | `fix_loops` | `fix_cycles` or fixer stages ≥ 2 |
   | `recovery` | `chairman_strategy_runs` other than provider reroutes, per failure category |
   | `stage_timeout`, `provider_block` | stage `error_class` TIMEOUT; USAGE_LIMIT / MODEL_UNAVAILABLE / AUTH_FAILURE |
   | `completion_limits` | `final_status = NEEDS_USER_ACTION` |
   | `slow_stage` | an agent stage over 20 minutes |
   | `task_stuck` | a stuck task's blocker (kind and message) |

   No signal → review `skipped` ("clean run"), no model call.
3. **Review** ([reviewer.ts](../../apps/orchestrator/src/learning/reviewer.ts)):
   rule findings always (a missing catalog program → `INSTALL_TOOL`, observed,
   HIGH; a refused skill → a report); plus, when Settings → Learning *Use the
   Chairman agent* is on and the reasoner is available, `Reasoner.review`
   (same read-only runner as recovery, usage step `learning`). The prompt
   (`Role: chairman`, `Mode: learning`) carries the signals, the final report
   fenced as `<untrusted_evidence>`, the catalog, up to 25 skills ranked by
   shared words (installed + marketplace), live lessons and open findings (for
   `sameAs`); a stuck task has no final report, so its latest review,
   verification or implementation report is sent instead. Each finding must cite an offered signal id or it is dropped;
   at most 5 are kept; a bad proposal becomes `null` without dropping the
   finding; `app_defect` never carries a proposal; `INSTALL_TOOL` is global.
4. **Aggregate**: `fingerprintOf` — a program by tool id, a skill by scope +
   name, otherwise kind + scope + first eight title words. `observe` counts a
   task once per finding (`learning_observations` PK).
5. **Desk** ([policy.ts](../../apps/orchestrator/src/learning/policy.ts)):
   acts when learning is on, autonomy is `act`, the finding was seen in 2
   tasks **or** is observed + HIGH, fewer than `maxActionsPerDay` improvements
   since local midnight, under the caps (12 lessons, 10 skills per scope) and
   the fingerprint was never undone. Waiting reasons keep the finding `open`;
   the rest set `needs_you`. After each review, other open findings with a
   proposal are reconsidered (up to 20).
6. **Act** (`act`):

   | Proposal | Result |
   |---|---|
   | `ADD_LESSON` | safety scan → improvement `lesson` |
   | `USE_SKILL` | installed → `skill_recommendation` ("Use the /x skill when …"); in a trusted marketplace → folder copied → `skill_adopted`; else `needs_you` |
   | `AUTHOR_SKILL` | safety scan of name, description, body → SKILL.md written → `skill_authored` |
   | `INSTALL_TOOL` | `ToolService.invoke('software.install', origin chairman)` → PATH refreshed from the registry, provider re-detected → `tool_installed`; approval → `needs_you`; failure → `failed` |

7. **Trial**: each later task in scope created after the improvement counts
   once (a re-review does not count again); a recurrence is the review seeing
   the improvement's finding. `trialVerdict`: recurrences × 2 ≥ target → undo
   (`ineffective`, by `chairman`, finding `failed`); seen ≥ target → `active`.

## Safety ([safety.ts](../../apps/orchestrator/src/learning/safety.ts))

Rejects text with a web address, instruction-override or role claims,
anything that weakens tests/checks/review/hooks (including `--no-verify`),
secret-shaped values or anything `redact` changes, history rewrites, safety
bypasses, and command lines (backticks, fences, `$`/`PS>` prompts) the command
classifier rates Level ≥ 4, dangerous or production, or download-and-run.
Fails closed; false positives only mean a lesson is not adopted.

## Skills ([skills.ts](../../apps/orchestrator/src/learning/skills.ts))

Two Claude Code plugins in `<dataDir>/learning/plugins/`: `global/` (plugin
`acc-learned`) and `repo-<id>/` (plugin `acc-repo`). Written SKILL.md
frontmatter is ours (name, description only — never `allowed-tools`).
Marketplace skills come from `known_marketplaces.json` under
`CLAUDE_CONFIG_DIR` (or `~/.claude`), plugins with a local `./path` source
inside the marketplace copy, minus `blocklist.json`; only the skill folder is
copied (no links, ≤ 200 files, ≤ 2 MB), with a content hash. Nothing is
downloaded.

Runs: `ContextBuilder.pluginDirs` → `AgentExecutionInput.pluginDirs` → Claude
Code `--plugin-dir` per non-empty folder (measured on 2.1.280: loaded under
`--setting-sources project,local`, zero turns). `ContextBuilder.lessons` adds
"## Lessons from earlier tasks" after the Chairman guidance (≤ 10 lines):
lessons, then skills — "loaded for this run" for `claude`, the SKILL.md path
for other agents. The skills still run inside the stage's closed tool set
([agents.md](agents.md#skills)).

## Programs ([installer.ts](../../packages/tools/src/packs/installer.ts))

Provider `installer` (built-in): `software.catalog` (Level 1) and
`software.install {toolId}` (Level 3, `elevated`, persistence + network — the
classifier's class for `npm -g`). `toolId` is an enum of
`INSTALLABLE_TOOLS` ([learning.ts](../../packages/shared/src/learning.ts)):
gh, jq, yq, ripgrep, uv, adb (winget, `--exact --scope user --silent`) and
wrangler (`npm install -g`). Under the default Autopilot policy it runs on
its own; under Safe it needs approval, which the page's **Do it now** gives
(`preApproved`). Not in any agent profile except `operator`; an agent in a
Level 3 stage can still reach it by escalation. `refreshedPath` merges the
user and machine PATH from the registry into the orchestrator's environment.

## Tables (migration 11)

`learning_reviews` (PK task, cascade), `learning_findings` (unique
fingerprint), `learning_observations` (finding × task), `learning_improvements`
(trial counts, `reverted_by`), `learning_log`. Summaries only — no prompts,
logs or file contents.

## API

`GET /api/learning` (settings, counts, improvements, findings, 50 reviews with
task titles, 100 log entries, `reviewerUnavailable`) ·
`GET /api/learning/tasks/:id` · `POST /api/learning/tasks/:id/review` (202;
409 unless completed or stuck) · `POST /api/learning/improvements/:id/revert` (409 if not
live) · `POST /api/learning/findings/:id/dismiss` (409 if adopted) ·
`POST /api/learning/findings/:id/act` (409 without a proposal, when adopted, or
`NOT_ADOPTED` with the reason). WebSocket `learning {change, taskId}` →
the dashboard refetches the `learning` keys. Neither is relayed to the cloud;
the page and the Settings section are local only.

## Settings

`learning`: `enabled` (true), `autonomy` `act|propose` (act),
`reviewWithModel` (true), `maxActionsPerDay` (3), `trialTasks` (3).

## Gotchas

- Tests: `[sim:learning-none|skill|unsafe|uncited]` steer the simulated
  Chairman's learning answer; by default it proposes one lesson about the
  first signal.
- The simulated reviewer maps every signal to the same finding, so an
  unrelated signal in a later test task counts as a recurrence — commit
  leftovers between test tasks.
- Undoing an installed program does not uninstall it.
- Only `agentId === 'claude'` is told its learned skills are loaded; any
  other agent gets file paths.

Last verified: 2026-09-24
