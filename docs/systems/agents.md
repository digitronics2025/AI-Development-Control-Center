---
system: agents
sources:
  - packages/agent-sdk/**
  - packages/agent-claude/**
  - packages/agent-codex/**
  - packages/executor/**
  - apps/orchestrator/src/services/skills.ts
  - packages/shared/src/skills.ts
verified_at: 57af61a
---

# Agent adapters

Contract: [contract.ts](../../packages/agent-sdk/src/contract.ts)
(`detect, healthCheck, getCapabilities, listModels, execute, cancel,
parseResult`). CLI plumbing shared by providers:
[cli-adapter.ts](../../packages/agent-sdk/src/cli-adapter.ts). Prompts always
travel on **stdin**; argv holds only fixed flags and validated model/effort
values. Processes are killed as a tree on cancel/timeout
([process.ts](../../packages/executor/src/process.ts)).

**As the agent account.** With agent isolation on ([security.md](security.md#agent-os-boundary)),
a stage's run carries `AgentExecutionInput.runAs` (only stage runs:
[runners.ts](../../apps/orchestrator/src/engine/runners.ts) `launchAgent`, Stage
Team workers included; Ask, the Chairman and commit-message drafts stay Level 1
runs as the operator). `CliAgentAdapter.execute` then refuses with
`PERMISSION_DENIED` before anything starts when it is not Windows, the relay is
missing or the password record is missing (`runAsRefusal`,
[run-as.ts](../../packages/agent-sdk/src/run-as.ts)); otherwise it starts
Windows PowerShell on [agent-relay.ps1](../../scripts/windows/agent-relay.ps1)
with the run's environment plus `ACC_AGENT_RELAY` (base64 JSON: account, record,
the program and the exact command line `runProcess` would have used —
`windowsLaunch`: cross-spawn's `cmd.exe /d /s /c` for a `.cmd` shim, libuv's
quoting otherwise — and the folder; nothing secret). The relay starts the
program as the account, copies stdin to it and its output back byte for byte,
holds it in a kill-on-close job (ending the relay's tree on cancel or timeout
ends everything the run started, and a run's leftovers end with it), and exits
with its code. A relay refusal (exit 31436, one `Agent isolation:` line) becomes
`PERMISSION_DENIED` with that line. Never a fallback to the operator. Claude
Code's `--mcp-config` is inline JSON in such a run (the account cannot open the
operator's temp folder). Without `runAs` the launch is unchanged.

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
- Images: `launchAgent` passes the task's image attachments (PNG, JPEG, WebP,
  GIF; five at most, 10 MB each) as `images` to any adapter whose
  capabilities say `images: true` — Codex, as `-i <path>` — so reference
  pictures reach the model without the agent copying anything out of the data
  folder. Claude Code (`images: false`) reads them by path from
  `{{attachments}}` ([design-agent.md](design-agent.md)).
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

- Run: `claude -p --output-format stream-json --verbose --no-session-persistence --permission-prompts none --permission-mode … --tools … --allowedTools … --disallowedTools … [--model] [--effort] [--setting-sources project,local] [--settings {"disableAllHooks":true} | <the shell guard>] --strict-mcp-config [--mcp-config <acc>]`
- **The Control Center itself is denied natively, at every level** (SEC-3, `controlCenterDenied`, from `AgentRuntimeOptions.controlCenter`, which `AgentRegistry.runtimeOptions` fills with the real data folder and listen port): `Read(//<data>/auth-token)`, `Read(//<data>/*.db*)`, `Read(//<data>/credential-key*)`, `Read(//<data>/privileged-key*)` (paths in the CLI's POSIX form, `//c/Users/…`, `rulePath`), `Edit(//<data>/*)` (every file at the data folder's top), `Edit(//<data>/learning/plugins/**)` (the learned skills are read-only), `Edit`/`Write(**/.claude/settings*.json)` and `Edit(~/.claude/settings*.json)` (a run cannot switch its hooks off), `Bash(*auth-token*)`, `Bash(*127.0.0.1:<port>*)`, `Bash(*localhost:<port>*)`. Read and Edit rules also cover the file commands the CLI recognises in Bash and redirection targets. The files only: for these rules the rest of the data folder (learned skills, attachments) stays readable, and the agents' worktrees are outside it ([orchestrator.md](orchestrator.md#work-root-acc_work_dir)); from Level 2 the precheck hook below narrows file reads further, and these rules are its backstop. Level 1 gets only the Read rules, and they are all its reads have: it runs no hooks. Lexical, like every rule here.
- **From Level 2 native Bash and file reads run only behind the Control Center's precheck** (SEC-3). `--settings` carries `disableAllHooks: false` and one PreToolUse command hook on `Bash|Read|Grep|Glob` (`shellGuardSettings`, `GUARDED_FILE_TOOLS`; one entry, not one per tool, for cmd.exe's line limit): `"<node>" "<orchestrator dist>/acc-shell-guard.mjs"` ([shell-guard.ts](../../packages/agent-claude/src/shell-guard.ts), inline JSON, never a file an agent could edit). cmd.exe's operators `|&<>^` are written in that JSON as `\u` escapes: an npm-installed `claude.cmd` reads its arguments again (`%*`), and a bare `|` ran the rest as a command (measured through a `.cmd` shim). The script is out of the run's reach too: `.mjs`, so no package.json decides how Node loads it; `Edit(//<orchestrator dist>/**)` on its folder (`shellGuardDenied`, only in a hooked run); and the precheck refuses a command that names the script or that folder to do more than read. Before each call it posts to `POST /api/tool-session/precheck` — `{ command }` for Bash, `{ tool, input, cwd }` for Read, Grep and Glob (the CLI's own folder, from the hook's input) — with the run's tool session from its environment (`AgentExecutionInput.shellGuard`, the session `EngineTooling.openAgentSession` opens for the stage — for the hook alone when tools are off for agents or the run starts as the agent account) and lets it run only on an explicit allow ([tool-system.md](tool-system.md#sessions)). A file read is refused when a path it reads names the Control Center or when it searches a folder that holds the data folder; the learned plugins and the task's own attachments stay readable ([security.md](security.md#permission-levels)). The CLI lets a call through when a hook exits with anything but 2, fails to start or times out, and an `http` hook's failures do not block, so the hook is a command and refuses — exit 2, the reason on stderr, which Claude sees, and the deny decision on stdout — on every other outcome: no session, an unreadable call or a tool it does not guard, the orchestrator unreachable, a non-2xx or undecided answer, its own 15 s deadline (the CLI's is 60 s), any error of its own. An allow prints nothing, so the run's deny rules still apply after it; whether the CLI weighs a deny rule before the hook (Claude Code's message, no row) is what `--run` reports for Read. **No native shell at all** (`nativeShellRefusal`, fails closed, said in the first line of the run log): without a guard (no build, or the orchestrator not listening yet), with the guard's program missing, or in a repository whose `.claude/settings.json` or `settings.local.json` sets `disableAllHooks: true` — which would switch the hook off (and the operator's own hooks) — whatever the user config; edits and reads stay, the reads with only the deny rules.
- Permission mapping (`claudeToolPolicy`): L1 `dontAsk`, read-only tools and **no shell**; L2 `acceptEdits`, no git commit/push/deploy; L3 adds git; L4+ adds deploy. Always denied, at every level with a shell (prefix rules on Claude's native Bash — a heuristic, not the Control Center's classifier): force and mirror push, `git reset --hard`, `git clean`, `git restore`, `git checkout --`/`.`/`-f`, `git switch --discard-changes`, `git stash drop|clear`, `git branch -D`, `git worktree remove`, `git filter-branch`, `rm -rf`/`rm -r`, `rmdir /s`, `rd /s`, `del /s`, `Remove-Item`, `npx rimraf`. From L3 (where git is allowed) `gh pr merge` and a push to a branch that deploys are denied too: a push there is Level 5 and never an agent's. The rules name each release branch of the task's repositories on its own remote (the engine passes `AgentExecutionInput.releaseBranches`, one per repository of a multi-repository task that releases by push) and the production-named branches (`PRODUCTION_BRANCH_NAMES`: main, master…) on `origin`, in the usual spellings: `git push <remote> <branch>` and `HEAD:<branch>`, each also with `-u` or `--set-upstream`. The set is kept small on purpose: an npm-installed `claude` is `claude.cmd` on Windows, run through cmd.exe, which refuses a command line over 8191 characters, and a rule per remote × branch × spelling pushed a multi-release task past it (a test bounds it). They are prefix rules, so they are best-effort: `git push origin topic:main`, `HEAD:refs/heads/main`, a production name on a remote other than `origin`, a bare `git push` whose upstream is main, or a global option before `push` are not a prefix they name. The Control Center's own tools judge a push in the ways a line runs one (lexically: a script or program that pushes by itself is judged by what the line says) and fail closed when its destination cannot be read, and rate a pull-request merge Level 5 too (`git.push`, and any command line through `shell.*`, `process.*`, `terminal.send`, `node.run_script`, and a terminal's line at Enter: [tool-system.md](tool-system.md#the-execution-door-servicets)); routing native Bash through that judgement is SEC-3's precheck hook. `Skill` is allowed at every level.
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
  (the key merges restrictively). It stops the Control Center's own precheck hook
  as well, which cannot be kept while the repository's go, so an L1 run's native
  reads (`Read`/`Grep`/`Glob`) are held by the deny rules alone. Skills still load and run. From L2 hooks stay on
  (`disableAllHooks: false` beside the shell guard): the agent has a shell anyway, a
  hook answering `allow` does not lift a deny rule (measured: an L2 `git commit`
  stayed denied), and the switch would take away the operator's own hooks — their
  secret guards match `Bash|PowerShell`, which L1 does not have — and the Control
  Center's own.
- **A repository that switches hooks off gets no native shell from L2.** The key
  merged restrictively in that direction too on 2.1.283: a repository's
  `disableAllHooks: true` silently switched off the operator's own hooks
  (measured), and so it would the shell guard; the documentation says the flag's
  settings take precedence instead. Either way the run fails closed: no Bash, and
  the log's first line names the file (`repositoryHookSwitches`; a file that does
  not parse is skipped, as the CLI skips it). `pnpm verify:agents --run` records
  which way the installed CLI goes.
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
leave out the files the diff did not show; by default they name the ones to read, never media to view, under `## Files reviewed`).
Role `designer` changes files like the implementer (the same markers apply) and
reports with `## Summary` and `## Design decisions` ([design-agent.md](design-agent.md));
`[sim:assets]` makes it also write two PNGs in `public/generated/` and a
`manifest.json` naming both with their SHA-256, `[sim:assets-unnamed]` adds a
PNG the manifest does not name, `[sim:assets-bad-hash]` gives `hero-2.png` a
wrong SHA-256. `[sim:ui]` makes the implementer and the designer also change
`src/components/SimOutput.tsx` (a user-interface file, so Full Autopilot's visual
critique runs); `[sim:ui-in-fix]` makes only the fixer do it. Specialists
([stage-teams.md](stage-teams.md#specialists)): `[sim:plan-frontend]` makes the
planner write one unit labelled `Frontend`, `[sim:plan-mixed]` an API unit and a
frontend unit that depends on it; with `[sim:team]`, `[sim:team-frontend]` labels
alpha `frontend`, `[sim:team-unknown-label]` labels it `ui`, and `[sim:team-email]`
labels beta `email`. Role `art-director` answers with a direction and a $0 media
budget; role `visual-critic` passes unless `[sim:critic-fail-once]` /
`[sim:critic-fail-always]`, and names unshown files like the reviewer. Stage
Teams: `[sim:team]` (units alpha and beta), `[sim:team-chain]`, `[sim:team-three]`, `[sim:team-overlap]`, `[sim:team-out-of-scope]`,
`[sim:fail-unit-once:<key>]` ([stage-teams.md](stage-teams.md)); a variant
(`- Your approach:`) writes `sim-output.md` and `variant-<key>.md`, and role
`judge` answers `WINNER:` with the first variant, the last with
`[sim:judge-last]`, none with `[sim:judge-none]`. The simulated `codex`
declares `images: true` like the real one and logs the pictures it receives.
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

The skills catalog is listed for a stage only when the task or an active directive names a `/skill` token (`SKILL_TOKEN`, the rule `requestedSkills` uses) or the stage lists `skills`; a file path or URL no longer triggers a cold listing.

Last verified: 2026-09-28
