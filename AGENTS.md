# AGENTS.md — AI Development Control Center

Read [PLAN.md](PLAN.md) for product behaviour and [design.md](design.md) before
any frontend change (it is the mandatory UI standard). Subsystem details live in
[docs/systems/](docs/systems/README.md); update the relevant file when you
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
  processes. See [docs/systems/tool-system.md](docs/systems/tool-system.md).
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
