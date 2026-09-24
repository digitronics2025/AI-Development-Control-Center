---
system: usage
sources:
  - apps/orchestrator/src/usage/**
  - apps/orchestrator/src/http/usage-routes.ts
  - packages/shared/src/usage.ts
  - packages/agent-sdk/src/usage.ts
  - apps/dashboard/src/pages/usage/**
  - apps/dashboard/src/api/usage.ts
verified_at: 5ad2a6b
---

# Usage, cost and capacity

Answers what agents used, what it cost, what remains and where it was wasted.
Every figure is traceable to recorded attempts and a known calculation. Unknown
values stay unknown and are never counted as zero. Plan:
[docs/plans/usage-costs.md](../plans/usage-costs.md).

## Capture

The one capture boundary is `AgentRegistry.launch`
([agents.ts](../../apps/orchestrator/src/services/agents.ts)). Every provider
attempt goes through it: stage runs ([runners.ts](../../apps/orchestrator/src/engine/runners.ts)),
the Chairman's reasoning ([reasoner.ts](../../apps/orchestrator/src/chairman/reasoner.ts))
and commit-message suggestions ([assist.ts](../../apps/orchestrator/src/source-control/assist.ts)).
A test fails if any other orchestrator file calls an adapter's `execute({` directly.

1. **Budget check.** An exceeded `STOP_NEW_RUNS` budget refuses the launch with
   `AgentGuardError(PERMISSION_DENIED)`, so the stage waits for the user. No
   provider attempt happens, so nothing is recorded. If the budget engine
   itself fails, the run is allowed and the failure is logged (fail open).
2. **Dispatch.** Once the process has started, a `usage_pending` row keyed by the
   execution id is written.
3. **Finish.** The adapter's result carries `usage` (per-model token lines and the
   provider-reported cost) and `capacity` observations. The recorder writes one
   `usage_events` row with its lines in a single transaction, and deletes the
   pending row.
4. **Failure to save.** The attempt is appended to `<data>/usage-spool.jsonl` and
   retried with backoff (1 s to 60 s). The execution id is `UNIQUE`, so replays
   never double count. The provider is never called again to recreate telemetry.
5. **Startup** ([recorder.ts](../../apps/orchestrator/src/usage/recorder.ts) `recover`).
   The spool is replayed first. Pending rows still left belonged to attempts that
   a stop interrupted: they are recorded as `interrupted` with unknown usage.

### What the providers report

| | Claude Code | Codex | Simulated |
|---|---|---|---|
| Tokens | `result.modelUsage`, cumulative per model (the top-level `usage` is only the last turn) | `turn.completed.usage`, summed | from prompt and output size |
| Input semantics | uncached input | includes cached input, so the parser subtracts it | uncached |
| Cost | `costUSD` per model (list-price equivalent) → `PROVIDER` | none: price list, else `UNKNOWN` | the simulated `claude` reports one; `codex` does not |
| 1-hour cache writes | known only when one model ran and `usage.cache_creation` covers every write | not applicable | 0 |
| Capacity | `rate_limit_event.rate_limit_info.unifiedWindows` (five-hour and weekly utilisation, reset times) and `overageStatus` | only a failure message ("out of credits", "usage limit") | a five-hour window |

The real Claude Code 2.1.280 events are kept in
[tests/fixtures/claude-2.1.280-usage.jsonl](../../tests/fixtures/claude-2.1.280-usage.jsonl).
On that run, the calculated Haiku 4.5 cost matched Claude Code's own `costUSD`
exactly (33,137,900 nano-dollars).

**Subscription billing.** Runs on a subscription are not billed per request. The
cost shown is what the same usage would cost at API list prices, and the
dashboard says so wherever the billing kind is `subscription`.

## Ledger

Migration 4 ([migrations.ts](../../apps/orchestrator/src/db/migrations.ts)).
Money is integer **nano-dollars** (1 USD = 10⁹). A price of $1 per million
tokens is 1,000 nano-dollars per token, so calculated costs are exact.

| Table | Content |
|---|---|
| `usage_events` | One row per provider attempt. Keyed by execution id (`idempotency_key UNIQUE`). Holds attribution, timings, token totals, retry lineage, provider, calculated and display cost, `cost_source`, the price version used, status and a 16-character prompt hash. There are no foreign keys to tasks, so history outlives them |
| `usage_event_lines` | Usage per model inside an attempt |
| `usage_cost_revisions` | Audit record of every later costing (Unknown → Calculated) |
| `usage_pending` | Attempts dispatched but not yet recorded |
| `pricing_versions` | Versioned price list (`effective_from`/`effective_to`, source, verification) |
| `capacity_snapshots` | Limit readings with source, confidence and time |
| `budgets` | Internal budgets. One per scope and period (unique index) |

**Append-only by trigger.** Deleting an event or a line is refused. So is any
update, except costing an attempt whose `cost_source` is `UNKNOWN`. No
prompts, responses or credentials are stored; error text never reaches this
table, only `error_class`.

**Attribution.** A stage attempt records `project_id` (repository), `task_id`,
`run_id` (stage instance id: one per stage attempt), `workflow_id` (also the
task type used for comparisons), `workflow_step` (stage key), `agent_role` and
`mode`. A Chairman attempt uses step `chairman`. A commit-message attempt uses
step `commit-message`, role `committer` and no task.

**Lineage** (stage attempts only). The parent is the previous attempt of the
same stage in the same task. The attempt reason is:

- `reroute` if the agent or model differs, recording `fallback_from`/`fallback_to`
- `retry` if the parent failed
- `rerun` if the parent succeeded (fix cycle, recovery)
- `initial` if there is no parent

## Cost

Implemented in [cost.ts](../../apps/orchestrator/src/usage/cost.ts). Each line is
costed at the price version in force when the attempt **started**, so a new price
never changes history.

- Input or output tokens not reported: the calculated cost is null.
- A dimension the price list bills but the provider did not report: null.
- A dimension the price list does not bill (null price) and the provider did not
  report: adds 0.
- Cache writes at two different rates with no one-hour split: null.

The event cost is `PROVIDER` when every line has a provider cost; otherwise
`CALCULATED` when every line has a provider or calculated cost; otherwise
`UNKNOWN`, with a null display cost. Seeded prices are the Anthropic
first-party list prices:

- Haiku 4.5: `verified`
- Opus 5.5: `unverified` (its cache-write rates are derived)
- all others: `documented`

OpenAI and Codex models have no verified price, so their cost stays Unknown
until one is added. **Recalculate** (`POST /recalculate`) costs Unknown attempts
that a new price can now cover, and writes one revision each.

## Read models

Implemented in [queries.ts](../../apps/orchestrator/src/usage/queries.ts). Every
figure is an indexed SQL aggregate of the raw ledger. There are no rollup
tables, so nothing needs rebuilding. Cost sums include only known costs; each
total carries `unknownCostRequests`. The model view has one unit per model an
attempt used, and a line's cost counts only when its attempt's cost is fully
known, so model totals add up to the overall total.

The trend groups by hour (ranges up to 2 days), day (up to 92 days) or
Monday-based week, all in the orchestrator's local time.

**Measured** ([usage-perf.test.ts](../../apps/orchestrator/test/usage-perf.test.ts),
20,000 attempts over 30 days, loaded machine):

| Query | Time |
|---|---|
| Overview | ~1.5 s |
| Events page | 10–20 ms |
| Model-filtered events page | ~20 ms |
| Task page | ~200 ms |
| Model breakdown | ~450 ms |
| Reconciliation | 0.6–1 s |
| Export of 20k rows | 2–3.6 s |

## Reconciliation and health

`reconcile()` runs at startup and from `POST /reconcile`. It checks that
provider, model, task (plus unattributed), daily and token totals equal the
sum of the raw attempts. It also checks that each attempt equals the sum of
its model lines, and that calculated prices stay within 2 % of the provider's
own figure (a drifted price list fails that check).

Health covers ingestion (spooled writes, recent errors), the cost engine
(share of Unknown in 30 days), aggregates, capacity freshness, pricing (models
without a price) and reconciliation.

## Capacity

Implemented in [capacity.ts](../../apps/orchestrator/src/usage/capacity.ts).
Readings arrive only with agent runs, because the provider command-line tools
have no separate limits endpoint. They are never fetched, scraped or estimated.

- A reading keeps its value and is marked **stale** after 30 minutes, or once its
  window's reset time has passed.
- Metrics a provider does not expose show `Unavailable`.
- "Refresh" re-judges freshness and prunes superseded readings older than 90 days.
- **Can't run now.** `blocksRuns` ([usage.ts](../../packages/shared/src/usage.ts)):
  a fresh `exhausted` reading of any metric except `overage` (paid extra usage,
  never used in Subscription Only mode). The recorder's `capacityBlock(agentId)`
  exposes it as `AgentInfo.capacityBlock` on `GET /api/agents`; Home shows it
  on the agent's health row, and the Chairman never reroutes into such an agent
  ([chairman.md](chairman.md)). It never refuses a launch, and a stale reading
  never blocks, so adding credits or a window reset clears it by itself.
  Dashboards refetch agents with every `usage` message.

## Budgets

Implemented in [budgets.ts](../../apps/orchestrator/src/usage/budgets.ts).

- **Scopes:** `GLOBAL`, `PROVIDER`, `PROJECT`, `MODEL` (its own line share),
  `AGENT`, `TASK` (period `total` only).
- **Periods:** local day, Monday week or month.
- **States:** `ok`, `warning`, `critical`, `exceeded`, from the thresholds.
- **Amount:** at least one nano-dollar (`amountUsd >= 1e-9`); a smaller one would
  round to zero. A zero amount already stored reads as `exceeded`.
- **Policies:** `WARN_ONLY` (the default) and `STOP_NEW_RUNS`. A model budget stops
  only runs that request that model explicitly. Nothing is ever switched to a
  cheaper model.

## Anomalies

Implemented in [anomalies.ts](../../apps/orchestrator/src/usage/anomalies.ts).
These are deterministic rules: each anomaly states its rule, threshold and
measured value.

| Rule | Triggers when |
|---|---|
| Excessive retries | 4 or more attempts of one stage |
| Duplicate request | same prompt hash, agent and model resent within 10 minutes of a successful attempt |
| Repeated context | 3 or more attempts of 150k or more context tokens in one task |
| Failed-attempt spend | any cost on failed attempts (a warning from $1) |
| Unusual task cost | more than 3× the median of 5 or more same-workflow tasks in 90 days |
| Context growth | 2× or more between consecutive attempts of a stage, and at least 50k tokens |
| Model escalation | a reroute to a model with a 1.5× or higher input price |
| Review and fix loop | 3 or more fixer attempts in one task |

## API (`/api/usage`, bearer token)

`GET overview|trend|breakdown/:dimension|tasks|tasks/:id|tasks/:id/live|providers|events|events/:id|anomalies|health|export|budgets|pricing`,
`POST reconcile|capacity/refresh|budgets|pricing|recalculate`,
`PATCH|DELETE budgets/:id`.

- **Ranges** need `from` before `to` and at most 400 days.
- **Events** use a keyset cursor on `(started_at, id)`.
- **Export** writes the CSV or JSON of the filtered attempts, tasks or models.
  Its field list is safe, and spreadsheet formulas are neutralised with a
  leading `'`.
- **Realtime:** every recorded or re-costed attempt publishes `{type:'usage', event}`.
  The dashboard refetches its usage queries at most once a second.

## Dashboard

`/usage` (design.md §7.10) has seven tabs:

- Overview
- Tasks
- Models (with the price list)
- Agents (by role or agent)
- Providers (capacity rows with confidence)
- Budgets
- Attempts

`/usage/tasks/:id` is the cost ledger: cost flow, anomalies, budgets and an
attempt drawer. Task Detail's inspector has a live **Usage** panel. Shared
components ([charts.tsx](../../packages/ui/src/components/charts.tsx)):
`ColumnChart`, `StatTile` and `Meter`.

## Gotchas

- Usage history starts when migration 4 was applied (`trackingStartedAt`).
  Earlier executions have no token data and are not backfilled.
- A Claude run can use several models. Model totals come from the lines, never
  from the requested alias.
- The live orchestrator runs from this repository's `dist`. Rebuild it only
  from a committed, checked tree: the dashboard is served live as soon as it is
  rebuilt.

Last verified: 2026-09-24
