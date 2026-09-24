---
status: done
owner: Chairman
started: 2026-09-24
---

# Learning loop — the Chairman improves the Control Center after every task

## Goal

After each finished task, look back at how it went, write down what would have
made it easier (a missing program, a missing skill, a weaker way of working),
and let a system-wide Chairman **act on its own** when the evidence is good
enough: adopt a lesson for future prompts, attach a skill, write a skill,
install a reviewed program. Every change is recorded, tried on the next tasks,
kept only if the problem stops recurring, and undoable in one click.

Decided with the operator on 2026-09-24: the Chairman acts on its own rather
than asking first.

## What the loop does

```text
task COMPLETED, or stuck (hard blocker, limit, fix limit, error, out of credits)
   │
   ▼
1. Signals (rules, OBSERVED)  ── nothing notable ──► review "skipped" (clean run, no model call)
   │ some friction
   ▼
2. Review (Chairman agent, read-only; rules only when no model)
   │ findings, each citing ≥1 signal
   ▼
3. Findings aggregate by fingerprint across tasks (occurrences, distinct tasks)
   │
   ▼
4. Desk policy (deterministic): evidence threshold, daily budget, caps,
   safety scan, never retry a reverted fingerprint
   │ act                                  │ cannot act
   ▼                                      ▼
5. Improvement in TRIAL                  finding "needs you" (with the reason)
   │ next N tasks in scope reviewed
   ▼
6. Recurred in ≥ half → reverted automatically ("ineffective"); else ACTIVE
```

### 1. Signals ([signals.ts](../../apps/orchestrator/src/learning/signals.ts))

Read from what the orchestrator already recorded — never from the model:

| Signal | Source | Key |
|---|---|---|
| `tool_missing` | tool calls refused `NOT_INSTALLED` | provider id |
| `command_missing` | agent log lines "command not found" / "is not recognized" | command name |
| `tool_failures` | the same capability failing ≥ 2 times | capability |
| `skill_denied` | log `permission denied: Skill <name>` | skill name |
| `fix_loops` | fix cycles ≥ 2 | failing source |
| `recovery` | Chairman strategy runs, with their outcomes | failure category |
| `stage_timeout` | stages failed with `TIMEOUT` | stage key |
| `provider_block` | stages blocked on usage/auth/model | agent |
| `completion_limits` | the task completed with unmet checks | — |
| `slow_stage` | a stage ran longer than 20 minutes | stage key |

No signal → the review is recorded as *skipped* and costs nothing. This is
the answer to "a reviewer always finds something": it only looks when the
record shows friction.

### 2. Review ([reviewer.ts](../../apps/orchestrator/src/learning/reviewer.ts))

The Chairman's reasoning agent (Settings → Chairman), level 1, in the task's
artifact folder, 4-minute timeout, one repair attempt — the same runner and the
same `<untrusted_evidence>` fence as recovery. It receives the signals, the
final report (AGENT_REPORTED), open findings for the repository (so it can say
`sameAs` instead of inventing a near-duplicate), and up to 25 candidate skills
matched by keyword. It returns at most 5 findings; each must cite at least one
offered signal id or it is dropped. Proposals are a closed union:

| Proposal | Effect when adopted |
|---|---|
| `ADD_LESSON {text}` | a line in "Lessons from earlier tasks" in every later prompt in scope |
| `USE_SKILL {skill, when}` | installed skill → a lesson naming it; a skill found in a trusted marketplace on disk → copied into the managed plugin |
| `AUTHOR_SKILL {name, description, body}` | a new SKILL.md in the managed plugin |
| `INSTALL_TOOL {toolId}` | `software.install` through `ToolService.invoke` (reviewed catalog only) |
| none | a report for the operator (a defect in the Control Center itself) |

Without a model the rules still turn `tool_missing` / `command_missing` for a
catalog tool into an `INSTALL_TOOL` finding and `skill_denied` into a report.

