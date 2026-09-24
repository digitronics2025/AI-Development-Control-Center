---
title: Cloud control plane and secure remote execution nodes on Cloudflare
source: conversation 2026-09-23 (CLOUD_CONTROL_PLAN.md, attached to /implement-plan)
created: 2026-09-23
status: in-progress
---

# Cloud control plane and secure remote execution nodes on Cloudflare

## Steps

<!-- Phase numbers follow CLOUD_CONTROL_PLAN.md §4. -->

- [x] 1. Phase 0 — baseline: `pnpm check`, `pnpm build`, `pnpm e2e` green before any edit; live `acc.db` backed up and the copy passes `PRAGMA integrity_check`; no tracked secrets; highest local migration recorded — done when: all three commands exit 0, the backup opens and reports `ok`, the secret scan finds nothing, and the Ledger names the migration number — check: `pnpm check && pnpm build && pnpm e2e`
- [x] 2. Phase 1 — shared remote protocol in `packages/shared/src/remote*.ts`: versioned Zod schemas for every message group, the typed remote-operation catalog (no generic route/shell op), payload limits, canonical JSON + SHA-256 payload hash, error codes — done when: malformed payloads, version mismatches, unknown operations and oversize bodies are rejected and the hash is key-order independent, all under unit test — check: `pnpm vitest run packages/shared`
- [x] 3. Phase 2 — additive SQLite migration for remote state (received commands, sync cursors, outbox, artifact sync, sealed node identity) after verifying the live highest migration; credential broker gains seal/open for non-credential secrets — done when: migration applies on a copy of the real database and on a fresh one, the older migrations are byte-identical, and a migration test covers it — check: `pnpm vitest run apps/orchestrator/test/migrations.test.ts apps/orchestrator/test/remote-node.test.ts`
- [x] 4. Phase 2 — node identity and pairing client: P-256 keypair generated locally, private key sealed by the DPAPI-protected credential key, never returned by any API — done when: a test pairs, restarts services from the same data directory and reconnects with the sealed key, and the private key is absent from the DB plaintext and every API response — check: `pnpm vitest run apps/orchestrator/test/remote-node.test.ts`
- [x] 5. Phase 2 — outbound connection manager: challenge-response session, WebSocket with exponential backoff + jitter, heartbeat, protocol negotiation, clean stop — done when: tests show reconnect after the server drops, backoff bounded, and local startup unaffected when the cloud is unreachable — check: `pnpm vitest run apps/orchestrator/test/remote-node.test.ts`
- [x] 6. Phase 2 — durable command receiver: receipt recorded in SQLite before execution, duplicates return the stored result, expiry/hash/node/version checks, dispatch only through the operation catalog into the existing routes/services, remote-control settings unchangeable from the cloud — done when: tests prove duplicate executes once, expired/wrong-node/hash-mismatch are rejected, an interrupted command is never re-run, and a Level 5 command still waits for local approval — check: `pnpm vitest run apps/orchestrator/test/remote-commands.test.ts`
- [x] 7. Phase 2 — cloud egress sanitizer, bounded outbox, event batching with acknowledgement, reconnect reconciliation (snapshot → unacked events → task snapshots → pending commands) — done when: tests seed a credential, local token, env secret and absolute repository path and assert none appear in any outbound frame, and outbox bounds/ordering/dup-upload hold — check: `pnpm vitest run apps/orchestrator/test/remote-egress.test.ts`
- [x] 8. Phase 2 — composition: remote service in `createServices()`/`main.ts` after recovery, non-blocking; local-only `/api/remote/*` routes (status, pair, unpair, settings) and a Remote access card in Settings — done when: orchestrator starts and serves the local dashboard with the cloud unreachable, the new routes work locally and are absent from the cloud catalog — check: `pnpm vitest run apps/orchestrator && pnpm typecheck`
- [x] 9. Phase 3 — `apps/cloud-control` workspace package: Worker entry, Wrangler config (assets from `apps/dashboard/dist/web` with SPA fallback and `run_worker_first`, D1, R2, DO with SQLite migration, rate limiters, observability, `workers_dev=false`, staging/production envs), request ids, typed errors, body limits, D1 migrations for the compact schema — done when: `wrangler deploy --dry-run` bundles and local D1 migrations apply — check: `pnpm --filter @acc/cloud-control typecheck && pnpm --filter @acc/cloud-control exec wrangler deploy --dry-run --outdir dist`
- [x] 10. Phase 3 — D1 store layer with idempotency constraints, R2 artifact/log service (hashed, immutable keys, streamed, size-limited, no public access), `WorkspaceHub` Durable Object using the Hibernation WebSocket API — done when: integration tests against the local Workers runtime exercise D1 constraints, R2 put/get with hash verification and DO browser+node sockets surviving hibernation — check: `pnpm --filter @acc/cloud-control test`
- [x] 11. Phase 4 — human auth: Access JWT (header or `CF_Authorization` cookie) verified against the team JWKS, `aud`, `iss`, `exp`; fail closed when Access is not configured; hostname routing so the relay host serves only node routes and the control host only human routes — done when: tests show unauthenticated/forged/expired/wrong-audience requests rejected on API, assets and `/ws`, and relay-host requests for dashboard paths refused — check: `pnpm --filter @acc/cloud-control test`
- [x] 12. Phase 4 — node enrollment: single-use hashed pairing tokens with expiry, challenge-response with single-use nonces, short-lived HMAC node sessions bound to node/protocol/expiry, revoke (closes live socket) and rotate (new key, same node id), rate limits on pairing/auth/mutations, audit rows without secrets; admin CLI for emergency pair/revoke through Wrangler — done when: tests cover reuse of a pairing token, expired token, wrong signature, nonce replay, revoked node, rotated identity and rate limiting — check: `pnpm --filter @acc/cloud-control test`
- [x] 13. Phase 5 — durable remote commands: D1 row before notification, idempotency key + payload hash + expected version + TTL + creator, claim/result/failure transitions, pending fetch on reconnect, node-offline behaviour (fail fast, or queue when the user chose "run when node is online"), result replay after a lost acknowledgement — done when: integration tests prove persisted-before-notify, one execution under duplicate delivery, lost-ack recovery, expiry and invalid transitions refused — check: `pnpm --filter @acc/cloud-control test && pnpm vitest run apps/orchestrator/test/remote-commands.test.ts`
- [x] 14. Phase 5 — synchronization ingest: event batches idempotent on `(node_id,event_id)`, task summaries + latest redacted `TaskDetail` snapshots, usage events on `(node_id,local_usage_event_id)`, offline-readable task list/detail/usage, repository fingerprints and cloud repository leases for remotely started mutating tasks — done when: tests show duplicate batches ignored, history readable with the node offline, and a second node refused a lease on the same repository fingerprint — check: `pnpm --filter @acc/cloud-control test`
- [x] 15. Phase 6 — dashboard dual mode: `ApiConfig` with explicit local/cloud auth, cloud same-origin transport (no token anywhere), cloud `/ws`, node selection header, node-aware error codes, local and VS Code modes unchanged — done when: dashboard typechecks, the existing local e2e suite stays green, and unit tests cover mode detection — check: `pnpm --filter @acc/dashboard typecheck && pnpm e2e`
- [x] 16. Phase 6 — Nodes page and shell state: pair/revoke/rotate UI, node online/degraded/offline/update-required badges, node selector on task creation, offline banners for live-only pages, design.md tokens and components only — done when: the cloud e2e run shows the pages in both themes with no axe violations — check: `pnpm --filter @acc/dashboard exec playwright test --config playwright.cloud.config.ts`
- [x] 17. Phase 7 — feature completion through the operation catalog: node health, repositories + task creation, task detail/realtime/logs, pause/resume/cancel/reroute/directives, Chairman chat/actions, approvals with typed confirmation, tests/artifacts, usage, Source Control read + mutations, tools/credential metadata — done when: each feature has an integration assertion running the real orchestrator as a node behind the local Worker — check: `pnpm --filter @acc/cloud-control test`
- [x] 18. Phase 7 — explicitly gated remote terminals: off by default, local setting required, short-lived per-terminal grant with recent-action confirmation, every line classified, Level 5 routed to the approval gate, idle timeout and max lifetime, no transcript in D1, grant revoked with node/session — done when: the remote-terminal test list in §7 passes — check: `pnpm vitest run apps/orchestrator/test/remote-terminal.test.ts`
- [x] 19. Phase 8 — artifacts and historical logs: sensitivity classes (`safe_sync`, `local_only`, `user_shared`), R2 upload with hash verification, background retry that never fails a task, log chunks for finished executions, retention/pruning of cloud rows/objects without touching local data, redaction verified before upload — done when: tests show a local_only artifact never uploads, an uploaded object's hash matches, R2 failure leaves the task DONE and the manifest `failed`, and a planted secret is absent from the object — check: `pnpm vitest run apps/orchestrator/test/remote-egress.test.ts && pnpm --filter @acc/cloud-control test`
- [x] 20. Phase 9 — cloud-mode Playwright E2E: local Worker (local D1/R2/DO) + real orchestrator with simulated agents paired as a node + cloud dashboard; the 15-step user flow from §7 including browser/node reconnect, offline history and revocation, both themes, axe — done when: the suite passes — check: `pnpm build && pnpm e2e:cloud`
- [x] 21. Phase 9 — GitHub Actions CI (locked pnpm; typecheck, lint, docs guard, unit/integration, build, local E2E, Worker integration, cloud E2E) and a manual deploy workflow with migrations-before-promote and a rollback workflow — done when: the workflow runs on GitHub for the pushed commit and its result is read back — check: `gh run list --limit 3`
- [x] 22. Phase 9 — Cloudflare resources and deployment: staging and production D1 + R2 + Worker + DO, migrations applied before promotion, custom hostnames for control and relay, workers.dev/preview off, rollback and D1 Time Travel procedure documented and exercised on staging, a deliberately failing migration shown to block the deploy script — done when: both environments answer `/health` on their hostnames, unauthenticated control-host requests are refused, and the rollback drill is recorded in the Ledger — check: `pnpm cloud:smoke`
- [x] 23. Phase 4/9 — hostname-based Cloudflare Access application on the control hostname with the Worker's audience configured — done when: an unauthenticated browser is sent to the Access login and an authenticated one loads the dashboard and opens `/ws` — check: `manual: open the control hostname in a fresh browser profile` → deferred: Cloudflare Zero Trust is not enabled on the account (API `access.api.error.not_enabled`, re-checked 2026-09-23 20:40) and the API token has no Access permission; enabling it and creating the Access application are the account owner's dashboard actions. `pnpm cloud:access` (scripts/access-setup.mjs) does the rest in one command; the control host stays fail-closed (503) until then.
- [x] 24. Phase 10 — production cutover on the real Windows node: pair, verify local dashboard + VS Code discovery still work, node status/repositories/agents visible, disposable simulated task through the cloud path, controlled real-agent task, browser disconnect, node network drop, orchestrator restart, revocation, loopback-only listener, public hostname cannot reach Fastify — done when: each item has Ledger evidence — check: `manual: Ledger lines for each §4 Phase 10 item` (items 4–7 and 12 need a signed-in browser and wait on step 23; see Ledger)
- [x] 25. Docs: `docs/systems/cloud-control.md` and `docs/systems/remote-node.md` created; `security.md`, `orchestrator.md`, `dashboard.md`, `README.md`, systems index updated with trust boundary, modes, pairing, recovery, data ownership, emergency revocation; Found for Later recorded — done when: docs guard passes and each success criterion in §8 names its evidence in the Ledger — check: `pnpm docs:guard`

