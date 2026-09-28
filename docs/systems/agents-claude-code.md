---
system: agents-claude-code
sources:
  - packages/agent-claude/**
verified_at: 57af61a
---

# Claude Code adapter

Part of [Agent adapters](agents.md).

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
- Runtime tripwire (Subscription Only mode): the init event must report `apiKeySource: none` (a claude.ai login). Any other value stops the run, and so does a missing field: it fails closed, because a CLI that stops reporting where its credentials come from cannot be told apart from one billing an API key. Both end `AUTH_FAILURE`, the missing field with its own message. A run with no init event at all (a renamed or dropped event) is stopped too, at the first event of a turn (`assistant`, `user`, `result`, `rate_limit_event`) that arrives before one (`AUTH_FAILURE`); one that exits 0 with no event at all fails `PROTOCOL_DRIFT` rather than succeeding. API Mode runs are not stopped. The run log's first line states what the event said (`· apiKeySource none`, or `(not reported)`; `loggedApiKeySource` reads it back), and `pnpm verify:agents --run` prints it for the installed CLI (`init apiKeySource: none | MISSING | NO INIT EVENT`; anything but `none` fails the check) — run it after every Claude Code update. The fake CLI omits the field when `FAKE_CLAUDE_APIKEY_SOURCE` is unset, renames the event with `FAKE_CLAUDE_INIT_SUBTYPE`, and prints nothing with `FAKE_CLAUDE_SCENARIO=silent`.
- Usage limits: `rate_limit_event` with `status: rejected`, or `api_error_status: 429`.

Last verified: 2026-09-28
