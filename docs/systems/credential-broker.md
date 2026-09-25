---
system: credential-broker
sources:
  - apps/orchestrator/src/tools/credentials.ts
  - apps/orchestrator/src/tools/vault-bridge.ts
  - apps/orchestrator/src/tools/vault-deposit.ts
  - apps/orchestrator/src/tools/vault-bridge-protocol.ts
  - apps/orchestrator/src/http/vault-bridge-routes.ts
  - apps/dashboard/src/pages/VaultBridgePage.tsx
  - apps/dashboard/src/pages/tools/CredentialsTab.tsx
  - packages/tools/src/packs/credential-broker.ts
  - packages/security/src/credential-cipher.ts
  - packages/security/src/env-guard.ts
  - packages/security/src/redact.ts
verified_at: 811149cd
---

# Credential broker

[credentials.ts](../../apps/orchestrator/src/tools/credentials.ts). Secrets are
used by tools without ever reaching a model, a log, a report or SQLite in
plain text. MyVault can feed it, and it can generate secrets MyVault then keeps
(plan: [myvault-credential-bridge.md](../plans/myvault-credential-bridge.md)).

## Storage

- `credential_references` (migration 5): name, kind, environment variable,
  description, repository scope, AES-256-GCM `ciphertext`/`iv`/`tag` (the row id
  is bound as additional data, so a ciphertext cannot be moved to another row),
  an 8-character SHA-256 fingerprint, timestamps. The **only** table holding a
  value.
- Migration 7, metadata only:
  - `credential_vault_links` — one row per credential linked to MyVault:
    `authority` (`myvault` for imported items, `control-center` for generated
    secrets), trusted `origin`, `vault_id`, MyVault `vault_item_id`, `state`
    (`pending_push`, `pending_pull`, `synced`, `conflict`, `missing`, `error`,
    `detached`), `synced_fingerprint` (the value both sides last agreed on),
    `vault_fingerprint` (what MyVault last reported), `replace_vault_fingerprint`
    (set by "keep the Control Center value"), `first_synced_at`, timestamps and a
    redacted `last_error`. Deleting a credential cascades to its link.
  - `vault_bridge_origins` — MyVault origins the operator trusted.
  - `credential_events` — audit: operation, direction, status, task, target,
    redacted detail. Never a value. Kept after a credential is deleted.
