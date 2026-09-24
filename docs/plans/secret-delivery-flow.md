---
title: Generate, save and deploy secrets without waiting — MyVault delivery box and GitHub secrets
source: conversation 2026-09-24 (operator request, /goal autopilot)
created: 2026-09-24
status: in-progress
---

# Generate, save and deploy secrets without waiting

## Context

Operator request (2026-09-24), verbatim:

> Many times when I'm building apps, I needed to generate secrets and save them.
> And deploy them to Cloudflare or to GitHub. I want this flow between control
> center and my vault to be perfectly auto and sync and the flow work sound and
> clear. Investigate this build it if needed test it to make sure this flow will
> work perfectly

Operator instruction: full autopilot, decide everything, only finish when it
works reliably.

### What the investigation found

- `credential.generate` creates the secret sealed and `pending_push`; the
  vault-before-deploy gate (`heldForVault`: `synced_fingerprint = fingerprint`)
  then refuses `cloudflare.secret_put` until MyVault acknowledged the value.
- MyVault only acknowledges over the popup bridge, which needs the vault open
  and unlocked and a click (or automatic sync right after an unlock or a shared
  save). MyVault auto-locks after 5 minutes. An agent that generates and then
  deploys therefore stops at the gate almost every time, waiting for a person.
- There is no way to deploy a secret to GitHub (no `github.secret_put`).
- MyVault's Worker already has per-device, scoped, revocable, hashed tokens
  (`sync_devices`, enrollment codes) — the right primitive for a narrow
  "may only deliver" credential.
- A new vault payload field needs a schema version bump, which older builds
  (the Android keyboard's autofill reader, the extensions) refuse; storage must
  reuse what the payload already carries.
- `apps/orchestrator/src/tools/credentials.ts` trips the operator's
  secret-file commit guard by name; this plan changes it not at all.

### Decisions

- **Delivery box (sealed mailbox on MyVault's Worker).** When MyVault has set
  one up, a newly generated secret is sealed by the Control Center to MyVault's
  long-term delivery key (ECDH P-256 → HKDF-SHA-256 → AES-256-GCM,
  `mvcc-deposit-v1`), signed with the Control Center's pinned identity key, and
  posted to `POST /api/v1/deposits` with a deposit-only device token. The Worker
  stores ciphertext it cannot read. Once the Worker has stored it, the secret is
  durably saved for MyVault (only the vault can open it), so the gate releases
  it and deployment proceeds at once. Link state `deposited`.
- **Collection.** While unlocked, MyVault collects deposits from its own Worker
  (same-origin fetch: no window, no click) on unlock, every 60 s and when the
  tab regains focus; verifies the signature against a pinned Control Center
  key; opens it; saves it as the generated API item through the normal write
  path (deterministic item id `cc-<credential id>` so two devices never create
  two items); then posts a receipt. The Control Center polls receipts and marks
  the link `synced`. A receipt saying the deposit cannot be opened puts the
  secret back on hold (`pending_push`), so the bridge delivers it instead.
- **Setup is automatic.** In any bridge session, the Control Center advertises
  delivery support; MyVault (when its cloud sync is configured) creates its
  delivery key as a reserved vault item, asks its Worker for a single-use
  `deposit` enrollment code, and hands the key and code to the Control Center
  inside the sealed channel. The Control Center redeems the code for its token
  and stores it sealed. The device appears in MyVault's device list and can be
  revoked there.
- **Scope of deposits:** only brand-new generated secrets (no MyVault item yet).
  Replacements and conflicts keep using the bridge, where they can be settled.
- **GitHub:** `github.secret_put {credential, secretName, environment?}` — value
  on stdin to `gh secret set`, gated like Cloudflare, verified by listing names
  and update time. Level 4.
- **Worker tokens:** new device scope `deposit` (deposit and read its own
  receipts; never read or write the vault). A read-write device token may mint a
  `deposit` enrollment; everything else stays bootstrap-only.

### Irreversible steps

- Pushing MyVault `main` deploys the Worker and applies D1 migration 0004
  (`deposits`, additive) to production. Authorized by the operator's request.
- The Control Center's live orchestrator applies migration 10 on its next
  restart (additive).

## Steps

- [ ] 1. `mvcc-deposit-v1` seal/open in both protocol files with shared vectors — done when: a deposit sealed by the Control Center code opens in MyVault's code, a tampered or unsigned one does not — check: `npx vitest run apps/orchestrator/test/vault-bridge-protocol.test.ts` and `npx vitest run src/integrations` (MyVault)
- [ ] 2. MyVault Worker: `deposit` scope, deposit enrollments for read-write devices, `/api/v1/deposits` (post, list, status, receipt), migration 0004, limits — done when: Worker tests prove a deposit token cannot read the vault, a vault token cannot deposit, receipts erase ciphertext — check: `npx vitest run worker` (MyVault)
- [ ] 3. Control Center: migration 10, deposit targets, `VaultDepositService` (accept offer, deposit, wait-for-deposit gate, receipt polling), bridge advertises delivery and accepts `deposit.offer` — done when: tests prove generate → deposit → gate open → receipt → synced against a fake Worker, and a failed or missing box leaves the old behaviour — check: `npx vitest run apps/orchestrator/test/vault-deposit.test.ts apps/orchestrator/test/vault-bridge.test.ts apps/orchestrator/test/migrations.test.ts`
- [ ] 4. MyVault client: delivery key item, offer during a bridge session, collector with receipts, panel status — done when: unit tests prove offer, collection, dedup across repeated collection, and refusal of an unsigned deposit — check: `npx vitest run src/integrations` (MyVault)
- [ ] 5. `github.secret_put` — done when: a fake `gh` proves stdin delivery, gate, verification — check: `npx vitest run packages/tools/test/packs.test.ts apps/orchestrator/test/vault-bridge.test.ts`
- [ ] 6. Dashboard: `deposited` state, delivery status in Connect MyVault — done when: Playwright passes — check: `pnpm build && pnpm --filter @acc/dashboard exec playwright test e2e/vault-bridge.spec.ts`
- [ ] 7. Real journey: Control Center + MyVault Worker (local D1) + browser — done when: delivery is set up through a bridge session, a secret generated while MyVault is locked deploys immediately, and after unlock it is collected into the vault and the link reads synced — check: `manual: journey output in the Ledger`
- [ ] 8. Docs both repos (credential-broker, tool-system, control-center-bridge, threat model, testing, CHANGELOG) — check: `node scripts/docs-guard.mjs` in both repos

## Tail

- [ ] T1. Adversarial review of both diffs — check: findings fixed or ledgered
- [ ] T2. Similar-issue sweep — check: `manual: list what was searched`
- [ ] T3. Gates: `pnpm check`, `pnpm build && pnpm e2e` (Control Center); `npm run check`, `npm run test:e2e`, sync and passkey-cloud suites (MyVault) — check: the commands
- [ ] T4. Path-scoped commits (index checked empty first) and pushes in both repos — check: `git show --stat HEAD`
- [ ] T5. Live: MyVault Worker deployed with migration 0004 applied; a real delivery against the live Worker from the running Control Center after its restart — check: `manual: live deposit + collection recorded in the Ledger`

## Ledger

- 2026-09-24 — created; next free Control Center migration is 10, MyVault D1 migration 0004.
