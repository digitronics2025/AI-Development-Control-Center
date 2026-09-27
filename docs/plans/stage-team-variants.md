---
title: Stage Team variants — competing attempts, one judged winner; specialty routing gated
source: docs/plans/frontend-design-agent.md step 35 (conversation 2026-09-27)
created: 2026-09-27
status: done
---

# Stage Team variants — competing attempts, one judged winner; specialty routing gated

## Context

From [frontend-design-agent.md](frontend-design-agent.md), Phase 3 "maximum capability", verbatim:

> - **Platform work:**
>   - OAuth in the gateway (Higgsfield, Canva, Figma remote, Recraft official);
>   - a `team.mode: variants` tournament (needs a new plan, because `STAGE_TEAMS_PLAN.md` excludes it);
>   - specialty routing;

> | `team.mode: variants` + judge unit; specialty routing | `schemas.ts:91-95`, `stage-team.ts`, new plan doc | L | Tests |

> - [ ] 35. `team.mode: variants` tournament + judge unit; specialty routing — done when: a new plan exists (the source says STAGE_TEAMS_PLAN.md excludes it) and is either implemented with tests or closed per its own gate — check: `node <skill>/scripts/plan-check.mjs docs/plans/stage-team-variants.md`

From [STAGE_TEAMS_PLAN.md](STAGE_TEAMS_PLAN.md), verbatim:

> ### Explicitly out of scope
> …
> - Allowing several write workers to edit the same parent task worktree.
> …
> - Automatic model benchmarking/routing by specialty; the design must leave a clean extension point for it.

> 2. **Specialty-aware automatic model routing** - use historical usage/success/latency to decide Claude vs Codex per frontend/backend/security unit.

> ## 10. Next Recommended Task
>
> Create a focused **ADAPTIVE_WORKER_ROUTING_PLAN.md** after Stage Teams are proven in production-like runs.
>
> That task should use the existing Usage & Costs ledger plus work-unit outcomes to choose the best available agent/model/effort for a worker specialty while respecting:
>
> - subscription availability;
> - user-configured role preferences;
> - usage limits;
> - measured latency;
> - retry/failure history;
> - no paid/API fallback when subscription-only policy is active.
>
> Do not implement automatic routing before Stage Teams have trustworthy per-worker execution and outcome data.

### Design (decided here)

- **`team.mode: variants`**: 2–4 listed workers, each an *approach* (`focus`,
  optional `agentId`/`model`/`effort` pin, as a fixed team), all doing the
  **whole** stage. Allowed on agent stages at Level 1–3 that are not verdict
  stages and not judge-class roles; no `primary`. Optional `judge` pin
  (`agentId`/`model`/`effort`); otherwise the stage's own assignment judges.
- **Running.** Level 1: variants side by side in the task's working tree
  (read-only), exactly like a fixed team. Level 2–3: each variant in its own
  child checkout of one wave base, like an adaptive write unit, but owning the
  whole repository (no path scope): only one variant is ever integrated, so
  overlapping edits are the point, not a conflict. This keeps the Stage Teams
  rule "several write workers never edit the parent worktree" intact.
- **Judging.** A failed variant does not fail the stage while another
  succeeded. With one candidate left it wins without a judge. Otherwise one
  read-only judge unit (kind `judge`, Level 1, on the task worktree, which no
  variant touched) reads each candidate's report, its changed files and its
  diff (bounded), and ends with `WINNER: <key>`. An answer naming no candidate
  fails the stage.
- **Result.** Write: only the winner's changes are integrated (the existing
  `integrate`, byte-exact against its wave base), no integration pass (one
  unit). Read: the winner's report is the stage's report. The losers' units
  stay `SUCCESS` with "not chosen" in their summary; their results remain as
  hidden refs and their reports as unit artifacts. The stage report is the
  winner's report plus the judge's reasons.

### Gate

- **Variants: implement.** Everything they need exists: child checkouts and
  result capture (adaptive write units), side-by-side read-only workers (fixed
  teams), byte-exact single-wave integration, a read-only Level 1 run (the Fix
  decomposer). No new infrastructure.
- **Not in this plan (found for later):** a running app per variant, so a judge
  could open each build in a browser. The App runtime starts one app per task
  worktree; per-checkout runtimes (ports, processes, cleanup) are their own
  project. Until then, a judge sees what each variant reported, changed and
  checked, and the screenshots the variants kept.
