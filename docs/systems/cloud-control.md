---
system: cloud-control
sources:
  - apps/cloud-control/**
  - apps/dashboard/src/app/mode.ts
  - apps/dashboard/src/api/cloud.ts
  - apps/dashboard/src/pages/NodesPage.tsx
  - apps/dashboard/e2e-cloud/**
  - .github/workflows/**
verified_at: e215cf5
---

# Cloud control plane

A Cloudflare Worker that lets a signed-in person use the Control Center from any
browser while every task still runs on a paired machine
([remote-node.md](remote-node.md)). The cloud relays typed requests, stores a
sanitized copy of history for offline reading, and never runs code. Plan and
evidence: [docs/plans/cloud-control-plane.md](../plans/cloud-control-plane.md).

> Last verified: 2026-10-10 — authorized cloud-release policy and enforced public-host network denial checked; no new deployment is claimed.

Fleet supervision and its separate owner/scoped machine routes are documented in
[fleet-operations.md](fleet-operations.md). Code repairs still execute on paired nodes.

## Pieces

| Piece | What it is |
|---|---|
| Worker `acc-cloud-control` (+ `-staging`) | [src/index.ts](../../apps/cloud-control/src/index.ts): routes by hostname; serves the dashboard build as Static Assets with `run_worker_first` so every request is authenticated first |
| D1 `acc-control-production` / `acc-control-staging` | nodes, pairing codes, commands, the task mirror, usage, manifests, leases, audit ([0001_control_plane.sql](../../apps/cloud-control/migrations/0001_control_plane.sql), 13 tables) |
| R2 `acc-artifacts-production` / `-staging` | private; artifact bytes and log chunks uploaded by nodes |
| Durable Object `WorkspaceHub` | [src/hub.ts](../../apps/cloud-control/src/hub.ts): one object, holds every node and browser WebSocket (Hibernation API, tags `node`, `node:<id>`, `browser`) |
| Rate limits | pairing 20/min, unauthenticated requests 60/min per IP, actions 300/min per person |
| Cron `17 3 * * *` | retention (below) |
| Cron `*/5 * * * *` | bounded durable fleet operations ([fleet-operations.md](fleet-operations.md)) |

Hostnames (dr-badawi-abdalsalam.com): production `acc.` (people) and
`acc-relay.` (machines); staging `acc-staging.` and `acc-relay-staging.`.
`workers_dev` and `preview_urls` are off; any other hostname gets 404 (only
`/health`, which reveals nothing, answers on every hostname).

## Two hostnames, two trust boundaries

`CONTROL_HOSTS` serve people: the dashboard, `/api/*`, `/ws`. `RELAY_HOSTS`
serve machines: `/node/v1/*` and separately authenticated `/ops/v1/*`. A relay path on the control host, or
anything else on the relay host, is 404. `/health` answers `{ok:true}` on both
and reveals nothing.

### People (control host)

[auth/access.ts](../../apps/cloud-control/src/auth/access.ts). Cloudflare Access
sits in front of the control hostname; the Worker verifies the Access JWT again
(header `cf-access-jwt-assertion` or cookie `CF_Authorization`): RS256 against
the team's JWKS, `aud` = `ACCESS_AUD`, `iss` = `https://<ACCESS_TEAM_DOMAIN>`,
`exp`/`nbf`. `ALLOWED_EMAILS` narrows further, in case the Access policy is too
broad. **Until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, every human request
is refused with 503 `ACCESS_NOT_CONFIGURED`** — fail closed. `ACCESS_JWKS` (a
static key set) exists for tests and is ignored in staging and production.

Production (since 2026-09-24): team `sparkling-breeze-b580.cloudflareaccess.com`,
self-hosted application "ACC Control" on `acc.dr-badawi-abdalsalam.com` only,
policy "Owner only" (the owner's two addresses; login method: Cloudflare
account). Staging has no Access application and stays fail-closed (503).

State-changing requests must be same-origin (`Origin`, `Sec-Fetch-Site`). The
dashboard HTML gets a strict CSP, `X-Frame-Options: DENY` and `no-store`.

### Machines (relay host)

[auth/node.ts](../../apps/cloud-control/src/auth/node.ts),
[routes/relay.ts](../../apps/cloud-control/src/routes/relay.ts):

| Route | Does |
|---|---|
| `POST /node/v1/pair` | trades a single-use pairing code (`accpair_…`, 15 min, stored only as a SHA-256) and a P-256 public key for a node id |
| `POST /node/v1/challenge` | a 60-second nonce; 404 unknown node, 403 revoked |
| `POST /node/v1/session` | signature over the challenge → an HMAC session `accs1.…` (10 min), bound to node, key version and protocol; signed with the `NODE_SESSION_SECRET` secret |
| `POST /node/v1/rotate` | new public key, signed challenge, authorized by the current session |
| `GET /node/v1/connect` | the node's WebSocket (session in `Authorization`, never in the URL) |
| `PUT /node/v1/artifacts/:id`, `PUT /node/v1/logs/:executionId/:index` | uploads with `x-acc-sha256`; R2 rejects bytes that do not match |

Node sockets older than 12 h are closed so every connection re-authenticates.

## The API people call

`/api/cloud/*` is cloud-native ([routes/control.ts](../../apps/cloud-control/src/routes/control.ts)):
session, health (database, storage, realtime, sign-in), nodes (list, rename,
revoke, rotate), pairing codes (list, create, cancel), commands and audit, and
artifact/log downloads from R2.

Every other `/api/*` path must match an operation in the typed catalog
([remote-operations.ts](../../packages/shared/src/remote-operations.ts)); anything
else is 404 `NOT_REMOTE` ("only available on the machine itself"). The target
node comes from `x-acc-node` (a node id, or `auto` for a new task: the Worker
picks an online node that has the same repository by fingerprint, preferring
`x-acc-source-node`); with exactly one active node it may be omitted.

- **Reads** go to the node over RPC through the hub. When the node is offline
  (or answers 503/504), the operations marked `offline` are answered from D1/R2
  with `x-acc-source: cache` ([offline.ts](../../apps/cloud-control/src/offline.ts)):
  overview, task list/detail/events/artifacts, execution logs, artifact content,
  approvals, agents, repositories, usage events. Others: 503 `NODE_OFFLINE`.
- **Mutations** become durable commands: body validated against the operation,
  node chosen, precondition bound (task version, or the approval's hash), the
  command row written to D1 **before** the node is told. The `Idempotency-Key`
  is looked up first: a repeat of the same request returns the first answer
  (never a second command, even if the approval was decided or the node went
  away meanwhile); the same key with a different request is 422
  `IDEMPOTENCY_MISMATCH`. Repository-bound operations take a lease per
  repository fingerprint **before** the command row exists, so two nodes never
  work on the same repository at once (409 `LEASE_CONFLICT`). A lease is
  released when its node has nothing left in flight on that repository: no
  undelivered or running command and no unfinished (or not yet mirrored) task a
  command started — checked after each command, each finished task and every
  heartbeat. The
  request waits briefly for the result (the waiter is registered before the
  node is told, so a fast answer is never missed, and a wait that times out
  answers with what the command row holds by then); a command still running answers 202
  with `x-acc-command-status`. A new task may be queued for an offline node
  (`x-acc-queue: 1`); anything else needs the node online.
- Opening a remote terminal also needs `x-acc-confirm: open-terminal` and a
  sign-in younger than one hour.

Command states follow `COMMAND_TRANSITIONS` in
[remote.ts](../../packages/shared/src/remote.ts); `CloudStore.transition` is a
single conditional UPDATE, and the hub handles each node's frames in order, so a
claim and its result can never overtake each other.

## Realtime

Browsers connect to `/ws` (same-origin, Access-verified); the hub forwards the
node's live messages and mirrored events to every browser, tagged by node, and
the dashboard keeps only the selected node's. `remote.*` messages come only
from the cloud: the hub drops any a node sends, and the dashboard ignores one
that carries a `nodeId`, so a node cannot impersonate another. A node's answer
keeps its content type only when it is JSON, plain text, CSV or a raster image;
anything else is `application/octet-stream`, and every relayed answer carries
`Content-Security-Policy: default-src 'none'; sandbox` (binary operations also
`Content-Disposition: attachment`), so nothing a node returns runs as a page on
the signed-in origin. Terminal keystrokes need a sign-in younger than one hour,
as opening a terminal does. Nodes send heartbeats (every 30 s); the hub checks
revocation and idle leases at most once a minute, and writes `last_seen_at` at
most once a minute — not at all while event batches (which write it too) have
just done so, when the revocation check is a one-row read instead. A node's
status therefore still turns `degraded` 2 minutes after its last sign of life.

## Retention (daily cron)

The Worker's own `17 3 * * *` cron, not the hub: it runs whether or not a node
is connected (confirmed 04–07/10/2026, every day a success with no node
online; the hub's hourly alarm only renews node sockets). Cloud copies only;
nodes keep their own history. A replaced artifact or log
chunk deletes its previous R2 object, a failed re-upload keeps the stored
copy's hash, and an artifact the node marks `local_only` is deleted from R2 and
no longer served. Artifact bytes, log chunks and
task events: 90 days. Finished commands, expired pairing codes and released
leases: 30 days. Usage events and audit: 400 days. A revoked node's stored
artifacts and logs are no longer served at once, and 30 days after revocation
its task mirror, events, entities, usage, repositories, manifests, log chunks
and R2 objects are deleted.

## Dashboard in cloud mode

The same dashboard build. A page served without the `acc-token` meta tag is in
cloud mode ([mode.ts](../../apps/dashboard/src/app/mode.ts)), confirmed by
`GET /api/cloud/session` before the app starts. Requests carry no token; they
send `x-acc-node` and an `Idempotency-Key`. Cloud mode adds the Nodes page and
the top-bar node selector, banners for offline or out-of-date nodes, "Run on"
and "Run when the node is back" on New Task, and hides what only the machine may
do (Settings → Remote access, attachments). See [dashboard.md](dashboard.md).

The cloud dashboard can be installed to a phone as an app. The manifest and
icons are ordinary assets behind Access and the Worker's own check; there is no
bypass path, and `pnpm cloud:smoke` proves `/manifest.webmanifest` is refused
without a sign-in. An installed app notices an expired Access session and says
so ([dashboard.md § Installable app](dashboard.md#installable-app-pwa)).
Changing the control hostname changes the app's origin, so installed copies
must be reinstalled.

## Deploy, pair, revoke, recover

| Task | Command |
|---|---|
| Release | `pnpm cloud:deploy:staging` / `pnpm cloud:deploy:production` ([deploy.mjs](../../apps/cloud-control/scripts/deploy.mjs)): refuses a test key set → applies D1 migrations (a failure stops before any code ships) → deploys → creates `NODE_SESSION_SECRET` on first release → live smoke |
| Live check | `pnpm cloud:smoke` ([smoke.mjs](../../apps/cloud-control/scripts/smoke.mjs)): both `/health`, control host refuses dashboard/app manifest/API/realtime/forged tokens, relay serves no dashboard, refuses unknown nodes, and answers a forged session on a real WebSocket upgrade with 401 |
| Turn on Access | `pnpm cloud:access --env production --team <team>.cloudflareaccess.com --aud <tag> --email you@…` ([access-setup.mjs](../../apps/cloud-control/scripts/access-setup.mjs)) after creating a self-hosted Access application for the **control** hostname only; writes the three vars into wrangler.jsonc and releases. Commit the changed file. |
| Pairing code without the dashboard | `pnpm cloud:admin pair-code --env production --label "Desk PC"` |
| Emergency revocation | `pnpm cloud:admin revoke --env production --node node_…` — works with Access or the dashboard down (writes D1 through Wrangler); pending commands are rejected and leases released |
| List nodes | `pnpm cloud:admin nodes --env production` |
| Roll back code | `wrangler rollback <version-id> --env production` (or the Rollback workflow) |
| Roll back data | D1 Time Travel: `wrangler d1 time-travel restore acc-control-production --timestamp <iso> --env production` |
| Observability | [wrangler.jsonc](../../apps/cloud-control/wrangler.jsonc) keeps Workers Logs on at full sampling (`head_sampling_rate: 1`) and sets `traces.enabled: false` in every block, so a release switches tracing off on Cloudflare (Observability bills ingestion from 01/12/2026; logs carry the triage evidence). Takes effect only at the next manual release of each environment. |

Both rollbacks and a deliberately failing migration were exercised on staging
(plan Ledger, step 22). Current policy keeps GitHub Actions disabled and these
Workers outside Workers Builds; pushing main does not release them. The supported
scripts run from an authorized local or cloud environment. The former blanket
cloud-session ban was a repository instruction, not a Cloudflare requirement;
on 2026-10-10 it was replaced with prerequisite and proof gates in AGENTS.md and
CLAUDE.md. Full-autopilot authorization covers routine release, but never grants
permission to bypass network policy, migration cost checks or scoped credentials.

Before remote mutation, check the clean tested revision, actual migration cost
inputs, configured credentials and public-host reachability/full smoke support.
Then use the staged script and verify the exact deployed version and complete
smoke checks; merely uploading successfully is not release acceptance. These are
operator/agent prerequisites: deploy.mjs itself currently performs its smoke check
after upload, so it must not be used to discover an environment's network denial.
The paired owner PC is needed for subscription-authenticated investigations on
that node, independently of publishing the cloud Worker.

Managed cloud sessions keep proxy and CA trust; use `NODE_USE_ENV_PROXY=1` for the
Node entrypoint. On 2026-10-10 the environment reported an enforced restricted
policy allowing Cloudflare's API, GitHub and package presets, but excluding the
public app hosts. A read-only staging relay request confirmed `Tunnel connection
failed: 403 Forbidden` before reaching Cloudflare. The required additional host
allowlist for this rollout is `acc-staging.dr-badawi-abdalsalam.com`,
`acc-relay-staging.dr-badawi-abdalsalam.com`, `acc.dr-badawi-abdalsalam.com`,
`acc-relay.dr-badawi-abdalsalam.com` and `messenger.digitronics.app`. Add only
those hosts through environment configuration, then verify policy enforcement
and run the existing checks. No available tool in this session can edit that
network policy. Billing inputs remain a separate release blocker.

## Repository snapshot write cost

`CloudStore.setRepositories` keeps one atomic snapshot per node: delete only missing local IDs, insert new records, and update only changed name/fingerprint/remote-host/default-branch fields. Unchanged rows retain `updated_at` (last content change; no reader treats it as node liveness). The JSON membership list keeps the delete below D1's parameter cap for large inventories. Duplicate local IDs still reject the complete snapshot without writes. An empty snapshot removes only that node's repositories.

Round 2 C1 baseline: 50–85K writes/day, about 80% repository replacement; expected saving 1.5–2M/month. Claims/proof: [change-claims.md](../change-claims.md). Production release remains manual and is pending outside this read-only cloud task.

## Data ownership

The machine owns the truth: the task database, files, diffs, credentials and
the local token never leave it. The cloud holds what the node chose to send —
sanitized task and event mirrors, repository records (name, fingerprint,
configured command lines and dev URL — redacted, never a path),
agents, usage, manifests, `safe_sync` artifact bytes and log chunks — plus its
own records (nodes, pairing codes, commands, leases, audit). Losing the cloud
loses no work; restoring an older D1 makes the node resend everything
(`ackedSeq` went backwards → full resync).

Mirror writes happen on change only ([store.ts](../../apps/cloud-control/src/store.ts)
`eventStatements`): an entity, task, task detail or usage event identical to the
stored row is an upsert that changes nothing (zero rows written). For entities,
`$.status.checkedAt` (a repository's last Git check) does not count as a change,
and an unchanged row is still refreshed once it is 6 hours old
(`ENTITY_REFRESH_MS`, accepted up to 15 minutes early because the node times
its 6-hour refresh from when it queued the copy, not from when the cloud stored
it). A copy that waited offline in the node's outbox is stored much later than it
was queued, so a refresh is also accepted when the stored `status.checkedAt` is
that window older than the incoming one: the node's own check times, unaffected
by delivery delay. An offline "Checked" time is therefore at most that stale.
`detail_updated_at` is when the detail last changed. The batch cursor
(`nodes.last_event_seq`) is still written on every batch: a cursor behind the
node's would make it run a full resync on the next welcome.

## Gotchas

- A Worker deploy resets the hub, dropping every socket (close 1006); nodes and
  browsers reconnect by themselves.
- Deploy from a committed tree: Wrangler bundles `packages/shared` from source,
  so a working tree with someone else's uncommitted edit ships it.
- `wrangler dev` reloads when shared sources change; in tests that looks like a
  node drop.
- Pinned `wrangler` 4.135.0 and `@cloudflare/workers-types` 5.20260919.1: pnpm's
  one-day minimum release age refused newer ones.

## Tests

`pnpm cloud:test`: the real Workers runtime (`wrangler dev --local`, local
D1/R2/DO) with a test Access key set and the real orchestrator as the node —
`auth`, `nodes`, `commands`, `objects`, `features`, `load`, `uploads`
([test/](../../apps/cloud-control/test/)). Without a dashboard build (`pnpm check`
on a fresh checkout) the harness serves a placeholder page through `--assets`
instead of failing; the assets these tests touch are only the Worker's gate. The
local dev proxy resets a reused socket now and then, so the harness talks to it
without keep-alive (`httpJson`, and `httpBytes` for hash-checked downloads).
Fixture shutdown clears its ten-second fallback timer on child exit (also on
a stop error), instead of keeping the Vitest worker alive until its own
termination deadline; exit, timeout and failure cleanup have regression tests.
`pnpm e2e:cloud`: the cloud
dashboard in a browser against that Worker and a paired simulated-agent node,
both themes, five viewports, axe
([e2e-cloud/](../../apps/dashboard/e2e-cloud/)).

Fleet operation checks count individual D1 statements (48 maximum/tick), defer
work durably at the quota boundary, and skip action budgeting when both action
flags are off. First unavailable health observations are visible. Enabled job
contracts require an explicit proof kind; only fresh same-job native evidence
updates deadlines or resolves missing activity. See the owning fleet operations
contract for scopes, read-only staging and rollout blockers.

## Owner fleet Operations

The cloud-only /operations route reads the owner-scoped registry, status and
25-item incident pages. A native task link selects its actual execution node;
no investigation is started by viewing a page. Shared UI controls support mobile
and desktop in both themes. Queries cache for five minutes, stop while hidden,
and reuse existing task-event invalidation. Monitoring stamps reject future
values; offline nodes, absent job receipt contracts, budget-limited coverage and
held actions stay explicit. See fleet-operations.md for release and cost gates.
