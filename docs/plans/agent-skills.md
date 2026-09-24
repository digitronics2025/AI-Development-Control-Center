---
title: Stage agents can use the operator's skills without ever exceeding their stage level
source: conversation 2026-09-24 — AGENT_SKILLS_PLAN.md
created: 2026-09-24
status: done
---

# Stage agents can use the operator's skills without ever exceeding their stage level

## Context

Copied verbatim from [AGENT_SKILLS_PLAN.md](../../AGENT_SKILLS_PLAN.md) (headings demoted one level).

Status: proposed · 2026-09-24 · Claude Code 2.1.280, Codex 0.156.1 on the operator's PC

### What was measured (the ground this plan stands on)

Every row below is a real `claude -p` run using the flags that
`ClaudeCodeAdapter.buildArgs` produces
([packages/agent-claude/src/index.ts](../../packages/agent-claude/src/index.ts)), run in a
scratch folder containing probe skills.

| Case | Today |
|---|---|
| A plain skill (no `allowed-tools` in its frontmatter), Level 1 and Level 2 | **Runs** |
| A skill that declares `allowed-tools`, at any level | **Refused**: "requires approval, and this session has no approval surface" |
| The operator's own MCP tools (for example Claude Docs), Level 2 | Loaded (about 60 servers are started) but **refused** |
| `Skill` added to `--allowedTools`; a skill grants `Bash, Write` at Level 1 | Still refused (dontAsk) ✔ |
| `Skill` allowed; a skill grants `Bash` while the stage denies `Bash(node:*)`, Level 2 | Refused, because a deny rule wins ✔ |
| `Skill` allowed; a skill grants `WebFetch` and a personal MCP tool, Level 2 | **Allowed**, which gets around `ToolService.invoke` ✘ |
| `Skill` allowed + `--tools <fixed set>` + `--strict-mcp-config`, user settings on | 794 skills load and run; `WebFetch` and personal MCP tools **do not exist**; about 65k tokens of starting context instead of the documented ~150k |

About 19 skills in `~/.claude/skills` declare `allowed-tools`, and dozens more
come from plugins. They include most of the workflow skills a stage would want:
`fix-bug`, `verify-tests`, `security-audit`, `prove-it`, `add-migration`,
`plan`, `investigate`, `ship-it`, `prerelease-audit`, `pre-deploy-check`,
`review-pr`.

**Root cause.** `claudeToolPolicy` allowlists tool names on top of Claude
Code's *open* tool set. `Skill` is not on that list, so Claude Code asks
before running any skill that grants tools. `--permission-prompts none` then
turns that request into a refusal. Just adding `Skill` would not be safe: in
`acceptEdits` mode, a skill's `allowed-tools` can switch on a tool the stage
never listed. That includes the operator's own MCP servers, which skip the
Control Center's policy, checkpoints and audit trail. The fix has to *close*
the tool set, not just widen the allowlist.

### 1. Goal

Agents launched by the Control Center can run the operator's installed skills,
including skills that declare `allowed-tools`. No skill can ever give an agent
a tool or command beyond what its stage level already permits. The operator
can see which skill ran in the stage log.

### 2. Scope

In:

- The Claude Code adapter: a closed built-in tool set per level, `Skill`
  allowed, and personal MCP servers never loaded into agent runs (the `acc`
  bridge stays).
- Showing skill use in stage logs: the skill's name on the `[tool]` line, the
  skill count on the init line, and the skill named on refusal lines.
- One short prompt section telling agents how skills and outside tools work in
  a Control Center run.
- The Agents page wording for the "Load my CLI customisations" switch.
- A repeatable real-CLI probe (`pnpm verify:agents --skills`).
- Docs: `docs/systems/agents.md` and `docs/systems/mcp.md`.

Out:

- Codex behaviour changes. Codex already loads `~/.codex/skills` and
  `~/.agents/skills`, and `--ignore-user-config` skips only `config.toml`.
  Its sandbox, not a tool allowlist, is what limits it.
- New tools for stages (`WebFetch`, `WebSearch`, `Agent`, `PowerShell`). They
  are refused today and stay unavailable.
