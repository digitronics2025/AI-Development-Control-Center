## Deploys — READ FIRST
- **Not connected to Workers Builds — deployed by hand.** Workers: `acc-cloud-control` (production) and `acc-cloud-control-staging`. Pushing to `main` does NOT deploy. After a manual deploy, check the live URL answers.
- GitHub Actions is OFF.
  Do not add deploy steps to Actions.
- Authorized direct release, from local or cloud: `pnpm cloud:deploy:staging`, then `pnpm cloud:deploy:production` after staging acceptance and required callees are live.
  Rollback: `npx wrangler rollback`.
- Cloud sessions may release when the user has authorized it, including an explicit full-autopilot request. Use the supported scripts above from a clean, tested revision, with scoped configured credentials and reviewed migration costs. Before any remote mutation, verify the target hosts are reachable through the environment's approved network policy and the full smoke check can run; verify the exact live version and smoke checks afterward. When a managed proxy is configured, set `NODE_USE_ENV_PROXY=1` and preserve its CA trust. A denied host, unknown cost input or missing credential is a blocker: do not bypass it, use raw `wrangler deploy` to skip gates, or repeatedly retry. The owner PC is required only for work that actually executes on that paired node.
- Never print or commit secret values. Secrets live in Cloudflare.

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

<!-- BEGIN operator-conventions: regenerated from digitronics2025/claude-config -->
## Efficient execution — local and cloud

Use the smallest verification tier that proves the request:

- **T0 — read-only:** questions, investigation, and plans. Do not mutate files,
  Git, external systems, or deployments unless the request requires it.
- **T0D — documentation-only:** review the changed material and run only a
  focused link or formatting check when one exists. Do not run product tests,
  open a browser, or deploy.
- **T1 — isolated low-risk change:** run focused tests plus lint and type-check
  for the affected package or files. For UI work, verify the changed route at
  its primary viewport.
- **T2 — cross-cutting change:** shared code, public behavior, multiple routes,
  integrations, caching, or background work. Run relevant unit and integration
  suites, affected browser journeys, and CI before release.
- **T3 — critical change:** authentication, authorization, billing, money,
  personal data, migrations, security controls, infrastructure, release
  machinery, or destructive behavior. Run the full applicable gate, CI,
  deployment verification, and live proof of the changed behavior.

Escalate one tier when scope is uncertain, a focused check exposes wider impact,
or verification fails. Do not begin routine production work at T3 by default.

Run each check once. Local work owns focused checks, CI owns the complete suite,
and release verification owns provider status, health, and live behavior. Do not
repeat a successful check unless relevant inputs changed. When CI is unavailable,
run the complete applicable suite locally once for T2/T3 before release.

Default to the smallest complete change. Do not redesign unrelated pages, sweep
sibling systems, add infrastructure, or perform broad cleanup without evidence
that the same requirement affects them. Preserve unrelated working-tree changes.

Use browser automation only for changed or investigated browser behavior. T1 UI
work needs the affected route and primary viewport; T2 needs the affected desktop
and mobile journey; reserve a complete accessibility, console, and network pass
for T3 or an explicit audit. Backend-only, documentation, database, and
configuration work does not need a browser unless runtime evidence requires it.

Read subsystem documentation when it materially shortens discovery. Update it
only when documented behavior, architecture, interfaces, operations, or important
gotchas change. Read `BUILD_LOG.md` only when explicitly continuing its multi-stage
build; ordinary questions and maintenance do not trigger automatic continuation.

Commit, push, migrate, and release according to the repository-specific policy
above this block. For authorized runtime work, release once at the end after the
applicable gate passes. Documentation and developer-only changes do not trigger a
production release unless they change the deployed artifact. Build and release the
exact committed revision, then verify the changed behavior. Never claim cloud or
local verification that the current environment could not perform.

## Reply contract — every task-closing reply

End every task-closing reply with these three, in order, nothing after:

1. **Plain recap**, 3 sentences, no paths/hashes/jargon ("saved" not "commit",
   "sent live" not "deploy"); shipped work may use the five-part form
   (changed / was wrong / before→after / gain / next), ~180 words.
2. **Grandma summary**, 2-4 plain sentences, no tool, file or product names —
   what it means for the shop. Unverified stays unverified.
3. **What you need to do** — numbered steps naming the exact button and what
   they should see, or exactly `Nothing — you're all set.` Never empty, never
   "just". Anything the user must do goes ONLY here.

"skip recap" silences 1 and 2; 3 stays. Not for technical answers, code, plans or
commit messages.

Prefer **maintainable > scalable > secure > production-ready > sustainable**.
Never report unverified work as done: checked, not verified, or could not check.
Update the doc owning a behaviour in the same commit. Never commit a secret.
Only this repo's tracked files and account-level skills reach a session off the
operator's PC — never point at `~/.claude/...` or `C:\Users\...` unmarked.

**Merge your own PR once it is green — without asking.** Operator's standing
order (2026-09-29), every repo and session. Merge a PR you opened or were asked to
drive as soon as the repo's own gate passes (lint, tests, any guard script), no
real check is red or pending (Actions checks that can never run do not count), it
merges cleanly, and no bot review is still running or blocking finding open.
Otherwise fix it or report. Never merge a red, untested or conflicted PR, one that
needs a manual step first (remote migration, secret, Worker deploy), or one you
only watch. Where a merge deploys to production, say so in the reply.

Conditional rules (branch model, approval, autopilot, machine-bound skills):
[digitronics2025/claude-config](https://github.com/digitronics2025/claude-config)
<!-- END operator-conventions sha256:e9e19068bab9 -->
