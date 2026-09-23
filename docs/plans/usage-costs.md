# Usage, Cost & Capacity — plan record

The operator's plan ("AI Usage, Cost & Capacity Control Center", 2026-09-23)
asked for one source of truth for AI usage, cost attribution, remaining
capacity and budget health, where every number traces back to recorded
attempts. The system is described in [docs/systems/usage.md](../systems/usage.md);
this file records how the plan maps onto this product and what was left out.

## How the plan maps onto this product

| Plan term | Here |
|---|---|
| AI request / provider attempt | One agent CLI run (`claude -p`, `codex exec`). One run makes several API calls internally; the CLIs report cumulative usage per run, so the attempt is the accounting unit |
| Project | Repository |
| Run | Stage instance (one per stage attempt) |
| Workflow step | Stage key |
| Task type | Workflow profile id |
| Effort | The stage's effort setting |
| Provider cost | Claude Code's own `costUSD` (list-price equivalent); Codex reports none |
| Remaining quota | Claude Code's `rate_limit_event` windows; Codex exposes none |

## Decisions

- **Capture at `AgentRegistry.launch`.** This is the narrowest boundary every
  provider attempt passes. It is not an agent-by-agent patch.
- **The execution id is the idempotency key.** It is generated before dispatch.
  Replays, spooled retries and restarts cannot double count.
- **Money is integer nano-dollars.** Per-token prices are whole numbers, so
  calculated costs are exact. Floating-point money is never summed.
- **Raw aggregates, no rollups.** 20,000 attempts over 30 days keep the overview
  near 1.5 s on a loaded machine. Rollups can wait until measurements need them.
- **Budget hard stop reuses `PERMISSION_DENIED`.** The stage waits for the user
  with the budget named. There is no new error class and no model downgrade.
- **Only two budget policies (`WARN_ONLY`, `STOP_NEW_RUNS`).** The plan listed
  more; see below.
- **Nothing is backfilled.** Past executions carry no token data. Tracking starts
  when migration 4 is applied, and the dashboard says so.

## Found for later

### Finding: Codex model pricing is not verified

Issue: Codex reports tokens but no cost, and the models it uses (`gpt-6-*`, `gpt-5.6-*`, `gpt-5.5`) have no verified price here.
Why it matters: Codex costs show as Unknown and are left out of totals.
Recommended fix: add prices from OpenAI's published list with their source (Models → Price list → Add price version), then Price unknown attempts.
Priority: Medium. Affects current Usage task: No (it is shown honestly as Unknown).

### Finding: Codex usage is untested against a real successful run

Issue: on 2026-09-23 the installed Codex was out of credits, so only its failure path was observed live; the `turn.completed.usage` parsing follows the documented event shape and the fake CLI.
Why it matters: a changed field name would leave Codex tokens as "Not reported" (never wrong numbers).
Recommended fix: run `pnpm verify:agents --run --only codex` once credits return and compare with the dashboard.
Priority: Medium. Affects current Usage task: Yes, as a known limitation.

### Finding: REQUIRE_APPROVAL and ALLOW_CONFIGURED_FALLBACK budget policies

Issue: The plan listed these policies alongside WARN_ONLY and STOP_NEW_RUNS.
Why it matters: an approval-gated overspend would need a new approval kind; a configured fallback would change the model automatically, which the plan itself treats with caution.
Recommended fix: add an approval kind `budget_exceeded` reusing the approval gate, if the operator asks for it.
Priority: Low. Affects current Usage task: No.

### Finding: RUN-scoped budgets

Issue: A run is one stage attempt; its id does not exist before it starts, so a budget cannot name it in advance.
Recommended fix: none unless a need appears; task budgets cover it.
Priority: Low. Affects current Usage task: No.

### Finding: The webview bundle is over 1 MB

Issue: `vite build --mode webview` warns that `webview.js` is 1.1 MB. This was already true before this work.
Recommended fix: code-split the webview entry.
Priority: Low. Affects current Usage task: No.

## Next recommended task

Adaptive model routing, recommendation mode first. Once real usage has
accumulated, compare models per task type on median cost, cost per successful
task, retry rate, failure rate and latency. Show the evidence first; add
automatic routing policies only later.