- Database, API or migration changes.
- Hooks, which are unchanged: they load when the switch is on, as today.

### 3. Enhanced design / architecture

```text
stage level ──► claudeToolPolicy(level)
                 ├─ tools   : the built-in tools that EXIST in this run  → --tools
                 ├─ allowed : what runs without asking (now incl. Skill) → --allowedTools
                 └─ denied  : always-denied commands (unchanged)         → --disallowedTools
buildArgs ──► always --strict-mcp-config  (only --mcp-config = the acc bridge)
             loadUserConfig=false ─► also --setting-sources project,local
```

- **The tool set is the security boundary.** A skill's `allowed-tools` can
  only pre-approve tools that are in `--tools`, and deny rules still win. This
  gives two layers: a tool outside the set does not exist, and a command
  inside it is still subject to allow and deny rules.
  - Level 1: `Read, Grep, Glob, Bash, Skill, ToolSearch, TodoWrite`. Bash
    stays limited to the read-only patterns, and `dontAsk` refuses everything
    else.
  - Level 2 and above: the Level 1 set plus `Edit, Write, NotebookEdit`.
  - `allowed` gains `Skill` at every level. `denied` is unchanged.
    `ToolSearch` is included because Claude Code defers MCP tools, and the
    `acc` bridge's tools are reached through it.
- **Personal MCP servers never join a stage run.** Their tools were already
  refused. Loading them only cost startup time, context tokens and outside
  connections. The supported path for an outside server is the Control
  Center's MCP gateway (Settings → MCP). Agents reach it with
  `acc_call_capability`, which runs it through the Control Center's policy.
- **Visibility reuses the existing log path.** `summarizeToolInput` also reads
  `input.skill`, so the log shows `[tool] Skill fix-bug`. The init line adds
  `· N skills` from `event.skills`. Refusals already use the same summariser.
  Skill `args` are never logged, only the name.
- **Prompt.** `ToolingService.promptSections` appends a short section for
  every agent: "Your installed skills are available; use one when it fits.
  This stage's limits still apply: a refused skill or tool is an operator
  decision, so report it rather than working around it. Personal MCP servers
  are not connected here. For a browser, Cloudflare or Android, use the
  Control Center tools (`browser.*`, `cloudflare.*`, `android.*`)." That last
  sentence covers skills such as `browser-autopilot`, whose instructions
  expect a Playwright MCP.
- Every Claude launch goes through `buildArgs`: stages, the Chairman, and
  source-control assist. The change therefore reaches all of them with no
  per-caller edits.

### 4. Implementation steps

1. `claudeToolPolicy` returns `{ mode, tools, allowed, denied }` with the sets
   above. `Skill` is added to `allowed` at every level.
2. `buildArgs` pushes `--tools tools.join(',')` and always
   `--strict-mcp-config`. It keeps `--setting-sources project,local` only when
   `loadUserConfig === false`.
3. The parser:
   - `summarizeToolInput` handles `skill`.
   - The init `system` line appends the skill count when `event.skills` is an
     array.
4. `tests/fixtures/fake-claude.mjs` gets a `skill` scenario. Its init event
   carries `skills: [...]` and it emits a `tool_use` `Skill {skill:"docs-systems"}`.
5. Unit tests in `packages/agent-claude/test/claude.test.ts` (see §7).
6. `promptSections` gains the short skills section, with a matching test next
   to the existing tooling prompt tests.