### 3–4. The desk ([policy.ts](../../apps/orchestrator/src/learning/policy.ts), [safety.ts](../../apps/orchestrator/src/learning/safety.ts))

Acts when **all** hold:

- Settings → Chairman → Learning: on, and *Act on its own* (the default);
- fewer than `maxActionsPerDay` (default 3) improvements today;
- evidence: the finding was seen in **2 distinct tasks**, or it rests on an
  OBSERVED definitive signal (`tool_missing`, `command_missing`) — a missing
  program is a fact, not an opinion;
- caps: 12 lessons per repository (plus 12 global), 10 managed skills per scope;
- the fingerprint was never reverted before (the desk does not retry what failed);
- the text passes the safety scan: no URLs, no download-and-run, no
  destructive commands, no instruction-override phrasing, no secrets, nothing
  that skips tests, review or hooks.

### Where things live

- **Lessons**: rows only; `ContextBuilder` adds a section after the Chairman
  guidance, capped at 10 lines, framed as advice that the request, directives
  and permission limits outrank.
- **Skills**: `<dataDir>/learning/plugins/global` (plugin `acc-learned`) and
  `<dataDir>/learning/plugins/repo-<id>` (plugin `acc-repo`). Claude Code runs
  get `--plugin-dir` for each non-empty one (measured on 2.1.280: loaded under
  `--setting-sources project,local`, zero turns). Codex gets the SKILL.md paths
  in the prompt. The operator's own Claude configuration is never touched, and
  the skills still run inside the stage's closed tool set.
- **Adopted marketplace skills** come only from marketplaces the operator
  already added to Claude Code, from plugins whose files are already on disk
  (no download), skipping the CLI's blocklist; only the skill folder is
  copied (no hooks, no MCP servers), with a size cap and a content hash.
- **Programs**: a reviewed catalog in [installer.ts](../../packages/tools/src/packs/installer.ts)
  (exact winget ids, user scope; npm for Node CLIs). Level 3 — "installs
  software for the user account", the same class the command classifier
  gives `npm -g` — so it runs on its own under the default Autopilot policy
  and asks under Safe. After an install the orchestrator reloads PATH from the
  registry and re-detects the provider; only a detected program counts.

### 5–6. Trial and undo

An improvement starts in **trial** for `trialTasks` (default 3) later tasks in
its scope that started after it. Each of their reviews either re-observes the
finding (a recurrence) or not. At the end: recurrences ≥ half → reverted
automatically as *ineffective*; otherwise *active*. The operator can undo any
improvement at any time; an undone skill folder is deleted, a lesson stops
being sent. An installed program is not uninstalled automatically — the page
says so.

## Data (migration 11)

`learning_reviews` (one per task), `learning_findings` (unique fingerprint),
`learning_observations` (finding × task), `learning_improvements`,
`learning_log`. Structured summaries only — no prompts, logs or file contents.

## Surfaces

- API: `GET /api/learning`, `GET /api/learning/tasks/:id`,
  `POST /api/learning/tasks/:id/review`, `POST /api/learning/improvements/:id/revert`,
  `POST /api/learning/findings/:id/dismiss`, `POST /api/learning/findings/:id/act`.
- WebSocket `learning` (local only; never relayed to the cloud).
- Dashboard: **Learning** page (Improvements · Findings · Reviews · Activity),
  a Learning block in Settings → Chairman.

## Irreversible steps

- Installing a program from the catalog changes the operator's user account;
  undo does not uninstall it.
- Pushing to `main` publishes the change to GitHub.

## Assumptions

- Claude Code keeps loading `--plugin-dir` skills in print mode (checked on 2.1.280).
- winget exists on the operator's PC; without it `software.install` routes to
  nothing and the finding waits for the operator.

## Out of scope (next)

- Downloading skills or plugins from the internet.
- The Chairman changing the Control Center's own code (defects are reported).
- Cross-task routing of agents/models from outcomes (separate plan).
