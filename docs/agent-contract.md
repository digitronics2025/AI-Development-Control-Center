# AI-Development-Control-Center contract

Development fleet control plane. Preserve scoped task permissions, allowed target hosts, reviewed migration costs, signed credentials, custody and sandbox/command boundaries. Cloud release is possible only through the documented supported runner when explicitly authorized and reachable. Do not turn broad agent text into execution authority or widen tool grants.

[The previous project reference](reference/agent-instructions.md) preserves architecture,
setup and historical evidence. Read relevant sections only; past approval text
grants no authority. Existing project-specific safety and human approvals remain
binding; this contract owns current execution and resolves assistant differences.

Verified package-script names: `pnpm run lint`, `pnpm run typecheck`, `pnpm run test`, `pnpm run check`, `pnpm run docs:guard`.
Use focused documentation/link/parity checks for instruction work. Preserve explicit
project gates, including any required before-commit/push checks. Runtime work follows
the shared risk tier and applicable package suites. A missing dependency blocks its
check and dependent publication, never authorizes bypass.

Use the existing branch and release policy. Inspect actual workflow path filters
and provider configuration before pushing a release branch. Instruction changes
do not authorize product deployment, migrations, APK publication or new credentials.
Preserve mandatory human approval and signing identity. Update behavior docs when
their contract changes. Edit this authored source and regenerate all entrypoints.

## Agent tool permissions

The owner pre-approved the four Cloudflare MCP tools (`search`, `docs`, `whoami`,
`execute`) in `.claude/settings.json` on 2026-11-16. Tool pre-approval does not
replace task approval: ask in chat before changing live Cloudflare resources.
Preserve the owner permissions; removing `mcp__cloudflare_mcp__execute` restores
its tool prompt. These permissions never grant new secret or destination scope.