7. Agents page copy ([AgentsPage.tsx:69](../../apps/dashboard/src/pages/AgentsPage.tsx#L69)):
   "Your own hooks, skills and plugins. Personal MCP servers are not loaded
   into runs; add one under Settings → MCP to use it through the Control
   Center. Turn off for faster, isolated runs." Update the code comments in
   `schemas.ts` and `contract.ts` to match.
8. The `scripts/verify-agents.ts` flag `--skills` (Claude only), in a new temp
   folder with three probe skills. It reuses the real adapter, so it always
   tests the flags that ship. The probes:
   - `acc-probe-plain` replies with a token. It must run at Level 1.
   - `acc-probe-tools` (`allowed-tools: Read`) replies with a token. It must
     run at Level 2. This is the case that is broken today.
   - `acc-probe-grant` (`allowed-tools: WebFetch, Bash, Write`) tries
     `WebFetch`, then writes a marker file with Bash and with Write. At
     Level 1 the marker file must not exist and `WebFetch` must be
     unavailable. At Level 2 `WebFetch` must be unavailable.

   It exits non-zero on any mismatch and removes the temp folder in `finally`.
9. If the CLI rejects `--tools` or `--strict-mcp-config` ("unknown option"),
   `classify.ts` maps the message to the existing class whose hint says to
   update the CLI (`MODEL_UNAVAILABLE`), so the operator is told to update
   Claude Code rather than seeing a crash.
10. Docs:
    - `docs/systems/agents.md`: the run line, the permission table with tool
      sets, a "Skills" subsection with the measured table, the new token
      figure, and `Last verified`.
    - `docs/systems/mcp.md`: personal servers are not loaded into agent runs;
      use the gateway.
11. Checks, then a real run (§7). Commit only the explicit paths (other
    sessions share this working tree) and push to `main`.

### 5. Failure handling and recovery

- **A skill is refused mid-run.** The stage log names it. The agent is told to
  report it as an operator decision, and the stage continues or fails exactly
  as it does today. Nothing is widened automatically.
- **A skill needs a personal MCP server.** The prompt points it to the
  matching Control Center capability. If there is none, the agent reports the
  work as unverified, which is the behaviour `browser-autopilot` already
  specifies.
- **An outdated CLI rejects the new flags.** The run fails fast with an
  update-the-CLI message (step 9). It never falls back to the old, open tool
  set.
- **A future Claude Code changes the permission semantics.**
  `pnpm verify:agents --skills` is the tripwire. It must pass after every CLI
  update, and it is listed in agents.md.
- **Rollback.** One adapter commit, with no data, schema or API change.
  Reverting it restores the previous flags exactly.

### 6. Security and data protection

- The stage level stays the only authority. Each layer is proven by a unit
  test (the flags) and by the real probe (the CLI's behaviour). This meets the
  AGENTS.md rule that the tool policy never changes without a test proving the
  new behaviour.
- The change closes a latent bypass. Personal MCP tools and unlisted
  built-ins could be pre-approved by a skill's frontmatter once `Skill` was
  allowed. With `--tools` and `--strict-mcp-config` they are absent.
- Fewer outside connections per run. Connector servers such as Gmail, Drive
  or Google Ads no longer start inside agent processes, so their credentials
  are never exercised by an agent.
- Unchanged: the subscription-only guard, `ALWAYS_DENIED`, the Level 2 and 3
  git and deploy denies, the `acc` session token handling, and redaction.
  Every log line still passes through `LogSink`'s redactor, and skill `args`
  are not logged.

### 7. Testing and verification

- **Unit** (`claude.test.ts`):
  - Every level's policy includes `Skill` in `allowed`.
  - The Level 1 `tools` has no `Edit`, `Write` or `NotebookEdit`.
  - No level's `tools` contains `WebFetch`, `WebSearch`, `Agent` or
    `PowerShell`.
  - `buildArgs` always contains `--tools` and `--strict-mcp-config`.
  - `--setting-sources` appears only when `loadUserConfig === false`.
  - With a bridge, `mcp__acc` is allowed and `--mcp-config` is present.
  - The `skill` scenario logs `[tool] Skill docs-systems` and an init line
    containing `skills`.
- **Prompt:** a `promptSections` test asserts that the skills section is
  present.
- `pnpm check`, `pnpm build`, and `pnpm e2e` (the Agents page text changed,
  so run the matrix in both themes).
- **Real CLI:** `pnpm verify:agents --run --only claude --claude-model haiku --skills`
  must pass all probe expectations.
- **Real app:** restart the orchestrator after checking the shared tree for
  other sessions' migrations. Run one small task on the e2e repository with
  Claude Code, "Load my CLI customisations" on, and the Control Center tools
  on. Confirm:
  - the init line shows the skill count;
  - there is no `permission denied: Skill` for a skill with `allowed-tools`;
  - `acc` capabilities still appear in tool executions;
  - the task completes as before.
- **Browser:** check the Agents page wording with Playwright MCP in both
  themes, with Simple Browser opened on the same URL.

### 8. Success criteria

1. A skill that declares `allowed-tools` runs inside a Level 2 stage. Proven
   by the real probe and by the real task log.
2. No skill can reach `WebFetch`, a personal MCP tool, or a write at Level 1.
   Proven by the real probe.
3. The stage log names every skill used or refused.
4. Control Center tools (`mcp__acc`) still work in a real task.
5. `pnpm check`, `pnpm build` and `pnpm e2e` pass. `verify:agents --skills`
   passes.
6. agents.md and mcp.md describe the new behaviour, with today's
   `Last verified` date.

### 9. Found for Later

- **Codex skills at runtime.** Codex 0.156.1 lists `~/.codex/skills`, but a
  run could not be checked because the ChatGPT workspace is out of credits.
- **Isolated mode.** With the switch off (`--setting-sources project,local`),
  a probe's reply still referred to the operator's conventions. Parent-folder
  or user memory may still be loading; this needs a look.
- **Skill sprawl.** 794 skills include duplicate plugin copies (`synced`,
  `marketplaces`, `.trash`). Claude Code's skill listing has a size budget, so
  many descriptions are likely trimmed. Pruning the duplicates would make the
  right skill easier to find.
- **Skill use in history.** Recording which skills each execution used, for
  the Usage and History pages, needs a migration.
- **Automatic tripwire.** Run the skills probe automatically when the
  detected Claude Code version changes.
- **Research tools.** An investigator could use `WebFetch` or `WebSearch`
  through an `acc` capability under policy, rather than as a native tool.

### 10. Next Recommended Task

**Import my MCP servers into the Control Center gateway.** This is a one-click
import from `~/.claude.json` into Settings → MCP, with per-server level and
tool narrowing. Skills such as `browser-autopilot` then get their tools
through the Control Center's policy instead of being unable to reach them.

### 11. Final execution prompt

> Implement `AGENT_SKILLS_PLAN.md` in `AI-Development-Control-Center`. Read the
> plan, `AGENTS.md`, `docs/systems/agents.md`, `docs/systems/mcp.md` and
> `docs/systems/tool-system.md` first, and re-read
> `packages/agent-claude/src/index.ts` before editing. Make
> `claudeToolPolicy` return a closed built-in tool set per level with `Skill`
> allowed. Make `buildArgs` always pass `--tools` and `--strict-mcp-config`,
> keeping `--setting-sources project,local` only for isolated runs. Show skill
> names and counts in the stage log, add the short skills prompt section,
> update the Agents page wording, add the `--skills` real probe to
> `scripts/verify-agents.ts`, map "unknown option" to the update-the-CLI
> class, and update both system docs. Prove every policy change with unit
> tests and with `pnpm verify:agents --run --only claude --claude-model haiku --skills`.
> Then run `pnpm check`, `pnpm build` and `pnpm e2e`. Then run one real task
> through the restarted orchestrator and check the Agents page in both themes
> with Playwright MCP. Never widen what a stage may do, never loosen the
> subscription guard or `ALWAYS_DENIED`, stage explicit paths only, and commit
> and push to `main` with the `[autopilot]` trailer once everything passes.

### Irreversible steps

None. There is no migration, deploy, deletion or history rewrite. The push to
`main` is revertible.

### Assumptions

- Claude Code on the operator's PC is 2.1.280 or newer. `--tools` and
  `--strict-mcp-config` behave as measured above, and `--strict-mcp-config`
  also drops plugin MCP servers (the init event showed `mcp: []`).
- No registered repository depends on a project `.mcp.json` server inside
  agent runs. Those tools were not on the allowlist and would have been
  refused anyway.

## Steps

- [x] 1. `claudeToolPolicy` returns `{ mode, tools, allowed, denied }`: L1 tools `Read, Grep, Glob, Bash, Skill, ToolSearch, TodoWrite`; L2+ adds `Edit, Write, NotebookEdit`; `Skill` allowed at every level; `denied` unchanged — done when: policy unit tests assert the sets — check: `pnpm vitest run packages/agent-claude`
- [x] 2. `buildArgs` always passes `--tools` and `--strict-mcp-config`; `--setting-sources project,local` only when `loadUserConfig === false`; `--mcp-config` + `mcp__acc` unchanged — done when: args tests pass for loadUserConfig on/off and with a bridge — check: `pnpm vitest run packages/agent-claude`
- [x] 3. Parser shows skills: `[tool] Skill <name>` (never args), init line appends `· N skills` — done when: fake-claude `skill` scenario test sees both lines — check: `pnpm vitest run packages/agent-claude`
- [x] 4. `tests/fixtures/fake-claude.mjs` gains the `skill` scenario (init `skills` array + `Skill` tool_use) — done when: step 3 test uses it and existing scenarios still pass — check: `pnpm vitest run packages/agent-claude`
- [x] 5. Unit tests for steps 1–3 in `packages/agent-claude/test/claude.test.ts` (no WebFetch/WebSearch/Agent/PowerShell in any level; no Edit/Write/NotebookEdit at L1) — done when: they fail on the old code and pass on the new — check: `pnpm vitest run packages/agent-claude`
- [x] 6. `promptSections` appends the short skills/outside-tools section for every agent, with a test — done when: orchestrator test asserts the section — check: `pnpm vitest run apps/orchestrator`
- [x] 7. Agents page wording and the `schemas.ts`/`contract.ts` comments describe hooks, skills and plugins, and that personal MCP servers are not loaded — done when: the new text renders — check: `pnpm build && pnpm e2e` plus Playwright MCP look in both themes
- [x] 8. `pnpm verify:agents --skills` real probe (plain skill L1, allowed-tools skill L2, grant skill cannot reach WebFetch nor write at L1) — done when: it passes against the real CLI and exits non-zero on a mismatch — check: `pnpm verify:agents --only claude --claude-model haiku --skills`
- [x] 9. "unknown option" from the CLI is classified as the update-the-CLI class — done when: a classify test covers it — check: `pnpm vitest run packages/agent-sdk`
- [x] 10. `docs/systems/agents.md` and `docs/systems/mcp.md` updated (run line, tool sets, Skills subsection with the measured table, token figure, Last verified) — done when: both docs match the code — check: `git diff --stat docs/systems`
- [x] 11. Real app run: restart the orchestrator (after checking the shared tree for other sessions' migrations), run one small task on the e2e repository with Claude Code — done when: init line shows the skill count, no `permission denied: Skill`, `acc` capabilities appear in tool executions, task completes — check: `manual: stage log + tool executions of the run`

## Tail

- [x] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat` reviewed hunk by hunk
- [x] T2. Similar-issue sweep — done when: every other place that builds Claude/Codex argv or tool allowlists was searched for the open-tool-set pattern — check: `manual: list what was searched and what was found`
- [x] T3. Gates green — done when: `pnpm check` and `pnpm build && pnpm e2e` pass, or a failure is shown to be another session's — check: the commands
- [x] T4. Docs synced — done when: agents.md, mcp.md and this plan reflect the change — check: `git diff --stat docs/`
- [x] T5. Committed path-scoped and pushed — done when: the push succeeded and the commit holds only this work — check: `git log origin/main..HEAD --oneline`
- [x] T6. Confirmed live where the push deploys — done when: no deploy on push for this repo (cloud deploy is workflow_dispatch only; the orchestrator is local and was restarted in step 11) — check: `manual: .github/workflows/deploy-cloud.yml trigger`
- [x] T7. A claim registered for this change — done when: a claim is registered or this step says "no observable outcome" with the reason — check: `manual: name the claim or say why none`

## Ledger

- 2026-09-24 — created from AGENT_SKILLS_PLAN.md (conversation 2026-09-24); /implement-plan was invoked with no argument and no plan in docs/plans was in-progress, so the plan written in this conversation is the source
- 2026-09-24 — AGENT_SKILLS_PLAN.md stays at the repo root (the operator asked for a root file with that name); this checklist is the tracked copy with its context verbatim
- 2026-09-24 11:07 — checks — per-package `pnpm --filter … test` does not exist (packages have no test script); checks use the root `pnpm vitest run <path>` — the repo's real test runner
- 2026-09-24 11:12 — steps 3/4 — the fixture scenario (step 4) was written before the parser change (step 3) because step 3's check runs on it; the scenario also emits a refused skill so the denial line is covered
- 2026-09-24 11:20 — step 6 — the section is written for the case where the Control Center tools are switched off too (it says "when this run has them"), so it never names tools the run lacks; asserted in the existing end-to-end engine test rather than a new file
- 2026-09-24 11:24 — step 7 — the plan said "Settings → MCP"; the real screen is Tools → MCP servers (ToolsPage `mcp` tab), so the wording and docs use that
- 2026-09-24 11:25 — step 7 — its check (`pnpm build && pnpm e2e` + browser look) runs once with T3 after steps 8–10, per AGENTS.md "run each check once"; step 7 stays open until then
- 2026-09-24 11:34 — step 8 — `--skills` does not need `--run` (it runs its own probes), so the check drops `--run`. Real result on Claude Code 2.1.280: 5/5 pass; on the old adapter (HEAD) the "allowed-tools skill runs at Level 2" probe FAILs with "no approval surface" and the script exits 1. The Level 2 WebFetch probe cannot fail on the old adapter (it never allowed Skill); the hole it guards against was shown by hand in the planning run (Skill allowed without `--tools` → WebFetch and a personal MCP tool ran)
- 2026-09-24 11:38 — step 9 — reused MODEL_UNAVAILABLE (its task blocker offers "Open Agents", the right remedy) instead of adding an error class, which would touch shared constants, labels and stored rows; the visible message stays the CLI's own "unknown option '--…'" line
- 2026-09-24 11:52 — T3 — `pnpm check`: typecheck, lint, docs guard pass; tests 586/587, the one failure is the real-ConPTY test timing out under full-suite load (packages/pty untouched by this change); it passed twice run alone (`pnpm vitest run packages/pty`: 3/3, 3/3)
- 2026-09-24 12:05 — step 7 — `pnpm build && pnpm e2e`: 85 passed. Live Agents page (restarted orchestrator), Claude Code → Settings drawer via Playwright MCP: new text renders in dark (rgb 167,176,190 on 15,19,25) and light (75,85,99 on white), no horizontal overflow; screenshot `~/.claude/browser/playwright-mcp/agent-skills-agents-page-dark.png`. Simple Browser: the `vscode://tenten.tenten-simple-browser` link was fired but the receipt stayed at 2026-09-15 — the preview is NOT confirmed in the editor (extension host needs a window reload)
- 2026-09-24 12:05 — step 11 prep — live DB backed up online to `backups/acc-before-agent-skills-2026-09-24.db` (integrity ok, 6 tasks, none unfinished); stopped/started with the scripts; new pid 8512. The dist was built from the shared tree, whose only changes are this work (git status checked, no migrations touched)
- 2026-09-24 12:30 — step 11 — ran on an isolated instance (same new dist, `ACC_DATA_DIR` in the scratchpad, port 4473, `ACC_REPOSITORY_AUTOMATION=0`) against a disposable fixture repo, as the 2026-09-24 full-flow test did, instead of registering a fixture in the operator's live DB; the live orchestrator was restarted on the new build separately (step 7). Evidence, TASK-0001 (quick-change, Claude haiku): implement (L2) and review (L1) both logged `[tool] Skill file-census` (a skill declaring `allowed-tools: Read, Glob`), every init line `· 792 skills`, no `permission denied`, argv carried `--tools …` and `--strict-mcp-config --mcp-config`, CENSUS.md = "4 files · CENSUS-7731", COMPLETED/READY (two fix cycles: the L1 reviewer judged from the implementer's report, not its tool log). TASK-0002: an agent-origin `network.port_owner` call through `mcp__acc` succeeded ("Port 4473: node (pid 23424)"), PORT.md written, COMPLETED/READY
- 2026-09-24 12:40 — T1 — diff read hunk by hunk. Fixed: (1) Level 1 returned the shared `BASE_TOOLS` array by reference — now a copy, so no caller can mutate the constant; (2) the "unknown option" pattern matched anywhere in the output tail (e.g. a project's own test output) — now anchored to the CLI's `^error: unknown option '--` line (`/im`). Re-ran agent-claude + agent-sdk tests (34/34), typecheck and lint. Accepted as is: `LS`/`MultiEdit` stay in `--allowedTools` (names absent from CLI 2.1.280, harmless, dropped nowhere else); the Skills prompt section also reaches Codex (it loads skills too) and isolated runs (project skills still load)
- 2026-09-24 12:45 — T2 — searched apps/, packages/, scripts/ for `allowedTools`, `--permission-mode`, `bypassPermissions`, `dangerously`, `--mcp-config`, `--tools`, `--sandbox`, `--ignore-user-config` and every `'claude'`/`'codex'` launch: Claude argv is built only in `ClaudeCodeAdapter.buildArgs` (stages, Chairman and source-control assist all go through it); Codex only in `CodexAdapter.buildArgs` (sandbox-bounded, out of scope); the MCP gateway's `allowedTools` is server-tool narrowing under policy, unrelated; PTY terminals start shells for the operator, never agents; the webview bundle hit is React's `dangerouslySetInnerHTML`. Nothing else to change
- 2026-09-24 12:45 — T3 — full gates ran before T1 (`pnpm check`: typecheck/lint/docs guard green, 586/587 with the ConPTY timing flake passing alone; `pnpm build && pnpm e2e`: 85 passed). After T1's two one-line fixes: typecheck + lint green, affected suites (agent-claude, agent-sdk) 34/34
- 2026-09-24 12:50 — T6 — no deploy on push: `.github/workflows/deploy-cloud.yml` is `workflow_dispatch` only and the change is in the local orchestrator, which was restarted on the new build (and is rebuilt/restarted again after the commit so the live dist includes T1's fixes)
- 2026-09-24 12:50 — T7 — this repo keeps no claims register (no `docs/claims*`); the standing downstream probe is `pnpm verify:agents --only claude --claude-model haiku --skills`, documented in agents.md as the check to run after every Claude Code update, which reads the CLI's real behaviour rather than anything this diff wrote
- 2026-09-24 12:58 — T4 — the docs hook flagged operations.md (describes verify-agents.ts): added `--skills` there. Other flagged docs (autopilot, checkpoints, recovery, workflow-engine, repository-automation, dashboard) cover other parts of the touched files — nothing in them describes skills, the tool set or the switch's wording
- 2026-09-24 13:40 — T5 — origin/main had moved 3 commits (6912045, 5e05d5b, 817d79f: crash classification, capacityBlock, bisect; no migrations). Rebased onto them; one conflict in `tests/fixtures/fake-claude.mjs` (their `crash` scenario next to this `skill` one) — both kept, header lists both. Gates re-run on the merged tree: `pnpm check` green (594/594, typecheck, lint, docs guard), `pnpm build && pnpm e2e` 85 passed. agents.md's failure-classification section now names the "unknown option" line
- 2026-09-24 13:40 — live orchestrator — the first restart (step 7) ran a dist built from the pre-rebase base, i.e. briefly without 6912045/817d79f's fixes; rebuilt from the merged tree and restarted again (pid 28740, no unfinished tasks, no migrations); the live bundle contains `ToolSearch`, `describeExit` and the anchored `unknown option` rule
- 2026-09-24 13:50 — T5 — a 4th upstream commit (8e97fb2, dashboard theme switching; no file in common) landed during the push; rebased again, typecheck green, pushed 8e97fb2..bcce09f. The live orchestrator runs the build from before 8e97fb2 (that change is the other session's to release)
