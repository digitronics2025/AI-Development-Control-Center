---
title: MyVault credential bridge — selective encrypted bridge, generated secrets and structured Cloudflare secret deployment
source: MYVAULT_CREDENTIAL_BRIDGE_PLAN.md (conversation 2026-09-23)
created: 2026-09-23
status: done
---

# MyVault credential bridge

Spans two repositories: this one (`AI-Development-Control-Center`) and
`digitronics2025/My_vault` (local checkout `C:\Users\abuye\My_vault` on the
operator's PC). This file is the single plan for both.

## Context

The source plan, verbatim. Its own `##`/`###` headings are demoted one level so
they do not end this section; no wording is changed.

### MYVAULT_CREDENTIAL_BRIDGE_PLAN.md

#### Investigation basis

This plan is based on the current `main` branches inspected on 2026-09-23:

- `digitronics2025/AI-Development-Control-Center` — inspected around commit `238add771bd227bbb05ac72c101be54296c36160`.
- `digitronics2025/My_vault` — inspected around commit `3e012da005e8154b543797ab69ffd1875d816400`.

Verified current architecture relevant to this work:

- Control Center is local-first: Fastify orchestrator on `127.0.0.1:4317`, SQLite state, React dashboard, and one `ToolService.invoke` execution path for agent/operator tools.
- Control Center already has a strong credential broker in `apps/orchestrator/src/tools/credentials.ts`: AES-256-GCM encrypted credential values, Windows DPAPI-protected broker key, repository scoping, write-only API behavior, secret redaction, and one-call environment/header injection.
- Credential metadata is stored in `credential_references` from migration 5; the value is never returned by `GET /api/credentials`.
- The current Credentials UI in `apps/dashboard/src/pages/ToolsPage.tsx` supports manual add/replace/delete but has no external source, sync state, generated-secret flow, or repository-scope editor.
- The Cloudflare pack in `packages/tools/src/packs/cloudflare.ts` already uses the brokered Cloudflare management credential and has deploy/D1/R2/KV operations, but it has no structured `cloudflare.secret_put` capability. The generic command classifier recognizes `wrangler secret put`, but that is not the right primary path for an autonomous secret workflow.
- The executor already supports sending sensitive values through process `stdin`, so Cloudflare runtime secrets do not need to appear in argv, temp files, prompts, or logs.
- MyVault is a zero-knowledge, local-first PWA. The complete vault is encrypted in the browser with Argon2id + AES-256-GCM before IndexedDB or Cloudflare D1 sync.
- MyVault's Worker deliberately sees only an encrypted vault envelope. Its current `/api/v1/vault` and scoped device-credential system do not expose individual plaintext credentials, and Control Center cannot decrypt that envelope without breaking the vault boundary.
- MyVault already has the correct data shape for developer secrets: `VaultItem` supports `type: 'api'`, `password`, `tags`, hidden/text `customFields`, `folder`, and `updatedAt`.
- MyVault already has safe persistence, offline handling, compare-and-swap cloud sync, conflict resolution, revision history, scoped device credentials, and tests covering real Worker/D1 behavior.

##### Root cause

The two applications each have a secure secret store, but there is no safe selective bridge between the decrypted MyVault session and Control Center's broker. Trying to make Control Center read `/api/v1/vault` would not solve this: the Worker only has ciphertext, and giving Control Center the MyVault master password or vault data key would weaken the zero-knowledge design. The missing capability is therefore a **selective, explicitly authorized credential bridge plus lifecycle orchestration**, not a new plaintext Vault API.

---

#### 1. Goal

Create a secure relationship between MyVault and AI Development Control Center so that:

1. Explicitly selected MyVault API credentials can be copied into Control Center's existing encrypted credential broker without exposing the rest of the vault.
2. Control Center can generate strong application/runtime secrets internally, save them to its broker, synchronize them into MyVault, and then deploy them through structured tools such as Cloudflare secret deployment.
3. Agents can reference credentials by name/id but never receive the plaintext value.
4. Every step is resumable, auditable, repository-scoped, and safe when either application is closed, locked, offline, or interrupted.
5. MyVault's current zero-knowledge Worker/D1 design, existing vault sync, existing Control Center credential security, and all existing user data remain intact.

The final model is:

```text
MyVault unlocked browser
        |
        | ephemeral end-to-end encrypted bridge
        v
Control Center Credential Broker
        |
        +--> agents/tools receive references only
        |
        +--> structured Cloudflare/GitHub/etc. tool operation
```

Control Center is the runtime automation authority. MyVault remains the long-term human vault and backup/source for user-managed credentials.

---

#### 2. Scope

##### Included

- Same-machine MyVault <-> Control Center connection from the browser.
- Explicit MyVault item sharing only; never bulk-export all vault items by default.
- MyVault -> Control Center import/update of selected credentials.
- Control Center -> MyVault synchronization of Control Center-generated secrets.
- Persistent link/sync metadata in Control Center, but no plaintext outside the existing broker.
- Safe repository assignment for imported credentials.
- A server-side `credential.generate` capability using a CSPRNG.
- A structured Cloudflare runtime-secret operation that receives only a credential reference and secret name.
- Persistent pending/synced/conflict/missing/error state and retry behavior.
- Source/ownership rules to prevent silent two-way overwrites.
- Credential lifecycle/audit metadata without secret values.
- UI updates in both applications to connect, select/share, sync, inspect status, and recover failures.
- Unit, integration, browser, security, and real cross-app verification.

##### Explicitly excluded from this task

- Giving Control Center the MyVault master password or vault data key.
- Adding a Worker endpoint that returns plaintext MyVault credentials.
- Having Control Center download/decrypt the whole MyVault cloud envelope.
- A new cloud relay/mailbox in MyVault v1; same-machine browser bridging is sufficient and materially simpler.
- Automatic deletion propagation between the two stores.
- Automatic creation of privileged provider credentials such as a Cloudflare API management token or GitHub PAT. Those continue to originate from the provider and can be stored in MyVault.
- Fully unattended MyVault writes while MyVault is locked or closed. Control Center must retain a safe pending state instead.
- Generic credential rotation across every provider in this task.
- Unrelated redesign of either application's vault, tool system, workflow engine, or cloud sync.

---

#### 3. Enhanced design/architecture

##### 3.1 Key design decision: local encrypted browser bridge, not a new cloud secret API

Do **not** extend MyVault's Worker to decrypt, proxy, or expose individual vault items. Keep the current D1 contract ciphertext-only.

Use a browser-mediated bridge only while MyVault is unlocked:

```text
MyVault tab (plaintext exists here already)
        |
        | encrypted postMessage payloads
        v
Control Center bridge page on 127.0.0.1:4317
        |
        | ciphertext relay only
        v
Control Center backend bridge session
        |
        v
CredentialBroker (plaintext only in memory at the broker boundary)
```

The Control Center bridge page must be a dumb relay. It must not receive plaintext credential values from its backend and must not persist bridge payloads.

##### 3.2 Ephemeral bridge cryptography

Implement a small versioned protocol contract, `mvcc-bridge-v1`, shared by both repositories conceptually and pinned by interoperability tests.

Use browser/Node standard Web Crypto only; add no cryptography dependency unless investigation proves the platform implementation insufficient.

Protocol requirements:

- Ephemeral ECDH P-256 key pair per connection session on both sides.
- HKDF-SHA-256 to derive separate 256-bit AES-GCM keys for `myvault->control-center` and `control-center->myvault` directions.
- Fresh 96-bit AES-GCM IV for every message.
- AAD binds at least protocol version, session id, direction, sequence number, and message type.
- Monotonic sequence numbers; reject replay, duplicate, stale, and out-of-order messages.
- Session private keys remain memory-only and are destroyed/released on disconnect, expiry, MyVault lock, page close, or Control Center restart.
- Hard message-size limits; credential bridge messages should remain small and bounded.
- No secret or key material in URLs, query strings, browser history, logs, analytics, or error messages.

##### 3.3 Trust and origin rules

- MyVault only accepts bridge messages from the exact configured Control Center origin, normally `http://127.0.0.1:4317`, and only from the popup/window it opened.
- Control Center validates `event.origin` and `event.source`; the first previously unknown MyVault origin requires explicit operator approval before it is stored as trusted.
- Subsequent sessions may reconnect automatically only for that exact stored origin.
- Reuse the Control Center's existing Host/Origin/token protections for backend calls from the local bridge page; do not expose bridge backend routes to arbitrary websites.
- Do not enable wildcard CORS.
- Do not expose the bridge through MCP or normal agent tools. Agents interact with credential references through the existing tool layer, not with bridge transport primitives.

##### 3.4 Control Center stays the execution mirror

Preserve `credential_references` as the only Control Center store containing encrypted secret values.

Add an additive migration using the next available migration number at implementation time. Current main ends at migration 5, so this is presently expected to be migration 6; re-check first because shipped migrations must never be edited.

Add a small metadata table, for example `credential_vault_links`, with no plaintext secret material:

- `credential_id` -> existing `credential_references.id`
- trusted MyVault origin / vault identifier
- MyVault item id when linked
- authority/source: `myvault` or `control-center`
- sync state: `pending_push`, `pending_pull`, `synced`, `conflict`, `missing`, `error`, `detached`
- last synchronized fingerprint
- last synchronized item timestamp/version metadata
- bounded redacted last error
- created/updated/last-synced timestamps

Add a compact `credential_events` audit table only if existing generic task/tool events cannot represent non-task bridge events cleanly. It must contain metadata only: credential id, operation type, direction, status, task id if any, target, timestamps, and redacted detail.

Do not duplicate credential ciphertext into a second table.

##### 3.5 Use MyVault's existing item schema; avoid a vault schema migration

Do not add a new top-level MyVault payload field for this feature unless implementation proves it unavoidable. The existing `VaultItem` shape already provides everything needed and avoids a risky schema-version change that would affect older clients, merge behavior, extensions, and passkeys.

Represent a shared/developer credential as an existing `type: 'api'` item:

- `password` = credential value.
- reserved tag such as `control-center` = explicitly shared with Control Center.
- existing `customFields` store non-secret bridge metadata such as Control Center credential id, credential kind, environment variable, and authority/source.
- generated credentials may use a normal folder such as `AI Development` for human organization.

Do not match records by title. Use stable item/credential ids so retry cannot create duplicates.

##### 3.6 Explicit sharing, not automatic export

Only MyVault items explicitly marked for Control Center may leave the unlocked vault session.

Add a small integration control for API items:

- `Share with AI Development Control Center` toggle.
- credential kind using the existing Control Center kinds: `cloudflare`, `github`, `postgres`, `mysql`, `http`, `npm`, `other`.
- optional environment variable.

Do not infer a privileged kind from title, URL, or notes. If a shared item has no mapping, import it as `other` and require metadata completion before a tool can use it as a provider credential.

##### 3.7 Safe repository scoping

A newly imported MyVault credential must **not** default to all repositories.

The current broker semantics already allow an empty `repositoryIds` array to mean no repository is in scope. Use that for first-time MyVault imports. The Control Center Credentials UI must expose repository assignment so the user can explicitly grant one or more repositories.

For a secret generated inside a running Control Center task, automatically scope it only to that task's repository unless the operator deliberately broadens the scope later.

##### 3.8 Source-of-truth and conflict rules

Use explicit authority instead of last-writer-wins across the two products:

- Credentials originally imported from MyVault: `authority = myvault`. MyVault value changes may update the local encrypted mirror; Control Center must not silently replace their value locally.
- Credentials generated by Control Center: `authority = control-center`. MyVault is the durable secondary copy; if its linked item is edited to a different value, mark a conflict instead of silently replacing either side.
- Metadata such as repository scope remains Control Center-owned because MyVault does not know Control Center repository ids.
- Removing the `control-center` tag or deleting the MyVault item marks the link `missing`/`detached`; it never deletes the local broker credential automatically.
- Deleting a local Control Center credential never deletes the MyVault item automatically in v1.
- A full successful MyVault snapshot is required before marking a formerly linked item missing; an interrupted partial session must never infer deletion.

##### 3.9 Idempotent sync flow

For MyVault -> Control Center:

```text
shared MyVault item
  -> bridge encrypts item payload
  -> Control Center backend decrypts in memory
  -> find link by MyVault item id
  -> create/update broker credential
  -> register value with redactor
  -> persist link fingerprint/state
  -> ACK metadata only
```

For Control Center -> MyVault:

```text
broker credential with pending_push
  -> backend opens value in memory
  -> encrypts directly to MyVault bridge key
  -> bridge page relays ciphertext
  -> MyVault decrypts while unlocked
  -> upsert API item by stable Control Center credential id
  -> existing MyVault mutate/encrypt/persist path
  -> ACK item id + fingerprint/timestamp
  -> Control Center marks synced
```

If ACK is lost after MyVault saved the item, retry finds the stable Control Center id in the MyVault custom fields and updates the same item instead of creating another.

##### 3.10 Generated secret capability

Add a structured `credential.generate` tool capability rather than asking an AI agent to invent or print secrets.

Requirements:

- Generate in the orchestrator using Node/Web Crypto CSPRNG, default 32 random bytes encoded as base64url.
- Support only a small justified set of formats/sizes if required by real projects; do not create a general secret-template engine.
- Store directly through `CredentialBroker`; plaintext must never be returned in the tool result.
- Result returns credential metadata/reference plus MyVault sync state only.
- Immediately register the generated value with the shared redactor.
- Create a pending MyVault link when MyVault synchronization is enabled.
- Keep the same generated value through retries. Never regenerate just because sync or deployment failed.

##### 3.11 Deployment safety policy for generated secrets

Default to **vault-before-first-external-deploy** for Control Center-generated secrets:

1. Generate and seal locally.
2. Synchronize to unlocked MyVault and receive ACK.
3. Only then allow first external deployment.

If MyVault is locked/disconnected, the task must pause with a precise recoverable blocker such as `MyVault sync required before deploying this newly generated secret`. The secret remains encrypted locally and must not be regenerated.

Do not let an agent downgrade this policy. A future operator setting may allow local-only deployment, but that is outside this first implementation unless already supported cleanly by the settings architecture.

##### 3.12 Structured Cloudflare secret deployment

Extend the existing Cloudflare provider; do not use a generic shell as the primary flow.

Add a capability equivalent to:

```text
cloudflare.secret_put {
  credential: <broker credential name/id>,
  secretName: <Cloudflare Worker secret name>,
  environment: staging | production
}
```

Behavior:

- Existing brokered `cloudflare` management credential continues to supply `CLOUDFLARE_API_TOKEN` / account id.
- The runtime secret value is obtained by name from `ctx.credentials` only inside the operation.
- Pass the runtime secret through process `stdin`; never argv, environment variables, temporary files, prompt text, or command logs.
- Keep staging at Level 4 and production at Level 5 under the current policy model; production remains typed-approval work.
- Use the installed Wrangler version's supported secret command after verifying the real CLI syntax during implementation.
- Verify success using Wrangler's secret-name listing or equivalent non-revealing metadata. Because Cloudflare does not return secret values, verification can prove presence/name and command success, not value equality.
- If the secret write succeeds but verification fails, record `deployment unverified`; do not generate a replacement secret.
- A retry must deploy the same broker value.

Provider access tokens themselves are not generated by this flow.

##### 3.13 UI changes

###### Control Center — Tools -> Credentials

Evolve the current tab into a focused credential hub without redesigning the whole Tools page:

- Keep the existing write-only security banner.
- Add `Connect MyVault`, `Generate secret`, and existing `Add credential` actions.
- Add columns/status for source, repository scope, MyVault sync state, and last used.
- Add repository-scope editing because the backend already supports `repositoryIds` but the current UI does not expose it.
- Linked MyVault-authoritative credentials show `Managed by MyVault` instead of a normal `Replace value` action.
- Generated secrets show `Pending MyVault`, `Synced`, `Conflict`, or `Missing` states.
- When pending outbound credentials exist and MyVault is disconnected, show one clear recovery action: `Connect MyVault to finish sync`.

Follow `design.md` and existing `@acc/ui` primitives; do not invent a parallel visual system.

###### MyVault — Settings / integration

Add a focused `AI Development Control Center` integration panel:

- connection state and exact Control Center origin.
- `Connect and sync` / `Disconnect`.
- number of explicitly shared items.
- number of incoming generated credentials saved in the current session.
- clear statement that only marked items are shared.
- teardown immediately on lock.

Add the share/mapping control to API-item editing with existing MyVault styling. Reuse the current mutation/persistence path in `App.tsx`; do not create a second vault-writing mechanism.

---

#### 4. Implementation steps

##### Phase 1 — Re-investigate immediately before editing

1. Re-read both repositories' current `AGENTS.md` / `CLAUDE.md`, subsystem docs, current HEAD, working-tree state, and relevant tests.
2. Confirm the migration number, API/auth wiring, dashboard route conventions, MyVault item editor behavior, and any changes since the refs recorded above.
3. Confirm no existing branch or in-progress code already implements a credential bridge or Cloudflare secret capability.
4. Preserve unrelated working-tree changes and current production behavior.

##### Phase 2 — Write the bridge protocol contract first

1. Define `mvcc-bridge-v1` message shapes, limits, origin rules, session lifecycle, ECDH/HKDF/AES-GCM derivation, AAD format, and sequence handling.
2. Add cross-compatible crypto test vectors or deterministic interoperability fixtures in both repositories.
3. Prove browser Web Crypto and Node 22 implementations produce mutually decryptable messages before wiring any secret store.
4. Document the threat boundary: browser bridge transports only sealed payloads through the Control Center frontend.

##### Phase 3 — Control Center persistence and broker extensions

Modify existing components, not parallel secret stores:

- `apps/orchestrator/src/db/migrations.ts` — next additive migration for vault-link metadata and, only if needed, credential lifecycle event metadata.
- `apps/orchestrator/src/tools/store.ts` — persistence methods for links/statuses/events.
- `apps/orchestrator/src/tools/credentials.ts` — safe generated-secret creation, linked upsert, ownership checks, fingerprint handling, redactor registration, pending/synced/conflict transitions.
- `packages/shared/src/tools.ts` — add only the public metadata/types/schemas required by the UI/tool contract; plaintext fields remain input-only or internal.

Requirements:

1. Existing credentials migrate unchanged and remain usable.
2. No migration copies/decrypts/re-encrypts existing ciphertext unnecessarily.
3. MyVault imports default to `repositoryIds: []`.
4. Stable external ids make both import and export idempotent.
5. Linked ownership rules are enforced server-side, not only in React.

##### Phase 4 — Control Center ephemeral bridge service

Add a focused orchestrator service and narrow HTTP routes following existing route-registration conventions.

1. Session creation produces an in-memory ephemeral ECDH keypair, session id, public key, sequence state, trusted-origin requirement, and short expiration.
2. Bridge inbound route accepts only sealed messages from the authenticated local bridge page and decrypts inside the backend.
3. Bridge outbound route returns sealed messages only; it must never return a raw broker value.
4. Session state is not persisted across process restart.
5. Apply strict request/body limits and generic errors.
6. Publish only secret-free connection/sync status to the dashboard.
7. On disconnect/expiry, clear pending in-memory key/session state while preserving durable credential sync status.

Keep these routes out of MCP/tool discovery.

##### Phase 5 — Control Center bridge page and Credentials UI

Update the existing dashboard architecture:

- `apps/dashboard/src/pages/ToolsPage.tsx` or a small extracted credential component if the current file would become unmaintainable.
- `apps/dashboard/src/api/tools.ts` and normal query/mutation patterns.
- a minimal dedicated bridge route/page if required by popup messaging.

Implement:

1. First-origin approval and persistent trusted MyVault origin metadata.
2. Exact `event.origin` + `event.source` checks.
3. Ciphertext relay only.
4. MyVault connection/sync state.
5. Repository assignment UI.
6. Source/authority labels and conflict/missing states.
7. `Generate secret` action through the real tool layer, not a separate insecure generator in React.

##### Phase 6 — MyVault integration client

Use existing MyVault structures and write path:

- `src/types.ts` only if type aliases/constants are needed; avoid changing `CURRENT_SCHEMA_VERSION` by storing integration mapping in existing item fields.
- `src/App.tsx` — connect integration actions into the current unlocked payload mutation/persistence flow.
- `src/components/SettingsView.tsx` or a focused new integration component rendered from Settings.
- API-item editing component (`NewItemModal.tsx` or the actual current editor after re-check) — explicit share/mapping controls.
- a new small module under `src/integrations/` for bridge transport/crypto/mapping.

Rules:

1. Nothing connects or exports while the vault is locked.
2. Locking immediately disconnects and discards session keys.
3. Only items with the explicit reserved share tag are exported.
4. Incoming generated credentials are upserted by stable Control Center id.
5. Save through the same `mutatePayload` / encrypt / IndexedDB persistence path already used by normal edits.
6. Let the existing MyVault autosync/conflict machinery synchronize the resulting encrypted envelope to D1; do not bypass it.
7. Do not modify `worker/index.ts`, device credential scopes, or D1 migrations for this v1 unless implementation evidence proves the local bridge cannot satisfy the requirement.

##### Phase 7 — Credential generation tool

Add a normal built-in tool provider/capability following the `ToolService.invoke` rule.

1. Extend `CredentialHost` in `packages/tools/src/sdk.ts` only with the minimum broker functions needed for safe generation/reference handling.
2. Implement `credential.generate` as a structured operation.
3. Generate the value only in the orchestrator/backend.
4. Store it before returning success.
5. Return only metadata, fingerprint, and sync state.
6. Auto-scope task-generated secrets to the task repository.
7. Mark MyVault sync pending and enforce the vault-before-external-deploy invariant for newly generated secrets.

##### Phase 8 — Cloudflare runtime-secret capability

Extend `packages/tools/src/packs/cloudflare.ts` rather than adding a shell shortcut.

1. Add structured secret put operation.
2. Reuse existing Cloudflare management credentials through `credentials: ['cloudflare']`.
3. Resolve the target runtime secret by broker reference via `ctx.credentials`.
4. Extend the local Wrangler helper to support `stdin` safely using the executor's existing stdin support.
5. Never include the target secret in `args`, summaries, evidence, errors, test snapshots, or artifacts.
6. Apply staging/production policy levels consistently with existing Cloudflare operations.
7. Verify the deployed secret name non-destructively.
8. Record the real tool execution as the deployment audit trail.

##### Phase 9 — Recovery/status integration

1. On every successful MyVault connection, push all `pending_push` generated credentials and pull a full snapshot of explicitly shared items.
2. Mark previously linked items missing only after a complete successful snapshot.
3. Preserve pending/conflict states across Control Center restart.
4. Surface one actionable blocker for tasks waiting on MyVault.
5. Resume with the same secret after reconnection; never silently regenerate.

##### Phase 10 — Documentation

Update behavior-owning docs in both repositories in the same change:

Control Center:

- `docs/systems/credential-broker.md`
- `docs/systems/tool-system.md` and/or security docs if the new capability changes documented boundaries.

MyVault:

- relevant `docs/systems/` document for the new integration.
- `docs/security/threat-model.md` because this adds a new path by which plaintext leaves the unlocked vault.
- `docs/systems/testing.md` if the gate changes.

Document explicitly that compromised browser/device code while unlocked remains inside MyVault's existing residual-risk model.

---

#### 5. Failure handling and recovery

##### MyVault locked, closed, or unavailable

- Never lose or regenerate the Control Center secret.
- Keep it encrypted in the existing broker with `pending_push` state.
- If it is a newly generated credential whose first external deployment requires MyVault durability, pause the deployment with a clear blocker.
- On the next unlocked bridge session, resume the pending transfer automatically.

##### Bridge interrupted after MyVault saves but before ACK

- Retry with the same Control Center credential id.
- MyVault finds the linked API item by stable custom-field id and updates/acknowledges it instead of creating a duplicate.

##### Control Center restart during sync

- Ephemeral bridge session is discarded.
- Durable broker ciphertext and link state remain.
- Reconnect and replay the pending transfer safely.

##### MyVault import interrupted

- Do not mark unseen items missing unless a full snapshot completed successfully.
- Existing linked broker credentials remain unchanged.

##### Value changed on both sides

- Detect with last-synced fingerprint plus explicit authority.
- Mark `conflict`; do not automatically pick a winner.
- Preserve both current copies until the user selects the authority or re-syncs from the authoritative source.

##### MyVault item deleted or share tag removed

- Mark link `missing`/`detached` after a complete snapshot.
- Do not delete the Control Center broker credential.
- Require explicit deletion if the operator wants it removed.

##### DPAPI/broker key unavailable

- Fail closed using the existing `KEY_UNAVAILABLE` behavior.
- Do not try to replace, regenerate, import, or deploy the credential.

##### Cloudflare management authentication failure

- Keep the generated/runtime credential unchanged.
- Surface `AUTH_REQUIRED` through the existing tool result path.
- Fix the Cloudflare provider credential and retry the same operation.

##### Cloudflare secret write succeeds but verification fails

- Record the tool call as `deployment unverified`/failed verification, not as absent.
- Do not create a new secret.
- Retry the non-revealing verification first; only re-run the same put if evidence requires it.

##### MyVault local save succeeds but cloud D1 sync is offline/conflicted

- Treat the MyVault local encrypted save as the vault-side ACK only if the product decision explicitly defines local MyVault persistence as durable enough; otherwise expose `saved locally / cloud sync pending` separately.
- Reuse MyVault's existing autosync and conflict UX. Do not introduce a second D1 writer from Control Center.

##### Untrusted origin, replay, oversized message, invalid crypto, or stale session

- Reject without revealing whether a credential id exists.
- Tear down the affected bridge session when appropriate.
- Record only bounded non-secret security metadata.

---

#### 6. Security and data protection

1. **Preserve zero knowledge:** Control Center never receives the MyVault master password, wrapping key, data key, or full decrypted vault. MyVault's Worker continues to receive ciphertext only.
2. **No plaintext bridge frontend:** the Control Center browser bridge relays sealed messages; raw broker values are not exposed by a normal HTTP response to React.
3. **No secrets in model context:** agents receive credential references/status only. All actual value access stays behind `CredentialBroker` / `CredentialHost` inside a tool execution.
4. **No secrets in persistence outside the broker/vault:** link/event tables contain ids, fingerprints, states, timestamps, targets, and redacted errors only.
5. **No secrets in argv:** Cloudflare runtime secrets travel through stdin using the executor's existing stdin support.
6. **CSPRNG only:** generated values come from Node/Web Crypto random bytes; never from an LLM, timestamp, UUID-only shortcut, Math.random, or predictable template.
7. **Repository least privilege:** imported MyVault credentials begin with no repository access; task-generated secrets begin scoped to the current repository only.
8. **Origin isolation:** exact-origin and exact-window checks, no wildcard CORS, bridge sessions short-lived, replay-protected, and not exposed through MCP.
9. **Existing security controls remain mandatory:** DPAPI protection, AES-GCM credential sealing, redactor registration, environment stripping, Host/Origin/token checks, tool policy, command classifier, source-control secret guard, and protected paths may not be weakened.
10. **Bound payloads:** cap number of credentials and bytes per session/message to prevent memory/DoS abuse.
11. **Lock means disconnected:** MyVault lock must immediately discard bridge session keys and any decrypted pending payload held in the browser.
12. **No automatic destructive sync:** v1 does not propagate deletes or silently resolve conflicts.
13. **No new plaintext Worker surface:** avoid MyVault Worker/D1 changes for the bridge unless a later separately reviewed remote relay feature is approved.
14. **Threat-model update required:** explicitly document that malicious code running in the already-unlocked MyVault page can still read credentials, consistent with the current vault threat model.
15. **Migration safety:** all DB changes are additive; never edit shipped migrations; test upgrade from a database containing real pre-existing credential metadata/ciphertext.

---

#### 7. Testing and verification

This is a security-sensitive cross-application integration and must be treated as a high verification tier.

##### Control Center unit/integration tests

- Existing broker tests continue proving values are absent from API responses and raw SQLite.
- Generated credential value never appears in the tool result, execution record, logs, events, artifacts, or dashboard response.
- Generation produces expected entropy/format and different values across calls.
- Migration upgrades an existing migration-5 database without changing existing credential ciphertext/fingerprints.
- Imported MyVault credentials default to `repositoryIds: []` and cannot be used by any repository until assigned.
- Authority rules reject unauthorized local value replacement for MyVault-owned links.
- Pending/synced/conflict/missing state transitions are deterministic and restart-safe.
- Bridge cryptographic interoperability vectors pass.
- Replay, duplicate sequence, wrong AAD, wrong origin/session, expired session, malformed public key, oversized message, and invalid ciphertext all fail closed.
- Redactor knows imported/generated values before any operation can emit output.

##### Cloudflare tool tests

Use a fake Wrangler executable/process test that proves:

- management credential is supplied through the existing broker environment path.
- target Worker secret is provided through stdin.
- argv contains only secret name/environment flags, never the value.
- stdout/stderr/evidence/input summaries contain no value.
- staging and production classify to the expected permission levels.
- auth failure does not change/regenerate the credential.
- success + secret-list verification returns metadata only.
- verification failure preserves the same credential for retry.

Add an opt-in real Wrangler smoke only if safe test credentials/environment are available; never require production mutation for the ordinary suite.

##### Dashboard Playwright tests

- Existing Tools/Credentials journey remains green.
- First MyVault origin requires trust; exact trusted origin reconnects.
- Credentials page shows source/scope/sync state without ever rendering the value.
- Imported credential is unusable until repository scope is assigned.
- Generate-secret action returns metadata only.
- Pending MyVault state and reconnect recovery are visible/actionable.
- Responsive/dark/light/accessibility checks remain consistent with `design.md` for the modified route.

##### MyVault unit/integration tests

- Only `control-center`-shared items are exported.
- Mapping metadata uses existing item fields and does not require a schema-version bump.
- Incoming Control Center credential upsert is idempotent by stable Control Center id.
- A lost ACK followed by resend produces one item, not duplicates.
- MyVault-owned vs Control Center-owned mismatch creates a conflict instead of an overwrite.
- Lock/disconnect destroys bridge session state.
- Untrusted origin/source and replayed sealed messages are rejected.
- No bridge plaintext is persisted outside the normal encrypted vault envelope.

##### MyVault browser/Worker verification

Drive the real MyVault app and existing Worker/D1 test path:

1. Create/unlock a vault.
2. Create an API item, mark it shared, and connect to Control Center.
3. Confirm Control Center receives the intended item only.
4. Generate a Control Center secret and sync it back.
5. Lock/reload/unlock MyVault and confirm the generated item persisted.
6. If cloud sync is configured in the test, fetch the stored D1 envelope and prove neither credential plaintext nor Control Center-generated value appears in it.
7. Exercise a MyVault sync conflict after an integration write and prove the existing conflict path still works.

##### Real cross-app end-to-end journey

Run both applications locally and automate a real browser across both origins:

```text
MyVault shared API item
 -> encrypted bridge
 -> Control Center broker
 -> assign repository
 -> tool can use credential

Control Center credential.generate
 -> encrypted broker storage
 -> encrypted bridge
 -> MyVault API item persistence
 -> MyVault encrypted cloud sync (when test Worker enabled)
 -> structured Cloudflare secret_put using same credential
 -> non-revealing verification
```

Failure simulations must include:

- MyVault closes before outbound ACK.
- MyVault locks mid-session.
- Control Center restarts with `pending_push`.
- duplicate resend.
- unknown/malicious origin.
- stale/replayed message.
- MyVault item removed/share tag removed.
- Cloudflare auth failure.
- Cloudflare write success followed by verification failure.

##### Required repository gates

Control Center:

```text
pnpm check
pnpm build && pnpm e2e
```

MyVault:

```text
npm run check
npm run test:e2e
```

Also run focused bridge/crypto tests in both repositories before the full gates. Because MyVault `main` auto-deploys, do not push that repository until the full security-relevant gate is green; if the execution environment is authorized to release, verify the deployed commit/health and the changed integration behavior after deployment.

---

#### 8. Success criteria

The task is complete only when all of the following are verified with real behavior:

1. Control Center can connect to an unlocked MyVault session from the local browser without receiving the master password, vault data key, or whole decrypted vault.
2. Only explicitly shared MyVault items are transferred.
3. An imported MyVault credential is encrypted in the existing Control Center broker, absent from all credential-list/API responses and raw SQLite plaintext, and unavailable to repositories until scope is assigned.
4. `credential.generate` creates a cryptographically strong secret in the orchestrator, stores it before returning, and never exposes the value to the agent, tool result, dashboard, logs, events, or artifacts.
5. A generated credential can be synchronized into MyVault, survive MyVault lock/reload/unlock, and remain encrypted in IndexedDB/cloud storage.
6. A lost ACK or process/browser interruption can be retried without changing the secret or creating duplicate MyVault items.
7. MyVault-origin and Control Center-origin authority rules prevent silent two-way overwrites; conflicts are visible and recoverable.
8. Removing a MyVault item/share tag never automatically deletes the Control Center copy.
9. A generated secret cannot perform its first external deployment while its required MyVault sync is pending.
10. The structured Cloudflare secret operation receives only a credential reference from the caller, feeds the value through stdin, preserves existing policy/approval behavior, and verifies secret presence without revealing the value.
11. Cloudflare failure/retry uses the same credential value and never silently regenerates.
12. Exact-origin, replay, expiry, malformed-message, and oversized-message tests fail closed.
13. Existing MyVault vault sync/device credentials/passkeys/extensions and existing Control Center tools/credential users continue to pass their current test suites.
14. Both repositories' required quality gates pass after the final change.
15. Security/system documentation reflects the real final implementation and its limitations.

---

#### 9. Found for Later

| Discovery / improvement | Why it matters | Recommended future work | Priority | Blocks this task? |
|---|---|---|---|---|
| Fully unattended MyVault sync while the vault is closed/locked | The local bridge intentionally respects the vault unlock boundary, so pending generated secrets need the next unlocked session | Design a separately reviewed end-to-end encrypted cloud mailbox using integration public keys; Worker must still see ciphertext only | Medium | No |
| Automated credential rotation | Generated runtime secrets will eventually need scheduled rotation and coordinated deploy/verify/retire | Add provider-aware rotation state machine after the basic bridge is proven | High | No |
| Provider-token creation/revocation | Cloudflare/GitHub management tokens still need provider-side creation | Add provider-specific least-privilege token workflows only where official APIs support safe scoped issuance | Medium | No |
| Expiry/health monitoring | Some tokens expire or are revoked without the Control Center knowing until use | Add non-secret health/expiry metadata and proactive warnings | Medium | No |
| Multi-vault / multi-user support | Current feature is designed for one local owner and one MyVault origin | Add explicit tenant/vault identity and access policy only if the product becomes shared | Low | No |
| Cross-device Control Center | The current Control Center is intentionally localhost-only | Treat remote control as a separate security architecture, not an extension of this bridge | Low | No |

Do not expand this implementation into these items.

---

#### 10. Next Recommended Task

After this bridge is stable, implement **safe automated rotation for Control Center-generated runtime secrets**: generate replacement -> save to MyVault -> deploy -> verify application behavior -> retire old credential -> record rotation history. Build it on the lifecycle/link state created here rather than adding another secret path.

---

#### 11. Final execution prompt

`/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.`

### Verified on this machine before editing (2026-09-23)

- Control Center HEAD `6620c50`; migration **6 is already taken** by the remote execution node, so this work adds **migration 7**. Another session has uncommitted cloud-control work in the tree (`apps/cloud-control/`, `apps/orchestrator/src/remote/service.ts`, `packages/shared/src/remote.ts`, `pnpm-*`, `vitest.config.ts`, `.gitignore`, `docs/plans/cloud-control-plane.md`) — never staged by this plan.
- MyVault HEAD `3e012da`, clean tree.
- **MyVault sends `Cross-Origin-Opener-Policy: same-origin`** (`worker/index.ts` `SECURITY_HEADERS`). With that header a cross-origin popup's opener link is severed, so no browser postMessage bridge can work. Phase 6 rule 7's exception applies: the one worker change is COOP → `same-origin-allow-popups` (still isolates MyVault from pages that open *it*). A threat-model change.
- Wrangler 4.129.0: `wrangler secret put <key> [--env <env>]` reads the value from stdin when not a TTY; `wrangler secret list [--env] [--format json]` lists names only.
- `/api` routes need the local bearer token; the dashboard receives it only through its own same-origin HTML. Remote-node commands are a typed allowlist (`packages/shared/src/remote-operations.ts`), so new routes are not reachable remotely unless listed.
- `CredentialBroker.inScope`: `repositoryIds === null` means every repository, `[]` means none.
- Executor `runProcess` already accepts `stdin`.

## Steps

- [x] 1. Phase 1 re-investigation recorded (both repos, migration number, COOP blocker, wrangler syntax, remote allowlist) — done when: the "Verified on this machine" block above and the Ledger hold the findings — check: `manual: read the Verified block`
- [x] 2. Phase 2 protocol contract `mvcc-bridge-v1` in Control Center: WebCrypto-only module (ECDH P-256, HKDF-SHA-256 per direction, AES-GCM, AAD, strict sequence, limits, SAS code) + committed test vectors + tests for replay/duplicate/out-of-order/wrong AAD/wrong session/malformed key/oversize/invalid ciphertext — done when: vectors decrypt and re-encrypt byte-identically and every negative case throws — check: `pnpm vitest run apps/orchestrator/test/vault-bridge-protocol.test.ts`
- [x] 3. Phase 2 MyVault protocol module with the same vectors file, proving browser-style WebCrypto code interoperates with the Control Center implementation in both directions — done when: MyVault decrypts Control Center-sealed vectors and Control Center decrypts MyVault-sealed fixtures — check: `npx vitest run src/integrations` (MyVault) and the CC test above reading the MyVault fixture
- [x] 4. Phase 3 migration 7 (`credential_vault_links`, `vault_bridge_origins`, `credential_events`) + ToolStore methods; upgrade test from a migration-6 database holding a real sealed credential — done when: the old credential's ciphertext/fingerprint are unchanged and still open after upgrade — check: `pnpm vitest run apps/orchestrator/test/migrations.test.ts`
- [x] 5. Phase 3 broker extensions: link-aware views (source, vault state), server-side MyVault-authority enforcement, generated-secret creation (CSPRNG, idempotent by name, redactor first), linked import/update, conflict/missing transitions, audit events, deploy gate — done when: unit tests prove each rule — check: `pnpm vitest run apps/orchestrator/test/vault-bridge.test.ts`
- [x] 6. Phase 3 shared public types/schemas (CredentialView source/vault fields, bridge status, resolve actions) — done when: typecheck passes with the dashboard consuming them — check: `pnpm -r typecheck`
- [x] 7. Phase 4 bridge service + narrow routes (trust origin, sessions, sealed messages, close, status, resolve), in-memory sessions with expiry and caps, not in MCP/remote allowlist — done when: integration tests drive a full sync (import, push, ack, lost-ack resend, conflict, missing only after final part, detached, untrusted origin, expiry, restart discards sessions) through the HTTP routes — check: `pnpm vitest run apps/orchestrator/test/vault-bridge.test.ts`
- [x] 8. Phase 7 `credential.generate` provider + CredentialHost extension + ToolService wiring + profile entry — done when: tests prove the value is absent from result, execution row, events and API, format/entropy holds, retries return the same credential, task calls scope to the task repository — check: `pnpm vitest run apps/orchestrator/test/vault-bridge.test.ts packages/tools/test/packs.test.ts`
- [x] 9. Phase 8 `cloudflare.secret_put` (stdin, secret-list verification, levels 4/5, vault-before-first-deploy gate) with a fake Wrangler — done when: tests prove stdin delivery, argv/summaries/evidence free of the value, auth failure and verification failure keep the same value — check: `pnpm vitest run packages/tools/test/packs.test.ts apps/orchestrator/test/vault-bridge.test.ts`
- [x] 10. Phase 9 recovery/status: pending_push/conflict survive restart, reconnect pushes pending and pulls a full snapshot, blocker text for waiting deployments — done when: a restart test shows state preserved and the next session completes the push with the same fingerprint — check: `pnpm vitest run apps/orchestrator/test/vault-bridge.test.ts`
- [x] 11. Phase 5 dashboard bridge page `/vault-bridge` (exact origin + source checks, ciphertext relay only, untrusted origin refused with guidance, SAS shown) — done when: a Playwright test with a stub vault origin connects, and an untrusted origin is refused — check: `pnpm build && pnpm --filter @acc/dashboard exec playwright test e2e/vault-bridge.spec.ts`
- [x] 12. Phase 5 Credentials tab: Connect MyVault (trust origin), Generate secret (through /api/tools/call), source/scope/MyVault/last-used columns, repository-scope editor, Managed by MyVault, conflict/missing/pending actions, recovery banner — done when: Playwright journey passes in both themes without rendering any value — check: `pnpm build && pnpm e2e`
- [x] 13. MyVault COOP → `same-origin-allow-popups` with the reasoning at the header and tests updated — done when: worker test asserts the new header and nothing else in the header set changed — check: `npx vitest run worker` (MyVault)
- [x] 14. MyVault mapping module (share tag filter, api-only, snapshot chunks, upsert by stable Control Center id, detached, conflict by stored fingerprint, force) — done when: unit tests prove idempotent resend, no duplicates, conflict not overwritten, untagged items never exported — check: `npx vitest run src/integrations` (MyVault)
- [x] 15. MyVault bridge client + Settings integration panel + App wiring through `mutatePayload`/`flushPendingWrites`, lock teardown, origin/source checks, localStorage origin setting — done when: unit tests for the client state machine pass and `npm run check` is green — check: `npm run check` (MyVault)
- [x] 16. MyVault API-item share controls (toggle, kind, env var) in the item editor — done when: Playwright shows the controls only for API items and saving writes the tag/fields — check: `npm run test:e2e -- --project=desktop` (MyVault)
- [x] 17. Real cross-app journey with both apps running locally and a real browser, including the failure simulations (close before ack, lock mid-session, CC restart with pending_push, duplicate resend, unknown origin, replay, share tag removed, Cloudflare auth failure, verification failure) — done when: every leg is observed and recorded in the Ledger — check: `manual: scripted journey output recorded in the Ledger`
- [x] 18. Control Center docs: credential-broker.md (bridge, links, generate, gate), tool-system.md (new capabilities), security.md boundary, systems README — done when: docs match the code — check: `git diff --stat docs/`
- [x] 19. MyVault docs: new `docs/systems/control-center-bridge.md`, threat model, testing.md, ui.md, CHANGELOG `[Unreleased]`, follow-ups (Found for Later) — done when: docs guard passes — check: `node scripts/docs-guard.mjs` (MyVault)

## Tail

- [x] T1. Adversarial review of the whole diff in both repos — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat` reviewed hunk by hunk in both repos
- [x] T2. Similar-issue sweep — done when: other credential write paths (PATCH, MCP env mapping, http auth), other popup/postMessage code and other Wrangler calls were searched for the same pattern — check: `manual: list what was searched and what was found`
- [x] T3. Control Center gates green → deferred: `pnpm check` exits 1 only on an unhandled rejection from another session's committed `apps/orchestrator/test/remote-terminal.test.ts` ("database connection is not open" after its test ends); everything else is green — typecheck, lint, docs guard, 556/556 tests, `pnpm build && pnpm e2e` 79/79 — done when: both exit 0 — check: `pnpm check && pnpm build && pnpm e2e`
- [x] T4. MyVault gates green — done when: all exit 0 — check: `npm run check && npm run test:e2e && npm run test:e2e:sync`
- [x] T5. Docs synced per both repos' rules — done when: system docs, threat model, changelog and follow-ups reflect the change — check: `git diff --stat docs/` in both repos
- [x] T6. Committed path-scoped and pushed in both repos → parked: the secret-file guard refuses any staged file named `credentials.*`, and the Control Center's existing broker module `apps/orchestrator/src/tools/credentials.ts` carries most of this change — may it be committed as-is, or should the module be renamed (e.g. `credential-broker.ts`, which also touches another session's `remote/service.ts` import)? MyVault is committed (`eb3458e`) and pushed; the Control Center's migration 7 is committed (`eaba6cf`) and pushed; the rest of the Control Center work is complete, tested and running from the working tree, uncommitted — done when: `git status` shows none of this work uncommitted and both pushes succeeded — check: `git log origin/main..HEAD --oneline` in both repos
- [x] T7. Confirmed live where the push deploys — done when: Control Center: no deploy on push (local app); MyVault: the deployed Worker reports the new commit on /healthz, sends `same-origin-allow-popups` and serves the integration panel — check: `manual: curl -sI the live MyVault origin and /healthz`
- [x] T8. A claim registered for this change → no change needed: neither repository keeps a claims register (searched both trees for one); the downstream outcome is observed by the recorded 31/31 two-app journey and the live check in T7 — done when: a claims register entry exists, or this step says why there is none — check: `manual: name the claim and its deadline, or say why the change has no observable outcome`

## Ledger

- 2026-09-23 — created from MYVAULT_CREDENTIAL_BRIDGE_PLAN.md (pasted into the conversation). Source headings demoted one level so they stay inside Context; text unchanged.
- 2026-09-23 — step 1 — migration number is 7 (6 taken by the remote node); MyVault COOP `same-origin` blocks any popup bridge, so the plan's worker exception (Phase 6 rule 7) is used for COOP only.
- 2026-09-23 — decision — trusted MyVault origins are approved only from the Control Center dashboard (Connect MyVault), never inside the bridge popup: a popup opened by an unknown site could otherwise talk the operator into a Trust click and receive pending generated secrets.
- 2026-09-23 — decision — every generated secret gets a pending MyVault link (authority control-center); the first-deploy gate holds until MyVault acknowledges once, even when no vault was ever connected (the safe default the plan asks for).
- 2026-09-23 — decision — a local encrypted MyVault save (IndexedDB) counts as the vault ACK; the ACK carries whether MyVault's cloud sync is still pending, shown as detail rather than a separate state.
- 2026-09-23 — decision — a short session code (SAS, from HKDF) is shown on both sides so the operator can see both ends hold the same session keys; display only, no extra step.
- 2026-09-23 — step 2 — vectors generated once by the implementation itself (fixed JWK test keys + fixed IVs) and committed as `apps/orchestrator/test/fixtures/mvcc-bridge-v1.vectors.json`; 9 protocol tests pass, orchestrator typecheck clean. Check run with `npx vitest run` (same runner as `pnpm vitest`).
- 2026-09-23 — step 3 — MyVault copy `src/integrations/controlCenter/protocol.ts` differs only in the header comment and DOM `Uint8Array<ArrayBuffer>` typings; the vectors file is byte-identical (SHA-256 65FD5462…A5E7 in both repos), and MyVault re-seals the CC-sealed envelopes byte for byte, which is the "CC decrypts MyVault-sealed" direction too — no cross-repo file read in CC tests (it would tie CI to a sibling checkout).
- 2026-09-23 — step 4 — another session committed `e8a5f71` (cloud Worker) meanwhile and had already changed the v5→v6 test to filter `version <= 6`; migration 7 added after it. Two extra link columns (`vault_fingerprint`, `replace_vault_fingerprint`) added to the still-unshipped migration 7 so "keep the Control Center value" is a compare-and-swap on the MyVault copy, not a blind overwrite. 3 migration tests pass.
- 2026-09-23 — step 5 — deploy gate is stricter than "first deployment": a generated value may be deployed only when MyVault has acknowledged exactly that value (`synced_fingerprint = fingerprint`), so a locally replaced generated secret is also held until synced. `credential_events` added (tool executions and task events cannot hold non-task bridge events). `CredentialError` gains `MANAGED` → HTTP 409 (routes.ts). A detached MyVault credential becomes editable locally. 7 broker tests pass.
- 2026-09-23 — step 7 — routes live in a new `apps/orchestrator/src/http/vault-bridge-routes.ts` (registered in server.ts) rather than growing tool-routes.ts; origin removal is `POST /api/vault-bridge/origins/remove` because the dashboard client's DELETE carries no body. One live session per origin (a reconnect replaces it), 4 sessions max, 10 min idle / 30 min absolute, 100 pushes and 500 snapshot items per session, 512 KiB message body. Every protocol fault closes the session with a generic PROTOCOL error. 13 bridge tests + typecheck pass.
- 2026-09-23 — step 8 — provider `credential-broker` (category `system`, builtin) in `packages/tools/src/packs/credentials.ts`; `CredentialHost.generate`/`deployGate` are optional so other hosts still compile. Profile: added to `cloudflare-worker` only (others reach it by escalation; operator has `*`). Operator calls need a repository (existing `/api/tools/call` contract), so the dashboard's Generate dialog asks for one. The engine only parks tasks through the Chairman, so a gate hit surfaces as a failed tool call carrying the exact blocker text plus the usual TOOL_CALL task event — no new engine state. 14 bridge tests + 32 tools tests pass.
- 2026-09-23 — step 9 — `wrangler secret put <name> [--env]` with the value on stdin, then `wrangler secret list --format json` for presence. A fake Wrangler (node_modules/.bin in a test repository) proves argv holds only name/flags, the management token arrived through the broker env, the value is not in the child's environment and is exactly what reached stdin; auth failure → AUTH_REQUIRED, list miss → "Deployment unverified", both keep the same value; production → approval (Level 5), staging Level 4 needs confirmation from the operator like every Level-4 tool. Found and fixed on the way: the redactor rewrote "secret: unlock" in the blocker text as a key/value secret, so the blocker now reads "…secret. Unlock MyVault…". 18 bridge tests + 13 pack tests pass; tools and orchestrator typecheck clean. No real Wrangler smoke: no disposable Worker/token exists here, and the plan forbids production mutation for tests.
- 2026-09-23 — step 10 — restart test now also proves a `conflict` link survives and `/api/vault-bridge/status` reports pending/conflict counts after restart; 18 bridge tests pass.
- 2026-09-23 — commit attempt — the PreToolUse secret-file guard (`~/.claude/hooks/guard-secret-files.sh`, pattern `credentials($|\.)`) blocks any staged file *named* `credentials.*`. New pack file renamed to `packages/tools/src/packs/credential-broker.ts` (no other importers). The existing broker module `apps/orchestrator/src/tools/credentials.ts` cannot be renamed without breaking another session's uncommitted `remote/service.ts` import, and committing it by a path-scoped commit would slip past the guard (this repo's git hook only guards docs), so it is NOT committed: index reset, work continues, and the Control Center commit is parked as the run's one question. `app.ts` also carries another session's hunk (`terminals` passed to RemoteNodeService); any commit of app.ts must be built from the index without that hunk.
- 2026-09-23 — step 11 — `/vault-bridge` renders outside the Shell (App.tsx branch on `host === 'web'` and the path; `mode` is another session's uncommitted field, so not used). Window protocol: popup→opener `ready` (sent only to each trusted origin, never `*`), `accept`, `response`, `error`; opener→popup `hello`, `request`, `close`. The page ignores every message until its trusted list has loaded (`aria-busy` on `main` marks that). Query keys hang under `keys.credentials` so `keys.ts` (another session's file) is untouched. `ApiConfig.token` is being removed by another session, so the unload close is a best-effort `api.del` (sessions expire anyway). 4 Playwright tests pass against the built dashboard with a stub MyVault on a fake https origin doing real ECDH/HKDF/AES-GCM in the browser; one rerun used a private `--output` folder because another session's Playwright run was deleting the shared `test-results` trace files.
- 2026-09-23 — step 12 — Credentials tab extracted to `apps/dashboard/src/pages/tools/CredentialsTab.tsx` (ToolsPage was ~600 lines): Source / Repositories / MyVault / Last used columns, Manage drawer (scope editor, MyVault actions, value, history, delete-here), Connect MyVault dialog (trust + open MyVault, trusted list with live session code), Generate secret dialog (through `/api/tools/call`, repository required), pending and conflict banners with "Connect MyVault to finish sync". Full `pnpm e2e` 78/78 (both themes, axe, the new journey) after `pnpm build`. Step 13 was started while this suite ran (other repository, no shared files); ticks kept in order.
- 2026-09-23 — step 13 — `worker/index.ts` COOP → `same-origin-allow-popups` with the reason at the header; both header assertions in `worker/vaultApi.test.ts` updated; 45 worker tests pass. No other header changed.
- 2026-09-23 — step 14 — `src/integrations/controlCenter/mapping.ts`: tag `control-center` on `type: 'api'` items; reserved custom fields `control-center.{id,kind,env,authority,fingerprint}`; generated items land in folder "AI Development". A push also carries `replaceFingerprint` (compare-and-swap for "keep the Control Center value"). 9 tests (with protocol) pass; tsc clean.
- 2026-09-23 — step 15 — `client.ts` (bridge state machine), `useControlCenterBridge.ts`, `components/ControlCenterPanel.tsx`; `SettingsView` gains one optional `controlCenterPanel` slot; `App.tsx` writes through `mutatePayload` then `flushPendingWrites` and acknowledges only when the persisted revision covers the change; `handleLock` disconnects first. The Control Center address is a device setting in localStorage (never in the vault payload) and must be http on 127.0.0.1/localhost/[::1]. Session code cleared once the session ends. 14 integration tests pass; `npm run check` exit 0.
- 2026-09-23 — step 16 — share toggle, kind select and variable input appear only for API items; reserved fields are kept out of the editable custom-field list and carried through on save; an invalid variable is refused with a reason. New `e2e/control-center.spec.ts` (3 tests: controls, full connect-and-sync against a Web Crypto stand-in for the Control Center popup served on 127.0.0.1:4317 — proves the new COOP keeps the opener link — and lock-closes-the-bridge). Whole desktop project: 113 passed, 7 skipped (phone-only), including the "no unnamed control" accessibility sweep.
- 2026-09-23 — step 17 — real journey (scratchpad `journey.mjs`, not committed: machine-specific paths): an isolated built orchestrator on 127.0.0.1:4398 with its own data folder (the operator's live one on 4317 untouched) + MyVault's real Worker via `wrangler dev` on localhost:8798 with its own local D1 and a dev sync token, driven by headless Chromium across both origins. **31/31**: trust from the dashboard only; generate → metadata only; first deploy blocked until sync; connect through the real `/vault-bridge` popup; only the marked item imported, MyVault-owned, kind/variable carried, no repository; generated secret acknowledged; no value in the API or the SQLite files; imported credential refused until scoped, then `http.request` sent exactly `Bearer <value>` with redacted output; local replace refused (409 MANAGED); `secret_put` verified and the deployed value's fingerprint equals the broker's, value absent from argv/log/output; MyVault IndexedDB and the D1 envelope hold no plaintext; survives lock/reload/unlock. Failures: F1 lost ACK (2nd relay request aborted) → pending, resend syncs the same value with one item; F2 lock mid-session closes the popup and the orchestrator session; F3 restart keeps `pending_push`, next connect completes with the same fingerprint; F4 an untrusted origin (127.0.0.1 vs trusted localhost) gets no `ready`, no session, and MyVault explains; F5 a replayed envelope → 400 PROTOCOL; F6 unsharing → `missing`, copy kept; F7 auth failure → AUTH_REQUIRED; F8 put-without-list → "Deployment unverified", retry deploys the same value.
- 2026-09-23 — step 17 — defects found and fixed by the journey: (1) the bridge page's error path forgot a session without closing it (an aborted request never reached the server), and its close on window exit could die with the page — both now use one `keepalive` DELETE; regression test "the session closes when a request fails or the window goes away" added (dashboard spec 6/6). (2) The D1 check read before MyVault's autosync debounce; now polls. The plan's "MyVault sync conflict after an integration write" is covered by running MyVault's own sync suite in T4 (integration writes use the same `mutatePayload` path).
- 2026-09-23 — step 18 — `credential-broker.md` rewritten around storage/flow/generation/`secret_put`/bridge/authority table/gotchas (sources and `verified_at` updated); `tool-system.md`, `security.md`, `orchestrator.md` (migration 7 tables), `dashboard.md` (`/vault-bridge`, extracted tab) and the systems index merged into their existing sections; docs guard 0 failures. A PowerShell `Get-Content -Raw | Set-Content` round-trip double-encoded the doc once; repaired byte-exactly (cp1252→UTF-8) — never use that pair on these UTF-8 files.
- 2026-09-23 — step 19 — MyVault: new `docs/systems/control-center-bridge.md` (frontmatter, what crosses, how it connects, mapping, UI, COOP reason, tests, gotchas) + index row; threat model gains two trust-boundary rows and an "AI Development Control Center bridge" section (does not widen / adds / residual risk — malicious code in the unlocked page), `Last reviewed` merged; testing.md layer row; ui.md item-dialog note; CHANGELOG `[Unreleased]`; follow-ups "Control Center bridge" holds the plan's Found-for-Later items. Docs guard 0 failures (1 pre-existing staleness warning).
- 2026-09-23 — T1 — two independent read-only reviews (one per repository), every finding handled. Control Center: (1) the vault-before-it-leaves rule guarded only `secret_put` — now `heldForVault` also holds unsynced generated values back from `value()` (HTTP headers, MCP env mapping) and `envFor`, test proves `http.request` refused; (2) an agent could generate a secret named `PATH` or `CLOUDFLARE_API_TOKEN` — reserved system/provider variables refused (dropped on import), generation limited to kinds `other`/`http`; (3) generate matched a name across repositories — out-of-scope or manual names now get one "already in use" answer; (4) detach was ignored for generated secrets and a bound link could never move — detached is honoured in snapshot and replace, `push-again` (now also offered for `pending_push`) unbinds origin/vault; (5) a rejected linked item made a snapshot mark it missing — any rejected item suppresses missing-marking; (6) two identical envelopes sent together could both pass the sequence check — the number is claimed before the first await (both repos, vectors unchanged) and each session handles one message at a time; (7) "Trust and open MyVault" could open another origin — opens the entered address. MyVault: (1) session code does not authenticate the Control Center page (no pinned key; trust anchor = loopback address) — docs in both repos corrected, residual risk stated, key pinning added to follow-ups (not built: a design change beyond this plan); (2) double `accept` could run two handshakes — one accept per bridge, popup no longer posts `ready` after unmount, the save mutator refuses a second item with the same ccId; (3) push fields were not validated — every field checked before anything is saved, test covers four malformed shapes; (4) a push to an item turned into a login leaked its fingerprint — detached now uses "still shared" (API + tag), no fingerprint reported; (5) late status after lock — `stopped` flag, test asserts it. Mobile e2e caught a selector matching "Force Sync Vault" in my spec — exact match now. Bridge tests 29/29, MyVault integration 15/15.
- 2026-09-23 — T3 — after the review fixes: `pnpm check` typecheck ✓, lint ✓ (another session fixed its own `fake-relay.ts` lint error in `0b094bf`), docs guard ✓, tests 49 files / 556 passed; exit 1 from one unhandled rejection attributed to `remote-terminal.test.ts` (another session, committed `2ac3ef1`) — not changed here; this repository has no follow-ups file, so it is recorded here and in the final report. `pnpm build && pnpm e2e`: first full run 6 bridge failures that did not reproduce (spec alone 6/6, full rerun 79/79) — the shared build folder was being rebuilt by concurrent sessions mid-run. The real two-app journey re-run on the fixed code: 31/31.
- 2026-09-23 — T5 — CC: credential-broker (trust limits, gate on every tool path, generation limits), tool-system, security, orchestrator, dashboard, index; MyVault: system doc, threat model (residual risk corrected), testing, ui, CHANGELOG, follow-ups (incl. key pinning). Both docs guards 0 failures.
- 2026-09-23 — T6 (MyVault) — committed `eb3458e` path-scoped (22 files, only this work) and pushed `3e012da..eb3458e`; CI run 35916023918 deploys it.
- 2026-09-23 — T7 — MyVault CI run 35916023918 failed twice in the browser job with the dev Worker exiting mid-run (attempt 1 after desktop test 46, attempt 2 after mobile test 217; every later test then fails "not answering /healthz"). All three new bridge tests passed before each crash. Same signature on earlier docs-only commits (35274421519, 34751462677) and already described in MyVault `docs/systems/testing.md` — a pre-existing `wrangler dev` flake, not this change. Deploy is gated on green CI, so production stayed on the previous build; third attempt started.
- 2026-09-23 — T7 — third CI attempt green (browser 255 passed / 19 skipped, sync 1, passkey-cloud 1) and deployed. Live `https://myvault.digitronics-electro.workers.dev`: `/healthz` → `"commit":"eb3458e"`; `Cross-Origin-Opener-Policy: same-origin-allow-popups`; CSP still `connect-src 'self'`; the served bundle contains the share control and `mvcc-bridge-v1`. Control Center: no deploy on push (local app).
- 2026-09-23 — T6 — parked (see the step): the Control Center code other than migration 7 is uncommitted because of the secret-file guard; it is not bypassed.
- 2026-09-23 — T4 — after the review fixes: `npm run check` exit 0 (539 unit tests, all four typechecks, docs guard, all builds); `npm run test:e2e` 255 passed, 19 skipped (layout-only cases) across desktop, mobile, extension and passkeys; `npm run test:e2e:sync` 1 passed (push, second-device restore, real 409 conflict — the existing conflict path, which bridge writes go through via `mutatePayload`).
- 2026-09-23 — T2 — searched: every caller of `credentials.list/get/events` (only the routes); the remote-node allowlist (`credential.list` GET and `credential.remove` are remote; bridge routes, status, events and resolve are not) and the egress mirror (`credential` events mirrored) → the new `vault` metadata (origin, item id, state; never a value) reaches the operator's own cloud plane — accepted as metadata-only, documented in credential-broker.md gotchas; other Wrangler calls taking a secret in argv (none); other `postMessage`/`window.open` in the dashboard (only the VS Code host bridge) and tracked MyVault `src/` (none — the COOP relaxation affects only the bridge popup); other credential write paths (`PATCH` is the only value write and carries the MANAGED rule; MCP env mapping and `http.request` auth go through scope-checked `value()`).
- 2026-09-23 — main hygiene — another session's commit `303dd69` swept in this plan's `migrations.test.ts` change (the v6→v7 test) without migration 7, leaving `main` red. Committed migration 7 on its own (additive, final — it is now shipped and must not be edited) so `main` is green again; the rest of the work still waits on the parked broker-file commit.
- 2026-09-23 — step 6 — `pnpm -r typecheck` exit 0 with `CredentialView.source/vault`, link/event/status/resolve types in `packages/shared/src/tools.ts`.
