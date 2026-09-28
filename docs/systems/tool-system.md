---
system: tool-system
sources:
  - packages/tools/**
  - apps/orchestrator/src/tools/service.ts
  - apps/orchestrator/src/tools/store.ts
  - apps/orchestrator/src/tools/environment.ts
  - apps/orchestrator/src/tools/processes.ts
  - apps/orchestrator/src/http/tool-routes.ts
verified_at: 6dc1a91
---

# Tool system

The Universal Tool & Autonomous Execution Layer ([plan](../plans/tool-layer-v2/PLAN.md)).
Agents ask for **capabilities**; the Control Center picks the program that
provides one, decides whether the call may run, runs it and records it.

## Model ([sdk.ts](../../packages/tools/src/sdk.ts))

- A **provider** is something the machine has (`git`, `powershell`,
  `playwright`, `wrangler`, `adb`…) with `detect()` and, for account-bound
  tools, `checkAuth()`.
- An **operation** is a capability id (`git.status`, `network.port_owner`)
  with a Zod input schema (also its JSON schema for MCP), a base permission
  level, a per-input `classify()` and `run()`. A paid operation also declares
  `estimateCost()` (see the spend gate below); an outside MCP tool carries
  `inputJsonSchema`, its server's own schema, which agents are shown (the call
  is still validated by the Zod schema). An operation that sends what its
  caller wrote declares it with `outbound()` (URL or target, headers, body,
  a credential attached by name): `http.request` (fetch and curl alike),
  `http.health`, `web.read` (both providers), `web.search` (the query, to
  DuckDuckGo) and every outside MCP tool (its arguments, to its server's URL,
  or to the server by name for stdio). The outbound check below reads it.
- Several providers may offer one capability: `shell.run` (PowerShell, CMD,
  Git Bash, WSL), `network.port_owner` (Windows via PowerShell, netstat;
  elsewhere `ss`/`netstat`, then `lsof` where those show no pids, as on macOS),
  `http.request` (built-in fetch, curl).

Built-in packs live in [packs/](../../packages/tools/src/packs): shell,
filesystem, git, github, runtime (Node/pnpm/npm/Python/uv/Java), browser
(Playwright, including pages an agent keeps open —
[browser-and-web.md](browser-and-web.md)), http (+curl), web (search, read), network, windows, cloudflare, database (SQLite,
psql, mysql), docker, android (adb, Gradle), hosted (processes, terminals,
checkpoints, privileged helper, VS Code), verify, credential-broker
(`credential.generate`), installer (`software.catalog`, `software.install` —
a reviewed program list only, [learning.md](learning.md#programs)), media
(fetch, view, SVG, fal generation, FFmpeg) and design (contrast, token lint)
([design-agent.md](design-agent.md#media-tools)). The orchestrator adds
`environment` and one `mcp:<id>` provider per healthy MCP server
([mcp.md](mcp.md)). About 178 built-in capabilities in total.

## Registry, router, health

- [ToolRegistry](../../packages/tools/src/registry.ts): register/unregister,
  capability lookup, keyword search (for `acc_find_capability`).
- [ToolRouter](../../packages/tools/src/router.ts): filters by platform and
  installed state, then orders by caller preference (`shell: 'bash'`), recent
  failures of that provider in this task, provider preference. Every decision
  carries a readable reason stored as `tool_executions.route_reason`.
- [ToolHealthCache](../../packages/tools/src/health.ts): detection results
  persisted in `tool_health`, fresh for 6 hours, refreshed in the background
  at startup (`refreshStale`) and on **Check**; account checks only on
  request. A provider never checked is detected on first use, so routing never
  refuses a tool just because nobody looked yet. The cache detects without a
  folder; when that finds nothing and the call has a repository, the provider
  is detected again in that folder (cached 10 minutes per folder), so a
  project-local binary such as `node_modules/.bin/wrangler` is used without a
  global install.

## The execution door ([service.ts](../../apps/orchestrator/src/tools/service.ts))

`ToolService.invoke()` is the only way anything runs a tool (in a task across
repositories it first narrows the call to the repository its `cwd`/`directory`
names — roots and credentials included, [multi-repository-tasks.md](multi-repository-tasks.md#tool-calls)):

1. route → 2. validate input → 3. classify (`classify()` may raise or lower
the level: a recursive delete is Level 5, a read-only shell script Level 1;
judged, with the self-reference check, on the input with the task's own folders
made relative — `relativizeOwnRoots`, [security.md](security.md)) →
4. policy ([autopilot.md](autopilot.md)): allow, **escalate** (outside the
stage's profile but within its level — recorded in `capability_escalations`
and as a `CAPABILITY_ESCALATED` event), needs approval, or deny; before it, a
design stage's session (`designSession`: the designer role or the
`frontend-design` profile, of the stage as it runs or as the workflow declares
it, so a specialist on a design stage keeps it; set by `openAgentSession`) is denied every outside
MCP tool at any level (`DESIGN_MCP_REFUSAL`: they declare no cost, so the
spend gate cannot see them) and is not shown them →
4b. spend gate, for an operation with `estimateCost` (paid media): paid
generation on and the estimate within the task's and every stopping media
budget, reserved in one transaction and settled after the run, else `DENIED`
([design-agent.md](design-agent.md#spend-gate)) →
5. checkpoint before high-impact work in a task (level ≥ 3, or database
writes) → 6. inject brokered credentials ([credential-broker.md](credential-broker.md);
a credential kept for the orchestrator — the phone-alert token — is read only
by a Level 5 `cloudflare.secret_put` / `github.secret_put`, never another tool;
a `media` key only by a media tool that asks for kind `media`)
→ 7. run with timeout and cancellation → 8. redact → 9. record a
`tool_executions` row, publish `toolExecution`, and add a `TOOL_CALL` event
for notable calls (level ≥ 3, long-running, failures, verification evidence).

Between 3 and 4, an agent's call whose input names the Control Center itself
(its data folder, token or key files, or its listen address in any spelling
Node's URL parser normalises: `127.1:4317`, `2130706433:4317`,
`[::ffff:127.0.0.1]:4317`) is denied (`inputReferencesSelf`,
[security.md](security.md#command-classification-commandsts)).

Then the **outbound check** (SEC-4, `outboundCheck`), for an operation with
`outbound()`: a credential attached by name to a host outside its audience
(`CredentialBroker.outsideAudience`, [credential-broker.md](credential-broker.md#audience)),
and every known secret (stored credentials, the local token, sensitive
environment values) raw or encoded, or a token of a known format, in what the
caller wrote (`scanOutbound`, [security.md](security.md#tool-layer)) — and in
what the run reads from disk and sends: `http.request`'s `outbound()` reads each
multipart file inside the roots and the run sends the bytes it read (a file it
could not read fails the run unsent). The call's `inputSummary` is recorded
again after the check, which has taught the redactor every stored value; a
string in which the check still reads a secret once redacted (base64 wrapped
over lines, hex bytes spaced) is recorded as `[REDACTED]` whole. A finding
adds its reason and the `credentials` effect to the risk and is passed to
`decide()` as `leak`: after the stage-level check, an agent (or a read-only
session) is refused and anyone else asked — whatever the mode would run on its
own; a Level 5 call keeps its typed confirmation. The reason names kind, name
and host only (`Sends github credential "x" to h…`, `Carries the Control Center
token to h…`) — a host whose own name carries a secret or token, which WHATWG
parsing lower-cases past the redactor's reach, is named `a host whose name
carries a secret` (`namedHost`) — and each such call adds a `TOOL_CALL` event (`<capability>
refused` / `needs approval` / `sent with approval`, `data.outbound`: kind,
name, host, where, form). A check that throws — the credential key not
loading included — counts as a finding. The
operator's approval re-runs the call with `preApproved`, and only then may the
broker hand the credential to that host (`approvedSend`). `http.request` that
carries a stored credential off the machine is Level 3 with the `credentials`
effect even as a read (`classifyRequest`).
`classify()` gets the call's `cwd` (moved by the tool's own `cwd` input, where
it has one) and the release branches it can reach
(`ClassifyContext.releaseBranches`, from each release setting that pushes,
read at each call: the call's repository's and, in a multi-repository task,
every repository's — a shell in one can `git -C ../other push` as easily as
one at the workspace root). A push to one of them, or to a
production-named branch (`PRODUCTION_BRANCH`, from `PRODUCTION_BRANCH_NAMES`:
main, master, production, prod, release, live — compared without case,
`refs/heads/` stripped), is Level 5 production: a typed approval for the
operator, refused for agents; any other branch stays Level 3. So is a
pull-request merge (`gh pr merge`, or `gh api` `PUT …/pulls/<n>/merge`,
`POST …/merges`, GraphQL `mergePullRequest`): its base is not on the line.
That holds for `git.push` and for any command line a tool runs (`shell.*`,
`process.exec` — its argv quoted word by word, so `C:\Program Files\Git\cmd\git.exe`
or a branch named `x'` stays one word — `process.start`, `terminal.send`,
`git.bisect`, `verify.web`'s start command, `node.run_script`'s script bodies
— the call's args appended to the body as the package manager appends them,
so `"q": "git push"` run with `origin main` pushes main — `node.exec`'s argv;
`withReleaseGate` in [release-gate.ts](../../packages/tools/src/release-gate.ts)),
for the line a terminal runs when Enter arrives, however many sends it
took (`TerminalService.judgeLine`, agents' and the cloud's input alike, after
the lines that terminal ran before, and together with the earlier lines of a
command the shell is still reading: [pty.md](pty.md)), and for the commands
the engine's own stages run (`stageCommandRisk` in
[runners.ts](../../apps/orchestrator/src/engine/runners.ts): an agent can
edit a package script a later stage runs). `gitPushTargets` finds a push in
the ways a line runs one — behind `then`/`do`/`!`/`{`, PowerShell's `if (…) {`, in
`$(…)` or backticks, in a PowerShell grouping expression given as an argument
(`Write-Output (git push …)`, `[void](…)`, `@(…)`; not inside quotes), through
`bash -lc` (a nested `bash -c "…\"…\""` through its escapes), `cmd /c`,
`pwsh -c`, PowerShell's `Start-Process`/`saps` (`-FilePath` and each
`-ArgumentList` value split at commas and spaces) and wrappers (`env`,
`timeout 60`, `nice`), with an escape inside the program name (`g\it`,
`g^it`) or as Git's own push programs (`…/git-core/git-push`,
`git-send-pack`, `git-http-push`) — reads each refspec destination
(`HEAD:main`, `topic:refs/heads/main`), and reads options as Git's parser
does: the last of `-n`, `--dry-run` and `--no-dry-run` wins, an unambiguous
prefix is the option (`--al` is `--all`, `--mirr` is `--mirror`), and an
unknown or ambiguous option counts as unknown. A line continued with `\`, a
backtick or `^` at the end of a line is read both joined and not. A `gh api`
write to a branch is a push to it (`PATCH|DELETE …/git/refs/heads/main`,
`POST …/git/refs` with `ref=refs/heads/main`, a file written through
`…/contents/…` with `branch=main`, a branch renamed, `merge-upstream`, and
its CLI form `gh repo sync <repository>`, which writes `-b` or else the default
branch; without a repository it syncs the local one and pushes nothing). A
push with no refspec or `HEAD` is the branch checked out (read from the
worktree's `HEAD`; a reftable repository keeps a stub there, so Git is asked,
and a HEAD that cannot be read is a deploy) in each folder the push may run
in — the working folder and any folder below it the line moved to (`cd web &&
git push`, `git -C web push`, `pushd web`; every folder a group or a failed
`cd` may have left the shell in) — plus any branch the
line checked out first (`git checkout main && git push`, `git stash branch
main`, or renamed HEAD's branch to: `git branch -M main`), plus where the
repository's push settings send it (`remote.<name>.push`,
`push.default=matching|upstream`, read with `git config` only for such a
push). `--all`/`--mirror`/`:`/a wildcard count as every branch, a dry run as
none. A subcommand that is not one of Git's own (`git p origin main`) is
looked up in the aliases where it runs (each folder's aliases read once with
`git config -z --get-regexp '^alias\.'`, and each name looked up once, so a
long line of subcommands is not a long wait; followed through an alias of an
alias), and one that pushes, or runs a shell
command (`!…`) that pushes, is a deploy. It fails closed: a destination only
known when the line runs is a deploy — a variable or substitution (`git push
origin $b`; `$(git branch --show-current)` is read as `HEAD`), a remote that
may bring refspecs of its own (a PowerShell splat, `git push @b` or `git push
origin @b`; a variable a POSIX shell splits into words, `git push $r main`),
one the shell
rewrites (cmd's `ma^in`, bash's `ma\in` and history designators such as
`!^`), a subcommand only known when it runs or rewritten first (`git $c`,
`git "$(…)"`, PowerShell's `git @args`, `git pu\sh`), `send-pack`,
`http-push`, `subtree push`, an alias the line defines (`-c alias.p=push`,
`git config alias.p push && git p`), a program named by a variable and given
`push` (`$GIT push`, `& $git push`, `%GIT% push`), a command held in a
variable and run, directly or by an interpreter, on a line that says `push`
as a word of its own (not `pushd`, `Push-Location`, `services/push` or
`pusher.py`) or gives a variable a value naming Git (`x="git push …"; $x`,
`eval "$cmd"`, `iex $c`, `x="git pu"; y="sh …"; $x$y`) — in a terminal, an
earlier line counts only when it gave a variable such a value, so a
`node server.js --port $PORT` after a feature-branch push is no push — a
shell alias of Git the line
defines (`alias g=git`, `Set-Alias g git`), a push run by another command
(`xargs git push`, `find … -exec git push`), code handed to an interpreter as
a string (`python -c "…os.system('git push …')"`, `node -e`, a shell nested
past four levels, a quoted command piped into one: `echo "git push …" | bash`,
`'…' | iex`; a command built from a substitution's output; Git's own
`-c core.pager='sh -c "…"'` and `submodule foreach '…'`), a `gh api` write that
does not name its branch (a file on the default branch, GraphQL
`createCommitOnBranch`/`updateRef`, a body from `--input`), `gh repo sync` of
a repository without `-b`, or a push of `HEAD` after the line left the working
folder (`cd ..`, `git -C ../x`), checked out `-` or a pull request (`gh pr
checkout`, whose head branch is named only on GitHub), moved through more than
16 folders, or changed where a push goes (`git
config push.default …`, `-c remote.origin.push=…`, `GIT_DIR=…`, `HOME=…`, an
edit of `.git/config`). It reads the line, not the files and programs it runs:
a script (`bash ship.sh`, `node ship.js`), a program that pushes by itself, a
shell alias or function defined outside the line (or, in a terminal, outside
its history), or a value computed while it runs is judged by what the line
says. Before it pushes, `git.push` runs the
Source Control secret preflight (`scanOutgoing`,
[packages/git/src/preflight.ts](../../packages/git/src/preflight.ts), merge
commits' own changes included) on the branch minus its remote-tracking branch
(or, when there is none, minus what that remote already has,
`--remotes=<remote>`: a commit only another remote has is still read, so a
secret on a private remote is caught before it first goes to a public one) and
fails `DENIED` naming each file
and the kind of secret, never the value; a range over 20 MB is refused, not
partly checked. It pushes a local branch only (`refs/heads/<name>`: a tag or
remote-tracking name is `INVALID_INPUT`, never created as a remote branch),
and the commit it checked (`<sha>:refs/heads/<branch>`), not whatever the
branch points to by then, and sets the upstream afterwards when asked, in the
branch's config as `push -u` does (`branch.<name>.remote` and `.merge`): that
needs no remote-tracking branch, which a single-branch or shallow clone never
makes for it, and a failure there is reported with the push as done. Only
`git.push` runs this preflight: a push typed as a command line (`shell.run`,
`terminal.send`, `process.exec`) is rated by the release gate but not
scanned, and the preflight takes the local remote-tracking branch as what the
remote has, which a command can move (`git update-ref`). It keeps a secret
from being pushed by mistake; it does not stop an agent set on pushing one.

Packs that stream a child process's output keep only its last 4000 lines
(`pushBounded` in [detect.ts](../../packages/tools/src/detect.ts)), so a
chatty build cannot grow the orchestrator's memory without limit. Package
names that start with `-` are refused by `node.add_dependency`, and
`docker.build`'s Dockerfile is confined to the repository like its context.

Tool inputs are stored as redacted, bounded summaries; outputs are never
stored, only the one-line summary, evidence lines, artifact ids, files changed
and network targets.

## Sessions

`openSession(scope, 'agent' | 'operator')` returns a random token held only in
memory. Agent sessions are opened per agent execution and closed when it ends
([mcp.md](mcp.md)); operator sessions come from `POST /api/tool-sessions`.
`/api/tool-session/{tools,find,call}` accept **only** a session token (the
local API token is refused there, and a session token opens nothing else);
a `guardOnly` session (tools off for agents, or a stage run as the agent
account, [security.md](security.md#agent-os-boundary)) is refused there with 403.
`POST /api/tool-session/precheck` (SEC-3) is the native precheck a
Claude Code run's hook asks before each Bash command (`{ command }`) and each
Read, Grep and Glob (`{ tool, input, cwd? }`): only the live agent
session of a stage that is `STARTING`, `RUNNING` or `RETRYING` gets an answer
(`{decision: 'allow'}` or `{decision: 'deny', reason}`; anything else is 401
or 403, which the hook treats as a refusal). `ToolService.precheck` judges
the command as `shell.*` would — `classifyScript` with the call's release
branches, then `decide()` at the session's level with origin `agent` and the
command counted in profile, that level passed as `approvedLevel` (the stage is
running, so it passed its gate: an approved Level 2 stage in a task that
auto-approves Level 1, or a Level 3 one in Safe, runs its own level; above it,
and dangerous or production commands, stay refused) — and refuses whatever
`decide()` does not allow outright (a native command cannot wait for an
approval; the reason points to `shell.run` when the run has the tools), a
command that names the Control Center itself
(`referencesSelf`), one that names Claude Code's `.claude/settings*.json`
(through which the hook could be switched off), and one that names the hook's
own script (by file name, any path) or its folder (`ToolServiceDeps.shellGuardPath`,
either spelling) and is not read-only (`namesShellGuard`: changed or removed,
the script would let every later command through). The learned plugins folder may
be read by name (`excuseReadOnlyFolders`: a command that only reads, with no
`..` after the folder), nothing more. `ToolService.precheckFile` judges a
file read by the paths it reads (`NATIVE_FILE_PATHS`: Read's `file_path`,
Grep's `path` and `glob`, Glob's `path` and `pattern`) — as given, with `~` and
`/c/…` spelled out, resolved against the session's folder and the reported
`cwd` (a glob or pattern against the searched folder), and through links
(`realish`) — and refuses one that names the Control Center (`referencesSelf`)
or a Grep/Glob of a folder that holds the data folder; the learned plugins and
the task's own `tasks/<id>/attachments` may be read. Only refusals are
recorded: a `tool_executions` row with capability `native.bash` (the command as
its input summary) or `native.read` / `native.grep` / `native.glob` (the path
fields), status `denied`.
An agent's tool list is its profile within its level, minus capabilities it
already has natively (`fs.*`, `shell.*`, basic `git.*`), capped at 60; the
rest stays callable through `acc_call_capability`. Over the cap the list keeps
the front of the profile's `include` order (`profileRank`: its speciality such
as `cloudflare.*` first, general Git/GitHub/editor tools last), then lower
levels first.

**Read-only sessions** (`ToolScope.readOnly`, used by Ask — [ask.md](ask.md)):
an allow-list, pinned credentials, plain settings for the packs
(`CLOUDFLARE_ACCOUNT_ID`, `ACC_GITHUB_OWNERS`, `ACC_READ_ONLY=1`), personal-data
masking and a call limit. A capability off the list is refused before routing
and never escalated; the list is all `sessionTools` and `find` show. An
operation is a read only when it declares `readOnly: true` (and its `classify`
does not say `writes`); `decide()` then allows it whatever its level and
denies everything else. Credentials come from `envForPinned` — the named
credential of each kind or none, never another of the kind and never an
ambient login. Normal scopes are unaffected.

## Profiles ([profiles.ts](../../packages/tools/src/profiles.ts))

`analysis` (every Level 1 stage), `general`, `web-development`,
`frontend-design` (media, browser, design and verify tools first; no outside
generation server, since only `media.*` calls pass the spend gate), `cloudflare-worker`, `android-development`,
`python`, `operator`. Chosen from repository tooling unless the stage names a
`toolProfile` (any but `operator`). MCP capabilities never match a wildcard entry: only the
`operator` profile, or an explicit `mcp.<server>.*` pattern in a profile,
includes them (`profileIncludes`); an agent otherwise reaches one by
escalation (`acc_call_capability`) within its stage's level.

## Environment discovery

Before a task's first stage: OS, CPU, memory, disk, branch, dirty files,
project type, installed tools with versions, listening ports, the task's
processes, agents and MCP servers → `environment.md` artifact, an
`ENVIRONMENT_DISCOVERED` event, and an "Environment" section in investigator,
planner and implementer prompts. Also callable as `environment.discover`.

## Task processes ([processes.ts](../../apps/orchestrator/src/tools/processes.ts))

`process.start` (and the verify stage, and `cloudflare.dev`) start long-running
commands owned by a task: a port already in use is reported with its owner
instead of fought over; readiness is an HTTP poll; child pids are learned
(Win32_Process on Windows, `ps` parent links elsewhere) so "is this pid ours"
covers the real server under a shell. What an agent stage starts (a dev
server to look at) stops when that stage ends — `stopForStage`, with a
`PROCESS_STOPPED` event naming them — and the terminals its agent opened close
with it (`TerminalService.closeForStage`; which stage opened each is held in
memory, as a terminal does not outlive a restart), so a later stage, the App
check among them, does not find a port the stage left taken (TASK-0024,
2026-09-28). A server started by other means (a detached shell command) is not
tracked and still ends only with the task. Processes stop as a
tree when the task's loop exits in any state other than running/queued, on
completion and cancel, and at shutdown. After a crash, rows still marked live
are killed only if the pid's creation time (Win32_Process, or `ps -o lstart`)
is within 15 s of when we started it; otherwise they are marked gone.

## Tables (migration 5)

`tools`, `tool_capabilities`, `tool_health`, `tool_executions`,
`task_processes`, `pty_sessions`, `recovery_attempts`, `mcp_servers`,
`capability_escalations`, `credential_references`; `task_checkpoints` gains
`type` and `metadata`; `tasks.policy_mode`, `repositories.policy_mode` and
`repositories.runtime`. Migration 4 belongs to the usage ledger developed in
parallel; the two apply in either order. Migration 7 adds the MyVault link,
trusted-origin and credential-event tables ([credential-broker.md](credential-broker.md));
migration 20 `media_usage_events`, the spend gate's ledger; migration 21
`mcp_oauth` and `mcp_servers.auth`/`oauth_scope` ([mcp.md](mcp.md#oauth));
migration 22 `task_stages.condition_digest` ([workflow-engine.md](workflow-engine.md#profiles));
migration 23 the specialist role of a stage or work unit ([stage-teams.md](stage-teams.md#specialists)).

Secrets an agent needs but must not see go through `credential.generate`
(sealed in the orchestrator, returns metadata only) and are used by reference,
e.g. `cloudflare.secret_put {credential, secretName, environment}`, which feeds
the value to Wrangler on stdin, and `github.secret_put {credential, secretName,
environment?}` ([github.ts](../../packages/tools/src/packs/github.ts)), which
feeds it to `gh secret set` on stdin and proves the write by the secret list and
its update time (Level 4; an environment named like production is Level 5). Both
refuse a generated value MyVault has not saved yet — with MyVault's delivery box
set up it is saved within seconds, even while MyVault is locked
([credential-broker.md](credential-broker.md#delivery-box)). `CredentialHost`
gains optional `generate` and `deployGate` for this.

`cloudflare.pages_status {project, commit?}` (in the read-only REST pack
[cloudflare-api.ts](../../packages/tools/src/packs/cloudflare-api.ts), no
Wrangler needed) is Level 1 and `readOnly`: the Pages project's production
branch, its canonical (live) deployment — id, commit, latest stage and status,
URL — and, with `commit`, the newest production deployment built from it. It
needs the repository's `cloudflare` key; the account comes from a
`CLOUDFLARE_ACCOUNT_ID` credential or, when the key sees exactly one account,
from the key. No key → `UNAVAILABLE`. A release reads it through
`ToolService.invoke` (`origin: engine`, operator profile) to prove Live
([release.md](release.md)); tests point it at a loopback stand-in with
`ACC_CF_API_BASE`.

## API

`GET /api/tools`, `GET /api/tools/capabilities`, `GET /api/tools/:id`,
`POST /api/tools/:id/check {auth}`, `POST /api/tools/refresh`,
`POST /api/tools/call {repositoryId, capability, input, confirmation}`
(operator call; Level 5 runs only when `confirmation` equals the capability
id), `GET /api/tool-executions`, `GET /api/tasks/:id/execution`,
`GET /api/tasks/:id/processes`, `POST /api/tasks/:id/processes/:processId/stop` (the `task_processes` record id, not an OS pid),
`GET /api/processes`, `POST /api/processes/:id/stop`, plus the terminal, MCP,
credential, checkpoint and session routes in their own docs. Realtime:
`tool`, `toolExecution`, `taskProcess`, `recovery`, `escalation`.

## Gotchas

- Routing depends on detection: tests and fresh data folders detect lazily,
  so the first call to a capability can take a second longer.
- `page.evaluate` code in the browser pack reaches DOM globals through
  `globalThis`; the package compiles without DOM types on purpose.
- `git.bisect` ([packs/git.ts](../../packages/tools/src/packs/git.ts)) drives the
  bisect loop itself and reads Git's verdict from its words, which changed:
  Git 2.55 prints `is the first 'bad' commit` (quoted), older Git `is the first
  bad commit`. Before both were accepted, Git 2.55 left the verdict unread and
  the loop re-ran the test command on the same commit until its 64-step cap;
  the loop now also stops as soon as bisect stops moving. The whole suite has
  been run against a portable Git 2.55 (GitHub's Windows runners use it).
- `node-pty`, `playwright-core`, `better-sqlite3` and `axe-core` stay external
  to the orchestrator bundle and must be dependencies of `@acc/orchestrator`.

## Folder detections after an install

Tools detected in a folder are cached 10 minutes; when a worktree's background dependency install ends, `ToolService.forgetFolder(cwd)` drops that folder's entries, so a tool (a local Wrangler) found missing during the install is found afterwards ([checkpoints.md](checkpoints.md)).

Last verified: 2026-09-28