- **Specialty routing: deferred** by STAGE_TEAMS_PLAN §9.2 and §10 above: it
  needs trustworthy per-worker outcome data from production-like runs, which
  this repository does not have yet. Closing it now as deferred is the plan's
  own gate, not a skip.

## Steps

- [x] 1. Schema and validation: `mode: variants` with 2–4 workers and an optional `judge` pin; refused on verdict stages, judge-class roles, non-agent stages and Level 4–5; no `primary` — done when: workflow validation accepts a variants stage and names each refusal — check: `pnpm vitest run packages/shared/test/workflow.test.ts`
- [x] 2. Runner: variants run read-only side by side (Level 1) or each in its own whole-repository checkout (Level 2–3); a lone survivor wins; otherwise a Level 1 judge unit names `WINNER: <key>`; only the winner is integrated or becomes the report; losers marked not chosen; simulated agents support variants and the judge — done when: engine tests prove a write variants stage integrates only the judged winner's files, a read variants stage reports the winner, a failed variant is tolerated, and a judge naming no candidate fails the stage — check: `pnpm vitest run apps/orchestrator/test/stage-teams.test.ts`
- [x] 3. Dashboard: the workflow team editor offers variants (workers and judge), the execution view labels the judge unit, the usage page counts it as not a team member — done when: dashboard typecheck and unit tests pass — check: `pnpm --filter @acc/dashboard typecheck && pnpm vitest run apps/dashboard/src`
- [x] 4. Docs: stage-teams.md (configuration, running, judging), workflow-engine.md mention — done when: the docs describe variants — check: `git diff --stat docs/systems/`
- [x] 5. Specialty routing → deferred: STAGE_TEAMS_PLAN §9.2/§10 require trustworthy per-worker execution and outcome data from production-like runs before any automatic routing, and this repository has none yet; recorded in this plan's Ledger and the parent plan's Ledger (the repository has no follow-ups file) — done when: the deferral is written with its reason in both ledgers — check: `grep -n "specialty routing" docs/plans/frontend-design-agent.md docs/plans/stage-team-variants.md`

## Tail

- [x] T1. Adversarial review of this plan's diff — done when: every finding is fixed or in the Ledger — check: `git diff --stat` reviewed hunk by hunk
- [x] T3. Lint, typecheck and the affected suites green — done when: all exit 0 — check: `pnpm lint && pnpm typecheck && pnpm vitest run packages/shared apps/orchestrator/test/stage-teams.test.ts apps/orchestrator/test/usage-teams.test.ts`
- [x] T5. Committed path-scoped and pushed — done when: nothing of this work is uncommitted and the push succeeded — check: `git status --short && git log origin/claude/design-agent-media-generation-p6wtd7..HEAD --oneline`
- [x] T6. Live check — done when: confirmed there is no deploy on push for this repository (ci.yml only; deploy-cloud is manual) — check: `manual: .github/workflows lists no deploy on push`

## Ledger

- 2026-09-27 — created from docs/plans/frontend-design-agent.md step 35
- 2026-09-27 — step 5 — specialty routing deferred (the plan's own gate): STAGE_TEAMS_PLAN §9.2 and §10 say not to route by specialty before Stage Teams have trustworthy per-worker execution and outcome data; the Usage ledger and work-unit outcomes are the inputs a future ADAPTIVE_WORKER_ROUTING_PLAN.md would use. Variants leave the extension point: each worker carries its own agent/model/effort pin.
- 2026-09-27 — step 2 — decided: a failed variant is tolerated while another finished (only an all-failed set fails the stage); a lone survivor is kept without a judge run; the judge runs at Level 1 in the task's tree through launchAgent's permissionLevel override (as the Fix decomposer does); losers keep status SUCCESS with a 'Not chosen:' summary rather than a new status (no migration, no new dashboard state). Found for later: a running app per variant so a judge can look at each build.
- 2026-09-27 — T1 — reviewed the whole diff: several waves of variants each record their own base, and nothing is integrated between them, so the winner's base is still byte-exact at integration; on a retry a winner already in the task counts as alreadyIntegrated and is not written again; variant diffs reach the judge redacted and bounded; BLOCKED ON OPERATOR from any variant still pauses the stage (unchanged). No findings to fix.