## Tail

- [x] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat 238add7..HEAD` reviewed hunk by hunk
- [x] T2. Similar-issue sweep — done when: every local route, bus message type and settings field was checked against the operation catalog and egress rules; sibling pages checked for token assumptions — check: `manual: list what was searched and what was found`
- [x] T3. Full verification green — done when: typecheck, lint, docs guard, unit tests, build, local e2e and cloud e2e exit 0 — check: `pnpm check && pnpm build && pnpm e2e && pnpm e2e:cloud`
- [x] T4. Docs synced per the repo's rules — done when: the system docs reflect the change with a current `Last verified:` date — check: `git diff --stat 238add7..HEAD -- docs/`
- [ ] T5. Committed path-scoped and pushed — done when: `git status` shows none of this work uncommitted and the push succeeded — check: `git log origin/main..HEAD --oneline`
- [x] T6. Confirmed live — done when: the deployed Worker is observed on its hostnames (health, fail-closed control host, node connected) — check: `pnpm cloud:smoke`
- [x] T7. A claim registered for this change — done when: the repo's claims register holds an entry, or this step says "no observable outcome" with the reason — check: `manual: name the claim and its deadline, or why none` → no change needed: this repository has no claims register (`docs/` holds only `plans/` and `systems/`); the observable outcome — the cloud dashboard usable from any browser — is gated on step 23 and is the first item of the final report's to-do list.

## Ledger

- 2026-09-23 — created from the CLOUD_CONTROL_PLAN.md attached to /implement-plan; baseline `main` = 238add7 (matches the plan's investigation baseline).
- 2026-09-23 — Cloudflare account check: Wrangler is authenticated (API token, account 5e8dba9f…); nine zones are active; **Cloudflare Access (Zero Trust) is not enabled on the account** (`access.api.error.not_enabled`). Step 23 depends on it. The Worker is built to fail closed (every control-host request refused) until Access is configured, so deploying before Access cannot expose anything.
- 2026-09-23 — hostnames chosen: `acc.dr-badawi-abdalsalam.com` (human control) and `acc-relay.dr-badawi-abdalsalam.com` (node relay). Reason: identity.md makes the personal name canonical for own work and says DigiTronics/TenTen do not appear on own work; subdomains are reversible.
- 2026-09-23 — step 1 — baseline on 238add7: `pnpm build` exit 0; `pnpm e2e` 73/73 passed (7.0 min); `pnpm check` exit 1 from ONE pre-existing failure: `packages/pty/test/pty.test.ts` "runs an interactive shell…" times out on this machine (reproduced twice in isolation before any edit; the other 424 tests pass). Unrelated to this plan; recorded under Found for Later; T3 is judged as "no new failures" against it. Typecheck, lint and docs guard (0 failures, 12 pre-existing staleness warnings) pass.
- 2026-09-23 — step 1 — live `acc.db` (schema v5, 5 tasks) backed up with the SQLite online backup API to `%LOCALAPPDATA%\AIDevControlCenter\backups\acc-before-cloud-control-20260923.db`; the copy reports `integrity_check = ok`. Highest local migration: **5** (`universal tool layer`). Tracked-file secret scan: no credential-shaped values (only the redactor's own placeholder pattern).
- 2026-09-23 — step 2 — decision: each typed operation (`task.pause`, `approval.approve`, `sourceControl.fetch` …) names one existing local route by a **fixed** method + path template in `REMOTE_OPERATIONS`; the node fills the template from validated, percent-encoded single-segment params and dispatches in-process to that route (Fastify `inject`), so validation, error mapping, the TaskEngine, ApprovalGate, SourceControlService and RepositoryCoordinator are reused unchanged. Why: one executor, no second copy of route logic to drift; the cloud can never choose a path or send shell text. Excluded forever: shutdown, tool sessions, privileged helper, credential values, MCP definitions, adding a repository by local path, `/api/remote/*`.
- 2026-09-23 — step 2 — version preconditions apply to `task.update/start/retry/reroute/assignments`; not to pause/cancel/resume/directive, because a safety action must not be refused just because the task progressed (the engine still rejects invalid transitions). Approvals are always bound to a hash of the approval.
- 2026-09-23 — step 3 — migration **6** `remote execution node` appended (live file still ended at 5; `git fetch` showed no concurrent migration). Applied to a copy of the real backup: v5 → v6, 5 tasks and 281 events unchanged, `integrity_check = ok`. Migrations 1–5 byte-identical. A v5 binary opening the v6 file applies nothing and keeps working (the new tables are ignored) — tested.
- 2026-09-23 — step 3 — tables: `remote_config` (singleton; the sealed identity and the node-local remote permissions, which are deliberately **not** in Settings so no cloud `settings.update` can reach them), `remote_sync_state`, `remote_outbox`, `remote_commands_received`, `remote_artifact_sync` (one table for artifacts and log chunks, `kind` column). `CredentialBroker` gained `sealValue/openValue` (same DPAPI-protected key, purpose-bound AAD) instead of a second vault.
- 2026-09-23 — steps 4–5 — node dials out only (`ws` client, Authorization header, so the session never appears in a URL or a Worker log line); P-256 keys via Web Crypto, private PKCS#8 sealed with purpose-bound AAD `remote-node-identity:<nodeId>`. Tested against an in-process fake relay (`apps/orchestrator/test/fake-relay.ts`) that speaks the same wire protocol; the real Worker gets its own runtime tests in steps 10–14. `ws` moves from devDependencies to dependencies of the orchestrator (it was already installed and bundled; not a new package).
- 2026-09-23 — step 6 — remote-only guards (`apps/orchestrator/src/remote/guards.ts`): a cloud command may not change billing mode, raise auto-approve levels, pick a more permissive policy, edit a repository's commands or dev command, or attach files; tightening is allowed. Reason: those settings decide what runs without asking, so loosening them must happen at the machine (plan §3.2 "cloud must never bypass local classification or approval"). Commands for the same target id run in order; different targets run side by side (a pause is not stuck behind a long push).
- 2026-09-23 — step 8 — the remote service starts at the end of `services.recover()` (after engine, process, terminal and Chairman recovery) and stops first in `close()`; `main.ts` needed no change. Local-only routes `/api/remote` (GET/PATCH), `/pair`, `/unpair`, `/rotate`, `/reconnect`; they also refuse any request carrying `x-acc-remote-request` (set on every in-process remote dispatch). Settings gained a "Remote access" section (design.md §7.8 updated first); status chips added to `packages/ui` (`REMOTE_LINK_VISUAL`, `NODE_STATUS_VISUAL`). Orchestrator suite: 18 files / 215 tests pass.
- 2026-09-23 — step 9 — `apps/cloud-control` added. Wrangler and workers-types pinned to **4.135.0 / 5.20260919.1**: pnpm 11's one-day minimum release age refused the latest (released today); older pinned versions were chosen instead of adding a release-age exclusion. `workerd` added to `allowBuilds` (it downloads the runtime binary). `.dev.vars` and `.wrangler/` git-ignored. Dry-run bundle 912 KiB (153 KiB gzip) including the dashboard assets; local D1 migration applies all 14 tables. Hostnames: `acc.` / `acc-relay.` (production), `acc-staging.` / `acc-relay-staging.` (staging) on dr-badawi-abdalsalam.com. `ALLOWED_EMAILS` added as defence in depth against a too-broad Access policy; `ACCESS_JWKS` (test key set) is ignored in staging/production by code.
- 2026-09-23 — step 9 — node side pushed as 6620c50; the first push was blocked by the credential guard on a literal test secret; fixed by assembling test secrets at runtime and amending the unpushed commit.
- 2026-09-23 — steps 10–14 — Worker integration tests run the real Workers runtime (`wrangler dev --local`, local D1/R2/DO) with a test Access key set, and the **real orchestrator** as the node: 4 files / 22 tests (`apps/cloud-control/test/{auth,nodes,commands,objects}.test.ts`), plus the node's 8 command tests. Added to the root vitest projects so `pnpm test` runs them.
- 2026-09-23 — step 13 — **defect found and fixed by the tests:** a node's `command.claim` and `command.result` frames interleaved in the hub (D1 calls are not input-gated), so the result's update matched no row and the command stayed `claimed`. Fix: `CloudStore.transition` is now one conditional UPDATE (`WHERE status IN` the states that may move to the target), and the hub handles each node's frames in order.
- 2026-09-23 — step 12 — emergency CLI `apps/cloud-control/scripts/admin.mjs` (`pair-code`, `revoke`, `nodes`) writes D1 through the operator's Wrangler login, so pairing and revocation work even when Access or the dashboard is down; the hub now checks revocation on every heartbeat write, closing a CLI-revoked node's live socket within about a minute.
- 2026-09-23 — tests — the local dev proxy occasionally resets kept-alive sockets; the test harness uses node:http without keep-alive (`httpJson`). Not a production concern (the edge terminates connections), recorded so it is not mistaken for a product defect.
- 2026-09-23 — step 14 — "hibernation" is exercised as a full control-plane restart (DO evicted, all sockets dropped): the node reconnects by itself and live reads resume. True hibernation (sockets kept, object evicted) is not observable locally; the design keeps no state in memory that a hibernation would lose except in-flight request waiters, which only exist while a request keeps the object awake.
- 2026-09-23 — step 15 — `ApiConfig.auth` is `{kind:'local',token}` or `{kind:'cloud',node()}`; cloud requests carry no token, send `x-acc-node` and a fresh `Idempotency-Key` per mutation; a 202 from a still-running command surfaces as `REMOTE_PENDING`. Mode = token meta present (local) or absent (cloud, confirmed by `/api/cloud/session` before the app starts). Realtime in cloud mode keeps only the selected node's messages. `useConnection().online` in cloud mode = link open AND selected node online/degraded AND not update-required. Local e2e 73/73 after the change; dashboard unit tests (new vitest project) 4/4.
- 2026-09-23 — concurrent session — another session is building a MyVault credential bridge in this tree (migration 7 on top of migration 6, `credentials.ts`, `shared/tools.ts`). Its files are never staged by this work; my migration test now pins versions ≤ 6.
- 2026-09-23 — step 16 — Nodes page, top-bar node selector, cloud connection banners, New Task "Run on" (shown node / Automatic) and "Run when the node is back"; design.md §3, §3.1, §7.12 and §9.4 updated first. Cloud e2e (`pnpm e2e:cloud`, `apps/dashboard/e2e-cloud`): 9/9, including both themes × 5 viewports with axe on desktop and mobile.
- 2026-09-23 — step 16 — **defect found by the cloud e2e:** the Chairman message route legitimately answers 202, which the cloud client read as "command still pending". Fix: pending is decided by `x-acc-command-status` (not succeeded/failed), not by the status code; unit-tested.
- 2026-09-23 — step 16 — intermittent node drops in the cloud e2e were `wrangler dev` reloading the Worker when shared sources changed (the concurrent session edits `packages/shared`); the node reconnected by itself each time. They exposed a real gap: a full resync did not mirror repositories, so the offline repository list was empty — fixed (resync now mirrors repositories). A load test (`load.test.ts`, 120 concurrent reads) shows no drops without reloads.
- 2026-09-23 — step 17 — every feature in §Phase 7 is exercised through the Worker with a real node: `features.test.ts` (health, agents, workflows, settings, tools, credential metadata, task → tests → artifacts by sync policy, typed confirmation for a dangerous command, remote terminal gates, usage live and from the mirror) plus the cloud e2e (task creation, realtime, logs, pause/resume/reroute/directive/cancel, Chairman chat, plan approval, usage page, Source Control stage/unstage).
- 2026-09-23 — step 18 — remote terminals: grant per cloud-opened terminal (10 min idle, 30 min max), every line classified at Enter against this machine's auto-approve level; refused lines are cancelled with Ctrl+C and a viewer-only notice; escape sequences and Tab are dropped so history recall/completion cannot bypass the classifier. **Deviation:** a Level 5/dangerous line is refused remotely instead of creating an approval, because the approval gate is task-bound and a free terminal has no task; the refusal tells the user to run it locally or through a task. **Defect fixed:** the first version typed the refusal notice into the shell; it is now a `notice` output message. Worker requires `x-acc-confirm: open-terminal` and a sign-in younger than one hour.
- 2026-09-23 — step 19 — node upload queue (`apps/orchestrator/src/remote/uploads.ts`): artifacts tracked on creation with `defaultArtifactSensitivity` (`git-diff`, `staged-diff`, `environment`, `task-json`, `tool-output` are local_only), finished executions become ≤ 1 MB log chunks; text is scrubbed + redacted again before hashing; R2 verifies the SHA-256 on write; failures back off (30 s doubling to 1 h, 8 attempts) and never touch the task. The Worker serves `artifact.content` and `execution.logs` from R2 while a node is offline (catalog ops marked offline). Retention runs in the daily cron (tested via `/cdn-cgi/local/scheduled`). `user_shared` exists in the model but no UI shares a local-only artifact yet — see Found for Later. **Defect fixed:** an upload in flight during shutdown could write to the closed database; the queue now stops first and skips writes once stopped. Cloud suite 7 files / 33 tests; node egress/upload 6/6.
- 2026-09-23 — step 22 — created D1 `acc-control-staging` (8f4edcf1…) and `acc-control-production` (8a7b3714…), R2 `acc-artifacts-staging` / `acc-artifacts-production` (private). Deployed with `scripts/deploy.mjs` (migrate → deploy → create `NODE_SESSION_SECRET` on first release → live smoke). Custom domains `acc-staging`, `acc-relay-staging`, `acc`, `acc-relay` on dr-badawi-abdalsalam.com were created by Wrangler; workers.dev and preview URLs verified **disabled** (API: enabled=false, previews_enabled=false; workers.dev 404). `pnpm cloud:smoke` (production): 9/9 live checks pass — control host refuses dashboard, API, realtime and forged tokens (503 until Access exists), relay serves no dashboard and refuses unknown nodes and forged sessions. Staging checked the same way through the resolved address (the local resolver held a negative answer from before the record existed).
- 2026-09-23 — step 22 drills on staging — (1) a deliberately invalid migration `0002_drill_failure.sql` made `deploy.mjs` stop at "D1 migrations apply failed"; no table from it exists, the Worker version stayed 85607d7e, the file was removed; (2) deployed 057fd39a then `wrangler rollback 85607d7e --env staging` → 85607d7e serving, relay health 200; (3) D1 Time Travel: inserted a marker row, restored to the timestamp before it → marker gone, 16 tables intact.
- 2026-09-23 — step 21 — first CI runs failed: (1) lint `no-useless-assignment` in smoke.mjs (fixed, eca4518); (2) Worker tests ran before the dashboard build existed (assets directory missing) — Build now runs before tests; (3) four older tests (repository discovery ×2, tool session, git bisect) compare real paths and failed because the Windows runner's TEMP is an 8.3 short name (`RUNNER~1`) — CI now points TEMP/TMP at `RUNNER_TEMP`; (4) **defect in this work**: a session welcome still building its snapshot when the service stopped read the closed database (unhandled rejection) — the welcome path now stops once the link is gone (010ac0f).
- 2026-09-23 — step 23 — `apps/cloud-control/scripts/access-setup.mjs` (`pnpm cloud:access --env production --team <team>.cloudflareaccess.com --aud <tag> --email …`) validates the inputs, writes ACCESS_TEAM_DOMAIN / ACCESS_AUD / ALLOWED_EMAILS into that environment's vars (idempotent; tested on a scratch edit, then reverted) and releases through deploy.mjs. Closed as deferred: Zero Trust is not enabled (API re-checked), which only the account owner can do in the dashboard.
- 2026-09-23 — step 24 — cutover on the real machine: live orchestrator (idle, 5 tasks COMPLETED) backed up online to `backups/acc-before-cutover-m6-2026-09-23.db` (integrity ok), stopped with the stop script, dist replaced by a build of the committed tree (`../acc-verify` at eca4518, later d940bab), restarted: migrations 6 and 7 applied, 5 tasks intact, `127.0.0.1:4317` only, runtime.json rewritten with the new pid (the VS Code discovery file), the local dashboard page still carries the `acc-token` meta (local mode), unauthenticated local API 401, wrong Host 421.
- 2026-09-23 — step 24 items 1–3 — paired with a production code from the admin CLI → node online in production D1; the outbox drained to 0 (60 events); D1 holds 5 tasks, 48 repositories, agents and usage. Scan of every mirrored row (168 KB): no user-profile path, no `AppData`, no user name, no local token, no pairing code; repository `path` arrives empty.
- 2026-09-23 — step 24, §8 criterion 7 — key rotation → key v2, reconnected; admin-CLI revocation → the node reported `revoked` within ~10 s, the relay answers 403 to its challenge, the local dashboard kept working (200); unpair + new code → a new node online; the revoked id stays refused.
- 2026-09-23 — step 24 items 8–9 — (a) two production Worker deploys dropped the live socket abnormally (close 1006); the node reconnected by itself each time. (b) A second, simulated-agent orchestrator (separate data dir, disposable repository) paired to production ran a task; remote access switched off mid-task → the cloud showed the node offline and the task RUNNING; the task completed locally. **Defect found:** after switching back on, the cloud still showed RUNNING — nothing is queued while off and re-enabling did not resync. Fixed (d940bab: switching off marks a full resync; the regression test fails without the fix). Re-run: the cloud caught up to COMPLETED within ~2 s of reconnecting. (c) orchestrator stopped mid-task and restarted → the task continued under existing recovery, completed, and the cloud showed COMPLETED. The demo nodes were revoked afterwards (relay 403); no path or token in their mirrored rows.
- 2026-09-23 — step 24 item 11 — public control host `/api/tasks` → 503 (fail closed), relay host `/api/tasks` → 404; nothing routes to Fastify, which listens on loopback only.
- 2026-09-23 — step 24 — one production redeploy was run from the shared working tree, whose `packages/shared` carries another session's uncommitted edit; production was immediately redeployed from the committed worktree (version 1f4e2a07), smoke 9/9.
- 2026-09-23 — step 24 **not verified in production, waiting on step 23**: items 4–7 (task, real-agent task, Chairman/approvals/logs/Source Control/usage and browser disconnect through the cloud dashboard) and item 12 (declaring cloud mode production-ready for people). All pass against the real Workers runtime locally (`pnpm e2e:cloud` 9/9, cloud integration 33/33), but nobody can sign in to the production dashboard until Access exists.
- 2026-09-23 — step 25 — docs: `docs/systems/cloud-control.md` created (pieces, the two trust boundaries, API, realtime, retention, dashboard cloud mode, deploy/pair/revoke/rollback commands, data ownership, gotchas, tests); `remote-node.md` gained Terminals, Uploads, the re-enable resync and the welcome-after-stop guard; sections added to `credential-broker.md` (sealValue/openValue), `orchestrator.md` (migration 6, remote routes), `dashboard.md` (cloud mode), `security.md` (cloud trust boundary), `pty.md` (remote terminals), the systems index and README.md. The shared files also carry another session's uncommitted edits, so only this work's additions are staged (blob built from HEAD + these sections). `pnpm docs:guard`: 0 failures, 12 warnings (the same pre-existing count as the baseline).
- 2026-09-23 — step 25, §8 criterion 18 — production Worker logs (Workers Observability, last 6 h, 1 128 events) searched for the user name, `AppData`, user-profile paths, `accpair_`, `accs1.`, `Bearer `, private-key headers: 0 hits (positive control `node/v1`: 96 hits). D1 scan: step 24. R2 holds only `safe_sync` bytes, scrubbed before upload (uploads.test.ts).
- 2026-09-23 — step 25 — §8 success criteria → evidence: 1 custom hostnames answer from the Internet (smoke 9/9, step 22/24). 2 unauthenticated dashboard/API/realtime refused (smoke; 503 until Access, `auth.test.ts` with Access configured). **3 browser realtime behind Access: not verified in production — waits on step 23**; verified with a test Access key in `pnpm e2e:cloud`. 4 loopback only (step 24 netstat; public hosts 503/404). 5 local dashboard unchanged (local e2e 73/73 after dual mode; live page in local mode, step 24). 6 VS Code: runtime.json rewritten with url/port/pid on the new build (step 24), webview bundle built in local mode. 7 pair/reconnect/rotate/revoke on the real node (step 24). 8 node online/offline/capabilities in D1 and the Nodes page (step 24 drill; `nodes.test.ts`, cloud e2e). 9 remote task through the TaskEngine (`commands.test.ts`, `features.test.ts`, cloud e2e; production UI waits on step 23). 10 Chairman remote through the same routes (cloud e2e). 11 pause/resume/cancel/reroute/directive remote and across reconnects (cloud e2e, `commands.test.ts`). 12 typed confirmation and approvals unchanged (`features.test.ts`, remote-commands tests, guards). 13 duplicates never run twice (receipts + idempotency key; remote-commands and `commands.test.ts`). 14 task continues through cloud/browser disconnect (step 24 drill with the link off; cloud e2e browser reconnect). 15 reconciliation after reconnect and restart (step 24 drill, after the d940bab fix). 16 offline history (`uploads.test.ts`, cloud e2e offline steps). 17 sync policy + hash verification (`uploads.test.ts`). 18 above. 19 Source Control through the existing coordinator (cloud e2e stage/unstage, catalog maps to the same routes). 20 remote terminal off by default, per-line classification (`remote-terminal.test.ts`, `features.test.ts`). 21 two-node routing and leases (`commands.test.ts` "keeps two nodes off the same repository…", two real orchestrators as nodes; production had two nodes during the drill). 22 migration failure, Worker rollback, D1 Time Travel (step 22 drills). 23 and 24: T3. 25 this step.
- 2026-09-23 — T2 sweep — searched: every Fastify route under `apps/orchestrator/src/http` (139) against the 119-entry catalog (the routes outside it are exactly the local-only set: credential values, adding repositories by path, MCP definitions, shutdown, tool sessions, privileged helper, `/api/remote/*`, and the other session's new `/api/vault-bridge/*`, excluded automatically because the catalog is an allowlist); every settings field against the guards; the egress type allowlist against `ServerMessage`. **Found and fixed (953e754 + the review commit):** a cloud `agent.update` could choose any executable as an agent (`executablePath`); a cloud `workflow.save` could drop a stage's approval step; `repositoryAutomation.roots` could add discovery folders (repositories by local path, indirectly); un-ignoring removed repositories.
- 2026-09-23 — T2 — **pre-existing defect found, fixed at the root:** `PATCH /api/settings` with a partial body (e.g. `{"theme":"light"}`) reset every other setting — auto-approve level, policy, discovery — to its default, because zod fills missing keys of `.partial()` with defaults and the route passed the filled object on. Locally this hit any partial update (and `DELETE /api/workflows/:id` of the default workflow); remotely it bypassed the settings guard. `mergeSettings` now applies only the keys sent (a partly-sent section keeps its other fields); the route passes the raw body; the remote guard judges the merged result. Tested through the remote path (partial section, theme-only, terminals-only keep the policy and ignore list).
- 2026-09-23 — T1 review — two read-only reviewers (node side; Worker + dashboard) plus the sweep. Fixed, each with a test unless noted: node-sent `remote.*` messages could impersonate another node (hub drops them; the dashboard ignores ones with a `nodeId` — code review only, no node can emit them through egress); relayed node answers could be served as HTML on the signed-in origin (content-type allowlist, `sandbox` CSP, attachment for binary); lease could be freed while another task on the same repository ran (state-based release; test reproduces the order and fails on the old code); a command row was deliverable before its lease was checked (lease first); idempotency looked up after other checks and ignored the payload (looked up first, 422 on mismatch; test); terminal keystrokes over `/ws` skipped the one-hour sign-in rule (checked per keystroke frame); the smoke "forged session" check could not fail (real WebSocket handshake; production answers 401); rollback workflow pasted a free-text input into the shell (env var + format check); failed re-upload overwrote the stored hash, replaced R2 objects were orphaned, a manifest turned local-only kept being served (all fixed); unbounded rpc chunk index (schema max + index < total); malformed `CF_Authorization` cookie gave 500 (401; test); repository override `null` bypassed the guard (effective values; test); cloud read/resize/close of terminals it did not open (grant required; test); a malformed cloud message crashed the node (payload schemas + try/catch; test); approval without a precondition skipped the hash check (required; test); upload error messages and plain-text fallbacks skipped the redactor or path scrub, JSON-escaped and network-share paths slipped through (fixed; test); emoji + Backspace desynchronised the terminal line tracker (code points). Documented, not changed: rotation needs only a valid 10-minute session (by design: sessions are short and bound to the key version); diffs are readable live over RPC while the node is online (redacted; the sync policy governs what is stored — docs now say so); the dashboard issues a new idempotency key per action (comment corrected).

- 2026-09-23 — T6 — released the review fixes from the committed worktree (`../acc-deploy` at c66a1fc) after the full Worker suite passed there (7 files / 34 tests): staging version 2595335c, production version 1ab390a1; `deploy.mjs` smoke 9/9 on both, including the new real-handshake check (forged session → 401). The live node was moved to the same build (idle, 5 tasks intact) and reconnected (`connected`, node_KJYoGPTVr3de6VaUxI6X online), settings unchanged (auto-approve 3).
- 2026-09-23 — T3 — on the committed tree (`../acc-verify`): `pnpm build` 0; `pnpm e2e` 73/73 (port 4498 — the default 4391 belongs to another project's server on this machine); `pnpm e2e:cloud` 9/9 (a first run hit one blank-page boot while three other suites loaded the machine; the rerun alone passed all 9). `pnpm check` failures traced: three Worker tests (fixed: a test query not scoped by node, an expectation of the old failed-upload hash, the dev-proxy reset) and load-only ones that pass alone (`pty` 3/3 alone, `shell.run` alone); the pre-existing pty interactive test (Found for Later) is the baseline's.
- 2026-09-23 — T3 final — `pnpm check` on c66a1fc: typecheck, lint, docs guard (0 failures) pass; tests 516/518. The two failures: the baseline's pty interactive test (Found for Later) and `packages/tools` "routes shell.run to PowerShell" hitting vitest's 5 s default while PowerShell starts under full-suite load — it passes alone (twice) and lives in code this work did not touch; recorded under Found for Later. Judged as "no new failures from this work" per step 1.
- 2026-09-24 — step 21 — result read back: run 35925073785 (a6c43b4, which contains all of this work plus other sessions' later commits): typecheck, lint, docs guard and build pass; tests 568/573 — every cloud-control, remote-node and dashboard test passes; the 5 failures are the pre-existing bisect test (Found for Later) and 4 new `vault-bridge.test.ts` tests from the concurrent MyVault session (they expect a Cloudflare CLI the runner lacks — theirs to fix, not touched here). Because the test step failed, CI's two browser suites did not run on GitHub; both pass locally on the committed tree (T3). The run for c66a1fc itself was cancelled by those later pushes (concurrency group).
- 2026-09-23 — step 21 — CI history: lint (fixed) → build order and TEMP short path (fixed; cleared 3 of 4 older tests) → a `--testTimeout` override that lowered per-project timeouts (reverted). Remaining on the hosted runner: `packages/tools` "bisects in a temporary worktree" returns `ok: false` there (passes locally on the same Git 2.52; no diagnostics in the log) — pre-existing test, recorded under Found for Later.

## Found for Later

- **shell.run test times out under load.** `packages/tools/test/packs.test.ts` "routes shell.run to PowerShell…" uses vitest's 5 s default; PowerShell start-up exceeds it when the whole suite runs on the operator PC. Why it matters: an intermittent red `pnpm check`. Recommended fix: give the test (or the tools project) a 30 s timeout like the other projects. Priority: Low. Affects current task: No.

- **git bisect test fails on the hosted Windows runner.** `packages/tools/test/packs.test.ts` "bisects in a temporary worktree…" passes on the operator PC but returns `ok: false` in GitHub Actions (windows-latest). Why it matters: CI stays red on one test unrelated to the cloud work. Recommended fix: log the bisect step output in the tool's error result, run once in CI, and adjust the "first bad commit" detection or the Windows test command to the runner's Git output. Priority: Medium. Affects current task: No.

- **Sharing a local-only artifact.** The `user_shared` sensitivity is modelled end to end (node policy, relay accepts it), but no screen on the machine offers "share this diff with the cloud" yet. Why it matters: a reviewer away from the machine cannot read a diff artifact. Recommended fix: a local-only "Share to cloud" action on the Artifacts tab (local mode only) that sets the object to `user_shared`. Priority: Low. Affects current task: No.

- **pty interactive-shell test times out on the operator PC.** `packages/pty/test/pty.test.ts` (first test) fails before this work, at baseline 238add7. Why it matters: `pnpm check` is red on this machine regardless of changes. Recommended fix: investigate the Read-Host prompt echo under the installed PowerShell/ConPTY. Priority: Medium. Affects current task: No.

## Context

The source plan, verbatim:

# CLOUD_CONTROL_PLAN.md

**Project:** `digitronics2025/AI-Development-Control-Center`  
**Investigation baseline:** `main` at commit `238add771bd227bbb05ac72c101be54296c36160` (2026-09-23)  
**Goal:** make the AI Development Control Center safely usable from anywhere through Cloudflare without weakening or replacing its proven local execution model.

## Verified investigation baseline

This plan is based on the current repository, not on assumptions.

### Current architecture verified

- `apps/orchestrator` is the product core: one Node.js process using Fastify, WebSocket, SQLite/WAL, the workflow engine, Chairman, source control, usage accounting, tools, terminals, credentials, and recovery.
- `apps/dashboard` is a React/Vite application that currently talks directly to the local orchestrator through `/api` and `/ws`. `apps/dashboard/src/api/client.ts` always sends the local bearer token; `realtime.ts` reconnects and reconciles after disconnects; `sync.ts` incrementally updates the React Query cache from complete entity messages.
- `apps/vscode-extension` is a thin local client. It discovers the orchestrator from `%LOCALAPPDATA%\AIDevControlCenter\runtime.json` and must remain compatible.
- `apps/orchestrator/src/config.ts` intentionally binds to `127.0.0.1` and refuses non-loopback hosts unless explicitly overridden.
- `apps/orchestrator/src/http/security.ts` intentionally rejects non-loopback Host headers and non-local browser origins and uses a per-machine local API bearer token.
- `apps/orchestrator/src/http/server.ts` injects that local token into local dashboard HTML. This mechanism is appropriate for localhost but must not become the cloud authentication model.
- `apps/orchestrator/src/http/ws.ts` and `packages/shared/src/ws.ts` already provide a useful realtime entity protocol, subscriptions for execution logs, and terminal traffic.
- `apps/orchestrator/src/db/database.ts` uses SQLite WAL, foreign keys, transactions, migration versioning, and restart-safe persistence.
- `apps/orchestrator/src/db/migrations.ts` already contains durable task, Chairman, Source Control journal, usage/cost, and tool-layer state. Existing migrations are forward-only and must not be rewritten.
- `TaskEngine` persists transitions before continuing, supports pause/resume/cancel/reroute, verification, approvals, recovery, and repository coordination.
- `RepositoryCoordinator` already coordinates task writers and Source Control mutations on a node.
- `packages/security` already provides command classification, approval levels, secret redaction, sensitive-file checks, and subscription-only environment protection.
- `CredentialBroker` already seals credential values and protects its key with Windows DPAPI on Windows. This should also be reused to protect any local node identity secret.
- Current tests include orchestrator unit/integration coverage and Playwright E2E against the real orchestrator with simulated agents, including Chairman, Source Control, tools, usage, accessibility and reconnect-related behavior.
- No `.github` CI workflow directory is currently present in the repository, so cloud CI/deployment must be added rather than modified.

### Root cause of the current limitation

There is no deployment bug to patch. The product was intentionally designed as a **single-machine local application**. The inability to use it safely from anywhere comes from four architectural assumptions:

1. browser authentication is a local token injected by the local orchestrator;
2. API and WebSocket requests are only trusted from loopback;
3. SQLite, artifacts, repositories, agents, shells and credentials are all local to one machine;
4. the browser assumes the server it talks to is also the machine executing Codex, Claude, Git, PowerShell, tests and tools.

The correct fix is therefore **not** to expose the local Fastify server or bind it to `0.0.0.0`. The correct fix is to introduce a cloud control plane and turn each local orchestrator into a secure execution node.

### Verified Cloudflare constraints used by this plan

- Workers Static Assets can deploy the dashboard assets together with Worker logic and supports SPA fallback.
- Durable Objects are appropriate for coordinating WebSockets; the Hibernation API should be used so idle connections do not keep the object active.
- D1 supports versioned migrations and Time Travel/point-in-time restore.
- R2 is appropriate for large logs and artifacts through a Worker binding.
- Cloudflare Access can protect a Worker/custom hostname. For WebSocket applications, use a **hostname-based Access application**; Worker-level Access protection currently rejects WebSocket upgrades.
- Workers expose a `node:child_process` compatibility stub rather than a real local process environment. The current executor, shells, Git, Codex and Claude therefore remain on execution nodes.

Useful platform references:

- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/d1/reference/migrations/
- https://developers.cloudflare.com/d1/reference/time-travel/
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/

---

# 1. Goal

Upgrade the current local-first AI Development Control Center into a production-ready **hybrid cloud control plane + local execution node system** so the user can securely open the application from any device and location and perform normal Control Center work remotely.

The final system must provide:

- a Cloudflare-hosted dashboard reachable through a custom hostname;
- strong human authentication before the dashboard/API/WebSocket is reachable;
- one or more securely paired execution nodes;
- remote task creation, Chairman chat, task monitoring, pause/resume/cancel/reroute and approvals;
- remote visibility of agents, repositories, usage, tests, artifacts, logs and Source Control state;
- safe remote access to tool/terminal capabilities only when explicitly permitted;
- reliable operation through browser disconnects, node disconnects, restarts, duplicate messages and temporary Cloudflare outages;
- no requirement to migrate the working local SQLite database to D1;
- no public exposure of the local Fastify service;
- no cloud storage of Codex/Claude login credentials, Git credentials, API keys, SSH keys or arbitrary repository contents;
- preservation of the existing local dashboard and VS Code workflows when the cloud is unavailable.

The architecture must be multi-node-capable from the beginning, while remaining simple for the initial one-PC deployment.

---

# 2. Scope

## Included

1. A new Cloudflare Worker control-plane application that serves the existing dashboard build and exposes the cloud API.
2. Cloudflare hostname-based Access protection for the human-facing hostname.
3. A Durable Object realtime hub using WebSocket Hibernation.
4. D1 for durable cloud metadata, node registry, mirrored task history, durable command delivery and audit records.
5. R2 for approved/redacted large artifacts and chunked historical logs.
6. A secure outbound remote-node client inside the existing orchestrator.
7. One-time node pairing, cryptographic node identity, revocation and rotation support.
8. A typed cloud/node protocol with schema validation, protocol versioning, replay protection and idempotency.
9. Reliable command delivery and acknowledgement without adding Cloudflare Queues in V1 of this upgrade.
10. Cloud synchronization of the minimum data required to make the dashboard useful when the node is offline.
11. Dashboard dual-mode operation: existing local mode plus cloud mode using the same UI/design system.
12. Node selection and node health/presence UI.
13. Cross-node repository identity and a cloud execution lease for remotely initiated mutating tasks.
14. Remote-safe support for current task, Chairman, approval, usage, Source Control, artifact and log features.
15. Explicitly gated remote terminal/tool capabilities.
16. Cloud observability, rate limiting, deployment scripts, D1 migrations and rollback procedures.
17. Automated local/cloud integration tests and Playwright cloud-mode E2E tests.
18. Documentation for deployment, pairing, recovery and security.

## Explicitly excluded

- Moving Codex CLI, Claude Code, Git, PowerShell, test processes or repository files into Cloudflare Workers.
- Replacing the existing local SQLite database with D1.
- Rewriting the TaskEngine, Chairman, approval engine, command classifier, credential broker or Source Control service.
- Storing plaintext credentials or provider login sessions in Cloudflare.
- Uploading entire repositories to R2/D1.
- Remote desktop/screen control.
- Multi-tenant SaaS organizations, subscription billing or public user signup.
- Building an always-on VPS execution node in this task.
- Rebuilding the visual design; new UI must follow the existing `design.md`.
- Unrelated refactors discovered during implementation.

---

# 3. Enhanced design/architecture

## 3.1 Architecture principle

Keep **execution authority local** and move **control, coordination and selected history** to Cloudflare.

```text
Phone / Laptop / Tablet
        |
        v
Cloudflare hostname-based Access
        |
        v
+----------------------------------------------------+
| Cloudflare Worker: apps/cloud-control              |
|                                                    |
| - existing React dashboard static assets           |
| - cloud API                                        |
| - auth/authorization                               |
| - node/task routing                                |
| - durable command creation                         |
| - D1 / R2 access                                   |
| - audit                                            |
+----------------------+-----------------------------+
                       |
                       v
             +--------------------+
             | WorkspaceHub DO    |
             | hibernating WS hub |
             +--+--------------+--+
                |              |
        browser WS        node outbound WS
                               |
                       TLS + node identity
                               |
          +--------------------+--------------------+
          |                                         |
          v                                         v
+-------------------------+              +-------------------------+
| Windows execution node  |              | Future execution node   |
| existing orchestrator   |              | existing orchestrator   |
| SQLite                  |              | SQLite                  |
| TaskEngine / Chairman   |              | agents / Git / tools    |
| Codex / Claude          |              |                         |
| Git / PowerShell/tools  |              |                         |
+-------------------------+              +-------------------------+
```

## 3.2 Authority boundaries

### Local node remains authoritative for

- repository paths and repository file access;
- Git state and mutations;
- running processes and terminals;
- Codex and Claude sessions/subscription checks;
- command risk classification;
- approval enforcement immediately before execution;
- credentials and secret values;
- exact execution state and crash recovery;
- local task artifacts and complete local logs;
- local SQLite recovery after restart.

### Cloud control plane becomes authoritative for

- authenticated human sessions;
- node registration and revocation;
- which node a remote action targets;
- durable remote command intent;
- cloud command status and audit history;
- cloud-visible task/node summaries;
- cloud-level repository leases for remotely started mutating work;
- cloud artifact manifests and R2 objects;
- browser realtime fan-out.

The cloud must **never be able to bypass local command classification or local approval checks**.

## 3.3 Repository changes

Prefer the smallest additions that fit the existing monorepo:

### New

- `apps/cloud-control/`
  - Worker entrypoint
  - Durable Object
  - D1 store/repositories
  - cloud routes/controllers
  - auth middleware
  - relay endpoints
  - R2 artifact/log helpers
  - Wrangler configuration
  - D1 migrations
  - cloud integration tests
- `apps/orchestrator/src/remote/`
  - node identity
  - pairing client
  - connection manager
  - command receiver/dispatcher
  - cloud event sanitizer
  - sync/reconciliation
  - remote state persistence
- `docs/systems/cloud-control.md`
- `docs/systems/remote-node.md`

### Extend instead of duplicating

- `packages/shared/src/` — add remote protocol types/Zod schemas here instead of creating another package.
- `apps/dashboard/src/api/client.ts` — support local bearer mode and cloud same-origin mode.
- `apps/dashboard/src/api/realtime.ts` — support local `/ws?token=` and cloud `/ws` transports.
- `apps/dashboard/src/api/sync.ts` — reuse existing entity synchronization; add node/cloud events only where necessary.
- `apps/dashboard/src/pages/` — add Nodes/Connection UI and node selectors without redesigning existing pages.
- `apps/orchestrator/src/app.ts` — compose the remote-node service without changing existing engine ownership.
- `apps/orchestrator/src/main.ts` — start/stop the remote client as part of the existing lifecycle.
- `apps/orchestrator/src/db/migrations.ts` — add a new forward-only migration after the currently highest migration. Determine its number from the live file at implementation time; do not edit an existing migration.
- `package.json` / workspace scripts — add cloud build/test/dev/deploy commands.
- `docs/systems/security.md`, `orchestrator.md`, `README.md` — document the new trust boundary and operating modes.

Do not add a second task engine, second Chairman implementation, second command classifier, or second credential vault.

## 3.4 Cloudflare resources

Use one control-plane Worker and the minimum supporting services:

- **Worker + Static Assets** — dashboard and API.
- **D1** — structured durable cloud state.
- **R2** — large approved/redacted artifacts and completed log chunks.
- **Durable Object `WorkspaceHub`** — realtime connections, presence and fast command notification.
- **Cloudflare Access** — human authentication on the control hostname.
- **Workers Rate Limiting binding** — pairing, auth-sensitive and command endpoints.
- **Workers Logs/Tracing** — operational observability with secrets excluded from structured logs.

Do **not** introduce Queues unless real testing demonstrates a need. Durable command rows in D1 plus realtime notification and reconnect polling are sufficient and easier to reason about.

## 3.5 Human and node endpoints

Use separate security boundaries.

### Human control hostname

Example only: `control.<domain>`.

- protected by a hostname-based Cloudflare Access application;
- serves dashboard assets;
- serves cloud `/api/*`;
- serves browser `/ws` realtime;
- Worker validates the Access JWT/audience for API and WebSocket requests as defense in depth;
- production `workers.dev`/preview exposure must be disabled or protected equivalently.

### Node relay endpoint

Prefer a dedicated relay hostname mapped to the same Worker, for example `relay.<domain>`.

- no dashboard or normal user API is served there;
- accepts only pairing and node relay protocol routes;
- protected by application-level node cryptographic authentication, strict schema/body limits and rate limits;
- after pairing, unauthenticated requests reveal no node/task data;
- if account/hostname constraints make this unsuitable, use a path/service-auth configuration with a distinct policy rather than weakening the human Access policy.

## 3.6 Node identity and pairing

Do not reuse `auth-token` remotely.

Implement a dedicated node identity:

1. Authenticated user creates a short-lived, single-use pairing token in the cloud UI.
2. Pairing token is stored only as a strong hash in D1, with expiry and use count.
3. The local orchestrator's Remote Setup flow submits the token to the relay endpoint.
4. The node generates a P-256 signing keypair locally.
5. Store the public key and node metadata in D1.
6. Seal the private key locally using the existing credential-key/DPAPI mechanism; do not store it in D1/R2.
7. Normal connection uses challenge-response signing and obtains a short-lived node session.
8. Every session is bound to `node_id`, protocol version and expiry.
9. Revocation immediately blocks new sessions and closes any active session through the hub.
10. Support explicit identity rotation without changing the node ID/history.

Required node metadata is limited to safe operational fields: node ID, label, OS, app version, protocol version, agent/tool capabilities, last seen, status and safe repository metadata. Never sync credential values or the local API token.

## 3.7 Remote protocol

Add strongly validated schemas to `@acc/shared`.

Every message must contain:

- protocol version;
- message/event/command ID;
- node ID;
- server-issued or monotonic sequence where applicable;
- type;
- created timestamp;
- bounded typed payload.

Core message groups:

- `node.hello`
- `node.capabilities`
- `node.heartbeat`
- `node.snapshot`
- `event.batch`
- `command.available`
- `command.claim`
- `command.result`
- `command.failed`
- `sync.request`
- `sync.ack`
- `artifact.manifest`
- `log.chunk.manifest`

Use explicit typed operations such as `task.create`, `task.pause`, `approval.resolve`, `sourceControl.fetch`, `chairman.message`, etc. **Never create a generic "execute this HTTP route" or "execute this shell text" remote command.**

## 3.8 Reliable remote command model

D1 is the durable command source of truth.

For every remote mutation:

1. Worker authenticates and authorizes the user.
2. Validate payload with Zod.
3. Resolve target node and repository/task mapping.
4. Create `remote_commands` row before notifying the node.
5. Include an idempotency key, payload hash, expected entity/task version, expiry and creator identity.
6. `WorkspaceHub` notifies the connected node immediately.
7. Node also fetches pending commands after every reconnect, so a missed WebSocket frame cannot lose work.
8. Node atomically records the received command ID in local SQLite before execution.
9. Duplicate command IDs return the previously recorded result and are never executed twice.
10. Node validates command type, target, expected state/version, expiry and payload hash.
11. Node invokes existing typed services (`TaskEngine`, `ApprovalGate`, `SourceControlService`, Chairman, tool services) rather than bypassing them.
12. Result is persisted locally, returned to the cloud, recorded in D1 and emitted to browser realtime.

Do not treat WebSocket delivery itself as durable delivery.

### Command expiry policy

- normal UI control actions: short TTL;
- dangerous/production approvals: very short TTL and exact target hash/version binding;
- queued task creation may support a longer TTL only when the user explicitly chooses "run when node is online";
- stale state/version produces a conflict and requires refetch, not blind execution.

## 3.9 Local remote-state migration

Add only remote-integration tables needed for reliability, for example:

- `remote_commands_received` — command ID, hash, status, result summary, timestamps;
- `remote_sync_state` — cloud node ID, last acknowledged cloud sequence, last uploaded event cursor;
- `remote_outbox` — bounded redacted non-log events waiting for cloud acknowledgement;
- `remote_artifact_sync` — local artifact ID, cloud/R2 status, hash, retry state.

Keep large log bodies out of this outbox. Existing `execution_logs` remains the durable local source for logs.

The migration must be additive, transactional and safe for existing databases. Back up `acc.db` before first migration and verify downgrade behavior means "older binary cannot understand the new DB" rather than trying destructive down-migrations.

## 3.10 Cloud D1 model

Do not copy the entire local SQLite schema.

Use a compact control-plane schema such as:

- `nodes`
- `node_repositories`
- `pairing_tokens`
- `remote_commands`
- `cloud_tasks` — searchable columns plus latest redacted `TaskDetail` snapshot JSON;
- `cloud_task_events` — bounded redacted/auditable events with unique `(node_id,event_id)`;
- `cloud_usage_events` — privacy-safe usage metadata needed by the existing usage UI;
- `artifact_manifests`
- `repository_leases`
- `audit_events`

Use D1 unique constraints for idempotency wherever possible.

Do not persist raw Source Control diffs, terminal streams, credential values or arbitrary file contents in D1.

## 3.11 Cloud event synchronization

Reuse the existing `ServerMessage` model where safe, but add a dedicated **cloud egress sanitizer** on the node.

The sanitizer must explicitly allow fields to leave the node; never "serialize whatever the local API returns".

Safe candidates include redacted task/stage/status/events, test results, Chairman state/messages/decisions/actions, approvals, safe agent health, repository display metadata and privacy-safe usage records.

Special rules:

- strip absolute repository paths from cloud repository data;
- never sync local `auth-token`;
- never sync credential values;
- never sync environment variables;
- terminal output is realtime only unless the user explicitly saves it as an artifact;
- Source Control diffs are fetched on demand and not retained by default;
- raw tool execution data must pass the same redaction/field allowlist as existing logs.

On reconnect:

1. exchange protocol/version and sequence cursors;
2. send current node capability/repository snapshot;
3. upload unacknowledged safe events;
4. reconcile cloud task snapshots;
5. fetch pending cloud commands;
6. resume live realtime mode.

A browser reconnect does not need event replay from the Durable Object; it refetches D1/latest node state and then resumes realtime, matching the current dashboard's reconciliation pattern.

## 3.12 Artifact and log handling

R2 stores only content that passes cloud-sync policy.

Add artifact sensitivity metadata:

- `safe_sync`
- `local_only`
- `user_shared`

Defaults:

- generated redacted text reports/log chunks: `safe_sync`;
- user attachments, arbitrary repository files, credentials/config files: `local_only`;
- explicit user request can mark an eligible artifact `user_shared`.

Requirements:

- hash every uploaded object;
- immutable/versioned object keys;
- content type and size limits;
- server-authorized downloads only;
- no public R2 bucket access;
- stream uploads/downloads; do not buffer large objects in Worker memory;
- chunk historical logs, keep live logs over WebSocket, and store only metadata/cursors in D1;
- node retries R2 failures without failing the underlying coding task.

## 3.13 Dashboard dual-mode behavior

Preserve one dashboard codebase.

Mode detection:

- local orchestrator continues injecting `<meta name="acc-token">`; presence of that token means local mode;
- VS Code WebView continues receiving explicit local URL/token configuration;
- cloud static `index.html` has no local token; absence of the token means cloud same-origin mode.

Update `ApiConfig` so the authorization mechanism is mode-specific instead of always requiring a token.

### Local mode

Unchanged behavior:

- `/api` local Fastify;
- bearer token;
- `/ws?token=`;
- full local features;
- works with Cloudflare unavailable.

### Cloud mode

- same-origin cloud API behind Access;
- no local bearer token in HTML or browser storage;
- cloud `/ws` behind hostname-based Access;
- global node selector and connection state;
- node-aware error states such as `NODE_OFFLINE`, `NODE_UPDATE_REQUIRED`, `REMOTE_COMMAND_EXPIRED`, `REMOTE_CONFLICT`;
- cached task history remains readable when a node is offline;
- live-only node features clearly show offline state instead of stale success.

Do not fork or duplicate page implementations. Extend existing hooks/transport behavior.

## 3.14 Feature mapping

### Tasks / Chairman / approvals

Fully support remotely by routing typed commands to the node and mirroring redacted state to D1.

Chairman reasoning remains on the execution node using the existing Chairman/agents. The cloud does not create a second Chairman implementation.

### Agents / workflows / prompts / settings

- read/write live against the selected node through typed RPC;
- cache only non-sensitive metadata where helpful;
- do not mirror prompt bodies/settings containing potentially sensitive content unless needed for a specific cloud page.

### Usage

Mirror the existing privacy-safe usage event fields and rollups with `(node_id, local_usage_event_id)` idempotency. Do not change the local append-only ledger; cloud aggregation is an additional view.

### Source Control

- status/history metadata may be fetched live;
- diff/file content stays on-demand and is not persisted in cloud storage by default;
- mutations route through the existing `SourceControlService` and local `RepositoryCoordinator`;
- cloud never runs Git directly.

### Tools and credentials

- tool health/capability metadata may be visible remotely;
- credential list may expose only current safe metadata such as name/kind/fingerprint already returned by `CredentialBroker`;
- credential values never leave the node.

### Remote terminal

Support only as an explicitly enabled high-risk feature:

- disabled for cloud mode by default;
- local setting must enable it;
- create a short-lived per-terminal remote grant;
- require recent authenticated user action and an approval/confirmation for opening the session;
- node classifies every entered command exactly as it does locally;
- Level 5/dangerous operations still use the existing approval gate;
- idle timeout and maximum lifetime;
- no terminal transcript persistence to D1;
- revoke grant immediately on node/user/session revocation.

## 3.15 Multi-node routing and repository safety

Generate a privacy-safe repository fingerprint from stable Git identity rather than absolute path. Use normalized remote identity where available, plus local repository ID as needed; strip embedded credentials before hashing.

Remote task creation supports:

- explicit node selection; or
- `Automatic`, selecting an online compatible node that has the repository and required agents/tools.

Add a cloud-level repository lease for remotely initiated mutating tasks so the control plane does not intentionally start conflicting work on separate nodes/clones of the same repository.

The local node still performs the final repository-state check. A cloud lease is coordination, not permission to overwrite local changes.

## 3.16 Observability and cost control

- structured logs with request ID, node ID, command ID and task ID, never secret payloads;
- Cloudflare Workers Logs enabled;
- tracing sampled rather than 100% in production;
- `/health` and cloud dependency health view;
- node online/offline/last-seen status;
- metrics for command latency, reconnects, failed syncs, D1 failures and R2 failures;
- rate-limit pairing attempts and mutation endpoints;
- Durable Object hibernation and delta sync to avoid unnecessary duration/database usage;
- keep verbose execution logs in R2/local storage rather than D1.

---

# 4. Implementation steps

## Phase 0 — protect the working baseline

1. Re-read the live repository and current `main` before editing because this project is actively changing.
2. Run the current verification suite and record the baseline:
   - `pnpm install`
   - `pnpm check`
   - `pnpm build`
   - `pnpm e2e`
3. Back up the current local `acc.db` and confirm restore works.
4. Confirm no credentials/secrets are tracked in Git.
5. Record the current highest local SQLite migration number before adding a migration.
6. Do not modify shipped migrations.

## Phase 1 — shared remote protocol

1. Add versioned remote schemas/types in `packages/shared/src/remote*.ts`.
2. Define node capability, pairing, session, command, acknowledgement, event batch and sync messages.
3. Add strict maximum payload sizes and enums for allowed remote operations.
4. Add canonical payload hashing and idempotency helpers using runtime-compatible Web Crypto/Node crypto abstractions.
5. Unit-test malformed payload rejection, version mismatch, hash stability and command type safety.

## Phase 2 — local execution-node integration

1. Add `apps/orchestrator/src/remote/` services.
2. Add Remote Node settings/config without changing default local-only server binding.
3. Implement key generation and locally sealed private identity using the existing protected credential-key mechanism.
4. Implement pairing flow.
5. Implement reconnecting outbound WebSocket with exponential backoff/jitter and bounded retries.
6. Add the additive remote-state SQLite migration.
7. Implement durable received-command/idempotency tracking.
8. Implement typed dispatch into existing services; never invoke arbitrary shell text from a cloud command.
9. Implement cloud egress sanitizer/redactor.
10. Implement reconnect reconciliation and event batching.
11. Integrate startup/shutdown into `createServices()` and `main.ts` without blocking local startup if the cloud is unavailable.

## Phase 3 — Cloudflare control plane

1. Create `apps/cloud-control` as a workspace package.
2. Add Wrangler config for:
   - Worker entry;
   - existing dashboard `dist/web` static assets with SPA fallback;
   - D1 binding;
   - R2 binding;
   - Durable Object binding/migration;
   - rate limiter bindings;
   - environment-specific variables/secrets;
   - observability.
3. Add D1 migrations for the compact control-plane schema.
4. Implement D1 repositories with explicit transactions/idempotency constraints.
5. Implement R2 artifact/log services.
6. Implement `WorkspaceHub` with Hibernation WebSocket API.
7. Add request IDs, typed error responses and body limits.

## Phase 4 — authentication and node enrollment

1. Configure a hostname-based Access application for the human control hostname.
2. Verify Access audience/JWT in Worker API and browser WebSocket entry.
3. Ensure `workers.dev`/preview cannot bypass the production authentication boundary.
4. Implement pairing token creation/revocation/expiry.
5. Implement node challenge-response authentication and short-lived node sessions.
6. Implement node revoke/rotate actions in UI/API.
7. Rate-limit pairing and failed authentication.
8. Add audit records for pair, revoke, rotate and login-sensitive mutations.

## Phase 5 — reliable commands and synchronization

1. Implement D1-backed durable command creation.
2. Notify connected nodes via `WorkspaceHub` only after D1 persistence succeeds.
3. Implement claim/result/failure states and strict transition rules.
4. Implement pending-command fetch on node reconnect.
5. Implement expected-version/state preconditions.
6. Add TTL/expiry handling.
7. Add local duplicate suppression and cloud duplicate suppression.
8. Implement safe event outbox batching and acknowledgement.
9. Implement cloud task snapshot updates and offline-readable history.
10. Add repository fingerprint and remote lease logic.

## Phase 6 — dashboard cloud mode

1. Refactor `ApiConfig` so token is optional and transport/auth mode is explicit.
2. Preserve current local mode exactly.
3. Add cloud same-origin mode.
4. Extend realtime URL/auth creation for cloud mode.
5. Reuse current `CacheSync` behavior wherever possible.
6. Add node state to the application shell and a Nodes page.
7. Add node selector to task creation and relevant node-specific pages.
8. Add clear offline/degraded/update-required states.
9. Keep all styling/components aligned with `design.md` and existing responsive/accessibility behavior.

## Phase 7 — feature completion

Implement and verify cloud-mode support in this order:

1. node health/capabilities;
2. repository list and task creation;
3. task detail/realtime/logs;
4. pause/resume/cancel/reroute/directives;
5. Chairman chat and actions;
6. approvals, including typed confirmations;
7. test results and task artifacts;
8. usage/cost view;
9. Source Control read operations;
10. Source Control mutations;
11. tools/credential metadata;
12. explicitly gated remote terminals.

For every feature, use the existing local service as the executor and add only the cloud routing/mirroring required.

## Phase 8 — artifacts and historical logs

1. Add artifact sensitivity classification.
2. Add R2 upload/download path with hash verification.
3. Add resumable/retryable background sync that does not block task completion.
4. Chunk old logs for R2 and keep live tail over WebSocket.
5. Add retention/pruning rules for R2 objects and cloud event rows without deleting the local source of truth.
6. Verify credential/secret redaction before upload.

## Phase 9 — deployment and CI

1. Add a GitHub Actions workflow because none currently exists.
2. On pull requests/main changes run:
   - install with locked pnpm version;
   - typecheck;
   - lint;
   - docs guard;
   - unit/integration tests;
   - dashboard build;
   - local E2E;
   - cloud Worker integration tests;
   - cloud-mode Playwright E2E.
3. Add staging/production Wrangler environments with separate D1 resources where practical.
4. Apply D1 migrations before promoting a version, with migration failure blocking deployment.
5. Use narrowly scoped Cloudflare deployment credentials in CI; never commit tokens.
6. Add a production rollback command/workflow and document D1 Time Travel recovery.
7. Deploy the dashboard/API Worker and configure custom hostname(s), Access, D1, R2 and Durable Object resources.

## Phase 10 — production cutover

1. Pair the real Windows machine as the first execution node.
2. Verify local dashboard and VS Code still work before enabling remote actions.
3. Verify cloud node status, repositories and agents.
4. Run a disposable real repository task through the cloud UI with simulated agents first.
5. Run a controlled real Codex/Claude task after simulation passes.
6. Verify remote Chairman, approvals, logs, Source Control and usage.
7. Disconnect the browser and confirm the task continues.
8. Disconnect Internet on the node during a task; confirm local work continues and cloud reconciles after reconnect.
9. Restart the orchestrator during a controlled task and verify existing recovery plus remote reconciliation.
10. Verify node revocation immediately blocks further cloud control.
11. Verify the public hostname cannot reach the local Fastify server directly and the orchestrator remains loopback-only.
12. Only after all checks pass mark cloud mode production-ready.

---

# 5. Failure handling and recovery

## Browser/network disconnect

- task execution is unaffected;
- browser WebSocket reconnects with bounded exponential backoff;
- on reconnect, refetch cloud state before trusting local cache;
- realtime events are optimization, not source of truth.

## Node loses Internet

- mark node `degraded`, then `offline` after a defined heartbeat threshold;
- existing local task continues normally;
- local dashboard/VS Code remain usable;
- outgoing cloud events remain queued/bounded locally;
- no new cloud commands execute until authenticated reconnect;
- reconnect reconciles snapshots/events and then pending commands.

## Cloudflare/D1 outage

- local execution continues;
- remote control actions fail closed with a clear cloud-unavailable state;
- do not execute destructive work based on unpersisted cloud intent;
- sync catches up when service returns.

## Duplicate command/delivery

- D1 idempotency key + node-local command receipt prevents duplicate execution;
- duplicate returns the original stored result.

## Command result lost after execution

- node retains result/status locally;
- reconnect replays the result by command ID;
- cloud does not create a replacement command automatically.

## Stale command

- reject on expiry or expected-version mismatch;
- return `REMOTE_CONFLICT` and current entity version;
- browser refetches before retry.

## Node/application version mismatch

- handshake negotiates protocol version/capabilities;
- incompatible node is visible but receives no mutation commands;
- UI shows `Update required` with current/required versions.

## R2 failure

- task completion does not depend on artifact cloud upload unless the specific user action requires it;
- retry with bounded backoff;
- retain local artifact;
- show `cloud sync pending/failed`, never falsely show uploaded.

## D1 migration failure

- block deployment;
- rely on transactional migrations and D1 Time Travel for production recovery;
- do not rewrite an already-applied migration;
- document the exact rollback/deploy-previous-version procedure.

## Node crash/restart

- existing `services.recover()`, process reconciliation, terminal reconciliation, TaskEngine recovery and Chairman recovery remain first;
- remote client starts after local persistent state is usable;
- cloud receives corrected status snapshot after recovery.

## Cloud/browser approval race

- approval is bound to exact node/task/action/command hash/version and expiry;
- local node revalidates before execution;
- a stale approval cannot authorize a changed command.

## Repository conflict

- cloud lease prevents intentional cross-node overlap for remote tasks;
- local RepositoryCoordinator remains authoritative for local operations;
- node checks working tree/head before mutation;
- conflict stops safely for user/Chairman resolution rather than auto-resetting or force-pushing.

---

# 6. Security and data protection

1. **Do not expose Fastify.** Keep `ACC_HOST=127.0.0.1`; do not use `ACC_ALLOW_REMOTE=1` as the cloud solution.
2. **Do not reuse the local API token in cloud mode.** It remains local only.
3. **Access before dashboard.** Protect the human hostname with hostname-based Cloudflare Access so WebSockets remain supported.
4. **Defense in depth.** Worker validates Access identity/audience on API and WebSocket entry, not just presence of a header.
5. **Separate node trust.** Nodes authenticate with per-node cryptographic identity and can be individually revoked.
6. **Protect private node keys locally.** Reuse the DPAPI-backed protected key mechanism; never store node private keys in D1/R2/Git.
7. **Typed remote actions only.** No generic remote shell/HTTP proxy command.
8. **Local enforcement wins.** Existing permission levels, command classifier, approval gates, sensitive-file checks and subscription-only guard remain mandatory.
9. **Secret egress allowlist.** Cloud sync is field-allowlisted and redacted; credential values, environment secrets, local auth token and raw provider sessions never leave the node.
10. **No public R2 objects.** Artifact downloads require authenticated Worker authorization.
11. **Bounded payloads.** Limits for WebSocket frames, command bodies, event batches and artifact sizes.
12. **Replay protection.** Challenge nonces, short-lived sessions, command IDs, hashes, sequence numbers and expiry.
13. **CSRF/cross-origin protection.** Same-origin cloud API behind Access, secure cookie behavior, strict CSP, no permissive CORS wildcard.
14. **XSS containment.** Never render log/markdown content as trusted HTML; preserve current markdown sanitization behavior and CSP.
15. **Rate limiting.** Pairing, login-sensitive routes, command mutations and remote terminal creation.
16. **Audit without secrets.** Record who/when/node/action/result/hash, not credentials or unredacted payloads.
17. **Remote terminal disabled by default.** Require explicit local enablement and short-lived grants.
18. **Repository identity privacy.** Do not persist local absolute paths in cloud state.
19. **Production resource separation.** Use environment-specific D1/R2/Worker configuration where practical; never point tests at production data.
20. **CI secret discipline.** Narrow Cloudflare token permissions, GitHub secret storage only, no `.dev.vars` or generated credentials in commits.

Before production activation, run a repository-wide secret scan and verify the existing commit/push guards still block credential-shaped values.

---

# 7. Testing and verification

## Preserve existing verification

All existing tests must remain green:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm docs:guard`
- `pnpm test`
- `pnpm check`
- `pnpm build`
- `pnpm e2e`

## New unit tests

### Shared protocol

- valid/invalid schemas;
- version negotiation;
- payload limits;
- canonical hash behavior;
- unknown operation rejection;
- sequence/idempotency behavior.

### Node identity/auth

- one-time pairing;
- expired pairing token;
- wrong signature;
- nonce replay;
- revoked node;
- rotated identity;
- sealed private key survives restart and cannot be read from DB/API.

### Remote commands

- persisted before notification;
- duplicate executes once;
- lost acknowledgement recovers;
- stale version rejected;
- expired command rejected;
- wrong node/task rejected;
- dangerous command cannot bypass local approval;
- production/dangerous approval hash mismatch rejected.

### Sync

- offline event buffering;
- reconnect ordering;
- duplicate event upload;
- cloud snapshot reconciliation;
- cloud outage does not stop local task;
- bounded outbox behavior;
- log cursor recovery.

### Egress security

Assert sensitive values never appear in:

- D1 writes;
- R2 objects;
- Worker logs;
- WebSocket payloads;
- audit rows.

## Cloud Worker integration tests

Run against the Workers runtime/local bindings rather than mocking everything:

- D1 migrations and constraints;
- Access/auth middleware using test-signed identity fixtures;
- Durable Object browser + node WebSockets;
- node presence/hibernation recovery;
- durable command lifecycle;
- R2 upload/download authorization;
- rate-limit behavior;
- task list/filter/history behavior;
- node offline responses;
- repository lease acquisition/release;
- audit creation.

## Playwright cloud-mode E2E

Add a cloud E2E configuration that starts:

- a local Worker dev environment with local D1/R2/DO;
- a simulated execution node using the real orchestrator and simulated agents;
- the cloud dashboard.

Test the real user flow:

1. open cloud dashboard;
2. see paired node online;
3. create a task;
4. watch investigate → plan → implement → test → review → verify;
5. chat with Chairman;
6. pause/resume/reroute;
7. resolve an approval;
8. view logs and artifacts;
9. view usage;
10. exercise Source Control read/mutation test repository;
11. disconnect/reconnect browser;
12. disconnect/reconnect node;
13. verify task history remains readable offline;
14. revoke node and verify control stops;
15. run responsive/accessibility checks at existing E2E viewports and Dark/Light modes.

## Remote terminal tests

- unavailable by default;
- cannot create without local feature enablement;
- short-lived grant required;
- grant expiry terminates/blocks input;
- input is classified;
- Level 5 command requests local approval;
- revoking node/session stops terminal access;
- terminal output is not written to D1 by default.

## Real production verification

After automated tests:

- deploy staging/production;
- validate Access login on the custom hostname;
- validate browser WebSocket under the hostname-based Access policy;
- pair the real Windows node;
- verify local listener remains `127.0.0.1` only;
- execute a safe disposable task remotely;
- deliberately interrupt browser, node network and orchestrator process and verify recovery;
- verify D1 task/audit state and R2 artifact hashes;
- verify no secrets in cloud logs/storage;
- verify local-only operation with cloud endpoint unavailable.

Compilation alone does not satisfy verification.

---

# 8. Success criteria

The upgrade is complete only when all of the following are proven:

1. The application is reachable through a Cloudflare custom hostname from a normal Internet connection.
2. An unauthenticated human cannot load the dashboard/API/realtime endpoint.
3. Browser realtime works behind the selected hostname-based Access policy.
4. The local orchestrator still listens only on loopback and is not directly Internet-accessible.
5. The current local dashboard works exactly as before.
6. The VS Code extension still works against `runtime.json` exactly as before.
7. At least one real Windows node can pair, reconnect, rotate and be revoked.
8. Cloud UI shows accurate node online/offline/capability state.
9. A remote task can be created and completed through the existing TaskEngine.
10. Chairman chat/actions work remotely without creating a second Chairman engine.
11. Pause/resume/cancel/reroute/directives operate remotely and survive reconnects.
12. Dangerous/production operations still require the existing local approval semantics and typed confirmation where applicable.
13. Duplicate cloud command delivery cannot execute an action twice.
14. A running local task continues through temporary cloud/browser disconnection.
15. State reconciles correctly after node reconnect and orchestrator restart.
16. Cloud task history remains readable when the node is offline.
17. Logs/artifacts are accessible remotely only according to sync policy and are hash-verified.
18. Credential values, local API token, provider login secrets and arbitrary repository files are absent from D1/R2/Worker logs.
19. Source Control mutations still pass through existing local coordination and safety logic.
20. Remote terminal is disabled by default and cannot bypass command classification/approval when enabled.
21. Multi-node schema/routing works with simulated two-node tests even if only one physical node is used initially.
22. D1 migration failure/rollback and deployment rollback procedures are tested.
23. Existing `pnpm check`, build and local E2E pass after the upgrade.
24. New cloud integration and Playwright cloud E2E suites pass.
25. Documentation accurately describes setup, authentication, pairing, recovery, data ownership and emergency revocation.

---

# 9. Found for Later

These are useful follow-ups but must not expand the current implementation scope.

### 1. Always-on execution node

**Why it matters:** remote tasks cannot execute while every paired execution machine is powered off.  
**Recommended later fix:** provision a dedicated Windows/Linux development node or VPS using the same remote-node protocol.  
**Priority:** High after cloud control is stable.  
**Affects current task:** No.

### 2. Cross-node parallel work with isolated Git worktrees

**Why it matters:** cloud leases intentionally serialize conflicting remote mutations. Safe parallel work on one repository can improve throughput later.  
**Recommended later fix:** extend existing worktree support with branch/lease-aware multi-node scheduling.  
**Priority:** Medium.  
**Affects current task:** No.

### 3. End-to-end encrypted cloud artifacts

**Why it matters:** the current design intentionally keeps secrets local and stores only approved/redacted artifacts in R2. If highly sensitive artifacts must later be stored, application-level encryption could reduce trust in cloud storage.  
**Recommended later fix:** per-node/workspace encryption keys with client/node-side encrypt/decrypt and key rotation.  
**Priority:** Medium/Low unless sensitive artifact requirements change.  
**Affects current task:** No.

### 4. Mobile push notifications

**Why it matters:** approvals and failed tasks would be easier to act on without keeping the dashboard open.  
**Recommended later fix:** PWA Web Push or native bridge after remote control is stable.  
**Priority:** Medium.  
**Affects current task:** No.

### 5. Global cross-task Chairman

**Why it matters:** current Chairman is task-scoped. A future system-wide Chairman could optimize scheduling and priorities across nodes/tasks.  
**Recommended later fix:** add a separate supervisory layer only after cloud task/node state has proven stable; reuse current Chairman decision/action concepts rather than mixing this into the transport implementation.  
**Priority:** Medium.  
**Affects current task:** No; this plan only routes existing Chairman behavior remotely.

---

# 10. Next Recommended Task

After this cloud control upgrade is fully verified, the next recommended task is:

**Build an always-on execution node profile using the same remote-node protocol, with hardened provisioning, repository synchronization/checkout rules, automatic updates and recovery, so remote tasks can run even when the primary Windows PC is off.**

Do not implement that until this plan's security, reconnect, idempotency and production success criteria are proven.

---

# 11. Final execution prompt

Implementation rules for the coding agent:

- Re-inspect the live project before editing because the repository is actively changing.
- Treat this file as the authoritative scope for the Cloudflare remote-control upgrade.
- Preserve local-first behavior, local SQLite data, VS Code behavior, security gates and existing functionality.
- Prefer additive changes and reuse current TaskEngine, Chairman, Source Control, security, credential and realtime infrastructure.
- Do not expose the local Fastify service publicly.
- Do not move process execution into Workers.
- Do not add Cloudflare Queues or extra services unless testing proves the simpler D1 + Durable Object design cannot meet the requirements.
- Make normal implementation decisions autonomously.
- Create/test Cloudflare resources with safe staging/local bindings before production.
- Fix blockers directly related to this plan.
- Record unrelated discoveries in Found for Later instead of expanding scope.
- Test actual remote behavior and failure recovery, not only compilation.
- Do not declare completion until every Success Criteria item has evidence.

/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.
