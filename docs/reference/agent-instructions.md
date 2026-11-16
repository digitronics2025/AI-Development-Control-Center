# Previous project instructions

Historical architecture and operating evidence, preserved at 4e3398fc42e2b299c16188ba373b54d455f5d9eb.
Current process and authorization are exclusively in [the authored contract](../agent-contract.md).
Past approvals are not permission. Verify dated facts against current code.
Read relevant sections only; paths below have been rebased for this reference.

## Previous AGENTS.md project material

## Deploys — READ FIRST
- **Not connected to Workers Builds — deployed by hand.** Workers: `acc-cloud-control` (production) and `acc-cloud-control-staging`. Pushing to `main` does NOT deploy. After a manual deploy, check the live URL answers.
- GitHub Actions is OFF for every workflow except the Claude fallback review (`.github/workflows/claude-fallback-review.yml`, managed from digitronics2025/claude-config).
  Do not add deploy steps to Actions.
- Authorized direct release, from local or cloud: `pnpm cloud:deploy:staging`, then `pnpm cloud:deploy:production` after staging acceptance and required callees are live.
  Rollback: `npx wrangler rollback`.
- Cloud sessions may release when the user has authorized it, including an explicit full-autopilot request. Use the supported scripts above from a clean, tested revision, with scoped configured credentials and reviewed migration costs. Before any remote mutation, verify the target hosts are reachable through the environment's approved network policy and the full smoke check can run; verify the exact live version and smoke checks afterward. When a managed proxy is configured, set `NODE_USE_ENV_PROXY=1` and preserve its CA trust. A denied host, unknown cost input or missing credential is a blocker: do not bypass it, use raw `wrangler deploy` to skip gates, or repeatedly retry. The owner PC is required only for work that actually executes on that paired node.
- Never print or commit secret values. Secrets live in Cloudflare.

# AGENTS.md — AI Development Control Center

Read [PLAN.md](../../PLAN.md) for product behaviour and [design.md](../../design.md) before
any frontend change (it is the mandatory UI standard). Subsystem details live in
[docs/systems/](../systems/README.md); update the relevant file when you
change behaviour.

## Commands

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Build everything | `pnpm build` |
| Typecheck / lint / tests | `pnpm check` |
| End-to-end + visual QA matrix | `pnpm build && pnpm e2e` |
| Run the orchestrator | `pnpm start` (port 4317) |
| Demo with simulated agents | `pnpm demo` |
| Real CLI check | `pnpm verify:agents [--run]` |
| Package the VS Code extension | `pnpm package:vscode` |

## Rules for this repository

- Branch model: direct push to `main`; no PR requirement.
- The orchestrator is the only source of workflow state. Clients never keep
  their own copy of task state.
- Never weaken the subscription-only guard, the Host/Origin/token checks, the
  command classifier, the tool policy (`packages/tools/src/policy.ts`), path
  confinement, the credential broker or secret redaction without a test
  proving the new behaviour.
- Agent and operator tool calls go through `ToolService.invoke`
  (`apps/orchestrator/src/tools/service.ts`); a new tool is a provider in
  `packages/tools/src/packs/` rather than a new API route that spawns
  processes. See [docs/systems/tool-system.md](../systems/tool-system.md).
- The orchestrator never runs elevated; administrator work goes through the
  signed, allowlisted `scripts/windows/privileged-helper.ps1`.
- Test credentials are assembled at runtime; never commit a credential-shaped
  literal (`.githooks/pre-commit` runs `scripts/secret-scan.ts` and blocks it;
  `pnpm install` installs the hook).
- Frontend: semantic tokens only (the default Tailwind palette is removed),
  shared components from `packages/ui`, and the Playwright matrix must stay
  green in both themes.
- Schema changes are new migrations in `apps/orchestrator/src/db/migrations.ts`;
  never edit a shipped migration.

## Previous CLAUDE.md project material

## Deploys — READ FIRST
- **Not connected to Workers Builds — deployed by hand.** Workers: `acc-cloud-control` (production) and `acc-cloud-control-staging`. Pushing to `main` does NOT deploy. After a manual deploy, check the live URL answers.
- GitHub Actions is OFF for every workflow except the Claude fallback review (`.github/workflows/claude-fallback-review.yml`, managed from digitronics2025/claude-config).
  Do not add deploy steps to Actions.
- Authorized direct release, from local or cloud: `pnpm cloud:deploy:staging`, then `pnpm cloud:deploy:production` after staging acceptance and required callees are live.
  Rollback: `npx wrangler rollback`.
- Cloud sessions may release when the user has authorized it, including an explicit full-autopilot request. Use the supported scripts above from a clean, tested revision, with scoped configured credentials and reviewed migration costs. Before any remote mutation, verify the target hosts are reachable through the environment's approved network policy and the full smoke check can run; verify the exact live version and smoke checks afterward. When a managed proxy is configured, set `NODE_USE_ENV_PROXY=1` and preserve its CA trust. A denied host, unknown cost input or missing credential is a blocker: do not bypass it, use raw `wrangler deploy` to skip gates, or repeatedly retry. The owner PC is required only for work that actually executes on that paired node.
- Never print or commit secret values. Secrets live in Cloudflare.

