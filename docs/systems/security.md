---
system: security
sources:
  - packages/security/**
  - apps/orchestrator/src/http/security.ts
  - apps/orchestrator/src/engine/script-resolve.ts
  - apps/orchestrator/src/http/launch-tickets.ts
  - apps/orchestrator/src/services/agent-isolation.ts
  - scripts/windows/agent-relay.ps1
verified_at: 57af61a
---

# Security

## Local service ([security.ts](../../apps/orchestrator/src/http/security.ts))

1. **Host header** must be `127.0.0.1`, `localhost` or `[::1]` → blocks DNS rebinding (421).
2. **Origin**, when present, must be a loopback `http://` origin, a `vscode-webview://` origin, or listed in `ACC_ALLOWED_ORIGINS` (403). Allowed origins get CORS headers.
3. **Bearer token** for `/api/*` and `/ws` (`?token=` for WebSockets, compared in constant time); `GET /oauth/mcp/callback`, outside `/api`, is proven by the single-use sign-in state it carries instead ([mcp.md](mcp.md#oauth)), still behind checks 1 and 2. The token lives in the data folder; the dashboard gets it through its own same-origin HTML. With agent isolation off, any request for `/` from this machine receives it, so a local program, an agent's included, can take it from there (agents' native tools are refused the port by name only, [Permission levels](#permission-levels)); with it on, only a request carrying a launch ticket does ([Agent OS boundary](#agent-os-boundary)). The check is decided on the percent-decoded path **and** the route the router matched, never on the raw request line (the router decodes `/%61pi/…` to `/api/…`); an undecodable path is 400. The tool-session and connected-app exemptions apply only when the matched route is in that group.
4. Binds to loopback only; `ACC_HOST` elsewhere is refused unless `ACC_ALLOW_REMOTE=1`.
5. Dashboard HTML ships a strict CSP (`script-src 'self'`, no framing).

## Subscription-only guard ([env-guard.ts](../../packages/security/src/env-guard.ts))

In Subscription Only mode every child process (agents and repository commands)
loses `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`, `*_BASE_URL` and other metered-provider
keys (case-insensitive). In **every** billing mode each child also loses the
ambient provider credentials an operator keeps in their own environment
(`AMBIENT_CREDENTIAL_ENV_VARS`: `CLOUDFLARE_API_TOKEN`, `GH_TOKEN`/`GITHUB_TOKEN`,
`NPM_TOKEN`, `AWS_*` keys, `DATABASE_URL`, deploy-platform tokens, and image,
video and voice generation keys such as `FAL_KEY`, `REPLICATE_API_TOKEN`,
`RUNWAYML_API_SECRET`, `ELEVENLABS_API_KEY` …); a tool that
needs one receives it from the credential broker for that call only. Git — and
therefore every repository hook — and the Playwright browser run with
`credentialFreeEnv`, which strips all of the above whatever the mode. At start
the orchestrator logs the **names** of any such variable it withheld.
`CLAUDE_CODE_OAUTH_TOKEN` (the subscription sign-in) is kept. Adapters verify the CLI's own login before each launch
(cached 5 minutes) and refuse API-key logins; a Claude Code run also stops
unless its init event reports `apiKeySource: none`, a missing field or a
missing init event included ([agents-claude-code.md](agents-claude-code.md#claude-code-agent-claude)). The shared adapter
conformance kit checks the stripping and the login refusal for every adapter
([agents-contract.md](agents-contract.md#adapter-conformance-kit)). Explicit API Mode requires typing
`API BILLING` in Settings → Billing — checked by the server: `PATCH /api/settings`
with `billingMode: 'api'` is 422 `CONFIRMATION_REQUIRED` unless the body carries
`confirmation: 'API BILLING'` — and shows a persistent indicator.

## Redaction ([redact.ts](../../packages/security/src/redact.ts))

Applied to log lines (stateful across multi-line private keys), command
strings, directives, artifacts, event messages and error text before storage
or broadcast, and to terminal output whole lines at a time: the line in
progress is held back briefly so a secret split across two chunks is redacted
whole, and a private key stays hidden across chunks (`streamRedactor`,
[pty.md](pty.md)). Covers provider key formats, GitHub/GitLab/Slack/AWS/Google/
Stripe/npm tokens, Hugging Face (`hf_`), PyPI (`pypi-AgEIcHlwaS5vcmc…`),
SendGrid (`SG.x.y`), Shopify (`shpat_`/`shpca_`/`shppa_`/`shpss_`), Supabase
(`sbp_`), Sentry (`sntrys_`, `sntryu_`), Linear (`lin_api_`) and Telegram bot
tokens (`<8–10 digits>:A…`, anchored so a host:port, a longer number or a
timestamp is not one, but found in a path segment and in the Bot API's own
`/bot<token>/` URL), JWTs, bearer/basic headers, URL credentials, cookies,
`secret-name=value` pairs, the signature and session parameters of signed URLs
(`sig`, `signature`, `X-Amz-Signature`, `X-Goog-Signature`,
`X-Amz-Security-Token`, `X-Amz-Credential`, `X-Goog-Credential`: only their
values, so host, path and expiry stay readable), and the literal values of
sensitive environment variables present on the machine and of registered
secrets (brokered credentials, the local token, sign-in tokens). Each literal
value it masks (8–512 characters) is also masked in its encoded spellings
(`encodedForms`): base64 and base64url at all three byte offsets (so it is found
inside the encoding of `user:secret`), hex and percent-encoding (URI and form
style, of the value and of its base64, and every byte as `%XX`) in any case;
an 8-character value's spellings (base64 cores of 10, hex of 16) are no weaker
than the value. A stretch between spaces, quotes and `?`/`&`/`#` that shows
such a value, or a token of a blocking format, only once its `%XX` escapes are
decoded (`percentDecoded`) is masked whole, however few of its characters are
escaped (`%51uartz…`, `%67hp_…`).

An `Authorization:` header value is masked whatever it looks like (any
scheme, any case, all lowercase), `:` included, so both halves of a fal
`Key <id>:<secret>` go. A `Bearer`/`Basic`/`Token` value elsewhere is masked
in any case too. Two design spellings stay readable
([design-agent.md](design-agent.md)) only when they are the whole value, with
regression tests showing real credentials still masked: a CSS custom property
(`token --color-accent`, also after `Authorization:`) and, outside that
header, plain hyphenated words (`Basic typography-scale`); a value that only
starts with `--` is masked. A `?`/`&` parameter that names a secret
(`?api_key=…`, a form body's `&client_secret=…`) ends at the next parameter,
so the rest of the URL stays readable; any other `key=value` secret keeps `&`
(a password may hold one). After names such as `accentToken` a design value
(`#3355ff`, `rgb(…)`/`oklch(…)`, `var(--x)`, `1.25rem`) is skipped only when it
is the whole value: `#Bad!Pass99` and `2024%SummerPass` are masked.

`detectSecrets` reports which **blocking** rules match (provider keys, cloud,
registry and SaaS tokens including the formats above, credentials in URLs,
private keys — not JWTs or the broad `key=value` rule) and [sensitive-files.ts](../../packages/security/src/sensitive-files.ts)
names files that are secret by name (`.env*` except `.example/.sample/.template`,
keys, keystores, `.npmrc`, SSH and cloud credentials). Source Control uses both to
block commits and pushes ([source-control.md](source-control.md)).

## Command classification ([commands.ts](../../packages/security/src/commands.ts))

Repository commands, agent tool calls and agent terminal input are classified
before running; `npm/pnpm/yarn run X` is expanded to the script body
(including pre/post and nested scripts, [package-scripts.ts](../../packages/tools/src/package-scripts.ts)).
The classifier is shell-aware ([shell-parse.ts](../../packages/security/src/shell-parse.ts)):
it splits on `; && || | & newline` outside quotes, unwraps `cmd /c`,
`powershell -Command`, `bash -c` and `wsl`, decodes `-EncodedCommand` and
judges the decoded script, and expands PowerShell aliases (`iex`, `iwr`,
`ri`, `rm`, `kill`, `saps`…). It returns `effects` (filesystem, git, network,
credentials, privilege, database, infrastructure, production, process,
persistence, code-execution) and `readOnly`; a read-only command (git
status/diff/log, `Get-ChildItem`, `Get-NetTCPConnection`, `--version`…, no
redirection, substitution or method calls) is Level 1.

Dangerous (Level 5): anything that names the Control Center's own data
folder, token or key files, or its listen address (`AIDevControlCenter`,
`auth-token`, `privileged-key`, `credential-key`, `127.0.0.1:4317`; the real
folder and port are set at start with `setSelfReferences`) — and
`ToolService.invoke` refuses **any** agent tool call whose input names them.
Claude Code's own tools are held to the same names from outside the tool
layer: deny rules on the token, database and key files and the port, and,
from Level 2, a precheck of every native shell command and file read
([Permission levels](#permission-levels)).
Agents' worktrees live in the work root, outside the data folder, so naming
their own files trips none of this ([orchestrator.md](orchestrator.md#work-root-acc_work_dir)).
No agent works inside the data folder: a task folder the move at start could
not relocate has its runs refused before they start, and the task waits for you
with the reason (`runners.launchAgent`, [orchestrator.md](orchestrator.md)).
So the self-reference check reads every call as written, and any path into the
data folder is refused however it is spelled — through a space or bracket in
the path, the root in its own quotes, in a variable or in another argument
(2026-09-28: an earlier version wrote a task's own folder relative before this
check, and a climb out of it then hid the data folder's name; guessing where a
relative climb lands from the text was tried and dropped, since each rule
opened another gap). A call is classified — never checked for self-reference —
with the task's own folders written relative (`relativizeOwnRoots`), in two
readings, the stricter counting: relative to the folder it runs in (a sibling
repository of a multi-repository task is `..\api`, so the release gate reads the
right one) and relative to the root that holds each path (`git -C <api> checkout
-- <api>` is `git checkout -- .`, discarding everything).
All of it is lexical, and unless agent isolation is on agents run as the
operator's own Windows user: a program that builds the path or the address at
run time, or reads the files through anything these guards do not read, is not
stopped. They narrow the way to the token; the boundary the operating system
enforces is the separate agent account ([Agent OS boundary](#agent-os-boundary)).
A page a tool drives is judged by `webUrlReferencesSelf` for web URLs: the
address in any spelling, one carried inside the URL, or the data folder — not
the key files' bare names, which are ordinary path words on other servers
([browser-and-web.md](browser-and-web.md)).
The address is matched in every spelling Node's URL parser normalises
(`referencesSelf`): each URL in the text, and a scheme-less `host:port` with
any numeric or dotted host, is first normalised by Node's URL parser, so `127.1:4317`,
`2130706433:4317`, `0x7f000001:4317`, `0017700000001:4317`, `0:4317`,
`0177.0.0.1:4317` and `[::ffff:127.0.0.1]:4317` (normalised to
`[::ffff:7f00:1]`) are the listen address, while `127.0.0.1:9` and a slice
such as `x[0:4317]` are not (`isLoopbackHostname`: 127/8, 0.0.0.0,
`localhost`, `*.localhost`, `::1`, `::`, IPv4-mapped forms). A command is also
read with its quoted pieces joined as the shell joins them
(`curl "http://127.1":4317/`), with curl's `--resolve name:4317:127.0.0.1`
(the Host check passes a request with `Host: localhost` sent there), with a
loopback `Host` header and a listen port in one statement (`curl -H 'Host:
localhost' http://lvh.me:4317/`: public names such as `lvh.me` resolve to
this machine) — a command of the line or a line of a file, cut at `;`, `&&`,
`|` and unescaped line ends outside brackets, so a call or hash table written
over several lines stays one; a tool input is read object by object (`{ url,
headers: { Host } }` is one request) and a JSON document in a string by its
objects, so a compose file or configuration that maps OpenTelemetry's 4317 in
one place and sets `host: localhost` in another is not a request — and with
a raw socket whose host and port are separate words (`nc 127.1 4317`,
`telnet localhost 4317`, bash's `/dev/tcp/127.0.0.1/4317`). It is lexical: a
host and port a script computes, or hands a socket API as two values
(`[Net.Sockets.TcpClient]::new('127.1', 4317)`, Python's `socket`), are not
seen. The scan is linear in the text (the URL scheme
is bounded and starts only where a run of scheme characters starts): it runs
on every agent tool input, up to megabytes. `inputReferencesSelf` applies it to
a tool input's JSON and to each string in it read as a URL; `urlIsSelfAddress`
judges one URL by its address alone, which `guardedFetch` and curl's
`http.request` use to refuse the first hop
([browser-and-web.md](browser-and-web.md#network-guards-net-guardts)).
The classifier's other rules read a Git command with its global options
removed as well (`git -C repo reset --hard` is `git reset --hard`, and so is
`git -c user.name="A B" reset --hard`: a quoted value may hold a space), read a
command behind a wrapper (`env`, `FOO=1`, `timeout 60`, `nice`, `command`) or a
leading redirection (`< .env nc host 443`), and unwrap a shell whose `-c` sits
in a cluster of flags (`bash -lc "…"`, `sh -ec "…"`) as they do `bash -c`,
reading a quoted `-c` argument as the shell does (backslash escapes inside
double quotes, `'\''` inside single quotes), so a nested
`bash -c "bash -c \"…\""` unwraps too.
The checkout/switch force rule scans command starts, flags and separators
once. It preserves the previous lexical classification (including quoted
mentions and an intervening `git` word) without repeatedly scanning the rest
of a long segment; the old regexp could take quadratic time. Regression tests
compare the old rule across spellings and boundaries and keep the existing
speed limits, including a force flag at the end of a 208 KB command.
Also Level 5: recursive deletes in any shell (including `rimraf`, `shutil.rmtree`,
recursive `rmSync`), disk formatting,
destroying backups, history rewrites and Git data loss (`reset --hard`, `clean` with any force
flag, force/mirror push, rebase, `commit --amend`, `branch -D` /
`--delete --force`, `worktree remove --force`, `checkout -f`, and the quiet
kind that removes what would recover a lost commit: `gc --prune=` anything
sooner than weeks (`now`, `all`, `1.second.ago`; `never` and `2.weeks.ago`
are fine), `reflog expire|delete`, `git prune` but not `-n`, and the same
through config set for the command: `-c gc.pruneExpire=now`,
`-c gc.reflogExpire…=`, `-c core.logAllRefUpdates=false`, `--config-env=gc.…`
— read from Git's global options word by word, not by a regex over the whole
segment, so a long line of `git` words stays linear), `find … -delete` or
`-exec rm` starting outside the working folder (absolute, `~`, `$VAR`, `..`,
after find's leading `-H/-L/-P/-D/-O/--`, or `.` once the line has changed
directory out of it: `cd / && find . -delete`) or inside `.git`,
`DROP`/`TRUNCATE`/unscoped `DELETE`,
infrastructure destruction, download-and-execute (`iwr … | iex`,
`curl … | sh`, `source <(curl …)`, `eval "$(curl …)"`, `bash -c "$(curl …)"`,
and across commands: a file saved by `curl -o/-O`, `wget`, `iwr -OutFile`,
`DownloadFile`, BITS, a redirection (`curl … > x.sh`, `irm … > x.ps1`) or a
`| tee`/`| Out-File`/`| Set-Content` it feeds, that a later command of the line
runs — `curl -o x.sh … && sh x.sh`, also through `env`, `VAR=…`, `timeout N`,
`nohup`, `exec`, `nice`, `xargs`), elevation (`Start-Process -Verb RunAs`, `sudo`, `runas`),
Defender tampering, shutdown/boot changes, deleting services or registry data,
and anything targeting production. Level 4: registry writes,
`Set-ExecutionPolicy`, scheduled/startup jobs, service start/stop, firewall,
system package installs, `Invoke-Expression`/dynamic code (`eval`,
`source <(…)`, `bash <(…)`, `. <(…)`), base64 decoded and run
(`… | base64 -d | sh`, `certutil -decode` or `[Convert]::FromBase64String`
with `iex`; a literal payload is judged by what it decodes to), remote commands,
stopping processes by name, reading stored credentials, sending a secret file
(one `sensitiveFileReason` names: `.env*`, keys, cloud and SSH credentials) with
`curl -d/--data*/--json @f`, `-F name=@f`, `-T f`, a file of headers (`-H @f`,
each line sent as a header) or a cookie file (`-b f`, a value without `=`),
`wget --post-file|--body-file`,
`Invoke-RestMethod -InFile`, its content put on the line (`curl -d "$(cat .env)"`,
`$(< .env)`, `iwr … -Body (Get-Content .env)`), `nc|ncat|telnet host port < f`
(or `0< f`, or `< f` before the command), `cat f | nc …` (or `base64`, `xxd`,
`od`, `gpg` of it), `socat FILE:f …`, an archive of it piped to a socket,
`ssh|plink host … < f` or piped into ssh, `gh gist create|edit`, `gh release
create|upload`, `aws s3 cp|mv|sync … s3://`, `gsutil`/`gcloud storage cp … gs://`,
`az storage blob upload -f`, or scp/pscp/rsync/`Copy-Item -ToSession` (a
one-letter host too, an ssh config alias: `scp .env s:/tmp`; `C:\x` is a drive),
deploys, `gh secret|variable set|delete`. Level 3: `git restore <path>` / `git checkout --
<path>` (discard changes to files); uploading any other file to a host that is
not this machine (the same forms — content put on the line counts only for a
secret file — and `tar czf - . | nc host 443`; a loopback target stays Level 2); scp, pscp, sftp and rsync to or from a host, and
`Copy-Item -ToSession|-FromSession`; `find … -delete` / `-exec rm` inside the
working folder. Not covered yet: `npx pkg`, `pnpm dlx pkg` and the like stay
Level 2, as `pnpm add pkg` does — telling a package the repository already has
from one fetched to run needs its lockfile, which the classifier does not read.
The listing forms of `git branch`, `tag`,
`remote`, `config`, `reflog`, `worktree` and `stash` are read-only only when
they are the whole command (`git branch new` or `git tag v1` is not). Level 5 always
needs an approval with a typed confirmation (the task ID). `git push origin
main` and `gh pr merge` stay Level 3 for the classifier, which knows no
repository, and so does a push only `gitPushTargets` reads (`git $c origin
main`, `git -c alias.p=push p origin main`, `git send-pack`, `echo "git push
…" | bash`, a `gh api` write to a branch): "Pushes to a remote".
`gitPushTargets` reads where each `git push` of a line sends branches
(`unknown` when a destination is only known when the line runs, `dirs` for a
push of HEAD in a folder the line moved to, `aliases` for subcommands the
repository's config may alias, and `before`: what the same shell ran
earlier), `mergesPullRequest` finds a pull-request merge, and the tools that
know the repository raise a push to its release branch or a production-named
one, an unreadable one, and a merge to Level 5: `git.push`, every tool that
runs a command line — `shell.*`, `process.exec|start`, `terminal.send`,
`git.bisect`, `verify.web`, `node.run_script` — a terminal's line at Enter,
and the commands the engine's stages run
([tool-system.md](tool-system.md#the-execution-door-servicets)). Claude's
native shell denies the usual spellings from Level 3 ([agents-claude-code.md](agents-claude-code.md)).

## Chairman ([chairman.md](chairman.md))

- Every Chairman action passes one gateway: schema, initiator permissions,
  task state, stale-version check (supervisor decisions always; API callers
  when they send `expectedVersion`; chat acts on current state), per-task lock,
  idempotency key, audit row.
- Agent output, logs, tests and repository text reach the reasoning model only
  inside `<untrusted_evidence>` fences it cannot close (the snapshot's
  agent-written fields included), and the model can only pick a pre-validated
  strategy; its guidance passes the learned-text safety scan; directives — text,
  kind and rule — come only from the user's own words.
- Chat has no shell: messages become typed actions or answers. Chairman text,
  decisions and directives are redacted before storage.
- Ask ([ask.md](ask.md)) runs every answer at permission level 1 through the
  metered launch. No route or setting raises the level. Its data tools are a
  read-only tool session: an allow-list of reads (refused, never escalated,
  otherwise), pinned read-only keys with no fallback to any login, strict
  single-statement read SQL, allowed GitHub owners, a fixed Cloudflare account,
  and personal data masked by default. No generic web or HTTP access, so read
  data leaves the machine only to the model provider. Questions and answers are
  redacted, Control Center records reach the prompt only as fenced evidence,
  and nothing about Ask is relayed to the cloud.

## Tool layer

- Tool sessions ([mcp.md](mcp.md)) use their own random, in-memory,
  per-execution tokens; `/api/tool-session/*` accepts only those (the local
  API token is refused there) and they open no other route. Host and Origin
  checks apply as everywhere. `/api/tool-session/precheck` answers only the
  live agent session of a running stage; a session opened for the shell guard
  alone (tools off for agents) opens no tool route
  ([tool-system.md](tool-system.md#sessions)).
- Every path a tool touches is confined to the task's roots after resolving
  links ([paths.ts](../../packages/tools/src/paths.ts)); files holding the
  user's pre-existing work are refused for writes, commits and restores. For
  `git.stage`/`git.commit`/`git.restore` a pathspec is refused when it is the
  protected file, any folder above it or the whole tree (case-insensitive on
  Windows, absolute paths made relative), and Git runs with
  `--literal-pathspecs`, so globs and pathspec magic are plain names.
- Connected apps ([connected-apps.md](connected-apps.md)): `/api/connected-app/*`
  skips the local token and refuses any `Origin`; each route accepts only a
  paired app's token (stored as a SHA-256 hash), which opens nothing else.
  Both route groups refuse `x-acc-remote-request`.
- Credentials: [credential-broker.md](credential-broker.md), including the
  MyVault bridge: its routes take the local token like any `/api` route, are
  not tools, not MCP and not remote operations, and trusted MyVault origins
  are added only from the dashboard. A `media` (generation) key opens only for
  a read that asks for that kind — the media tools, behind the spend gate;
  `http.request`, a secret put or an MCP server's variables get nothing.
  `http.request` sends a credential only to a host in its audience (its kind's
  hosts by default; [credential-broker.md](credential-broker.md#audience)):
  otherwise agents are refused and operators asked.
- Outbound secrets ([dlp.ts](../../packages/security/src/dlp.ts), SEC-4):
  before `http.*`, `web.read`, `web.search` or an outside MCP tool runs,
  ToolService searches what the caller wrote (URL, headers, body, query, MCP
  arguments, every string at any depth, and the name and content of each
  `http.request` multipart file, read inside the roots before the check; the
  run sends those very bytes, and a file the check could not read is not sent)
  for every value the redactor knows — stored credentials, the local token,
  sensitive environment values — raw, percent-decoded (byte by byte, so a
  stray invalid `%FF` hides nothing) or in any encoded spelling above, also
  when broken up the way tools print it (base64 wrapped over lines, hex bytes
  spaced or separated by `:` or `-`), and
  for a token of a blocking format that is not stored (a URL's own
  `user:pass@` is not one; a loopback URL may carry one, an app under test's
  own test key, but never a stored secret). A stored credential going to a
  host of its own audience, from a repository that may use it, is no finding.
  A host whose own name carries a finding is never named (`namedHost`). A finding refuses an agent or a
  read-only session and asks anyone else; it is named by kind, name and host
  in the refusal, the approval and a `TOOL_CALL` event, never by value
  ([tool-system.md](tool-system.md#the-execution-door-servicets)). The check
  fails closed: when the stored values cannot be read (the credential key will
  not load) it is itself a finding. Claude's
  native shell is outside this door (its precheck is SEC-3's).
  Policy and the
  privileged helper: [autopilot.md](autopilot.md). Terminals are loopback only
  ([pty.md](pty.md)).
- Redaction also covers values the broker hands out
  (`registerSecretValues`), every stored value the outbound check has read
  (so a call it stops records none, even after a restart), and their encoded
  spellings, and variables the
  broker manages are stripped from every inherited environment along with
  `ACC_TOOL_SESSION`.

## Permission levels

1 Analyze · 2 Develop · 3 Git · 4 Infrastructure · 5 Production. Default
auto-approve: up to 3 (global, per repository, per task). Stages above it wait
for approval.

**A repository or the operator's CLI settings cannot widen a stage**
([agents-claude-code.md](agents-claude-code.md)). Claude Code adds the `permissions.allow` rules of every
settings file a run loads (a repository's `.claude/settings.json` allowing
`Bash(*)`, for one) to the Control Center's, and only a deny rule or a missing
tool beats an allow rule; so each level's limits are deny rules, and Level 1,
whose "read-only commands only" no deny rule can express, has no shell — it
reads Git through the Control Center's own tools. Claude Code hooks are shell
commands outside every permission rule, and `-p` runs a repository's in any
folder, trusted or not, so Level 1 runs no hooks at all (`disableAllHooks`); from
Level 2 hooks stay on, so the operator's own secret guards keep working and the
Control Center's own runs: one PreToolUse hook (matcher `Bash|Read|Grep|Glob`)
that asks `/api/tool-session/precheck` before every native shell command and
every native file read, and refuses on any error, an unreachable orchestrator
included. A file read is judged by the paths it reads (Read's `file_path`,
Grep's `path` and `glob`, Glob's `path` and `pattern` — never Grep's search
text), as given, resolved against the run's folder and the CLI's, and through
links: one that names the Control Center (`referencesSelf`: its data folder,
token and key files) is refused with "Reads the Control Center's own data
folder, token or key files", and a Grep or Glob of a folder that holds the data
folder with "Searches a folder that holds…"; the learned plugins and the task's
own attachments may be read, like everything outside the data folder. Each
refusal is a `native.read`, `native.grep` or `native.glob` row, as a refused
command is a `native.bash` one ([tool-system.md](tool-system.md#sessions)).
Level 1 cannot carry the hook — the switch that keeps a repository's hooks from
running switches off the Control Center's too — so its reads have only the deny
rules. The hook's script
(`dist/acc-shell-guard.mjs`, `.mjs` so no package.json decides how it loads) is
out of the run's reach the same lexical way: an Edit rule on its folder, and the
precheck refuses a command that names the script or its folder to do more than
read — changed, replaced or removed, it would let every later command through.
Where it cannot run — no build,
or a repository whose settings switch hooks off — the run has no native shell
at all, and its reads keep only the deny rules. At every level the run's deny
rules refuse Claude's own tools the token, database and key files, the listen
port by name, and Claude Code's settings files ([agents-claude-code.md](agents-claude-code.md)) — from
Level 2 a backstop behind the hook. Codex runs with
`--ignore-rules`, because an execpolicy `allow` rule runs a command outside the
sandbox. `pnpm verify:agents --permissions` proves the Claude side with real
runs in a repository that allows `Bash(*)` and carries hooks, and `--run` the
native-tool guards against a throwaway Control Center.

## Agent OS boundary

**Decision (SEC-3): agent stages run as a separate, low-privilege local Windows
account — opt-in, reversible, off by default.** The setting is
`agentIsolation` (`mode: 'off' | 'account'`, `account`, default `off` /
`acc-agent`; [schemas.ts](../../packages/shared/src/schemas.ts)), changed on
this machine only: a cloud settings change that turns it on or off or renames
the account is refused ([guards.ts](../../apps/orchestrator/src/remote/guards.ts)).
Off, nothing changes. The lexical guards above apply in both modes.

Why this one:
- **Claude Code's sandbox** runs on macOS, Linux and WSL2; "Native Windows is
  not supported" (code.claude.com/docs/en/sandboxing, CLI 2.1.283). The Control
  Center runs on native Windows.
- **Codex's sandbox as the only runner from Level 2**: on Windows it confines
  writes, not reads, so the data folder stays readable — and Claude Code would
  leave every Level 2+ stage.
- **A separate account** is the only read denial of the data folder the
  operating system enforces natively, and it is undone by removing the account
  and its folder permissions.

With `account`:
- **Every stage run** (Stage Team workers too) starts as the account through
  [agent-relay.ps1](../../scripts/windows/agent-relay.ps1) — same program,
  arguments, folder, environment (its user-folder variables its own), prompt on
  stdin, streamed output and exit code, the whole run in a job that ends with
  the relay ([agents-contract.md](agents-contract.md)). A run that cannot start so fails with
  `PERMISSION_DENIED` and the reason; it never runs as the operator. Ask, the
  Chairman and commit-message drafts — Level 1, no shell, working in the data
  folder or your repository — stay runs as you.
- **No Control Center tools in a stage run** (`EngineTooling.stageToolsOffered`):
  they run as you, so a run could have `shell.run`, `process.*`, a test or
  install tool read what its account may not. Its tool session is the shell
  precheck's alone (`guardOnly`; the tool routes answer 403), and the run log
  says so.
- **What the account may touch**: denied the data folder (an inherited deny of
  everything) except the learned plugins, which it reads; changes the work root;
  reads, and cannot change, the program folders it runs from that sit inside your
  user folder (the orchestrator's build — shell hook and MCP bridge — Node, each
  agent CLI).
- **Launch tickets** ([launch-tickets.ts](../../apps/orchestrator/src/http/launch-tickets.ts)):
  `GET /` and every page path carry the token only with `?ticket=` from
  `POST /api/launch-tickets` (the token; refused from the cloud) — random,
  single use, 60 s, in memory, at most 32 waiting. Without one: 403 and a line
  saying to open the dashboard from the launcher (a reload needs it again). The
  dashboard drops the ticket from the address bar. `start-control-center.ps1`
  asks for one; the VS Code extension reads the token file and needs none.

**Setting it up** (the operator, once, as the Windows user that runs the Control
Center, with administrator rights — elevating as another user would save the
password for that user, and runs would then refuse):
1. Run `system.privileged` `{ "operation": "agent_account_create" }` (Level 5:
   `POST /api/tools/call` with a `repositoryId` and `"confirmation":
   "system.privileged"`), and accept the UAC prompt. The helper creates the
   account (or gives it a new password): a standard user hidden from the
   sign-in screen, marked by its description; a random password saved only for
   you (DPAPI, `<data>/agent-account.json`, never shown or logged); the folder
   permissions above, recorded in the same file ([autopilot.md](autopilot.md#privileged-helper)).
2. Sign in as it once (`runas /user:acc-agent cmd`) and sign the CLIs in there
   with your subscription (`claude` → `/login`, `codex login`): it has its own
   logins. Health checks still check yours; each run's own billing check
   (Claude's `apiKeySource`, Codex's `forced_login_method`) still applies.
3. `PATCH /api/settings` `{ "agentIsolation": { "mode": "account" } }` on this
   machine.

**Undoing it**: `{ "agentIsolation": { "mode": "off" } }` (immediate), then
`agent_account_remove`, which removes the account's permissions from every
folder it recorded, the account, its user folder (its CLI logins) and the record.

**Open until the operator sets it up** — none of this has run here: the live
proof that reading `auth-token` inside a run fails with an OS access-denied;
the relay's real start as the account (`CreateProcessWithLogonW`, the Secondary
Logon service), the job ending a cancelled run's tree (`taskkill /T` cannot end
the account's processes itself), whether a console window shows, inline
`--mcp-config`, plugins read below the denied data folder. Known limits: the
boundary covers the agent's run only — the engine's own steps still run as you,
the tests stage and other repository commands included, and those run code the
agent may have written; the account cannot read your repository's `.git`, so Git
commands the agent runs in a worktree fail (and the run has no `git.*` tools);
nor task attachments in
the data folder (Codex `-i` pictures); a work root inside your user folder relies
on Windows' traverse bypass (set `ACC_WORK_DIR` outside it if a CLI objects); the
dashboard's development server (`pnpm dev`, port 5173) puts the token in every
page, so do not run it with isolation on.

## Cloud control plane

Two trust boundaries ([cloud-control.md](cloud-control.md)): people reach the
control hostname only through Cloudflare Access, verified again by the Worker
(fail closed until configured); machines reach the relay hostname with a P-256
key and short-lived sessions. The orchestrator never listens for the cloud: it
dials out, stays on `127.0.0.1`, and the local token never leaves the machine.
The cloud may only ask for typed catalog operations, each mapped to one fixed
local route, so the classifier, approvals, tool policy and subscription-only
guard apply unchanged; the node also refuses anything that would loosen what
runs without asking or what may be spent (billing, auto-approve, policy,
repository commands, paid media generation and media budgets) or which Windows
account agents run as (agent isolation, either way), and launch tickets and MCP
server sign-in and sign-out happen on the machine only.
Everything sent is allowlisted by message type, stripped of path and secret
fields, path-scrubbed and redacted ([remote-node.md](remote-node.md#egress)).
Revocation from the cloud or the admin CLI stops the node for good.

## Gotchas

- Tests build fake credentials at runtime. The repository's own pre-commit hook
  ([.githooks/pre-commit](../../.githooks/pre-commit) →
  [secret-scan.ts](../../scripts/secret-scan.ts)) stops staged sensitive files and
  credential-shaped added lines for every commit, however it is made; it fails
  closed when it cannot run. `pnpm install` sets `core.hooksPath` to `.githooks`
  ([install-hooks.mjs](../../scripts/install-hooks.mjs)). A line that must keep a
  credential-shaped example carries `secret-scan: allow`. `git commit --no-verify`
  skips it; nothing else does.
- Redaction is conservative: values such as `API_KEY=absent` are masked too.

Last verified: 2026-10-01
