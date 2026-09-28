---
system: agents-skills
sources:
  - apps/orchestrator/src/services/skills.ts
  - packages/shared/src/skills.ts
  - packages/agent-sdk/src/skills.ts
  - packages/agent-sdk/test/skills.test.ts
verified_at: 57af61a
---

# Skills in agent runs

Part of [Agent adapters](agents.md).

## Skills

With **Load my CLI customisations** on, a run loads the operator's skills,
hooks and plugins (`--setting-sources` is left at the CLI default; hooks only
from L2, as L1 runs none); off, only the repository's own (`project,local`). Skills run inside the stage's
limits, measured with real runs on Claude Code 2.1.280:

| Case | Result |
|---|---|
| Plain skill, any level | runs |
| Skill declaring `allowed-tools`, any level | runs (before `Skill` was allowed it was refused: "no approval surface") |
| Skill granting `Bash`/`Write` at L1 | refused (neither tool exists at L1) |
| Skill granting a command the stage denies | refused (deny wins) |
| Skill granting `WebFetch` or a personal MCP tool | the tool does not exist in the run |

**Why the tool set is closed:** a skill's `allowed-tools` pre-approves any
tool that *exists*. With `Skill` allowed on Claude Code's open tool set, a
skill at L2 could run `WebFetch` and personal MCP tools, which bypasses
`ToolService.invoke`. `--tools` + `--strict-mcp-config` remove them.

**Learned skills** ([learning.md](learning.md#skills)): `AgentExecutionInput.pluginDirs`
becomes one `--plugin-dir` per folder for Claude Code — the Control Center's
own plugins in its data folder, for that run only. They are the one part of the
data folder an agent may name: readable (natively, and by a read-only shell
command through the precheck), never writable (`Edit(//<data>/learning/plugins/**)`).
Codex ignores it; the prompt names the SKILL.md files instead.

Stage logs name skills: `[tool] Skill fix-bug`, `permission denied: Skill
ship-it`, and the init line ends `· N skills`; skill `args` are never logged.
Every prompt carries a short "Skills" section
([tooling.ts](../../apps/orchestrator/src/engine/tooling.ts) `SKILLS_PROMPT_SECTION`).

**Tripwire:** these guarantees rest on the CLI's permission semantics. After
every Claude Code update run `pnpm verify:agents --only claude --claude-model
haiku --skills --permissions` (5 skill probes, the skill-list checks below, and 8
probes in a repository whose settings allow `Bash(*)` and carry SessionStart/Stop
hooks: a control proving the rule is live, then L1 cannot write a file or commit
and runs none of the hooks, L2 still runs commands but cannot commit or push, and
still runs the hooks — the control for the L1 hook check; exits 1 on any mismatch).
Add `--run` for the native-tool guards (SEC-3; `pnpm build` first — L2 has a
shell only with the built hook, `--permissions` included): against a throwaway
Control Center in the script's own process (own data folder, work root and
port, a stage of a simulated task hanging so its session is live), an L2 run
in that task's worktree must see `cat` of the token, `curl` to the port and
`node -e fetch` to `127.1:<port>` refused with the Control Center's reason and a
denied `native.bash` row each, Read of the token refused with the Control
Center's own words for a file read ("Reads the Control Center's own…" in a tool
error: a tool error cannot be placed by position when the model batches calls)
and a denied `native.read` row, with an `info` line naming the layer that
refused it — the hook, or Claude Code's own deny rule if the CLI weighs that
first (then the check fails: no row), the token's content
nowhere in the run, reads, an edit and a test command on absolute worktree
paths working, and `.claude/settings.local.json` unwritable; then native Bash
refused with the orchestrator gone, no shell in a repository whose
`settings.local.json` sets `disableAllHooks`, and an `info` line saying whether
the CLI itself lets the run's `--settings` hook beat that setting. A CLI too old for
`--tools` fails the run with "unknown option", classified `MODEL_UNAVAILABLE`
(update the CLI).

### Skill list and requested skills

`AgentAdapter.listSkills(options, cwd)` (optional) says which skills a CLI
loads in a repository. [SkillCatalog](../../apps/orchestrator/src/services/skills.ts)
merges it over the enabled agents, cached 60 s per repository and per agent
settings; `GET /api/skills?repositoryId=` serves it (remote read op
`skill.list`).

- **Claude Code** asks the CLI itself: `claude -p` with stdin `/skills` is
  handled locally — 0 turns, $0, no tokens, ~2.5 s — and its init event names
  every skill (`fix-bug`, `dx:fix-issue`, built-ins like `update-config`) and
  every plugin folder. Hooks are off for the lookup
  (`--settings {"disableAllHooks":true}`), with `--tools ""` and
  `--strict-mcp-config`; `--setting-sources project,local` when user config is
  off, as in a run. Descriptions are read from the repository's, the user's and
  each plugin's SKILL.md files (`skills/` plus any folder its manifest declares, never outside the plugin);
  a reported name without a readable file is listed with none (`builtin`, or
  `plugin`). Rebuilding the list from folders and `claude plugin list --json`
  was tried first and was wrong in both directions (link stubs and plugins the
  CLI does not load; skills-dir plugins, synced plugins shown `enabled:false`
  under the sanitised environment, manifest skill paths) — do not go back to it.
- **Simulated agents** list the repository's `.claude/skills` (demo, e2e).
- **Codex** lists none yet.

The New Task description and the Directive box accept `/name` (the slash picker,
[dashboard.md](dashboard.md)). `requestedSkills()`
([skills.ts](../../packages/shared/src/skills.ts)) keeps only `/name` tokens
that are real skill names in the description and in the directives a stage
receives — `/api/tasks`, URLs and `and/or` never count — and adds the
installed ones a workflow stage lists in `skills` (a name not installed is
dropped). The stage prompt then gets "## Requested skills" (name, description,
and the rule: run it in the stage whose job it matches, design, UI and media
skills in design stages; the implementation (or design build) stage when none
clearly does; at most once per stage; a refusal is an operator decision).
The description and directives stay the record; there is no separate task field.

`pnpm verify:agents --images` asks each CLI for the colour of a solid red
square three ways: Claude Code reading a PNG from disk, Codex given it with
`-i`, and Claude Code shown it as an MCP image block (the fixture
`packages/mcp/test/fixtures/red-picture-server.mjs` stands in for the `acc`
bridge). Run it after a CLI update; the design agent relies on all three
([design-agent.md](design-agent.md)).

`pnpm verify:agents --skills` also compares the picker's list with the CLI's
(791 = 791 on 2026-09-24, 750 with a description; the rest are built-ins with no file) and checks that the `/skills`
lookup still uses no model turn.

Codex loads `~/.codex/skills` and `~/.agents/skills` itself;
`--ignore-user-config` skips only `config.toml` (a run with it still scans
`~/.agents/skills`, seen 2026-09-27). Plugin skills do not load
([`--disable plugins`](agents-codex.md#mcp-servers-in-a-codex-run)). Its sandbox, not a tool
list, bounds it (execpolicy rules are ignored, see [Codex](agents-codex.md)). A skill running in a Codex stage is not yet observed.

## Skills lookup trigger

The skills catalog is listed for a stage only when the task or an active directive names a `/skill` token (`SKILL_TOKEN`, the rule `requestedSkills` uses) or the stage lists `skills`; a file path or URL no longer triggers a cold listing.

Last verified: 2026-09-28
