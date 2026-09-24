---
title: Generate, save and deploy secrets without waiting — MyVault delivery box and GitHub secrets
source: conversation 2026-09-24 (operator request, /goal autopilot)
created: 2026-09-24
status: done
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

- [x] 1. `mvcc-deposit-v1` seal/open in both protocol files with shared vectors — done when: a deposit sealed by the Control Center code opens in MyVault's code, a tampered or unsigned one does not — check: `npx vitest run apps/orchestrator/test/vault-bridge-protocol.test.ts` and `npx vitest run src/integrations` (MyVault)
- [x] 2. MyVault Worker: `deposit` scope, deposit enrollments for read-write devices, `/api/v1/deposits` (post, list, status, receipt), migration 0004, limits — done when: Worker tests prove a deposit token cannot read the vault, a vault token cannot deposit, receipts erase ciphertext — check: `npx vitest run worker` (MyVault)
- [x] 3. Control Center: migration 10, deposit targets, `VaultDepositService` (accept offer, deposit, wait-for-deposit gate, receipt polling), bridge advertises delivery and accepts `deposit.offer` — done when: tests prove generate → deposit → gate open → receipt → synced against a fake Worker, and a failed or missing box leaves the old behaviour — check: `npx vitest run apps/orchestrator/test/vault-deposit.test.ts apps/orchestrator/test/vault-bridge.test.ts apps/orchestrator/test/migrations.test.ts`
- [x] 4. MyVault client: delivery key item, offer during a bridge session, collector with receipts, panel status — done when: unit tests prove offer, collection, dedup across repeated collection, and refusal of an unsigned deposit — check: `npx vitest run src/integrations` (MyVault)
- [x] 5. `github.secret_put` — done when: a fake `gh` proves stdin delivery, gate, verification — check: `npx vitest run packages/tools/test/packs.test.ts apps/orchestrator/test/vault-bridge.test.ts`
- [x] 6. Dashboard: `deposited` state, delivery status in Connect MyVault — done when: Playwright passes — check: `pnpm build && pnpm --filter @acc/dashboard exec playwright test e2e/vault-bridge.spec.ts`
- [x] 7. Real journey: Control Center + MyVault Worker (local D1) + browser — done when: delivery is set up through a bridge session, a secret generated while MyVault is locked deploys immediately, and after unlock it is collected into the vault and the link reads synced — check: `manual: journey output in the Ledger`
- [x] 8. Docs both repos (credential-broker, tool-system, control-center-bridge, threat model, testing, CHANGELOG) — done when: every documented behaviour matches the code — check: `node scripts/docs-guard.mjs` in both repos

## Tail

- [x] T1. Adversarial review of both diffs — done when: every finding is fixed or ledgered — check: findings fixed or ledgered
- [x] T2. Similar-issue sweep — done when: similar gaps were searched for and listed — check: `manual: list what was searched`
- [x] T3. Gates — done when: `pnpm check`, `pnpm build && pnpm e2e` (Control Center) and `npm run check`, `npm run test:e2e`, sync and passkey-cloud suites (MyVault) pass, or a failure is shown to be another session's — check: the commands
- [x] T4. Path-scoped commits (index checked empty first) and pushes in both repos — done when: each commit holds only this work — check: `git show --stat HEAD`
- [x] T5. Live — done when: the MyVault Worker is deployed with migration 0004 applied and a real delivery against the live Worker was collected → deferred: the first delivery into the operator's own vault needs that vault unlocked once (its sync key is the only credential that can set the box up; with automatic sync on it happens at the next unlock) — everything else verified live — check: `manual: live deposit + collection recorded in the Ledger`

## Ledger

