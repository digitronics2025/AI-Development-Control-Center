## Deploys — READ FIRST
- **Not connected to Workers Builds — deployed by hand.** Workers: `acc-cloud-control` (production) and `acc-cloud-control-staging`. Pushing to `main` does NOT deploy. After a manual deploy, check the live URL answers.
- GitHub Actions is OFF for every workflow except the Claude fallback review (`.github/workflows/claude-fallback-review.yml`, managed from digitronics2025/claude-config).
  Do not add deploy steps to Actions.
- Authorized direct release, from local or cloud: `pnpm cloud:deploy:staging`, then `pnpm cloud:deploy:production` after staging acceptance and required callees are live.
  Rollback: `npx wrangler rollback`.
- Cloud sessions may release when the user has authorized it, including an explicit full-autopilot request. Use the supported scripts above from a clean, tested revision, with scoped configured credentials and reviewed migration costs. Before any remote mutation, verify the target hosts are reachable through the environment's approved network policy and the full smoke check can run; verify the exact live version and smoke checks afterward. When a managed proxy is configured, set `NODE_USE_ENV_PROXY=1` and preserve its CA trust. A denied host, unknown cost input or missing credential is a blocker: do not bypass it, use raw `wrangler deploy` to skip gates, or repeatedly retry. The owner PC is required only for work that actually executes on that paired node.
- Never print or commit secret values. Secrets live in Cloudflare.

<!-- BEGIN operator-conventions: regenerated from digitronics2025/claude-config -->
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

### MyVault credential workflow

**Secrets an agent creates go into MyVault first** — every AI, every repository.
Read `secret-custody` and the [agent guide](https://myvault.digitronics-electro.workers.dev/downloads/myvault-agent-guide.txt).
New values use the checksum-verified `vault-deposit` CLI (`MYVAULT_DEPOSIT`) or
the deposit connector; confirm the vault save before a destination write.
Queued/deposited is not collected/saved. Never decode the deposit configuration
or expose a value in chat, output, files or Git. Without a usable channel, the
owner saves privately.

For saved fields, prefer authorized MyVault GitHub/Cloudflare profile tools:
discover scope, preview, obtain required owner approval or a valid existing
policy, apply the unchanged preview, then verify names and activation.
`myvault.config.json` holds identifiers, not authority. Check actual tool access
and live scope; new repos/destinations need owner authorization. Delegated targets
are repository Actions secrets and existing Worker runtime text secrets; Pages,
build/environment/organization secrets and core-key rotation are unsupported.
Core keys use the separate signed owner workflow. Never bypass missing consent,
custody, scope or refusals; continue independent work and report the blocker.

### End every plan with the exact autopilot paragraphs

Every plan, including revised or shortened plans, MUST end with these two
paragraphs verbatim. Before presenting any plan, check its final two paragraphs
against this text. Do not shorten, paraphrase, indent, or add text after them.

<!-- prettier-ignore-start -->

Execute the entire plan end-to-end in full autopilot. Make independent decisions, always choosing the best long-term solutions for security, reliability, scalability, and maintainability.

Investigate, implement, fix, test, and verify everything autonomously. Do not pause for routine questions. Seek approval only for unavoidable blockers, irreversible high-risk actions, or significant costs. Continue until fully verified, then provide a concise completion report.

<!-- prettier-ignore-end -->

This ending describes authorized execution; it does not start implementation,
exit Plan mode, create a durable goal, change platform permissions, waive required
approvals, or override safety rules. Stay in Plan mode until the host permits
execution. Once implementation is authorized, proceed within the approved scope
without repeated routine confirmations. Required review and quality gates still apply.

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

## Simple language

Use simple words in answers, plans, updates, questions and reports. Assume no
coding knowledge. Lead with results. Use short sentences; explain jargon.
If unclear, rephrase. For user actions, number steps: one action, exact verified
button/text, expected result. Handle the rest. Keep commands exact.

## Reply contract — match the requested work

Finished investigations keep this format.
Investigation alone does not authorize implementation.

### Investigation report

“Investigate,” “diagnose,” “audit,” or “research”:

- **Finding:** Answer immediately.
- **Evidence:** Checks, supporting evidence and useful source links.
- **Cause and confidence:** Confirmed facts, likely explanations and unknowns, kept separate.
- **Impact:** Affected scope and why it matters.
- **Recommended action:** Fix or next check, clearly marked as proposed.

### Implementation report

Fixes, implementation, documentation and settings changes:

- **Result:** What now works or is complete.
- **Changes:** What changed and why; only when made.
- **Verification:** Checks, results and limits.
- **Remaining issues:** Only unfinished or blocked work.

“Investigate and fix” uses implementation format with diagnosis and evidence.

Use bold labels in order; about 180 words, longer for evidence. Omit empty sections.
Mention changes only when made. Use “Before → After” only for an actual change.
Never imply a proposed fix was implemented. Never present unverified work as verified.

Always end: **Grandma summary** (plain explanation), then
**What you need to do**. User actions only here: numbered steps with exact
verified labels and expected results, or exactly `Nothing — you're all set.`

“skip recap” omits body and Grandma summary; final actions remain.
Direct answers and plans need no report.

Human replies only. Preserve required machine JSON, verdicts and structured formats.

Prefer **maintainable > scalable > secure > production-ready > sustainable**.
Never report unverified work as done: checked, not verified, or could not check.
Update the doc owning a behaviour in the same commit. Never commit a secret.
Only this repo's tracked files and account-level skills reach a session off the
operator's PC — never point at `~/.claude/...` or `C:\Users\...` unmarked.

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
<!-- END operator-conventions sha256:dafeb9897595 -->