- Migration 9: `vault_bridge_identity` — one row (`id = 1`): the bridge
  identity's raw public key and its PKCS#8 private key sealed with
  `sealValue` (see [Identity](#myvault-bridge)).
- Migration 10 ([Delivery box](#delivery-box)): `vault_deposit_targets` — per
  MyVault origin: vault id, delivery key id and public key, sender id, the
  deliver-only token sealed with `sealValue` (AAD `vault-deposit-token:<origin>`),
  last delivery and last error; `vault_deposits` — each secret left in a box
  (`sending` / `stored` / `collected` / `refused`, receipt status, redacted
  detail), deleted with its credential.
- The 32-byte key: on Windows `<data>/credential-key.dpapi`, protected with
  DPAPI for the current user; elsewhere `<data>/credential-key` with mode 600.
  Loaded lazily; unavailable → `KEY_UNAVAILABLE`, and nothing is imported,
  generated or deployed.

## Flow

1. `POST /api/credentials {name, kind, envVar?, description, repositoryIds?, value}`
   — the value is write-only; no endpoint returns it (`PATCH` replaces it or
   changes `repositoryIds`). `repositoryIds: null` = every repository, `[]` = none.
2. A tool call that declares credential kinds (Cloudflare → `cloudflare`) gets
   `envFor(kinds)`: the first in-scope credential of each kind injected as its
   variable (`CREDENTIAL_KIND_ENV`), plus `CLOUDFLARE_ACCOUNT_ID` when stored.
   A credential named in Settings → Ask (`ask.sources.*.credential`) is **Ask
   only**: `envFor` skips it, so a read-only key never reaches a task or shadows
   the deploy key of the same kind. The reservation follows Settings; the
   Credentials list labels such keys `Ask only`.
   The credential named in Settings → Notifications → Phone alerts
   (`notifications.phone.credentialName`) is the **orchestrator's own**
   (`reservedForOrchestrator`, [alerts.ts](../../apps/orchestrator/src/services/alerts.ts)):
   `value()` returns null for it on every tool path (`http.request`, MCP env
   mapping) and `envFor` skips it; only `AlertService` (`reserved:
   'orchestrator'`) and a **production** `cloudflare.secret_put` /
   `github.secret_put` (Level 5, always the operator's typed approval;
   `reserved: 'deploy'`, chosen in `ToolService` from the capability and the
   call's level) read it. A staging put cannot. Only a credential of kind
   `http` is reserved, and `AlertService` reads nothing else, so naming a
   provider key there never sends it anywhere. Where alerts go and with which
   token is local-only: a cloud `settings.update` that changes it is refused
   ([remote-node.md](remote-node.md)). `heldForVault` still applies.
   `http.request {auth: {credential}}` uses one by name as a header.
   A read-only session (Ask, [ask.md](ask.md)) uses `envForPinned` instead:
   exactly the credential named in Settings → Ask for each kind, whatever its
   repository scope (choosing it there is its scope), still held back while
   MyVault has not saved it — or none, never another credential of the kind.
3. Every value handed out, imported or generated is first registered with the
   shared redactor; all stored values are registered at startup.
4. The variables the broker manages are stripped from every inherited
   environment ([env-guard.ts](../../packages/security/src/env-guard.ts)).

Kinds: `cloudflare`, `github`, `postgres`, `mysql`, `http`, `npm`, `other`.
`GET /api/credentials` adds `source` (`manual` / `myvault` / `generated`) and
`vault` (the link, no value). `GET /api/credentials/:id/events` is the audit.

## Generated secrets (`credential.generate`)

Provider `credential-broker` ([credential-broker.ts](../../packages/tools/src/packs/credential-broker.ts)),
Level 2, in the `cloudflare-worker` profile. `randomBytes` in the orchestrator:
16–64 bytes (default 32) as base64url or hex. The redactor learns the value
first; the credential and a `pending_push` link are written in one
transaction; the result is metadata (name, id, fingerprint, scope, sync state).
Scope is the calling repository only (an agent's task repository, or the
repository an operator chose). In a task across repositories that is the
repository whose folder the call names (`cwd`); at the workspace root it is
refused, and only credentials not limited to any repository are usable there
([multi-repository-tasks.md](multi-repository-tasks.md#tool-calls)). **Idempotent by name**: a second call returns the
same secret with `created: false` — a failed sync or deploy never regenerates.

Only application secrets are generated: kind `other` or `http` (a random value
is never a provider token), and never under a reserved variable — system names
(`PATH`, `SYSTEMROOT`, `HOME`, `NODE_OPTIONS`…) or a provider variable
(`CLOUDFLARE_API_TOKEN`, `GH_TOKEN`…): the broker strips its variables from every
process it starts, so either would break or impersonate. Imports drop such a
variable. A name held by a manual credential or by another repository's secret
gets one answer ("already in use"), never that other secret.

**Vault before it leaves** (`heldForVault`): a generated value is handed to no
tool path — not `value()` (HTTP headers, MCP env mapping), not `envFor` — until
MyVault acknowledged exactly that value (`synced_fingerprint = fingerprint`);
only the orchestrator's own checks may read it earlier. Replacing a generated
value locally makes it `pending_push` and held again (unless detached).
`cloudflare.secret_put` checks the gate first; the refusal is the fixed
`VAULT_SYNC_REQUIRED` text and a `deploy_blocked` event. No setting or agent
input lowers it.

## `cloudflare.secret_put`

In the Wrangler provider ([cloudflare.ts](../../packages/tools/src/packs/cloudflare.ts)):
`{credential, secretName, environment: staging | production}` — staging Level 4,
production Level 5 (typed approval). The management token arrives through the
usual `cloudflare` env injection; the runtime value is read by name from the
broker (scope-checked) and written to `wrangler secret put <name> [--env]` on
**stdin** — never argv, environment, file or output. Success is then checked
with `wrangler secret list --format json` (names only; Cloudflare cannot return
values). Put OK but name absent → "Deployment unverified", failed, same value
kept for the retry. Auth errors → `AUTH_REQUIRED`.

## MyVault bridge

MyVault encrypts its whole vault in the browser; its Worker only sees
ciphertext, so nothing here ever reads it. Instead, while MyVault is unlocked,
the operator clicks **Connect and sync** there: MyVault opens this
dashboard's `/vault-bridge` page as a popup and the two ends talk through it.

- **Trust**: an origin is trusted only from Tools → Credentials → Connect
  MyVault (`POST /api/vault-bridge/origins`, https, or http on loopback). The
  popup never adds one; it sends `ready` only to trusted origins (never `*`),
  accepts messages only from `window.opener` at a trusted origin, and ignores
  everything until its trusted list has loaded.
- **Channel** `mvcc-bridge-v1` ([vault-bridge-protocol.ts](../../apps/orchestrator/src/tools/vault-bridge-protocol.ts)):
  ephemeral ECDH P-256 per session on both sides; HKDF-SHA-256 salted with
  SHA-256(protocol, session id, both public keys) → one AES-256-GCM key per
  direction and an `XXXX-XXXX` code both windows show; fresh 96-bit IV per
  message; AAD = protocol, session, direction, sequence, type; sequence must be
  exactly last + 1, and only an authenticated message moves it. Web Crypto
  only; MyVault runs the same code. Committed vectors
  (`apps/orchestrator/test/fixtures/mvcc-bridge-v1.vectors.json`, byte-identical
  in MyVault) pin both.
- **Relay**: the popup posts `{envelope}` to
  `POST /api/vault-bridge/sessions/:id/messages` and passes the sealed replies
  back. It never sees a key or a value.
- **Identity** (plan: [myvault-bridge-identity-pinning.md](../plans/myvault-bridge-identity-pinning.md)):
  the orchestrator holds one long-term ECDSA P-256 key, created on first use,
  private half sealed (`sealValue`, AAD `vault-bridge-identity:<publicKey>`) and
  unsealed only into a non-extractable signing key in memory. `POST
  /api/vault-bridge/sessions` returns `identityKey` and `signature` over
  `mvcc-bridge-v1 identity\n<sessionId>\n<MyVault key>\n<our key>`; the popup
  relays both in `accept` and cannot make one. MyVault refuses a session without
  a valid signature, asks the user to compare the key's fingerprint on first
  contact, pins it per Control Center address, and refuses any other key there
  until the user forgets the pin. `GET /api/vault-bridge/status` carries
  `identity {publicKey, fingerprint}`; Connect MyVault and the popup show the
  fingerprint (8 groups of 4 hex, 128 bits of SHA-256 over the raw key). If
  the sealed key cannot be opened (the database moved to a machine with another
  credential key), `identity` is null and opening a session answers
  `IDENTITY_UNAVAILABLE` (503); nothing regenerates the key on its own, and
  there is no reset action yet — deleting the `vault_bridge_identity` row by
  hand makes the next call create a new key, which MyVault then refuses until
  its user chooses Forget trusted key.
- **What the code does not prove**: first contact is trust on first use. The
  Credentials tab that shows the fingerprint is served from the same address,
  so a program already answering there the very first time, when the user
  trusts without comparing, gets pinned. After that, a script in the dashboard
  can only relay ciphertext, and a program squatting the port is refused. In
  the other direction the orchestrator does not authenticate MyVault: anything
  holding the local API token can open a session as a trusted origin and be
  sent pending generated secrets — no wider than that token's existing reach,
  since it can already send any in-scope credential with `http.request`.
- **Sessions** ([vault-bridge.ts](../../apps/orchestrator/src/tools/vault-bridge.ts)):
  memory only (a restart drops them all), one per origin (reconnect replaces),
  4 at most, 10 min idle / 30 min absolute, 512 KiB per message, 100 pushes and
  500 shared items per session. Any protocol fault closes the session with a
  generic `PROTOCOL` error. The routes are local-token routes: not tools, not
  MCP, not in the remote-node allowlist.
- **Messages** (MyVault drives): `sync.start` → `credential.push` for each
  pending generated secret + `snapshot.request`; `credential.ack` per push;
  `snapshot.part {part, final, items}` → `snapshot.result` after the final
  part; `bye`.

### Delivery box

[vault-deposit.ts](../../apps/orchestrator/src/tools/vault-deposit.ts)
(plan: [secret-delivery-flow.md](../plans/secret-delivery-flow.md)). Without it,
a generated secret waits `pending_push` until MyVault is open and syncing, and
the gate refuses to deploy it — an agent working alone stops there. With it, the
secret is saved for MyVault at once, even while MyVault is locked, by leaving it
sealed on MyVault's own Worker.

- **Set up by MyVault**, inside an authenticated bridge session: `snapshot.request`
  carries `delivery {accepted, keyId, senderId, healthy}` for that origin and
  vault; MyVault (when its cloud sync is on) answers with `deposit.offer
  {keyId, publicKey, senderId, token}` — its long-term delivery key and a
  deliver-only `mvx_…` credential for its Worker — and gets `deposit.accepted
  {keyId, ok, detail}`. The key id must match the key; the token is sealed at
  rest. A new offer replaces the target (MyVault revokes the old credential).
- **Delivery**: when a brand-new generated secret exists (`pending_push`, never
  agreed, no MyVault item — replacements and conflicts stay on the bridge) and a
  target exists, it is sealed to the delivery key and signed with the bridge
  identity (`mvcc-deposit-v1` in
  [vault-bridge-protocol.ts](../../apps/orchestrator/src/tools/vault-bridge-protocol.ts))
  and posted to `<origin>/api/v1/deposits`. The deposit id is reserved first
  (`sending`), so a retry after a lost answer is the same deposit. Once the
  Worker stored it: deposit `stored`, link `deposited` with
  `synced_fingerprint = fingerprint` — the value is saved for MyVault (only the
  vault can open it), so the gate releases it. `credential.generate` waits up to
  15 s for this; the deploy gate waits up to 20 s for a delivery in progress
  instead of refusing a moment too early (both in
  [service.ts](../../apps/orchestrator/src/tools/service.ts)); the dashboard's
  Generate goes through the same tool path.
- **Receipts**: MyVault collects deposits while unlocked and leaves a receipt
  for every deposit — including one it can never open (unknown key, other
  vault, sender it does not trust). Receipts are read in one
  `POST /api/v1/deposits/receipts {ids}` per box and check, at most 90 ids (D1
  binds 100 values per query; the Worker rate-limits per address, and MyVault's
  own sync from the same address shares that limit): once a minute while any
  deposit waits, on startup, and whenever the dashboard asks for the bridge
  status (at most every 10 s). A replacement credential still reads what its
  predecessors left (the Worker keeps the lineage). `saved`/`unchanged` → link
  `synced` with MyVault's item id; anything else, or a deposit the box no longer
  holds → the deposit is `refused` and the secret is held again
  (`pending_push`, `synced_fingerprint` cleared) for the bridge, with the reason
  in `lastError`.
- **Failures** never lose a value. A 401 (credential revoked in MyVault) sets
  the target's `lastErrorKind` to `auth`: nothing more is sent there — not even
  retries — until MyVault offers a new credential, which the next session asks
  for (`healthy: false`). A 429 or an unreachable Worker is `transient`: retried
  on the next check, stopping at the first failure per box in a pass, and
  MyVault is not asked for a new credential. The gate's refusal names the
  error of the box that secret would go to. Removing trust in a MyVault address
  removes its box and holds back what was waiting in it. `GET
  /api/vault-bridge/status` lists targets under `delivery` (origin, key id,
  last delivery, last error, how many wait).
- **Trust**: the token lets this orchestrator deposit and read its own
  receipts on that Worker, nothing else; MyVault opens only deposits signed by
  a Control Center key it pinned. A deposit only ever creates a MyVault item
  (`cc-<credential id>`); when one already exists MyVault answers `unchanged`
  or `conflict` and writes nothing. The deploy gate waits for a delivery only
  for a credential the calling repository may use.

### Authority and state

| Case | Rule |
|---|---|
| New shared item | Imported with `repositoryIds: []` (usable nowhere until assigned), `authority: myvault`, linked by MyVault item id (never by title). |
| MyVault value changed | The local copy follows it. A local value change is refused server-side (`MANAGED`, 409) until the link is detached. |
| Generated secret pushed | `synced` only when the ack's fingerprint equals the value pushed; a value changed meanwhile stays `pending_push`. |
| Generated secret delivered | `deposited` (saved for MyVault, deployable) until the receipt says MyVault saved it (`synced`) or could not (`pending_push` again). A snapshot never marks a `deposited` link missing. |
| MyVault copy of a generated secret edited | `conflict`; neither side changes. The operator chooses **Keep the Control Center value** (next push may replace exactly that edited copy) or **Use the MyVault value** (`pending_pull`, taken on the next snapshot). |
| Item deleted or unshared in MyVault | `missing` — only after a complete, in-order snapshot; an interrupted one marks nothing. The local credential stays. A push to an unshared item is answered `detached`. |
| Local delete | Deletes here only; the MyVault item stays. Its link and deliveries go with it (cascade); the redactor keeps masking the old value, since text written before the delete may still carry it. |

The Credentials tab ([CredentialsTab.tsx](../../apps/dashboard/src/pages/tools/CredentialsTab.tsx))
shows source, repository scope, MyVault state, a recovery banner ("Connect
MyVault to finish sync") while generated secrets wait, and the resolve actions
(`POST /api/credentials/:id/vault-resolve {action}`).

## Sealing other secrets

`sealValue(plaintext, aad)` / `openValue(sealed, aad)` seal a value with the same
DPAPI-protected key and a caller-chosen purpose binding (AAD), so a sealed value
cannot be opened for another purpose. The remote execution node stores its
private key this way (AAD `remote-node-identity:<nodeId>`); see
[remote-node.md](remote-node.md#identity-and-pairing). So does the MyVault bridge
identity (AAD `vault-bridge-identity:<publicKey>`).

## Verified

Unit and route tests ([vault-bridge.test.ts](../../apps/orchestrator/test/vault-bridge.test.ts),
[vault-bridge-protocol.test.ts](../../apps/orchestrator/test/vault-bridge-protocol.test.ts)):
values absent from API responses, tool results, execution rows, events and raw
SQLite; replay, duplicate, out-of-order, forged AAD, wrong session, malformed
key, oversized and invalid ciphertext all refused; lost-ack resend, restart,
conflict and missing transitions; a fake Wrangler proves stdin delivery and
argv/output hygiene; every session's identity signature verifies, is bound to
its session, uses one key that survives a restart, and no PKCS#8 appears in the
row or any answer. Playwright ([vault-bridge.spec.ts](../../apps/dashboard/e2e/vault-bridge.spec.ts))
drives the popup with a Web Crypto stand-in for MyVault that verifies the
signature. Real cross-app runs (MyVault app + this orchestrator in Chromium) are
recorded in both plans' Ledgers.

## Gotchas

- The redactor treats `secret: <word>` as a key/value secret; user-facing text
  that says "secret" followed by a colon gets rewritten. The gate text avoids it.
- The cloud control plane ([remote-node.md](remote-node.md)) mirrors credential
  metadata — now including `source` and the `vault` link (MyVault origin, item
  id, state) — through `credential.list` and the `credential` event; never a
  value. The bridge's own routes, status and events are not remote operations.
- MyVault must send `Cross-Origin-Opener-Policy: same-origin-allow-popups`
  (not `same-origin`), or its popup has no opener to answer.

Last verified: 2026-09-26
