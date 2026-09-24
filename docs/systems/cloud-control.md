---
system: cloud-control
sources:
  - apps/cloud-control/**
  - apps/dashboard/src/app/mode.ts
  - apps/dashboard/src/api/cloud.ts
  - apps/dashboard/src/pages/NodesPage.tsx
  - apps/dashboard/e2e-cloud/**
  - .github/workflows/**
verified_at: c66a1fc
---

# Cloud control plane

A Cloudflare Worker that lets a signed-in person use the Control Center from any
browser while every task still runs on a paired machine
([remote-node.md](remote-node.md)). The cloud relays typed requests, stores a
sanitized copy of history for offline reading, and never runs code. Plan and
evidence: [docs/plans/cloud-control-plane.md](../plans/cloud-control-plane.md).

> Last verified: 2026-09-23

## Pieces

| Piece | What it is |
|---|---|
| Worker `acc-cloud-control` (+ `-staging`) | [src/index.ts](../../apps/cloud-control/src/index.ts): routes by hostname; serves the dashboard build as Static Assets with `run_worker_first` so every request is authenticated first |
| D1 `acc-control-production` / `acc-control-staging` | nodes, pairing codes, commands, the task mirror, usage, manifests, leases, audit ([0001_control_plane.sql](../../apps/cloud-control/migrations/0001_control_plane.sql), 14 tables) |
| R2 `acc-artifacts-production` / `-staging` | private; artifact bytes and log chunks uploaded by nodes |
| Durable Object `WorkspaceHub` | [src/hub.ts](../../apps/cloud-control/src/hub.ts): one object, holds every node and browser WebSocket (Hibernation API, tags `node`, `node:<id>`, `browser`) |
| Rate limits | pairing 20/min, unauthenticated requests 60/min per IP, actions 300/min per person |
| Cron `17 3 * * *` | retention (below) |

Hostnames (dr-badawi-abdalsalam.com): production `acc.` (people) and
`acc-relay.` (machines); staging `acc-staging.` and `acc-relay-staging.`.
`workers_dev` and `preview_urls` are off; any other hostname gets 404.

## Two hostnames, two trust boundaries

`CONTROL_HOSTS` serve people: the dashboard, `/api/*`, `/ws`. `RELAY_HOSTS`
serve machines: `/node/v1/*` only. A relay path on the control host, or
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
  request waits briefly for the result; a command still running answers 202
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
as opening a terminal does. Nodes send heartbeats; the hub
writes `last_seen_at` at most once a minute and checks revocation on that write.

## Retention (daily cron)

Cloud copies only; nodes keep their own history. A replaced artifact or log
chunk deletes its previous R2 object, a failed re-upload keeps the stored
copy's hash, and an artifact the node marks `local_only` is deleted from R2 and
no longer served. Artifact bytes, log chunks and
task events: 90 days. Finished commands, expired pairing codes and released
leases: 30 days. Usage events and audit: 400 days.

## Dashboard in cloud mode

The same dashboard build. A page served without the `acc-token` meta tag is in
cloud mode ([mode.ts](../../apps/dashboard/src/app/mode.ts)), confirmed by
`GET /api/cloud/session` before the app starts. Requests carry no token; they
send `x-acc-node` and an `Idempotency-Key`. Cloud mode adds the Nodes page and
the top-bar node selector, banners for offline or out-of-date nodes, "Run on"
and "Run when the node is back" on New Task, and hides what only the machine may
do (Settings → Remote access, attachments). See [dashboard.md](dashboard.md).

## Deploy, pair, revoke, recover

| Task | Command |
|---|---|
| Release | `pnpm cloud:deploy:staging` / `pnpm cloud:deploy:production` ([deploy.mjs](../../apps/cloud-control/scripts/deploy.mjs)): refuses a test key set → applies D1 migrations (a failure stops before any code ships) → deploys → creates `NODE_SESSION_SECRET` on first release → live smoke |
| Live check | `pnpm cloud:smoke` ([smoke.mjs](../../apps/cloud-control/scripts/smoke.mjs)): both `/health`, control host refuses dashboard/API/realtime/forged tokens, relay serves no dashboard, refuses unknown nodes, and answers a forged session on a real WebSocket upgrade with 401 |
| Turn on Access | `pnpm cloud:access --env production --team <team>.cloudflareaccess.com --aud <tag> --email you@…` ([access-setup.mjs](../../apps/cloud-control/scripts/access-setup.mjs)) after creating a self-hosted Access application for the **control** hostname only; writes the three vars into wrangler.jsonc and releases. Commit the changed file. |
| Pairing code without the dashboard | `pnpm cloud:admin pair-code --env production --label "Desk PC"` |
| Emergency revocation | `pnpm cloud:admin revoke --env production --node node_…` — works with Access or the dashboard down (writes D1 through Wrangler); pending commands are rejected and leases released |
| List nodes | `pnpm cloud:admin nodes --env production` |
| Roll back code | `wrangler rollback <version-id> --env production` (or the Rollback workflow) |
| Roll back data | D1 Time Travel: `wrangler d1 time-travel restore acc-control-production --timestamp <iso> --env production` |

Both rollbacks and a deliberately failing migration were exercised on staging
(plan Ledger, step 22). CI ([ci.yml](../../.github/workflows/ci.yml)) runs the
full local and cloud suites on Windows; releases are manual
(`deploy-cloud.yml`, `rollback-cloud.yml`).

## Data ownership

The machine owns the truth: the task database, files, diffs, credentials and
the local token never leave it. The cloud holds what the node chose to send —
sanitized task and event mirrors, repository names and fingerprints (no paths),
agents, usage, manifests, `safe_sync` artifact bytes and log chunks — plus its
own records (nodes, pairing codes, commands, leases, audit). Losing the cloud
loses no work; restoring an older D1 makes the node resend everything
(`ackedSeq` went backwards → full resync).

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
instead of failing; the assets these tests touch are only the Worker's gate. `pnpm e2e:cloud`: the cloud
dashboard in a browser against that Worker and a paired simulated-agent node,
both themes, five viewports, axe
([e2e-cloud/](../../apps/dashboard/e2e-cloud/)).
