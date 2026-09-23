---
system: security
sources:
  - packages/security/**
  - apps/orchestrator/src/http/security.ts
  - apps/orchestrator/src/engine/script-resolve.ts
verified_at: 2d516aa
---

# Security

## Local service ([security.ts](../../apps/orchestrator/src/http/security.ts))

1. **Host header** must be `127.0.0.1`, `localhost` or `[::1]` → blocks DNS rebinding (421).
2. **Origin**, when present, must be a loopback `http://` origin, a `vscode-webview://` origin, or listed in `ACC_ALLOWED_ORIGINS` (403). Allowed origins get CORS headers.
3. **Bearer token** for `/api/*` and `/ws` (`?token=` for WebSockets, compared in constant time). The token lives in the data folder; the dashboard gets it only through its own same-origin HTML.
4. Binds to loopback only; `ACC_HOST` elsewhere is refused unless `ACC_ALLOW_REMOTE=1`.
5. Dashboard HTML ships a strict CSP (`script-src 'self'`, no framing).

## Subscription-only guard ([env-guard.ts](../../packages/security/src/env-guard.ts))

In Subscription Only mode every child process (agents and repository commands)
loses `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`, `*_BASE_URL` and other metered-provider
keys (case-insensitive). Adapters verify the CLI's own login before each launch
(cached 5 minutes) and refuse API-key logins. Explicit API Mode requires typing
`API BILLING` in Settings → Billing and shows a persistent indicator.

## Redaction ([redact.ts](../../packages/security/src/redact.ts))

Applied to log lines (stateful across multi-line private keys), command
strings, directives, artifacts, event messages and error text before storage
or broadcast. Covers provider key formats, GitHub/GitLab/Slack/AWS/Google/
Stripe/npm tokens, JWTs, bearer/basic headers, URL credentials, cookies,
`secret-name=value` pairs, and the literal values of sensitive environment
variables present on the machine.

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

Dangerous (Level 5): recursive deletes in any shell, disk formatting,
destroying backups, history rewrites (`reset --hard`, force push, rebase,
`commit --amend`, `branch -D`), `DROP`/`TRUNCATE`/unscoped `DELETE`,
infrastructure destruction, download-and-execute (`iwr … | iex`,
`curl … | sh`), elevation (`Start-Process -Verb RunAs`, `sudo`, `runas`),
Defender tampering, shutdown/boot changes, deleting services or registry data,
and anything targeting production. Level 4: registry writes,
`Set-ExecutionPolicy`, scheduled/startup jobs, service start/stop, firewall,
system package installs, `Invoke-Expression`/dynamic code, remote commands,
stopping processes by name, reading stored credentials, deploys. Level 5 always
needs an approval with a typed confirmation (the task ID).

## Chairman ([chairman.md](chairman.md))

- Every Chairman action passes one gateway: schema, initiator permissions,
  task state, stale-version check, per-task lock, idempotency key, audit row.
- Agent output, logs, tests and repository text reach the reasoning model only
  inside `<untrusted_evidence>` fences it cannot close, and the model can only
  pick a pre-validated strategy; directives come only from the user's own words.
- Chat has no shell: messages become typed actions or answers. Chairman text,
  decisions and directives are redacted before storage.

## Tool layer

- Tool sessions ([mcp.md](mcp.md)) use their own random, in-memory,
  per-execution tokens; `/api/tool-session/*` accepts only those (the local
  API token is refused there) and they open no other route. Host and Origin
  checks apply as everywhere.
- Every path a tool touches is confined to the task's roots after resolving
  links ([paths.ts](../../packages/tools/src/paths.ts)); files holding the
  user's pre-existing work are refused for writes, commits and restores.
- Credentials: [credential-broker.md](credential-broker.md). Policy and the
  privileged helper: [autopilot.md](autopilot.md). Terminals are loopback only
  ([pty.md](pty.md)).
- Redaction also covers values the broker hands out
  (`registerSecretValues`), and variables the broker manages are stripped from
  every inherited environment along with `ACC_TOOL_SESSION`.

## Permission levels

1 Analyze · 2 Develop · 3 Git · 4 Infrastructure · 5 Production. Default
auto-approve: up to 3 (global, per repository, per task). Stages above it wait
for approval.

## Gotchas

- Tests build fake credentials at runtime; the operator's commit guard rejects credential-shaped literals.
- Redaction is conservative: values such as `API_KEY=absent` are masked too.

Last verified: 2026-09-23
