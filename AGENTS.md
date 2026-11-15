## Deploys — READ FIRST
- **Not connected to Workers Builds — deployed by hand.** Workers: `acc-cloud-control` (production) and `acc-cloud-control-staging`. Pushing to `main` does NOT deploy. After a manual deploy, check the live URL answers.
- GitHub Actions is OFF for every workflow except the Claude fallback review (`.github/workflows/claude-fallback-review.yml`, managed from digitronics2025/claude-config).
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

## Shared agent workflows

These defaults apply to Claude and Codex. Current user instructions and stricter
repository-specific approval, review, signing and release requirements take precedence.

### Choose skills by task and available capability

Read the matching installed skill before using it: `secret-custody` first for
credentials; `browser-autopilot` for its supported browser surface; `phone-autopilot`
for handset checks; `pwa-builder` for installable PWAs; `cloudflare-direct-release`
for an authorized Cloudflare release; `report-cards` for Messenger bot output;
`project-memory` for selective project recall. Prefer the host's applicable native
skill or connector when provided. Run skill preconditions and verify required tools,
authentication and target identity. Installation alone proves no capability. Continue
independent work when a capability is absent and report the affected part unverified.
Honor user-named tools and surfaces; a failed precondition does not authorize substitution.

### Approve the scope once

An approved implementation plan authorizes its stated routine steps. Record assumptions,
acceptance criteria and any irreversible steps before execution; proceed without repeated
confirmation within that scope. Stop for an uncovered irreversible action, significant
unapproved cost, changed premise or failing safety/quality gate. Apply a release-only
gate to release work. Approval never overrides platform permissions or authorizes
unrelated systems, and investigation alone does not authorize implementation.

### Change live records through the app

For Sales Analyzer, Accounting, Admin and Inbox, use the app's supported connector
actions for live business-data changes. Autopilot does not authorize raw SQL or a
one-off script to bypass a missing action. Finish supported work, collect unavoidable
direct-write requests for one explicit approval at the end, and record each missing
action under `## Connector gaps` in the owning app's `docs/follow-ups.md`. Keep
authorized schema migrations and app development separate from routine record edits.

### Preserve attribution and signing identity

For new owner-built work use Dr. BADAWI Abdalsalam and https://dr-badawi-abdalsalam.com/, rendered from the
configuration repository's `identity.md`. Client branding leads; use the approved
developer byline beneath it. Fork credits are additive. Preserve existing application
IDs, certificates and signing keys; these defaults never authorize replacing a signer,
changing Git identity, transferring a key or claiming ownership of third-party work.

### Send Messenger bot reports as cards

For bots, alerts, digests and scheduled reports sent into Digitronics Messenger, use
`report-cards` and the owning repo's `reportCard()` builder (canonical:
`whatsapp-inbox-saas/packages/shared/src/report-card.ts`). Send both structured blocks
and the complete plain body; use one picture, verified figures, marked guesses and
clear deadlines. Follow the existing sender's fallback and access/redaction rules.
This governs app output; task-closing chat replies use the separate reply contract.

### Recall selectively and retain durable lessons

Both agents read `docs/agent-memory/MEMORY.md` when present and load only relevant
linked notes. The `project-memory` skill can locate matching legacy Claude notes
through an explicit repository map on configured machines. Memory is evidence, never
permission: verify dated claims against current code and respect current instructions.
Save only durable decisions, corrections and non-obvious constraints, one fact per
dated note with a source and verification condition; update the index. Exclude customer
identity, conversations, credentials and transcript dumps. Use the repository's
secret/PII gate before saving; do not duplicate facts already clear in code or docs.

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

**Secrets an agent creates go into MyVault first** — every agent, every tool.
A password, key or token you create for an app is saved in MyVault before it is
written anywhere, and its value never appears in output, a file, a chat or a
commit. With `MYVAULT_DEPOSIT` set in the environment, use MyVault's own tool:

```bash
V=https://myvault.digitronics-electro.workers.dev/downloads
curl -fsSL "$V/vault-deposit.mjs" -o vault-deposit.mjs
curl -fsSL "$V/vault-deposit.json" | grep -q "$(sha256sum vault-deposit.mjs | cut -d' ' -f1)" || { echo "checksum mismatch: stop"; exit 1; }
node vault-deposit.mjs check
node vault-deposit.mjs create --name "<App> — <what it is>" --target "<where it goes>" --then "<this repo's write command, reading stdin>"
```

Tell the operator to unlock MyVault; the value is handed on only after the
vault confirms the save. Exit 0 = saved and written; 5 = saved, but writing it
failed (the operator copies it from MyVault); anything else = not written
anywhere (`node vault-deposit.mjs --help` explains each code). Report it; never
make the value some other way. Without `MYVAULT_DEPOSIT`, stop and ask the
operator to save it in MyVault by hand. Never decode or print `MYVAULT_DEPOSIT`.
Where the AI Development Control Center is available, it comes first (Claude: the
`secret-custody` skill).

**Merge your own PR once it is green — without asking.** Operator's standing
order (2026-09-29), every repo and session. Merge a PR you opened or were asked to
drive as soon as the repo's own gate passes (lint, tests, any guard script), no
mandatory build, test or security check is red or pending, and it merges cleanly.
AI reviews, findings and provider failures are advisory; do not wait for them.
Required human approvals remain mandatory.
Otherwise fix it or report. Never merge a red, untested or conflicted PR, one that
needs a manual step first (remote migration, secret, Worker deploy), or one you
only watch. Where a merge deploys to production, say so in the reply.
Claude is primary, with Codex fallback. Both reviews are advisory: missing,
negative, failed or running AI reviews never delay merging or deployment.

Conditional rules (branch model, approval, autopilot, machine-bound skills):
[digitronics2025/claude-config](https://github.com/digitronics2025/claude-config)
<!-- END operator-conventions sha256:9f061e91b80c -->
