---
system: security
sources:
  - packages/security/**
  - apps/orchestrator/src/http/security.ts
  - apps/orchestrator/src/engine/script-resolve.ts
verified_at: 57af61a
---

# Security

## Local service ([security.ts](../../apps/orchestrator/src/http/security.ts))

1. **Host header** must be `127.0.0.1`, `localhost` or `[::1]` → blocks DNS rebinding (421).
2. **Origin**, when present, must be a loopback `http://` origin, a `vscode-webview://` origin, or listed in `ACC_ALLOWED_ORIGINS` (403). Allowed origins get CORS headers.
3. **Bearer token** for `/api/*` and `/ws` (`?token=` for WebSockets, compared in constant time); `GET /oauth/mcp/callback`, outside `/api`, is proven by the single-use sign-in state it carries instead ([mcp.md](mcp.md#oauth)), still behind checks 1 and 2. The token lives in the data folder; the dashboard gets it only through its own same-origin HTML. The check is decided on the percent-decoded path **and** the route the router matched, never on the raw request line (the router decodes `/%61pi/…` to `/api/…`); an undecodable path is 400. The tool-session and connected-app exemptions apply only when the matched route is in that group.
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
(cached 5 minutes) and refuse API-key logins. Explicit API Mode requires typing
`API BILLING` in Settings → Billing — checked by the server: `PATCH /api/settings`
with `billingMode: 'api'` is 422 `CONFIRMATION_REQUIRED` unless the body carries
`confirmation: 'API BILLING'` — and shows a persistent indicator.

## Redaction ([redact.ts](../../packages/security/src/redact.ts))

Applied to log lines (stateful across multi-line private keys), command
strings, directives, artifacts, event messages and error text before storage
or broadcast. Covers provider key formats, GitHub/GitLab/Slack/AWS/Google/
Stripe/npm tokens, JWTs, bearer/basic headers, URL credentials, cookies,
`secret-name=value` pairs, the signature and session parameters of signed URLs
(`sig`, `signature`, `X-Amz-Signature`, `X-Goog-Signature`,
`X-Amz-Security-Token`, `X-Amz-Credential`, `X-Goog-Credential`: only their
values, so host, path and expiry stay readable), and the literal values of
sensitive environment variables present on the machine.

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

`detectSecrets` reports which **blocking** rules match (provider keys, cloud
and registry tokens, credentials in URLs, private keys — not JWTs or the broad
`key=value` rule) and [sensitive-files.ts](../../packages/security/src/sensitive-files.ts)
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
`ToolService.invoke` refuses **any** agent tool call whose input names them, so an
agent running as the operator cannot read the token and act as the operator.
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
native shell denies the usual spellings from Level 3 ([agents.md](agents.md)).

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
  checks apply as everywhere.
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
  Policy and the
  privileged helper: [autopilot.md](autopilot.md). Terminals are loopback only
  ([pty.md](pty.md)).
- Redaction also covers values the broker hands out
  (`registerSecretValues`), and variables the broker manages are stripped from
  every inherited environment along with `ACC_TOOL_SESSION`.

## Permission levels

1 Analyze · 2 Develop · 3 Git · 4 Infrastructure · 5 Production. Default
auto-approve: up to 3 (global, per repository, per task). Stages above it wait
for approval.

**A repository or the operator's CLI settings cannot widen a stage**
([agents.md](agents.md)). Claude Code adds the `permissions.allow` rules of every
settings file a run loads (a repository's `.claude/settings.json` allowing
`Bash(*)`, for one) to the Control Center's, and only a deny rule or a missing
tool beats an allow rule; so each level's limits are deny rules, and Level 1,
whose "read-only commands only" no deny rule can express, has no shell — it
reads Git through the Control Center's own tools. Claude Code hooks are shell
commands outside every permission rule, and `-p` runs a repository's in any
folder, trusted or not, so Level 1 runs no hooks at all (`disableAllHooks`); from
Level 2 hooks stay on so the operator's own secret guards keep working, and a
repository whose settings switch them off is named in the run log. Codex runs with
`--ignore-rules`, because an execpolicy `allow` rule runs a command outside the
sandbox. `pnpm verify:agents --permissions` proves the Claude side with real
runs in a repository that allows `Bash(*)` and carries hooks.

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
repository commands, paid media generation and media budgets), and MCP
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

Last verified: 2026-09-27
