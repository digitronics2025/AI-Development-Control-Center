---
system: remote-node
sources:
  - apps/orchestrator/src/remote/**
  - apps/orchestrator/src/http/remote-routes.ts
  - packages/shared/src/remote.ts
  - packages/shared/src/remote-operations.ts
  - apps/dashboard/src/components/remote-access.tsx
  - apps/dashboard/src/api/remote.ts
verified_at: c66a1fc
---

# Remote execution node

This machine as an execution node of the cloud control plane
([cloud-control.md](cloud-control.md)). Work always runs here; the cloud relays
requests and keeps a sanitized, offline-readable copy of history. Plan:
[docs/plans/cloud-control-plane.md](../plans/cloud-control-plane.md).

## Trust boundary

- The orchestrator still binds to `127.0.0.1` only. Nothing listens for the
  cloud: the node **dials out** one WebSocket to the relay hostname.
- The local API token never leaves the machine. It is registered with the
  shared redactor at startup, so any string that carries it is masked.
- The cloud can only ask for operations in the typed catalog
  ([remote-operations.ts](../../packages/shared/src/remote-operations.ts)).
  Every one names a fixed local route; the node fills the template from
  validated single-segment parameters and dispatches it in process
  (Fastify `inject`). There is no generic route, shell text or path.
- Local enforcement wins: routes, the TaskEngine, the approval gate (typed
  confirmations included), the command classifier and the tool policy run
  exactly as for a local request.

## Identity and pairing

1. The user creates a single-use pairing code on the cloud Nodes page.
2. Settings → Remote access (`POST /api/remote/pair`) sends it with a new
   P-256 public key ([identity.ts](../../apps/orchestrator/src/remote/identity.ts))
   to `POST /node/v1/pair` on the relay.
3. The private key (PKCS#8) is sealed with the credential broker's
   DPAPI-protected key (`CredentialBroker.sealValue`, AAD
   `remote-node-identity:<nodeId>`) and stored in `remote_config`. It is never
   returned by any route.
4. Each connection: `POST /node/v1/challenge` → sign
   `acc-node-session:v1:<nodeId>:<nonce>` → `POST /node/v1/session` → a
   short-lived session token, sent as `Authorization` on the WebSocket upgrade
   (never in a URL).
5. Rotation (`POST /api/remote/rotate`, or `node.rotate` from the cloud): the
   new key signs a fresh challenge (`acc-node-rotate:…`), the current session
   authorizes it; the node id and history stay.

## Connection

[connection.ts](../../apps/orchestrator/src/remote/connection.ts): backoff from
1 s doubling to 60 s with ±20 % jitter, reset after 30 s of stable connection,
a ping every 30 s. A refused session with `NODE_REVOKED`/`NODE_NOT_FOUND` or a
close code `4003` stops retrying (`revoked`); `426`/`4026` or a welcome that
requires a newer protocol stops with `update-required`.

Every cloud message is checked against its own payload schema
(`cloudFramePayloadSchemas` in [remote.ts](../../packages/shared/src/remote.ts));
an unknown or malformed one is ignored and can never crash the node.

States (`RemoteLinkState`): `unpaired`, `disabled`, `connecting`, `connected`,
`offline`, `revoked`, `update-required`. Every change is published locally as a
`remote.status` message (never relayed).

On `session.welcome` the node: moves its outbox sequence past the cloud's
`ackedSeq` (after a database restore), drops what the cloud already stored,
schedules a full resync if the cloud's cursor went backwards, sends
`node.capabilities` and `node.snapshot` (repositories with fingerprints),
enqueues a full resync when required, flushes the outbox, replays unreported
command results, then sends `sync.request` for pending commands. If the link
closes or the service stops while the snapshot is still being built, the
welcome stops there (nothing reads a closed database; a pending resync stays
flagged for the next welcome).

## Commands

[dispatcher.ts](../../apps/orchestrator/src/remote/dispatcher.ts). Order is
fixed:

1. Schema check (`remoteCommandSchema`).
2. **Receipt** in `remote_commands_received` — `INSERT OR IGNORE` before any
   other check or execution. An existing finished receipt is replayed; a
   running one reports nothing.
3. Admission: remote control enabled; addressed to this node; payload hash
   recomputed; not expired; operation exists and is a `command`; gate
   (`terminals`/`tools`, from `remote_config`); remote guards; precondition.
4. `command.claim`, then the local route runs; the sanitized response is the
   outcome (`command.result`, 4xx included). Refusals are `command.failed`
   with `REMOTE_*` codes.
5. The cloud answers `command.ack`; until then the result is replayed after
   every reconnect.

A restart marks running receipts `interrupted`: they are reported as
`REMOTE_INTERRUPTED` and **never re-run**. Commands for the same target id run
in order; different targets run side by side.

Preconditions: `taskVersion` for `task.update/start/retry/reroute/assignments`
(stale → `REMOTE_CONFLICT`; optional — sent when the person saw a version);
`approval` for approve/deny — required, and the SHA-256 of the approval's
sanitized view (`approvalBindingHash`) must match what the cloud mirrored.

Remote guards ([guards.ts](../../apps/orchestrator/src/remote/guards.ts)) refuse
what only the machine may decide: billing mode, raising auto-approve levels, a
more permissive policy (settings, repository, task), editing a repository's
commands or dev command, choosing an agent's program (`executablePath`),
removing the approval step from a workflow stage that has one or lowering a
stage's permission level, creating a new workflow (duplicate one instead),
adding a repository-discovery folder or un-ignoring a removed repository,
turning on terminals, agent tool access, automatic repairs, the Chairman
adopting improvements on its own, or an agent loading the operator's own CLI
customisations, attachments, and a task across several repositories (`linkedRepositoryIds`). Lowering is allowed. Settings are judged as they would be saved
(`mergeSettings` in [settings.ts](../../apps/orchestrator/src/services/settings.ts)),
and a repository override set to `null` is judged by the Settings value it falls
back to.

## Reads

`rpc.request` → `executeRpc`: catalog `read` operations only, same gates, same
egress policy. Responses above 256 K characters are chunked (`rpc.response`
`index/total`, at most 8 MB). Binary operations (`artifact.download`,
`usage.export`) travel base64; text ones are scrubbed first. Artifacts whose
sync policy is `local_only` are refused remotely.

## Egress

[egress.ts](../../apps/orchestrator/src/remote/egress.ts), applied to every
mirrored event, live message, command result and read:

1. Type allowlist: mirrored (`task`, `task.deleted`, `event`, `approval`,
   `artifact`, `repository(.deleted)`, `agents`, `usage`) or live only
   (stage, execution, logs for subscribed executions, chairman, tools …).
   Anything else — including `hello`, `remote.status` and terminal output of a
   terminal the cloud was not granted — never leaves.
2. Field rules: repository `path` → `''`, `worktreePath`/`workspacePath`/
   `executablePath`/`workdir` → `null`, attachment paths and health `dataDir/host/port` dropped;
   keys named `env`, `token`, `apiKey`, `secret`, `password`, `authorization`,
   `cookie`, `ciphertext`, `privateKey`… dropped at any depth.
3. Deep scrub (roots in either Windows or POSIX form, whatever the host):
   repository roots → `<repo:name>`, the data folder →
   `<acc-data>`, the home folder → `<home>`, any other absolute path (a drive
   path, also JSON-escaped, or a network share) → its last segment; then the
   shared redactor (credential values, environment secrets, token formats, the
   local API token). Plain-text fallbacks get the redactor too.

## Outbox and sync

`remote_outbox` holds sanitized mirrored events keyed by entity
(`task:<id>`, `event:<id>`, `detail:<taskId>` …). A newer event for an entity
replaces the queued one, so the queue is bounded by distinct entities; above
10 000 rows the oldest are dropped and a full resync is scheduled. Batches:
≤ 200 events and ≤ 900 KB, at most 4 unacknowledged; `sync.ack` deletes up to
its sequence. Task details are debounced (2 s) and capped at 900 KB (stages
trimmed to the last 100). A full resync sends the last 500 tasks, details of
the latest 100, pending approvals, agents, repositories and 30 days of usage.

Nothing is queued while remote control is switched off (`enabled = false`), so
switching it off flags a full resync: when it is switched back on, the welcome
sends everything again and the cloud copy catches up (found in the production
cutover drill, where a task finished while off stayed `RUNNING` in the cloud).

## Terminals

[terminal-grants.ts](../../apps/orchestrator/src/remote/terminal-grants.ts).
Remote terminals need the node's `remote_terminals` permission (typed
confirmation in Settings) and, on the cloud side, `x-acc-confirm: open-terminal`
plus a sign-in younger than one hour. A terminal opened by a cloud command gets
a grant (10 min idle, 30 min maximum); only granted terminals accept cloud
keystrokes or send output to the cloud. Every line is classified when Enter
arrives, against this machine's auto-approve level: a line above it, or one that
always needs approval (dangerous, production), is cancelled with Ctrl+C and a
viewer-only notice (`terminal.output` with `notice: true`, never typed into the
shell). Escape sequences and Tab are dropped, because history recall and
completion would change the line without the classifier seeing it. A Level 5
line is refused remotely rather than turned into an approval: the approval gate
is task-bound and a free terminal has no task. Switching remote access or remote
terminals off revokes every grant. Reading, resizing or closing a
terminal from the cloud also needs its grant: local and agent terminals are
never touched remotely. The cloud refuses keystrokes from a browser whose
sign-in is older than one hour.

## Uploads

[uploads.ts](../../apps/orchestrator/src/remote/uploads.ts). Each new artifact
gets a sync policy once (`defaultArtifactSensitivity` in
[remote.ts](../../packages/shared/src/remote.ts)): `git-diff`, `staged-diff`,
`environment`, `task-json`, `tool-output` and `operator-evidence` (Private Browser
re-checks, [connected-apps.md](connected-apps.md)) are `local_only`; others are
`safe_sync` unless larger than 25 MB. The cloud receives a manifest either way,
the bytes only for `safe_sync`/`user_shared`. A finished execution's log becomes
chunks of at most 1 MB of whole lines. Text is scrubbed and redacted again right
before upload (upload errors too); the SHA-256 of the exact bytes travels with them
(`PUT /node/v1/artifacts/:id`, `PUT /node/v1/logs/:executionId/:index`) and R2
verifies it on write. Uploads run in the background while connected; a failure
backs off from 30 s doubling to 1 h (manifest `failed` after 8 attempts) and
never changes the task — the local file stays the source of truth. Shutdown
stops the queue first, and no upload writes after the database closes.

The sync policy decides what is **stored** in the cloud. Live reads while the
node is online (a task's diff, Source Control diffs) still travel over RPC,
redacted and path-scrubbed, and are never stored there.

## Local routes and UI

`GET/PATCH /api/remote`, `POST /api/remote/pair|unpair|rotate|reconnect`
([remote-routes.ts](../../apps/orchestrator/src/http/remote-routes.ts)). Not in
the catalog, and refused when a request carries `x-acc-remote-request` (set on
every in-process remote dispatch). Settings → Remote access
([remote-access.tsx](../../apps/dashboard/src/components/remote-access.tsx))
pairs, shows the link state, and toggles remote control, remote terminals and
remote tool calls (the last two need a typed confirmation).

## Tables (migration 6)

| Table | Holds |
|---|---|
| `remote_config` | singleton: relay, node id, label, public key, sealed private key, key version, `enabled`, `remote_terminals`, `remote_tools` |
| `remote_sync_state` | acked sequence, usage cursor, resync flag, last connection and error |
| `remote_outbox` | sanitized events waiting for acknowledgement |
| `remote_commands_received` | one receipt per command id: status, sanitized outcome, reported time |
| `remote_artifact_sync` | artifact and log-chunk upload state (`kind`, sensitivity, hash, retries) |

Migration 6 applies over any v5 database; a v5 build opening a v6 file keeps
working (it ignores the new tables).

## Gotchas

- Remote permissions live in `remote_config`, not in Settings, so no cloud
  `settings.update` can widen them.
- Unpair keeps the command receipts (the local audit of what the cloud asked).
- A pause is never version-bound: safety actions must not fail because the task
  progressed.
- `POST /api/remote/reconnect` does nothing while the link is open or
  connecting; it only skips the backoff wait when offline.
- Revocation is decided by the cloud: the Nodes page closes the node's socket
  with `4003` at once; the admin CLI writes D1 directly, so the hub notices at
  the node's next heartbeat write (about a minute at most; ~10 s in the
  production drill). The node then stops retrying and shows `revoked`. Pairing again needs Unpair first and a new code;
  the node gets a new id.

## Tests

`apps/orchestrator/test/remote-node.test.ts` (store, pairing, sealed key,
restart, rotation, reconnect, offline, revocation, local routes),
`remote-commands.test.ts` (duplicates, expiry, tampering, interruption, lost
acknowledgement, stale version, typed confirmation, guards, reads) and
`remote-egress.test.ts` (no secret or path on the wire, offline buffering,
resend, upload failures) and `remote-terminal.test.ts` (grants, per-line
classification, dropped escapes, expiry) run against the in-process
[fake-relay.ts](../../apps/orchestrator/test/fake-relay.ts). Against the real
Worker: `apps/cloud-control/test/*.test.ts` (see
[cloud-control.md](cloud-control.md#tests)).

Last verified: 2026-09-24
