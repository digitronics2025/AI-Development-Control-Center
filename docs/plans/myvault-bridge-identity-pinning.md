---
title: MyVault pins the Control Center's identity key — the bridge authenticates the Control Center, not just its address
source: conversation 2026-09-24 (follow-up from docs/plans/myvault-credential-bridge.md; MyVault docs/follow-ups.md "Authenticate the Control Center, not just its address")
created: 2026-09-24
status: done
---

# MyVault pins the Control Center's identity key

## Context

From the credential-bridge review (MyVault finding 1) and the final report of
docs/plans/myvault-credential-bridge.md:

> MyVault trusts whatever answers at the local Control Center address; it
> doesn't check a key. Adding that check is on MyVault's follow-up list.

MyVault follow-up, verbatim: "Authenticate the Control Center, not just its
address. MyVault trusts whatever answers at the configured loopback address;
the session code does not authenticate that page. Pin a long-term Control
Center identity key at trust time (shown in the Control Center dashboard,
confirmed in MyVault) and require every session key to be signed by it."

Operator instruction (2026-09-24): "Act as auto pilot and go. you decide for all".

### Decisions

- **Identity key:** ECDSA P-256, generated once by the orchestrator, private
  half sealed with the existing DPAPI-protected broker key (same pattern as the
  remote node identity), stored in an additive migration 9 table.
- **What is signed:** `mvcc-bridge-v1 identity\n<sessionId>\n<myvaultEphemeralPub>\n<controlCenterEphemeralPub>`
  — binds the Control Center's ephemeral key to this session and to MyVault's
  key. The popup (and anything that controls it) relays the signature but cannot
  forge it, so a script in the dashboard or a program squatting the port can no
  longer complete a handshake MyVault accepts.
- **Pinning model (SSH-style):** the first successful handshake from a Control
  Center address stops before anything is shared and shows the key fingerprint;
  the operator compares it with Tools → Credentials → Connect MyVault and clicks
  **Trust this Control Center**. Later sessions with the same key run
  unattended; a different key is refused outright until the operator forgets
  the pinned key in MyVault Settings. The pin is a device setting (localStorage,
  keyed by Control Center origin) — never in the vault payload.
- **Channel unchanged:** envelopes, AAD and vectors of `mvcc-bridge-v1` stay as
  they are; the identity signature is an addition to the `accept` step, and a
  MyVault that finds no valid signature fails closed.

### Irreversible steps

- Pushing MyVault `main` deploys it to production (authorized by the operator's
  autopilot instruction).

## Steps

- [x] 1. Identity sign/verify + fingerprint in both protocol files, identity vectors in the shared vectors file, tests in both repos — done when: a Control Center signature verifies in MyVault's code and a tampered transcript does not — check: `npx vitest run apps/orchestrator/test/vault-bridge-protocol.test.ts` and `npx vitest run src/integrations` (MyVault)
- [x] 2. Control Center identity: migration 9, sealed storage, `open()` returns identity key + signature, status reports the fingerprint — done when: tests prove the signature verifies, the key survives a restart, and no private key material is in API output or SQLite plaintext — check: `npx vitest run apps/orchestrator/test/vault-bridge.test.ts apps/orchestrator/test/migrations.test.ts`
- [x] 3. Dashboard: popup relays identity fields; Connect MyVault shows the fingerprint — done when: Playwright passes with the stub vault verifying the signature — check: `pnpm build && pnpm --filter @acc/dashboard exec playwright test e2e/vault-bridge.spec.ts`
- [x] 4. MyVault client + panel: verify (fail closed), confirm-on-first-use, refuse a changed key, forget pin — done when: unit tests prove nothing is sent before confirmation, a changed key is refused, and a pinned key syncs unattended — check: `npx vitest run src/integrations` (MyVault)
- [x] 5. MyVault browser tests: stand-in Control Center signs; confirm step and changed-key refusal exercised — done when: the spec passes on desktop and mobile — check: `npm run test:e2e -- --project=desktop --project=mobile e2e/control-center.spec.ts` (MyVault)
- [x] 6. Real two-app journey updated (confirm on first connect) plus a changed-identity case — done when: every leg passes — check: `manual: journey output recorded in the Ledger`
- [x] 7. Docs both repos: credential-broker.md, MyVault control-center-bridge.md, threat model, follow-up closed, CHANGELOG — done when: docs guards pass — check: `node scripts/docs-guard.mjs` in both repos

## Tail

