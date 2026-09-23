---
system: credential-broker
sources:
  - apps/orchestrator/src/tools/credentials.ts
  - apps/orchestrator/src/tools/vault-bridge.ts
  - apps/orchestrator/src/tools/vault-bridge-protocol.ts
  - apps/orchestrator/src/http/vault-bridge-routes.ts
  - apps/dashboard/src/pages/VaultBridgePage.tsx
  - apps/dashboard/src/pages/tools/CredentialsTab.tsx
  - packages/tools/src/packs/credential-broker.ts
  - packages/security/src/credential-cipher.ts
  - packages/security/src/env-guard.ts
  - packages/security/src/redact.ts
verified_at: eaba6cf
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
   `http.request {auth: {credential}}` uses one by name as a header.
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
repository an operator chose). **Idempotent by name**: a second call returns the
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
- **What the code does not prove**: MyVault pins no long-term key of this
  orchestrator; its trust anchor is the loopback address. Something that
  controls the `/vault-bridge` page (script injected into the dashboard, or a
  program squatting the port while the orchestrator is down) could complete
  the handshake itself and read the items MyVault shares. The session code only
  catches two windows talking past each other. Key pinning is a MyVault
  follow-up.
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

### Authority and state

| Case | Rule |
|---|---|
| New shared item | Imported with `repositoryIds: []` (usable nowhere until assigned), `authority: myvault`, linked by MyVault item id (never by title). |
| MyVault value changed | The local copy follows it. A local value change is refused server-side (`MANAGED`, 409) until the link is detached. |
| Generated secret pushed | `synced` only when the ack's fingerprint equals the value pushed; a value changed meanwhile stays `pending_push`. |
| MyVault copy of a generated secret edited | `conflict`; neither side changes. The operator chooses **Keep the Control Center value** (next push may replace exactly that edited copy) or **Use the MyVault value** (`pending_pull`, taken on the next snapshot). |
| Item deleted or unshared in MyVault | `missing` — only after a complete, in-order snapshot; an interrupted one marks nothing. The local credential stays. A push to an unshared item is answered `detached`. |
| Local delete | Deletes here only; the MyVault item stays. |

The Credentials tab ([CredentialsTab.tsx](../../apps/dashboard/src/pages/tools/CredentialsTab.tsx))
shows source, repository scope, MyVault state, a recovery banner ("Connect
MyVault to finish sync") while generated secrets wait, and the resolve actions
(`POST /api/credentials/:id/vault-resolve {action}`).

## Sealing other secrets

`sealValue(plaintext, aad)` / `openValue(sealed, aad)` seal a value with the same
DPAPI-protected key and a caller-chosen purpose binding (AAD), so a sealed value
cannot be opened for another purpose. The remote execution node stores its
private key this way (AAD `remote-node-identity:<nodeId>`); see
[remote-node.md](remote-node.md#identity-and-pairing).

## Verified

Unit and route tests ([vault-bridge.test.ts](../../apps/orchestrator/test/vault-bridge.test.ts),
[vault-bridge-protocol.test.ts](../../apps/orchestrator/test/vault-bridge-protocol.test.ts)):
values absent from API responses, tool results, execution rows, events and raw
SQLite; replay, duplicate, out-of-order, forged AAD, wrong session, malformed
key, oversized and invalid ciphertext all refused; lost-ack resend, restart,
conflict and missing transitions; a fake Wrangler proves stdin delivery and
argv/output hygiene. Playwright ([vault-bridge.spec.ts](../../apps/dashboard/e2e/vault-bridge.spec.ts))
drives the popup with a Web Crypto stand-in for MyVault. A real cross-app run
(MyVault app + this orchestrator in Chromium) is recorded in the plan's Ledger.

## Gotchas

- The redactor treats `secret: <word>` as a key/value secret; user-facing text
  that says "secret" followed by a colon gets rewritten. The gate text avoids it.
- The cloud control plane ([remote-node.md](remote-node.md)) mirrors credential
  metadata — now including `source` and the `vault` link (MyVault origin, item
  id, state) — through `credential.list` and the `credential` event; never a
  value. The bridge's own routes, status and events are not remote operations.
- MyVault must send `Cross-Origin-Opener-Policy: same-origin-allow-popups`
  (not `same-origin`), or its popup has no opener to answer.

Last verified: 2026-09-23