- 2026-09-24 — created; next free Control Center migration is 10, MyVault D1 migration 0004.
- 2026-09-24 — step 2 — deviated from the plan text: the sender token is minted directly by MyVault (`POST /api/v1/deposit-senders`, read-write credential) and handed over inside the sealed bridge channel, instead of an enrollment code the Control Center redeems — the channel already protects it, and a separate `deposit_senders` table avoids rebuilding the live `sync_devices` table (its scope CHECK) in production D1. Senders are listed and revoked with the devices.
- 2026-09-24 — step 3 — `app.ts` is also being edited by another session (skill picker); only the two wiring lines of this plan will be committed from it (index blob built from HEAD + those lines).
- 2026-09-24 — step 6 — added `pollSoon`: the dashboard's status request triggers a receipt check (at most every 10 s), so the Credentials page shows a collected secret as synced when the operator looks, instead of up to a minute later.
- 2026-09-24 — step 7 — first real run 19/20: the Control Center never read the receipt because it checked each deposit with its own request, and MyVault's Worker rate-limits requests per address (60/min) — shared with the vault's own sync from the same home address. Fixed with one batched `POST /api/v1/deposits/receipts` per check (and the per-deposit status route removed). Re-run 20/20: delivery set up in one bridge session, a secret generated while MyVault was locked was delivered at once and deployed to Cloudflare and GitHub (both verified, same value), the Worker held only ciphertext, unlock collected it into the vault, the receipt marked it synced, a later bridge sync agreed, and with automatic sync on a second locked-vault secret ended synced with exactly one vault item.
- 2026-09-24 — T1 — independent review of both diffs: the core held (deposit tokens cannot reach the vault; `IN (...)` is parameterised; both migrations additive; every broker path handles `deposited`). Eight findings, all fixed: (1) removing trust in a MyVault address left its box live → `forgetOrigin` removes it and holds back waiting secrets, and `eligible` requires a trusted origin; (2) a replacement credential made waiting deposits look lost → Worker keeps sender lineage (`deposit_senders.replaces`), receipts and re-posts work across it, and only a 401 (`lastErrorKind: auth`) asks MyVault for a new credential; (3) collecting could overwrite a newer value, and a compromised Worker could replay → collection is create-only (existing item → `unchanged`/`conflict` receipt, no write) and a row whose contents claim another id is ignored; (4) unopenable deposits waited forever and could fill the 100-row list → error receipts (`unknown_key`, `wrong_vault`, `untrusted_sender`, `cannot_open`) so the Control Center falls back to the bridge; a device with no pins still waits; (5) 100 ids + sender id exceeded D1's 100 bound values → 90 per request; (6) retries hammered a refusing Worker → stop at the first failure per box per pass, no retries while refused; (7) a read-only sync key polled with 401s every minute → collection stops for that key, setup fails with the reason; (8) the gate waited for deposits of out-of-scope credentials and quoted any box's error → scope checked first, the secret's own box named.
- 2026-09-24 — T2 — swept every call either side makes to MyVault's Worker for the per-request pattern that broke the first journey (the Worker's rate limit is per address, shared by the Control Center, the collector and the vault's sync): found the collector sending one receipt per deposit → one `POST /api/v1/deposit-receipts {receipts}` per collection (≤90, matching the list size); Control Center receipt checks were already batched; deposits are one request per new secret by nature, and retries stop at the first failure per box. Also checked: no other place trusts a Worker answer without the identity signature (collection verifies every deposit), and no other code path writes a vault item from the Control Center without the create-only rule (bridge pushes keep their own conflict rules).
- 2026-09-24 — T3 — Control Center: typecheck, lint (3 lint errors of mine fixed), docs guard clean; `pnpm test` 632/641 with 9 failures in chairman, remote, repository-automation, source-control and usage tests (timeouts under full-suite load while another session was committing) — all 113 tests in those files pass when rerun; `pnpm build && pnpm e2e` 89/89. MyVault: `npm run check` 569 tests + builds; `npm run test:e2e` 259 passed / 19 skipped; sync 1/1 (port 8799); passkey-cloud 1/1. Real journey re-run after the review fixes: 20/20.
- 2026-09-24 — T4 — Control Center 8ad14a9 (20 paths; index checked empty; the other session had committed its skill-picker work meanwhile, so `app.ts` held only this plan's two lines), pushed 748cd29..8ad14a9. MyVault c416995 (22 paths) pushed 725e952..c416995, released by CI run 36007478377; docs follow-up 44b8fd9 (deployment, ui). The operator's live orchestrator (pid 19956, no active task — six tasks all finished or cancelled) was stopped, its database copied to `%LOCALAPPDATA%\AIDevControlCenter\backup-before-migration-10-*`, and restarted from the build of 8ad14a9 (pid 37436): migration 10 applied, identity key unchanged (32CC 97BC … 7670), `delivery` reported.
- 2026-09-24 — T5 — live: MyVault /healthz reports 44b8fd9 (c416995's code, CI runs 36007478377 and 36008911866 green, D1 migration 0004 applied by the deploy); unauthenticated and unknown-sender calls to every delivery route answer 401 — including a deposit POST that queries `deposit_senders`, which proves the table exists (a missing table would be a 500); the served bundle carries the collector, the `deposit.offer` step and the Delivery box line. The live Control Center runs 8ad14a9 with migration 10. Deferred (written in the step): the first live delivery into the operator's own vault waits for that vault's next unlock; the identical code path passed the real journey 20/20 against a local Worker with every migration.
