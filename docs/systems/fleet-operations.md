---
system: fleet-operations
sources:
  - apps/cloud-control/src/operations/**
  - apps/cloud-control/operations/**
  - apps/cloud-control/migrations/0002_fleet_operations.sql
  - apps/cloud-control/test/operations.test.ts
verified_at: e215cf5
---

# Fleet operations

> Last verified: 2026-10-10 — full local suite (2,346 passed, 23 existing skips), real local Workers/D1 safety tests, and Operations mobile/desktop browser checks in both themes. Production rollout, real subscription execution and elapsed observation windows remain unverified.

The existing cloud control plane owns the durable app registry, incidents,
probes, daily budgets, recovery receipts and owner-delivery outbox. Its five-minute
cron evaluates bounded due work, not every application database. Messenger
captures owner bot warnings in the message transaction and forwards immutable
IDs immediately for internal ingestion, with its fifteen-minute cron as retry.
The implemented account-scoped Messenger MCP tool `read_app_operations` is
pending the server release; the current connection still exposes six notification
tools. No native Dot chat-creation API was established;
investigations use actual Control Center tasks and their existing conversations.

## Trust and credentials

Human `/api/cloud/operations/*` routes require Access, exact Origin for changes,
and configured owner email. Machine routes use only the relay hostname:

| Route | Credential | Authority |
| --- | --- | --- |
| POST `/ops/v1/events` | Individual app token (only SHA-256 stored) | Own app's immutable events; fresh native proof can establish recovery |
| POST `/ops/v1/notification-events` | `OPS_BRIDGE_TOKEN` | Owner notification alerts; cannot supply healthy events or proof |
| GET `/ops/v1/summary` | `OPS_READER_TOKEN` | Bounded inventory/status or cursor-paginated incidents for one app |
| POST `/ops/v1/apps` | Separate `OPS_REGISTRATION_TOKEN` | Owner app-creation provisioner; validated registration and bot provisioning |

Reader OAuth grants no command, recovery, registration or send access.
Messenger rechecks reader revocation, current membership, Messages permission
and group consent on every MCP call. Old shared notification senders are limited
to their legacy identities; future bots have hashed per-source credentials and
an explicit owner recipient. Existing source credentials are never silently
rotated by registration. New tokens are returned once with no-store and belong
in secret managers, never logs, chat, bundles or Git. Deployment operators can
revoke a future source by disabling its registry row; credential replacement
requires an explicit administrative rotation on both issuer and producer.

Staging enables monitoring only: no recovery secret, no owner-delivery secret,
and `OPS_INVESTIGATION_ENABLED=false`, `OPS_RECOVERY_ENABLED=false`.
Production uses separate `OPS_HEALTH_TOKEN` for native health reads and
`OPS_RECOVERY_TOKEN` for the fixed bounded recovery recipe. Target bindings and
paths are compiled; alerts cannot choose a network destination or command.

## Evidence and recovery coverage

| App / failure | Implemented cloud evidence or action | Proof / remaining boundary |
| --- | --- | --- |
| Messenger stale never-attempted outbox | Own active workspace; queued, zero retries, no ad opener, queued message with no provider ID; native Queue requeue at most five, eight requests/day | All recorded IDs have provider-delivered/read status and provider IDs. A retry response or `sent` never resolves the incident |
| Messenger scheduler | Existing KV cron receipt, fresh within 45 minutes | Missing or stale receipt means unknown; the monitor does not manufacture a heartbeat |
| Uncertain message outcome | Decision-only incident | No resend or budget reservation cleanup by supervisor |
| Website / AI brain | Existing `/api/health`, D1/R2/cron readiness, bot alerts | Health is service evidence, not successful AI answers. Existing ring-zero AI recovery and consent/budget gates remain authoritative |
| Sales Analyzer | Basic `/exec` liveness and Sales Bot alerts | Inventory reconciliation requires `records_reconciled`, not HTTP 200; fifteen-minute sync preserved |
| Accounting | Accounting Bot technical and business alerts; actual scheduler metadata registered separately | 25 deployed scheduler/service Workers were individually enumerated through
Cloudflare on 2026-10-09, plus one undeployed print-agent config. Source and
live schedules differ: dispatcher is live every minute (source five minutes),
standalone stocktake_check runs at minute zero, while the managed stocktake_anomaly_digest runs at minute five (both successful native schedule rows inspected on 2026-10-10), Google
Sheets is live every two hours 06–20 (source daily 04:00), and DR backup has an
extra five-minute trigger. Existing schedules are preserved; a production
cost-cut baseline is held by another monitor. Website deployment never proves separate scheduler Workers. Job receipts unavailable to this new reader stay disabled until wired and verified |
| ARK | Backup alerts, durable pending investigation | Real device and current copy receipt required; static hosted preview is not backup proof |
| Product Hunter / Applybridge | Existing cheap basic health routes | No paid research/application call used as a probe |
| Rihla | Event ingestion/investigation contract | Existing health counts its cost ledger: periodic probe deliberately not seeded until a bounded health route is released |
| Code repairs / prevention | Existing typed `task.create`, full-autopilot workflow, isolated worktree, lease and two-strategy limit | Actual paired node must be online; existing typed release approval remains mandatory |

Native recovery beyond Messenger is not advertised as deployed. Existing app
procedures are described to the investigation agent, which must recheck their
preconditions on the real execution machine before invoking them. Financial
warnings, staff handoffs, opt-outs and budget holds stay decision-only. There is
no automatic financial adjustment, restore, provider fallback, spend-cap change
or uncertain customer resend.

Registered schedules with `heartbeatExpected:false` document a known cadence
without falsely treating a missing integration as a failed job. Enable only
once the producer emits validated success receipts and the job contract declares
its required `proofKind`. A liveness/HTTP receipt cannot substitute for a backup
artifact, provider delivery or inventory reconciliation. A registered producer can
publish a same-job heartbeat with its per-app credential; intervals and grace
are deadlines, never permission to rerun jobs.

## Incident and task lifecycle

Fingerprint = app + affected resource + operation + normalized signature.
Concurrent event retries have transaction-scoped ingestion nonces; changed
payloads reusing an ID are rejected. New, reopened, resolved and action-state
changes persist their owner-delivery receipt in D1. Duplicate alerts count
occurrences, rather than spawning tasks. Dependency incidents are linked as
context; cross-app symptoms are not silently declared to have a common cause.

Three recurrences in seven days persist a separate `prevention_review` incident.
It survives routine recovery of the original outage and requires fresh production
behavior evidence to close. Healthy proof must be no more than fifteen minutes
old, not precede the failure, and use the operation's required proof kind.
Notification prose never qualifies as proof.

No connected current node with the registered repository means
`waiting_execution`. No command is sent while offline. Routine task work inherits the actual machine/repository auto-approval and
policy ceilings; the remote monitor cannot raise them. Production/dangerous
actions still require existing typed owner approval.
Repository fingerprints,
protocol readiness and hub connection are rechecked before the 120-second typed
command is created. A current-event/version check rejects obsolete commands
before delivery. Stable idempotency prevents repeated task creation after a
Worker crash. A failed/rejected/expired command is not automatically replayed.
Task completion enters verification, not resolution.

## Cost and retention

Hard daily ceilings: 300 events, four investigations, 24 owner deliveries and
6,000 logical work units. These are admission guards, not a dollar guarantee or
measurement of Cloudflare billing. No paid AI/provider call is used for health;
source investigations still consume the execution account's existing quota.
Checks use indexed deadlines, bounded candidate sets and 25-item incident pages.
Each tick counts individual D1 statements, including every statement inside
a batch, and refuses egress beyond 48 statements (headroom below D1 Free's 50).
Phases leave work durable for later ticks when the remaining allowance is too
small. First boot registers all seeds in one bounded transaction; schedules
without connected receipts stay metadata-only and cause no due polling.
At most four overdue jobs, two incidents, two service probes and two owner
messages are handled per tick. Probe cadence: Messenger/website 15 minutes,
Sales 30 minutes, cheap secondary services hourly. Only probe transitions emit
events. Offline investigations back off hourly. Recovery never raises native
customer-send budgets.

Daily pruning deletes bounded batches of old events, sent owner receipts and
resolved incidents after thirty days. Pending/uncertain delivery and recovery
identities remain durable. Recovery identities cascade only when their resolved
parent is safely pruned. Messenger prunes only sent/verified thirty-day receipts.

Messenger's own hourly deterministic watchdog observes the supervisor heartbeat,
execution-node activity, monitoring admission limit and delivery backlog. It
writes an idempotent owner bot message and existing Web Push on state changes.
This covers a supervisor outage while Messenger is available. The separately
hosted ChatGPT task **Check app availability** is saved and enabled hourly as
an independent fallback. It checks reader access, reads the actual Messenger KV
scheduler timestamp through Cloudflare, and checks production supervisor
readiness without depending on either app's notification bot. Until production
`OPS_ENABLED` is true, absence of a supervisor tick is pending rollout rather
than an outage. Once enabled it reads one runtime row and one indexed oldest
pending notice: at most two D1 statements per run. Stale supervisor completion
(20 minutes), stale Messenger scheduler (45 minutes), blocked notice delivery
(30 minutes) or unavailable evidence can be reported through the hosted task.
The first scheduled execution and actual phone-push delivery remain unobserved.
Independent email setup is blocked by the current token's email-routing
permission (403); no disabled customer or Telegram channel is repurposed.

The separate **Review Messenger notifications** task is saved and enabled at
09:00 Asia/Shanghai, starting 2026-10-10. Authenticated review paginated all
2,388 available messages through checkpoint `2026-10-09T17:52:36.000Z`; unread
counts stayed unchanged. Future runs refresh every channel-list page, backfill
new bots once and use incremental successful checkpoints. Without supported
persistent task state they disclose the limitation and use an overlapping
24-hour review plus searches for unresolved alerts, not repeated whole-history
scans. Reporting groups still require explicit consent. The existing temporary
customer-reply monitor's complete prompt, enabled state and schedule are unchanged.

Private plugin 1.0.2 publishes these discovery and evidence instructions while
preserving its App binding, permissions, audience and presentation. Its optional
operations guidance explicitly labels unavailable supervision as pending.
Prepared server/plugin 1.2.0 capabilities are not represented as live. Platform
automation availability and quota are separate from the Workers/D1 admission
guards; no paid provider probe or plan increase was enabled.

## Registration and release

The seed inventory is [fleet.json](../../apps/cloud-control/operations/fleet.json).
The owner provisioner posts a complete app contract to `/ops/v1/apps`, then stores
returned individual event and notification tokens on the new producer. Onboarding
is retryable: registry success does not claim successful bot provisioning. Source
credentials are not returned again or automatically rotated after a lost response.
The app-creation playbook must perform this step; merely creating a GitHub repo
cannot infer a service, tenant, schedule or recovery permission. New bot chats
appear in reader discovery automatically. Reporting groups still need consent.

Release the Control Center through its manual staged deployment script, then
Messenger through its existing Workers Builds pipeline. Apply migrations before
code, preserve established secret values, and verify the actual Worker version,
cron heartbeat, owner-only outbox delivery and native provider proof. Do not mark
a release green if network policy prevents its live checks or the real execution
node is offline. Keep gaps and exact operator actions in the plan ledger.

The supported deployment script checks required scoped credentials before remote
migrations or code activation. Staging requires only native health access;
production requires the six individual purpose-specific operational secrets.
Legacy source onboarding reuses the existing bot without minting a notification
credential, while the registered app can receive its individual event token.

First installation uses `apps/cloud-control/scripts/provision-operations.mjs`:
credential values stay in memory and Cloudflare, no historical token rotates,
and partial installation fails closed. Owner onboarding also supports the
Access-authenticated `/api/cloud/operations/onboard`; an app-creation broker may
supply an ephemeral `OPS_ACCESS_JWT` to the CLI instead of retaining the shared
registration authority. The CLI verifies individual producer secret names;
metadata success with missing credentials is a blocked onboarding result.

The first unavailable health observation creates an unknown-health incident;
subsequent unchanged observations do not generate events. Environments with
both action flags disabled do not repeatedly reserve action budgets. This keeps
monitor-only staging within its intended deterministic checking allowance.

Verified same-job native receipts update the indexed deadline and resolve the
corresponding missing-activity incident atomically, even when the normal producer
operation has another fingerprint. Healthy prose without job identity, weak
proof types and stale receipts cannot close a missing-activity incident.

## Current release candidate and cost verification

Production keeps investigation and recovery held. Messenger independently holds
alert forwarding/watchdog behind OPS_BRIDGE_ENABLED=false and all recovery POSTs
behind OPS_RECOVERY_ENABLED=false until the supervisor rollout is verified.
Read-only native health remains available. Future timestamps never establish
native proof or monitor completion; current hub connectivity and minimum node
protocol are required, rather than a historical heartbeat.

The monitor reads incidents, jobs, notices and probes in one due-work statement.
Every branch applies an indexed limit before UNION ALL: two incidents, four
jobs, two notices, two probes. Incident states each stop at two indexed rows
before the final bounded priority sort. The existing indexes are reused; no
new application message indexes or write amplification are introduced. Quiet
ticks use four D1 statements: claim, daily admission, due snapshot, completion.
At 288 ticks/day this is 1,152 baseline statements; actual probes/actions add
work and must be measured. This is a projection, not an invoice or free-plan
claim. The 48-statement invocation ceiling remains enforced. Completed receipts
record actual D1 rows read/written before the final completion write, explicitly
excluding that last write. Optional work reserves enough daily units for the
remaining monitor receipts; budgetLimited discloses incomplete coverage while
leaving due work durable. New state notices join delivery on the next tick.

The owner Operations route is cloud-only, uses shared semantic components,
25-incident pages, authenticated task links, five-minute caching/polling and no
hidden-page polling. It separates business/staff/policy/uncertain cases, held
actions, missing receipt contracts and native verification. Empty pages and
finished tasks never assert healthy applications.

Optional Messenger review state uses a separate explicit OAuth metadata scope,
three small tables and signed snapshot/terminal tickets. Checkpoints use CAS and
idempotent successful-run receipts. Incomplete continuation is bounded to 60 KB
and 24 hours, never changes the successful checkpoint, and cannot resume across
revocation or changed consent. See the Messenger notification-reader document
and prepared plugin source for the fixed daily_digest protocol.

## Rollout ledger — 2026-10-10

- Production supervisor remains on version 2a9872f3-a59e-406d-808f-5b8d7f811129;
  OPS_ENABLED is absent and its ledger contains only migration 0001. Missing
  ops_runtime is pending rollout, not a newly detected outage.
- Staging is monitor-only, version 4d9ce7cc-4f78-4c92-bdf3-ecce9f269672, with
  migrations 0001/0002. Its old-candidate natural completions do not verify this
  candidate. Observe three new-candidate natural cron completions after release.
- Messenger production baseline is 664c76c5-0d38-45be-a329-afd6c15e7d1d,
  migration ledger through 0201. Release uses its normal main Workers Builds
  path; new migrations 0202/0203 are additive. Never rerun completed 0184.
- Actual owner account contact@tenten.ma and all seven current channels were
  read successfully. The existing grant exposes six legacy tools; optional
  metadata consent and new live capabilities remain separate acceptance steps.
- Owner PC Dr_AbuYahya is offline. A simulated local relay investigation is
  not evidence of a real subscription-authenticated investigation.
- The token cannot read subscription-plan details (403). Do not claim paid-plan
  headroom, production CPU/row targets or costs verified. No plan/cap is raised.
- The enabled 09:00 Asia/Shanghai digest and independent hourly availability
  tasks are reused. Other customer/spend monitors retain their established
  prompts and schedules. Do not add a second fleet polling orchestrator.

Operator deployment remains mandatory under AGENTS.md: cloud sessions never run
wrangler deploy. From the owner environment release staging with
pnpm cloud:deploy:staging, inspect three candidate-version completions, then use
pnpm cloud:deploy:production with actions still held. Production live health
requires actual Access. Verify reciprocal readers/owner notices and native job
receipts before enabling bridging, then investigations, then one recovery canary.
Unwired job contracts remain heartbeatExpected=false. Do not register a fake
producer or rotate existing credentials to manufacture acceptance evidence.

The 48-hour unchanged healthy baseline and seven-day recurrence/cost observation
windows begin only after a verified rollout/canary, using the exact deployed
revision and native receipts. Neither window has elapsed for this candidate.
