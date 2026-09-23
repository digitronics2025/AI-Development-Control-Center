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

## Command classification ([commands.ts](../../packages/security/src/commands.ts))

Repository commands are classified before running; `npm/pnpm/yarn run X` is
expanded to the script body (including pre/post and nested scripts,
[script-resolve.ts](../../apps/orchestrator/src/engine/script-resolve.ts)).
Dangerous (recursive deletes, `git reset --hard`, force push, `DROP TABLE`,
unscoped `DELETE`, `terraform destroy`…) and anything targeting production is
level 5 and always needs an approval with a typed confirmation (the task ID).

## Permission levels

1 Analyze · 2 Develop · 3 Git · 4 Infrastructure · 5 Production. Default
auto-approve: up to 3 (global, per repository, per task). Stages above it wait
for approval.

## Gotchas

- Tests build fake credentials at runtime; the operator's commit guard rejects credential-shaped literals.
- Redaction is conservative: values such as `API_KEY=absent` are masked too.

Last verified: 2026-09-23