- [x] T1. Adversarial review of the whole diff — done when: every finding is fixed or ledgered — check: `git diff --stat` reviewed in both repos
- [x] T2. Similar-issue sweep — done when: other places that trust an unauthenticated peer key were searched — check: `manual: list what was searched`
- [x] T3. Gates — done when: `pnpm check`, `pnpm build && pnpm e2e` (Control Center) and `npm run check`, `npm run test:e2e`, `npm run test:e2e:sync` (MyVault) pass, or a failure is shown to be another session's — check: the commands
- [x] T4. Committed path-scoped (index checked empty in its own step) and pushed in both repos — done when: both pushes succeed and each commit holds only this work — check: `git show --stat HEAD` in both repos
- [x] T5. Confirmed live — done when: MyVault's live /healthz reports the new commit and the served bundle contains the pinning code; Control Center: no deploy on push — check: `manual: curl the live /healthz and bundle`

## Ledger

- 2026-09-24 — created from the conversation; migration 9 is the next free number (8 is the Chairman's).
- 2026-09-24 — step 2 — the Chairman's v7→v8 migration test called `migrate(db)` with every migration and expected `[8]`; pinned it to versions ≤ 8 so migration 9 does not break it (test-only, no behaviour change).
- 2026-09-24 — step 2 — `VaultBridgeService.status/trustOrigin/untrustOrigin` became async (the identity is loaded lazily from the sealed row); every caller already awaited through Fastify.
- 2026-09-24 — step 6 — real journey (built orchestrator on :4398, MyVault wrangler dev on :8798 with local D1, headless Chromium) 38/38: first connect stops at the key check showing the same fingerprint as the Control Center status, nothing imported before trust, key survives a Control Center restart and the next connect runs unattended, a fresh Control Center install on the same port is refused with its fingerprint named and receives nothing.
- 2026-09-24 — T1 — independent read-only review of both diffs: no high or medium findings; six low ones, all handled: (1) an unopenable identity now answers `IDENTITY_UNAVAILABLE` (503) and MyVault names it instead of blaming trust; (2) no reset action for an unopenable key → deferred: documented in credential-broker.md (manual row delete; MyVault then refuses the new key until forgotten) and in the dashboard banner; (3) `open()` now re-checks trust and the session limit with no await before registering, so an origin removed mid-handshake gets no session (test added); (4) wording: the vault id and a one-time key reach the page before the check, so texts now say 'no item or secret was sent' instead of 'nothing was shared'; (5) the key question now ends after 9 minutes or when the Control Center window is closed, pinning nothing (test added); (6) orchestrator.md lists migration 9.
- 2026-09-24 — T2 — searched both repos for message listeners, `window.opener`, raw key imports and peer keys (`postMessage`, `addEventListener('message')`, `importKey('raw'`, `publicKey`): the VS Code webview only talks to its extension host inside the webview sandbox; MyVault's passkey extension relay/shim accept only `event.source === window`; the remote node reaches its relay over https only and proves itself with a signed challenge. One related gap, not widened by this change and documented in credential-broker.md: the orchestrator does not authenticate MyVault — a holder of the local API token can open a session as a trusted origin and receive pending generated secrets, which is no more than that token can already do with `http.request`.
- 2026-09-24 — T3 — Control Center: typecheck, lint and 578/580 tests green in `pnpm check`; the two failures (real ConPTY shell and `shell.run` via PowerShell, both timeouts) ran while MyVault's browser suite loaded the machine and pass alone (16/16), and neither touches the bridge. `pnpm build && pnpm e2e` 79/79. MyVault: `npm run check` green (545 unit tests, lint, docs, all builds); `npm run test:e2e` 257 passed / 19 skipped; `npm run test:e2e:sync` 1/1 on port 8799 via `PLAYWRIGHT_SYNC_PORT` because another project's dev server (sales-analyzer) holds 8788 — left running.
- 2026-09-24 — T4 — Control Center: plan b89b8db and code e8ada77 (15 paths, staged and committed by path with the index checked empty first), rebased onto 08e0a30 (another session's journey test, no overlap), merged tree re-typechecked and bridge/migration tests 41/41, pushed 08e0a30..e8ada77. MyVault: 6df4b3b (13 paths), pushed eb3458e..6df4b3b; CI run 35973381478 deploys it.
- 2026-09-24 — T5 — MyVault CI run 35973381478 green (browser 257 passed / 19 skipped, sync 1/1) and deployed; https://myvault.digitronics-electro.workers.dev/healthz reports commit 6df4b3b; the served bundle index-BY2bK7z1.js contains `myvault.controlCenterIdentities`, `Trust this Control Center?`, `Forget trusted key` and `IDENTITY_UNAVAILABLE`. The Control Center has no deploy on push; the operator's running orchestrator picks up migration 9 and the signing key on its next restart.
