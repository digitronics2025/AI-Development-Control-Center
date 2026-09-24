# Agent Skills Plan: let stage agents use the operator's skills safely

Status: implemented 2026-09-24 — checklist and evidence in [docs/plans/agent-skills.md](docs/plans/agent-skills.md) · Claude Code 2.1.280, Codex 0.156.1 on the operator's PC

## What was measured (the ground this plan stands on)

Every row below is a real `claude -p` run using the flags that
`ClaudeCodeAdapter.buildArgs` produces
([packages/agent-claude/src/index.ts](packages/agent-claude/src/index.ts)), run in a
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

## 1. Goal

Agents launched by the Control Center can run the operator's installed skills,
including skills that declare `allowed-tools`. No skill can ever give an agent
a tool or command beyond what its stage level already permits. The operator
can see which skill ran in the stage log.

## 2. Scope

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

## 3. Enhanced design / architecture

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

## 4. Implementation steps

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
7. Agents page copy ([AgentsPage.tsx:69](apps/dashboard/src/pages/AgentsPage.tsx#L69)):
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

## 5. Failure handling and recovery

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

## 6. Security and data protection

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

## 7. Testing and verification

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

## 8. Success criteria

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

## 9. Found for Later

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

## 10. Next Recommended Task

**Import my MCP servers into the Control Center gateway.** This is a one-click
import from `~/.claude.json` into Settings → MCP, with per-server level and
tool narrowing. Skills such as `browser-autopilot` then get their tools
through the Control Center's policy instead of being unable to reach them.

## 11. Final execution prompt

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

## Irreversible steps

None. There is no migration, deploy, deletion or history rewrite. The push to
`main` is revertible.

## Assumptions

- Claude Code on the operator's PC is 2.1.280 or newer. `--tools` and
  `--strict-mcp-config` behave as measured above, and `--strict-mcp-config`
  also drops plugin MCP servers (the init event showed `mcp: []`).
- No registered repository depends on a project `.mcp.json` server inside
  agent runs. Those tools were not on the allowlist and would have been
  refused anyway.

/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.
