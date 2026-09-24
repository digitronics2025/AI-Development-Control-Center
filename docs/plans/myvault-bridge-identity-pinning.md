---
title: MyVault pins the Control Center's identity key — the bridge authenticates the Control Center, not just its address
source: conversation 2026-09-24 (follow-up from docs/plans/myvault-credential-bridge.md; MyVault docs/follow-ups.md "Authenticate the Control Center, not just its address")
created: 2026-09-24
status: in-progress
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

- [ ] 1. Identity sign/verify + fingerprint in both protocol files, identity vectors in the shared vectors file, tests in both repos — done when: a Control Center signature verifies in MyVault's code and a tampered transcript does not — check: `npx vitest run apps/orchestrator/test/vault-bridge-protocol.test.ts` and `npx vitest run src/integrations` (MyVault)
- [ ] 2. Control Center identity: migration 9, sealed storage, `open()` returns identity key + signature, status reports the fingerprint — done when: tests prove the signature verifies, the key survives a restart, and no private key material is in API output or SQLite plaintext — check: `npx vitest run apps/orchestrator/test/vault-bridge.test.ts apps/orchestrator/test/migrations.test.ts`
- [ ] 3. Dashboard: popup relays identity fields; Connect MyVault shows the fingerprint — done when: Playwright passes with the stub vault verifying the signature — check: `pnpm build && pnpm --filter @acc/dashboard exec playwright test e2e/vault-bridge.spec.ts`
- [ ] 4. MyVault client + panel: verify (fail closed), confirm-on-first-use, refuse a changed key, forget pin — done when: unit tests prove nothing is sent before confirmation, a changed key is refused, and a pinned key syncs unattended — check: `npx vitest run src/integrations` (MyVault)
- [ ] 5. MyVault browser tests: stand-in Control Center signs; confirm step and changed-key refusal exercised — done when: the spec passes on desktop and mobile — check: `npm run test:e2e -- --project=desktop --project=mobile e2e/control-center.spec.ts` (MyVault)
- [ ] 6. Real two-app journey updated (confirm on first connect) plus a changed-identity case — done when: every leg passes — check: `manual: journey output recorded in the Ledger`
- [ ] 7. Docs both repos: credential-broker.md, MyVault control-center-bridge.md, threat model, follow-up closed, CHANGELOG — done when: docs guards pass — check: `node scripts/docs-guard.mjs` in both repos

## Tail

- [ ] T1. Adversarial review of the whole diff — done when: every finding is fixed or ledgered — check: `git diff --stat` reviewed in both repos
- [ ] T2. Similar-issue sweep — done when: other places that trust an unauthenticated peer key were searched — check: `manual: list what was searched`
- [ ] T3. Gates — done when: `pnpm check`, `pnpm build && pnpm e2e` (Control Center) and `npm run check`, `npm run test:e2e`, `npm run test:e2e:sync` (MyVault) pass, or a failure is shown to be another session's — check: the commands
- [ ] T4. Committed path-scoped (index checked empty in its own step) and pushed in both repos — done when: both pushes succeed and each commit holds only this work — check: `git show --stat HEAD` in both repos
- [ ] T5. Confirmed live — done when: MyVault's live /healthz reports the new commit and the served bundle contains the pinning code; Control Center: no deploy on push — check: `manual: curl the live /healthz and bundle`

## Ledger

- 2026-09-24 — created from the conversation; migration 9 is the next free number (8 is the Chairman's).
