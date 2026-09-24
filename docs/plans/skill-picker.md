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

- [x] 1. design.md: slash picker pattern (§8.3) and New Task line (§7.2) — done when: both sections describe the behaviour — check: `git diff --stat design.md`
- [x] 2. Shared parser `requestedSkills(text, names)` in `@acc/shared` — done when: tests cover plugin names, punctuation, paths/URLs ignored, dedupe — check: `pnpm vitest run packages/shared`
- [x] 3. Skill discovery in `@acc/agent-sdk` (frontmatter reader, directory scan, `SkillDescriptor`, optional `listSkills`) — done when: unit tests pass for single-line, quoted, folded and missing descriptions — check: `pnpm vitest run packages/agent-sdk`
- [x] 4. `ClaudeCodeAdapter.listSkills` (project, user, plugins via `plugin list --json`, isolated mode) with a fake-claude `plugin list` — done when: tests pass against a temp config dir — check: `pnpm vitest run packages/agent-claude`
- [x] 5. Simulated agent lists repository skills (demo and e2e) — done when: a test lists a fixture skill — check: `pnpm vitest run packages/agent-sdk`
- [x] 6. Orchestrator `SkillCatalog` + `GET /api/skills?repositoryId=` + remote read op `skill.list` — done when: route test returns the fixture skill; unknown repository → 404 — check: `pnpm vitest run apps/orchestrator packages/shared`
- [x] 7. Prompt: "Requested skills" section from `/name` tokens — done when: an engine test's prompt names the requested skill and its description, and a path in the description is not treated as a skill — check: `pnpm vitest run apps/orchestrator`
- [x] 8. `SlashTextarea` in `packages/ui` + New Task wiring (helper text, detected skills line) + `useSkills` hook — done when: typecheck passes and the picker works in the demo — check: `pnpm typecheck`
- [x] 9. Demo repo gets a project skill; Playwright e2e for the picker (keyboard select, Escape, both themes) — done when: the spec passes — check: `pnpm build && pnpm e2e`
- [x] 10. Real check: catalog vs the CLI's own init list for this repository — done when: every catalog name is in the CLI's list — check: `pnpm verify:agents --only claude --claude-model haiku --skills`
- [x] 11. Docs: agents.md, dashboard.md, remote-node/op list, orchestrator API — done when: docs describe the endpoint, picker and prompt section — check: `git diff --stat docs/`
- [x] 12. Live: rebuild, restart, pick a skill on the real New Task page via Playwright — done when: `/` lists the operator's skills and inserts one — check: `manual: Playwright on 127.0.0.1:4317/tasks/new`

## Tail

- [x] T1. Adversarial review of the whole diff — done when: every finding is fixed or ledgered — check: `git diff --stat` reviewed hunk by hunk
- [x] T2. Similar-issue sweep — done when: other free-text fields that reach prompts (directives, Chairman chat) were considered for the same picker — check: `manual: list what was searched`
- [x] T3. Gates green — done when: `pnpm check` and `pnpm build && pnpm e2e` pass — check: the commands
- [x] T4. Docs synced — done when: design.md and system docs reflect the change — check: `git diff --stat design.md docs/`
- [ ] T5. Committed path-scoped and pushed — done when: the push succeeded with only this work — check: `git log origin/main..HEAD --oneline`
- [ ] T6. Confirmed live where the push deploys — done when: no deploy on push (deploy-cloud is workflow_dispatch); local orchestrator restarted in step 12 — check: `manual`
- [ ] T7. A claim registered — done when: registered or "no claims register" with the standing probe named — check: `manual`

## Ledger

