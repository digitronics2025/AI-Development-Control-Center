---
system: agents
sources:
  - packages/agent-sdk/**
  - packages/agent-claude/**
  - packages/agent-codex/**
  - packages/executor/**
  - apps/orchestrator/src/services/skills.ts
  - packages/shared/src/skills.ts
verified_at: 892299f
---

# Agent adapters

Contract: [contract.ts](../../packages/agent-sdk/src/contract.ts)
(`detect, healthCheck, getCapabilities, listModels, execute, cancel,
parseResult`). CLI plumbing shared by providers:
[cli-adapter.ts](../../packages/agent-sdk/src/cli-adapter.ts). Prompts always
travel on **stdin**; argv holds only fixed flags and validated model/effort
values. Processes are killed as a tree on cancel/timeout
([process.ts](../../packages/executor/src/process.ts)).

**Line lengths.** `runProcess` splits lines longer than `maxLineLength`
(default 8,000 characters) for display. Agent CLIs stream one JSON event per
line, and a single event — a long final answer, a large file read — exceeds
that, so `CliAgentAdapter.execute` raises the limit to
`PROTOCOL_MAX_LINE_LENGTH` (32 MiB) and bounds only the lines the parser logs.
When events were split, the `result` event never parsed and a successful run
was reported as "finished without producing any output".

**Control Center tools.** `AgentExecutionInput.toolBridge` adds the
Control Center's stdio MCP server to a run; its session token is put in the
agent's environment only ([mcp.md](mcp.md)). Claude Code gets a temporary
`--mcp-config` file referencing the variable by name and `mcp__acc` in its
allowed tools; Codex gets `-c mcp_servers.acc.*` with `env_vars`, and every
other MCP server switched off ([below](#mcp-servers-in-a-codex-run)). The file is
removed when the run ends.

## Codex ([agent-codex](../../packages/agent-codex/src/index.ts))

- Run: `codex exec --json --color never --skip-git-repo-check -C <repo> --disable apps --disable plugins --disable skill_mcp_dependency_install [-c mcp_servers.<name>={enabled=false,…}]… --sandbox read-only|workspace-write --ignore-rules [-m model] [-c model_reasoning_effort="…"] -c forced_login_method="chatgpt" [--ignore-user-config] [-c mcp_servers.acc.command=… -c mcp_servers.acc.args=[…] -c mcp_servers.acc.env_vars=[…]] [-i <image>]… -`
- Level 1 stages use the read-only sandbox; higher levels `workspace-write`.
- `--ignore-rules` on every run: Codex's execpolicy `.rules` files (the operator's
  `~/.codex/rules`, the repository's `.codex/rules/`) are never loaded. An `allow`
  match for every segment of a command skips approval **and runs it outside the
  sandbox** (`exec_policy.rs`: `Skip { bypass_sandbox }`), so a repository could
  lift a read-only stage. Measured on 0.156.1 (2026-09-27): a repository rule —
  confirmed matching with `codex execpolicy check` — did not escape the sandbox in
  any run (Codex wraps commands in `powershell.exe -Command` and matches the parsed
  script), so the bypass is closed from the source, not reproduced. With user
  config off no Windows sandbox mode is set and a writing command is refused
  ("blocked by policy"); with it on (`[windows] sandbox = "unelevated"`) the
  command runs and the write is denied. A CLI older than the flag fails with
  "unexpected argument" → `MODEL_UNAVAILABLE` (update the CLI).
- Auth: `codex login status` — "Logged in using ChatGPT" = subscription.
- Models: read from `$CODEX_HOME/models_cache.json` (visible entries, per-model effort levels).
- Output: JSONL events (`agent_message`, `command_execution`, `file_change`, `turn.failed`).

### MCP servers in a Codex run

Codex has no `--strict-mcp-config`, and MCP servers run outside its sandbox:
any server but `acc` would hand an agent tools that skip `ToolService.invoke`
and the stage's level. Measured on Codex 0.156.1 (2026-09-27, real
`codex exec` runs with the adapter's flags, Codex's own log at
`RUST_LOG=info`), a run without the isolation below loads:

| Source | With `--ignore-user-config` | Switched off by |
|---|---|---|
| `$CODEX_HOME/config.toml` `[mcp_servers]` (7 here, incl. `node_repl`, the desktop app's computer-use runtime) | not loaded | name |
| A trusted repository's `.codex/config.toml` (`tenten-d1` in tenten-accounting-in) | not loaded: trust lives in the user config | name |
| `codex_apps`, ChatGPT connectors (reports itself as `plugin-runtime`) | **loaded** | `--disable apps` |
| Plugin servers, including plugins installed on the ChatGPT account (`cloudflare-api` → mcp.cloudflare.com) | **loaded** (account plugins) | `--disable plugins` |
| Servers a mentioned skill asks to install and enable | not reproduced | `--disable skill_mcp_dependency_install` |
| System (`%ProgramData%\OpenAI\Codex\config.toml`) and workspace-managed config | loaded by design; none exist here | name |

How ([index.ts](../../packages/agent-codex/src/index.ts) `buildArgs`):

- Before each run, `codex mcp list --json` with the same three `--disable`
  flags runs in the run's folder (~2 s), so Codex itself resolves every layer
  and the repository's trust. `mcp list` has no `--ignore-user-config`, so it also
  lists user servers when the run ignores them; switching those off is harmless.
- Every listed server but the run's bridge gets
  `-c mcp_servers.<name>={enabled=false,command="acc-disabled"}` (`url=…` for
  HTTP). A `-c` table merges into the loaded layers — `-c mcp_servers={}`
  changes nothing — so servers are named one by one, and the entry restates a
  transport because Codex refuses one without ("invalid transport"), which it
  would be when its layer is not loaded.
- Refused, never run open (`AgentGuardError`): the listing fails or is
  unreadable, or names a server a `-c` key cannot address (names outside
  `[A-Za-z0-9_-]`, transports other than `stdio`/`streamable_http`). A CLI
  that does not know one of the flags fails the listing with "Unknown feature
  flag" → `MODEL_UNAVAILABLE` (update the CLI).
- Price: plugin skills and ChatGPT connectors are not available in Codex runs.

**Tripwire:** after every Codex update run `pnpm verify:agents --only codex
--mcp [--codex-mcp-repo <trusted repository with a .codex MCP server>]`. With
the operator's real config it runs the shipped argv with a stand-in `acc`
server, config loaded and ignored, and passes only when Codex's log names `acc`
alone at session start, no other server starts or fails to start, and the
stand-in was started. 2026-09-27: 3/3 pass, `tenten-d1` switched off by name in
tenten-accounting-in.

## Claude Code ([agent-claude](../../packages/agent-claude/src/index.ts))

- Run: `claude -p --output-format stream-json --verbose --no-session-persistence --permission-prompts none --permission-mode … --tools … --allowedTools … --disallowedTools … [--model] [--effort] [--setting-sources project,local] [--settings {"disableAllHooks":true}] --strict-mcp-config [--mcp-config <acc>]`
- Permission mapping (`claudeToolPolicy`): L1 `dontAsk`, read-only tools and **no shell**; L2 `acceptEdits`, no git commit/push/deploy; L3 adds git; L4+ adds deploy. Always denied, at every level with a shell (prefix rules on Claude's native Bash — a heuristic, not the Control Center's classifier): force and mirror push, `git reset --hard`, `git clean`, `git restore`, `git checkout --`/`.`/`-f`, `git switch --discard-changes`, `git stash drop|clear`, `git branch -D`, `git worktree remove`, `git filter-branch`, `rm -rf`/`rm -r`, `rmdir /s`, `rd /s`, `del /s`, `Remove-Item`, `npx rimraf`. `Skill` is allowed at every level.
- Tool set (`--tools`, closed on purpose): L1 `Read, Grep, Glob, Skill, ToolSearch, TodoWrite` (and `Bash` denied outright); L2+ adds `Bash, Edit, Write, NotebookEdit`. `WebFetch`, `WebSearch`, `Agent`, `PowerShell` do not exist in a run.
- **A repository's settings cannot widen a stage.** Settings files the run loads —
  the repository's `.claude/settings.json` and `settings.local.json`, the
  operator's own with user config on — add their `permissions.allow` rules to
  `--allowedTools`; only a deny rule or a missing tool beats one. So every limit is
  one of those: from L2 the limits are deny rules and Bash and edits are already
  allowed (a `Bash(*)` rule adds nothing), and L1's "read-only commands only",
  which no deny rule can express, is no shell at all — Git is read through the
  Control Center's `git__status/diff/log/show` ([mcp.md](mcp.md)), and the prompt's
  tools section says so at L1. With tools off for agents an L1 run has only
  `Read`/`Grep`/`Glob`. Before this (TASK-0009, 2026-09-27) a repository allowing
  `Bash(*)` let an L1 investigator run `npm test` for 23 minutes. Claude Code
  honours a committed `.claude/settings.json` allow rule only in a folder the
  operator trusted (an untracked `settings.local.json` anywhere); excluding the
  `project` setting source, or `--restricted`, would also drop the repository's
  skills and was rejected for that.
- **Level 1 runs no hooks** (`--settings {"disableAllHooks":true}`). Hooks are shell
  commands outside every permission rule, and `-p` runs a repository's in trusted
  and untrusted folders alike (the CLI's gate is "non-interactive or trusted").
  Measured on 2.1.283 (2026-09-27), without the switch an L1 run in a temporary
  repository ran every hook event (SessionStart, UserPromptSubmit, Pre/PostToolUse
  on `Read`, Stop, SessionEnd) from `.claude/settings.json`, `settings.local.json`
  and a repository skill's frontmatter; so did a trusted isolated worktree. An L2
  agent can also write hooks into `settings.local.json` (hidden by a global
  gitignore) for a later stage to run. The switch stops all of them — plugins' and
  the operator's too — and a repository's `disableAllHooks: false` cannot undo it
  (the key merges restrictively). Skills still load and run. From L2 hooks stay on:
  the agent has a shell anyway, a hook answering `allow` does not lift a deny rule
  (measured: an L2 `git commit` stayed denied), and the switch would take away the
  operator's own hooks — their secret guards match `Bash|PowerShell`, which L1 does
  not have.
- **A repository that switches hooks off is named in the run log.** The key merges
  restrictively in that direction too: a repository's `disableAllHooks: true`
  silently switches off the operator's own hooks (measured). At L2+ with user
  config on, the init line is followed by `Warning: this repository's
  .claude/settings.json sets disableAllHooks, …` (`repositoryHookSwitches`; a file
  that does not parse is skipped, as the CLI skips it). The run is not stopped.
- `--strict-mcp-config` is always passed: the operator's personal and plugin MCP servers never join a run; only the Control Center's `acc` server does ([mcp.md](mcp.md)).
- Auth: `claude auth status` JSON; `authMethod: claude.ai` + `apiProvider: firstParty` = subscription.
- Runtime tripwire: if the init event reports `apiKeySource` other than `none` in Subscription Only mode, the run is stopped.
- Usage limits: `rate_limit_event` with `status: rejected`, or `api_error_status: 429`.

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
own plugins in its data folder, for that run only. Codex ignores it; the
prompt names the SKILL.md files instead.

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
still runs the hooks — the control for the L1 hook check; exits 1 on any mismatch). A CLI too old for
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
receives — `/api/tasks`, URLs and `and/or` never count — and
every stage prompt then gets "## Requested skills" (name, description, and the
rule: run it in the stage whose job it matches; the implementation stage when
none clearly does; at most once per stage; a refusal is an operator decision).
The description and directives stay the record; there is no separate task field.

`pnpm verify:agents --skills` also compares the picker's list with the CLI's
(791 = 791 on 2026-09-24, 750 with a description; the rest are built-ins with no file) and checks that the `/skills`
lookup still uses no model turn.

Codex loads `~/.codex/skills` and `~/.agents/skills` itself;
`--ignore-user-config` skips only `config.toml` (a run with it still scans
`~/.agents/skills`, seen 2026-09-27). Plugin skills do not load
([`--disable plugins`](#mcp-servers-in-a-codex-run)). Its sandbox, not a tool
list, bounds it (execpolicy rules are ignored, see Codex above). A skill running in a Codex stage is not yet observed.

## Stage Team workers

A Stage Team runs each worker as an ordinary run of its adapter through
`AgentRegistry.launch` — one execution, one tool session, one usage attempt —
never through a provider's own sub-agents. A write worker's cwd and only tool
root is its own checkout ([stage-teams.md](stage-teams.md)).

## Usage reporting

Every result carries `usage` (token lines per model; `null` when the CLI
reported none) and `capacity` observations, and every adapter declares
`usageCapabilities`. Claude Code: `result.modelUsage` (cumulative, with
`costUSD`) and `rate_limit_event` windows; Codex: `turn.completed.usage`
(cached input is inside `input_tokens`) and no cost. Runs are launched only
through `AgentRegistry.launch`, which records them — see [usage.md](usage.md).

## Failure classification ([classify.ts](../../packages/agent-sdk/src/classify.ts))

Structured provider messages are classified before log noise: `USAGE_LIMIT`
("out of credits", "hit your limit", 429…), `AUTH_FAILURE`,
`MODEL_UNAVAILABLE` ("requires a newer version", a CLI's own "error: unknown
option '--…'" line when it is older than the adapter's flags…), `PERMISSION_DENIED`,
`CONTEXT_FAILURE`; otherwise `PROCESS_CRASH`.

Only plain output lines count as evidence from the output tail
(`isProtocolEvent`): stdout protocol events (`{"type":…}`, matched by prefix
because the tail truncates long lines) carry what the agent read and ran, and
the parsers already lift structured errors out of them. Before this, a crash
right after reading a file that mentions "out of credits" — or line 429 of any
file — was classified `USAGE_LIMIT`, and the task waited for a reset that would
never come. A failure with no explaining line reads as `describeExit`: "Claude
Code crashed (fatal internal error) · Windows status 0xC0000409", not a raw
protocol line.

## Simulated agents

[simulated.ts](../../packages/agent-sdk/src/simulated.ts) is registered only
with `ACC_SIMULATED_AGENTS=1` and labelled in the UI. Markers in a task
description steer it: `[sim:review-fail-once]`, `[sim:review-fail-always]`,
`[sim:usage-limit]`, `[sim:fail:<role>]`, `[sim:slow]`,
`[sim:needs-operator]` (verifier names an operator decision), `[sim:hang]` (every run keeps working until cancelled),
`[sim:needs-decision]` (implementer stops with `BLOCKED ON OPERATOR:` until a directive says `ANSWER:`),
`[sim:verify-plan-mismatch]`, `[sim:chairman-down]`, `[sim:chairman-bad-json]`,
`[sim:big-diff]` (the implementer also writes three 60 KB files),
`[sim:source-only]` (implementer and fixer change `sim-output.ts` instead of `sim-output.md`),
`[sim:review-miss-coverage]` / `[sim:review-miss-coverage-once]` (reviewer and verifier
leave out the files the diff did not show; by default they name them under `## Files reviewed`).
Role `chairman` answers the Chairman's recovery and chat prompts with JSON.
Role `ask` answers "Simulated answer to: <question>" and names the repository
and any task it was shown ([ask.md](ask.md)). `[sim:lookup:<capability>:<json>]`
in the question makes it call that capability through its tool session
(`ACC_TOOL_URL`/`ACC_TOOL_SESSION` from `toolBridge.env`) and report OK or
REFUSED with the summary.

## Observed on the operator's machine (2026-09-24)

- Codex 0.156.1 accepts the default model; with credits back it runs end to
  end (2026-09-27).
- Claude Code 2.1.280 occasionally exits with `0xC0000409` mid-review with no
  result event; the stage retry recovers it.

## Observed on the operator's machine (2026-09-23)

- Claude Code 2.1.278 (Max subscription): runs end to end through the orchestrator.
- Codex 0.150.0 (ChatGPT login): the configured default model `gpt-6-astra` is
  rejected ("requires a newer version of Codex") → `MODEL_UNAVAILABLE`; other
  models return "workspace is out of credits" → `USAGE_LIMIT`. Update Codex and
  restore credits, or reroute Codex roles to Claude Code in Settings.
- Loading the user's own Claude customisations cost ~150k cached tokens per
  run while personal MCP servers were loaded; with `--strict-mcp-config` and the
  closed tool set a run with 794 skills starts at ~65k (2026-09-24). Turn off
  **Load my CLI customisations** per agent for leaner runs.

## Skills lookup trigger

The skills catalog is listed for a stage only when the task or an active directive names a `/skill` token (`SKILL_TOKEN`, the rule `requestedSkills` uses); a file path or URL no longer triggers a cold listing.

Last verified: 2026-09-27
