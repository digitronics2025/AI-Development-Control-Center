---
title: Typing "/" in a task description lists the agent's skills, and picked skills reach the right stage
source: conversation 2026-09-24 — operator: "i want when i write / … show available skills same behavior as claude chat"; /goal full autopilot
created: 2026-09-24
status: in-progress
---

# Skill picker in the New Task description

## Context

Operator request (2026-09-24, with screenshots of the New Task page and Claude
Code's chat `/` menu): "i want when i write / i want it to show available
skills same behavior as claude chat". The discussion that followed
(`/discuss`) found:

- The description is placed mid-prompt (`{{request}}` in
  [prompts.ts](../../apps/orchestrator/src/services/prompts.ts)); Claude only
  expands `/name` at the start of a message, so a typed `/fix-bug` is plain
  text to the agent. The app must turn a pick into an explicit instruction.
- Nothing lists skills: the only exact list is the `skills` array in Claude
  Code's init event (792 on 2026-09-24); the app keeps none of it.
- The description reaches every stage; a skill named once may run in several
  (implement and review both ran `file-census` in the agent-skills test).
- Open question answered by the operator's /goal ("decide yourself"):
  **a picked skill means "use this skill in the stage whose job it matches",
  with the implementation stage as the default owner** — not "the skill is the
  whole job".

### Decisions

- **Source of the list (Claude Code):** resolved the way the CLI resolves it —
  repository `.claude/skills/*/SKILL.md`, the user's `~/.claude/skills`
  (`CLAUDE_CONFIG_DIR` honoured), and plugin skills from
  `claude plugin list --json` (enabled; scope `user`/`synced`, or
  `project`/`local` whose `projectPath` is this repository) as
  `<plugin>:<skill>`. Measured: `plugin list --json` answers in ~0.6 s with no
  model call; 171 user + 605 plugin skills vs 792 reported by the CLI. With
  "Load my CLI customisations" off, only repository skills and
  repository-scoped plugins are listed (matches `--setting-sources project,local`).
- **Contract:** optional `listSkills()` on `AgentAdapter`; the catalog is the
  union over enabled agents, cached 60 s per repository. Codex returns none
  for now (skills unverified at runtime).
- **Picked skills are text, not new task state:** the picker inserts `/name`;
  a shared parser (`requestedSkills`) finds `/name` tokens that are real skill
  names — so URLs and paths (`/api/tasks`) are ignored — and the prompt gains a
  "Requested skills" section. No migration; the description stays the record.
- **Remote:** a read op `skill.list` so the cloud dashboard gets the same list.
- **UI:** a shared `SlashTextarea` in `packages/ui` (ARIA listbox,
  arrows/Enter/Tab/Escape, Ctrl+Enter untouched), design.md updated first
  (contract rule 12).

## Steps

- [ ] 1. design.md: slash picker pattern (§8.3) and New Task line (§7.2) — done when: both sections describe the behaviour — check: `git diff --stat design.md`
- [ ] 2. Shared parser `requestedSkills(text, names)` in `@acc/shared` — done when: tests cover plugin names, punctuation, paths/URLs ignored, dedupe — check: `pnpm vitest run packages/shared`
- [ ] 3. Skill discovery in `@acc/agent-sdk` (frontmatter reader, directory scan, `SkillDescriptor`, optional `listSkills`) — done when: unit tests pass for single-line, quoted, folded and missing descriptions — check: `pnpm vitest run packages/agent-sdk`
- [ ] 4. `ClaudeCodeAdapter.listSkills` (project, user, plugins via `plugin list --json`, isolated mode) with a fake-claude `plugin list` — done when: tests pass against a temp config dir — check: `pnpm vitest run packages/agent-claude`
- [ ] 5. Simulated agent lists repository skills (demo and e2e) — done when: a test lists a fixture skill — check: `pnpm vitest run packages/agent-sdk`
- [ ] 6. Orchestrator `SkillCatalog` + `GET /api/skills?repositoryId=` + remote read op `skill.list` — done when: route test returns the fixture skill; unknown repository → 404 — check: `pnpm vitest run apps/orchestrator packages/shared`
- [ ] 7. Prompt: "Requested skills" section from `/name` tokens — done when: an engine test's prompt names the requested skill and its description, and a path in the description is not treated as a skill — check: `pnpm vitest run apps/orchestrator`
- [ ] 8. `SlashTextarea` in `packages/ui` + New Task wiring (helper text, detected skills line) + `useSkills` hook — done when: typecheck passes and the picker works in the demo — check: `pnpm typecheck`
- [ ] 9. Demo repo gets a project skill; Playwright e2e for the picker (keyboard select, Escape, both themes) — done when: the spec passes — check: `pnpm build && pnpm e2e`
- [ ] 10. Real check: catalog vs the CLI's own init list for this repository — done when: every catalog name is in the CLI's list — check: `pnpm verify:agents --only claude --claude-model haiku --skills`
- [ ] 11. Docs: agents.md, dashboard.md, remote-node/op list, orchestrator API — done when: docs describe the endpoint, picker and prompt section — check: `git diff --stat docs/`
- [ ] 12. Live: rebuild, restart, pick a skill on the real New Task page via Playwright — done when: `/` lists the operator's skills and inserts one — check: `manual: Playwright on 127.0.0.1:4317/tasks/new`

## Tail

- [ ] T1. Adversarial review of the whole diff — done when: every finding is fixed or ledgered — check: `git diff --stat` reviewed hunk by hunk
- [ ] T2. Similar-issue sweep — done when: other free-text fields that reach prompts (directives, Chairman chat) were considered for the same picker — check: `manual: list what was searched`
- [ ] T3. Gates green — done when: `pnpm check` and `pnpm build && pnpm e2e` pass — check: the commands
- [ ] T4. Docs synced — done when: design.md and system docs reflect the change — check: `git diff --stat design.md docs/`
- [ ] T5. Committed path-scoped and pushed — done when: the push succeeded with only this work — check: `git log origin/main..HEAD --oneline`
- [ ] T6. Confirmed live where the push deploys — done when: no deploy on push (deploy-cloud is workflow_dispatch); local orchestrator restarted in step 12 — check: `manual`
- [ ] T7. A claim registered — done when: registered or "no claims register" with the standing probe named — check: `manual`

## Ledger

- 2026-09-24 — created from the conversation and /discuss; the operator's /goal delegates every decision