- 2026-09-24 — created from the conversation and /discuss; the operator's /goal delegates every decision
- 2026-09-24 — step 9 — `pnpm --filter @acc/dashboard e2e -- -g …` ignored the filter and ran the full matrix: 87 passed (85 before + the 2 picker tests, dark and light, each with an axe check while the list is open)
- 2026-09-24 — step 4/10 — **source of the list changed.** The first build resolved skills from folders plus `claude plugin list --json`; the real comparison (step 10) failed: 741 listed vs 791 loaded, with phantom names (README/TEMPLATE link stubs, stitch-* plugins the CLI does not load) and missing ones (skills-dir plugins `dx:`/`idea:`/`pw:`…, synced plugins reported `enabled:false` under the sanitised environment, manifest-declared `skills` paths such as ui-ux-pro-max's `./.claude/skills/`). Replaced by the CLI's own answer: `claude -p` with stdin `/skills` is handled locally (0 turns, $0, no tokens; ~2.5 s) and its init event names every skill and plugin folder; hooks off via `--settings {"disableAllHooks":true}`, `--tools ""`, `--strict-mcp-config`, and `--setting-sources project,local` when user config is off. Descriptions are read from repository, user and plugin folders (manifest `skills` honoured); names the CLI reports without a readable file get source `builtin` or `plugin` with no description. Real result: 791/791 names match, 741 with a description, and the lookup's result event shows 0 turns / $0 — both are checks in `pnpm verify:agents --skills`
- 2026-09-24 — T1 — review fixes: (1) if a future CLI ever sends `/skills` to the model, `listSkills` sees a non-zero `num_turns`/cost in the result event and stops listing for the life of the process (`lookupWasFree`, test with `FAKE_CLAUDE_SKILLS_SPENDS`), and passes `--model haiku` to bound that one call; (2) a plugin manifest's `skills` path is confined to the plugin folder with a separator-aware check (`dx2` no longer passes as inside `dx`; test); (3) inserting a pick mid-token no longer eats a closing bracket (`(/fi|)`); (4) lint caught a literal byte-order mark in a regex and a needless escape — replaced by `charCodeAt(0) === 0xfeff` with a test. The first `pnpm check` after step 11 had failed on (4) although its background wrapper reported exit 0 — the log said exit=1; gates are re-run below
- 2026-09-24 — T2 — searched every `<Textarea` in the dashboard (Approvals, Repository detail, Settings, Source Control commit message, Chairman chat, Directive, Tools) for text that reaches a stage agent: only the **Directive** box does (it is appended to the next stage's instructions). Given the same picker through a shared `useSkillPicker` hook, and `requestedSkillsSection` now reads the description plus the directives the stage receives (test: a directive naming `/file-census` reaches the implementation prompt). Chairman chat goes to the supervisor, not to a stage; commit messages, approval notes and settings never reach an agent prompt — left as they are
- 2026-09-24 — T3 — final gates on the finished tree: `pnpm check` (typecheck, lint, docs guard, 620/620 tests) and `pnpm build && pnpm e2e` (87/87) in one run, exit 0
- 2026-09-24 — step 12 — live on the operator's orchestrator (clean build of the committed tree from the `acc-verify` worktree swapped into `apps/*/dist`, because the shared tree held another session's uncommitted vault-bridge work; DB backed up to `backups/acc-before-skill-picker-2026-09-24.db`, no migrations): on the real New Task page with this repository, typing `/fix` listed 43 real skills (`/fix`, `/fix-bug`, `/fix-issue`, `/dx:fix-bug`, … with descriptions and Yours/plugin labels); ArrowDown + Enter inserted `/fix-bug ` and the line read "Skills requested: /fix-bug"; screenshot `~/.claude/browser/playwright-mcp/skill-picker-live-open.png`. Nothing was submitted. The live task list holds only finished tasks (whose Directive box is closed), so the Directive picker is proven on the demo instead: new e2e "the Directive box on a task offers the same picker" (3/3 picker specs pass). Simple Browser: link fired, receipt still dated 2026-09-15 — not confirmed in the editor
- 2026-09-24 — step 12 — found live: `/pw:fix` had no description. The pw plugin's manifest says `"skills": "./"` but its skills sit in `skills/`, which the CLI also reads; the scan now reads `skills/` plus declared folders (test). Real comparison after: 791 = 791, 750 with a description (the rest are Claude Code built-ins with no file)
- 2026-09-24 — step 12 — after the fix, rebuilt from 6994ac9 in the clean worktree and restarted (pid 29168, dist hash equal to the worktree build); live `/pw:fi` now shows `/pw:fix` with its description
