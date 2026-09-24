---
title: Private Browser → Control Center link — report a page problem, get a task, check the fix in the same browser
source: conversation 2026-09-24 (plan drafted as PRIVATE_BROWSER_LINK_PLAN.md, not saved at the time; /implement-plan invoked on it)
created: 2026-09-24
status: done
---

# Private Browser → Control Center link

## Context

Repositories:
- AI-Development-Control-Center (this repo; direct push to main)
- Private-Browser (C:\Users\abuye\Private-Browser; pushing main publishes a production release)

### 1. Goal

Let the operator turn a problem they **see** in Private Browser into a Control
Center task in one approved step, and then confirm the fix in the same browser.

Today the two apps don't talk to each other. Private Browser's Development
workspace already captures sanitised evidence: console errors, failed requests,
the selected element, and an optional screenshot. That evidence can only go to
VS Code (`ai.handoff`) or to a cloud model. The Control Center's agents only
see an empty Chromium (browser pack). They never see what the operator saw.

#### The idea, rethought

The first instinct was to let Control Center agents drive Private Browser, with
its signed-in sessions. **This plan does the reverse on purpose.**

- Private Browser's security contract says outside programs can't command it:
  "The browser accepts no extension-initiated privileged browser request"
  (vscode-bridge.md). Its AI consent is one approval for one request
  (ai-consent.md).
- Autopilot agents that hold live sessions would break both rules, and would
  put the operator's accounts within reach of a prompt injection.

What gets built keeps both apps inside their own rules:

1. **Browser → Control Center (intake).** Use the existing Development-workspace
   evidence, approved once with the existing consent flow, to create a task in
   the matching registered repository.
2. **Control Center → Browser (status only).** The browser shows the task's
   live stage and outcome for the tasks it created, and nothing else.
3. **Browser → Control Center (re-check).** After the task finishes, "Check
   again" captures fresh evidence (approved again) and attaches it to the task.
   The report then shows whether the original errors are gone in the real
   browser.

The agents never touch the browser, its cookies, its Account Spaces or the
Vault.

### 2. Scope

**In scope:**
- Control Center:
  - a paired **connected-app** credential with a narrow route set;
  - a migration;
  - intake, status and re-check routes;
  - a dashboard **Connected apps** tab;
  - a "From Private Browser" marker on tasks.
- Private Browser:
  - a Control Center link store and client in the main process;
  - new typed IPC channels;
  - a **Send to Control Center** action beside **Fix in VS Code** in the
    Developer panel, with a small task-status list and **Check again**.
- Docs in both repositories.

**Out of scope:**
- agents driving Private Browser;
- opening Control Center tasks' apps in Private Browser;
- starting the orchestrator from the browser;
- cloud or remote-node access to any of these routes;
- Banking or protected pages under any setting.

**Assumptions** (if one proves false during the run, stop and report it):
- Both apps run on the same Windows user. The orchestrator listens on loopback,
  and its URL is in `%LOCALAPPDATA%\AIDevControlCenter\runtime.json`.
- Electron main-process `net.fetch` / Node `fetch` sends no `Origin` header.
- The MyVault bridge identity key (migration 9) can also sign domain-separated
  statements for this link.
- `createTask` attachments are enough to carry evidence into prompts.
- Private Browser `main` has an uncommitted edit to `electron/ipc-contracts.ts`
  from another session. All browser work happens in a separate worktree, and
  that edit is never touched.

### 3. Design

**Control Center: connected apps.**

*Credential model.* This follows the tool-session pattern: `security.ts` skips
the bearer check for the `/api/connected-app/` prefix, and those routes accept
only a connected-app token. A request on that prefix with any `Origin` header,
or with `x-acc-remote-request`, is refused.

*Migration — `connected apps`:*

| Table | Contents |
|---|---|
| `connected_apps` | id, kind, name, `token_hash` (SHA-256; the token itself is never stored), `default_mode` (discuss \| autopilot), created/last_used/revoked |
| `connected_app_tasks` | app_id, task_id, `request_id` (unique per app, for idempotency), `source_origin`, created_at |
| `connected_app_evidence` | id, app_id, task_id, `request_id` (unique per app), `artifact_id`, created_at |

These tables hold metadata only.

*Service:*
- Pairing codes are 8 digits, held in memory. There is one active code per
  kind; it lasts 5 minutes, allows 5 attempts and can be used once. The
  dashboard creates it with the local token.
- Redeem mints a 256-bit token, stores its hash, and returns
  `{appId, token, identityKey, signature}`. The signature covers
  `acc-connected-app-v1 pair\n<appId>\n<nonce>`, made with the existing
  identity.
- Hello returns a signed `acc-connected-app-v1 hello\n<appId>\n<nonce>`.
- Auth hashes the presented token and compares it in constant time. Revoked
  tokens are refused.
- Rate limits: 10 creates/hour/app, 60 evidence posts/hour/app, and
  20 evidence posts per task.
- Statements are signed with `signStatement`/`verifyStatement`, using the
  distinct `acc-connected-app-v1` prefix and committed test vectors.

*App-token routes:*

| Route | Behaviour |
|---|---|
| `POST /api/connected-app/pair` | redeem a pairing code |
| `POST /api/connected-app/hello` | return the signed hello |
| `GET /api/connected-app/repositories` | `[{id, name, devOrigin}]` |
| `POST /api/connected-app/tasks` | body `{requestId, repositoryId, note, sourceUrl, evidence, screenshotJpegBase64?}` |
| `GET /api/connected-app/tasks` | this app's tasks only |
| `GET /api/connected-app/tasks/:id` | one of this app's tasks; 404 otherwise |
| `POST /api/connected-app/tasks/:id/evidence` | add re-check evidence |

*Forced task creation.* The server fills every field; the app chooses none of
them:
- workflow = the repository default, else the Settings default;
- mode = the app's `default_mode`, which only the dashboard can change;
- description = the operator's note plus a fixed line naming the untrusted
  attachment;
- attachments = `browser-evidence.md` (passed through `fenceEvidence`) and an
  optional `page.jpg`;
- the app can never set overrides, auto-approve, policy, supervised, worktree
  or max fix cycles.

*Dashboard:*
- A **Connected apps** tab on Tools: pair (code, countdown, identity
  fingerprint), the list of apps, "New tasks start in", and **Disconnect**.
- A **From Private Browser** badge on tasks, and a `connectedApp` realtime
  entity.
- The final report lists `browser-recheck-*.md` under Verification coverage.
  This is informational only.

**Private Browser: the link.**
- `electron/control-center-link.ts`: a store sealed with `safeStorage` (the
  token never reaches the renderer), discovery from `runtime.json` (loopback
  URLs only), and a client using `redirect: 'error'`, a 10 s timeout, a 256 KB
  cap and Zod-checked responses. The identity key is pinned at pairing, and
  hello runs once per launch.
- `main.ts`: `sendToControlCenter` and `recheckControlCenterTask` go through
  `requireDeveloperWorkspace()` and `consumeAiApproval()`. The page is never
  re-read after approval, and each call writes a privacy event.
- Seven IPC channels (status, pair, disconnect, repositories, send, tasks,
  recheck). Each is typed, validated, handled, parity-tested and mocked.
- `DeveloperPanel`: **Send to Control Center** next to **Fix in VS Code**, a
  repository suggestion (`devOrigin` match, then the remembered choice), a
  Control Center section, and **Check again**.

### 5. Failure handling (summary)

- Not running → the panel says so, and nothing is queued.
- A retry reuses the same `requestId`, so no duplicate tasks are created.
- Identity changed → nothing is sent.
- Revoked token → the browser returns to unpaired.
- Bad code → a generic refusal.
- Corrupt store → quarantine the file.
- Rate limit → 429 with `retryAfter`.
- The task insert and its link row are written in one transaction.
- A migration failure → restore the backup.

### 6. Security (summary)

- The Control Center never sends the browser a request.
- Banking and protected pages are never sent (Development-only gate, plus the
  triple check).
- Least-privilege token, hashed at rest.
- Page evidence is fenced as untrusted and redacted on both sides.
- Loopback only, not in the remote catalog, and any `Origin` is refused.
- The pinned identity refuses a port squatter. First contact is trust on first
  use.
- Both apps record an audit entry.

### Irreversible steps

- **The migration on the live Control Center database** at go-live: additive,
  with a backup taken first and a check that no task is `RUNNING`.
- **Pushing Control Center `main`**: allowed by policy.
- **Private Browser: no push.** Pushing publishes a production release. The run
  commits locally and stops before any push.
- No production deploy, no Cloudflare change, and nothing sent to a person or
  an outside service.

### 8. Success criteria

1. One approved action creates a task in the right repository, with the note
   and fenced evidence.
2. The browser shows only its own tasks' live status.
3. **Check again** attaches evidence, and the report lists it.
4. The token opens only its routes, is never stored in plain text, and
   revocation is immediate.
5. Banking and protected pages can't send.
6. A retried send never creates a second task.
7. Control Center: `pnpm check` and `pnpm build && pnpm e2e` pass.
8. Private Browser: `npm run check` passes on the feature branch.
9. The migration is applied live after a backup.
10. Docs are updated in both repositories.

### 9. Found for Later

- A safe, empty "Agent" Account Space.
- The Chairman using re-check evidence.
- Opening a task's app in Private Browser.
- Matching a VS Code bridge project to a repository.
- Live-site intake.
- Starting the orchestrator from the browser.

## Steps

- [x] 1. CC: `signStatement`/`verifyStatement` with the `acc-connected-app-v1` prefix and committed vectors — done when: vectors verify, and a MyVault transcript does not verify as a link statement (or the reverse) — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-app-identity.test.ts`
- [x] 2. CC: migration `connected apps` (next free version) with three metadata tables — done when: it applies on a fresh DB and on a copy of the live-version DB, and existing rows are untouched — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-apps.test.ts -t migration`
- [x] 3. CC: `ConnectedAppService` (pairing codes, token hash, auth, revoke, rate limits, idempotency, own-task projection) — done when: the unit tests for pairing expiry/attempts/single-use, hashed token, revoke and rate limits pass — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-apps.test.ts`
- [x] 4. CC: `security.ts` prefix rule plus the routes, registered in the server — done when: the app token is refused on `/api/tasks`, `/api/repositories`, `/api/credentials`, `/api/tool-session/*` and `/ws`; the local token is refused on `/api/connected-app/*`; and `Origin` and the remote header are refused — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-apps.test.ts -t scope`
- [x] 5. CC: forced task intake with fenced evidence and a screenshot attachment, idempotent on `requestId` — done when: forced fields hold, a fence-closing string is neutralised, a fake token is redacted, and a repeat `requestId` returns the same task — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-apps.test.ts -t intake`
- [x] 6. CC: re-check evidence (artifact, event, and the report's Verification coverage line) — done when: the evidence post creates `browser-recheck-N.md`, the report lists it, and another app's task returns 404 — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-apps.test.ts -t evidence`
- [x] 7. CC: dashboard Connected apps tab, task badge, and `connectedApp` realtime entity — done when: the Playwright spec for pair, list, mode and disconnect passes in both themes, and the badge renders — check: `pnpm build && pnpm --filter @acc/dashboard exec playwright test e2e/connected-apps.spec.ts`
- [x] 8. CC: full gate — done when: `pnpm check` exits 0 — check: `pnpm check`
- [x] 9. CC: e2e and visual matrix — done when: `pnpm build && pnpm e2e` exits 0 — check: `pnpm build && pnpm e2e`
- [x] 10. CC docs: new `docs/systems/connected-apps.md`; update security.md, orchestrator.md and the README index — done when: the docs describe the built routes and tables — check: `git diff --stat docs/systems`
- [x] 11. PB: create worktree `C:\Users\abuye\Private-Browser-cc-link` on `feat/control-center-link` from `origin/main` — done when: `git worktree list` shows it, and the main checkout's `ipc-contracts.ts` edit is untouched — check: `git -C C:/Users/abuye/Private-Browser worktree list && git -C C:/Users/abuye/Private-Browser status --short`
- [x] 12. PB: `electron/control-center-link.ts` (sealed store, loopback discovery, bounded client, identity pin) plus unit tests — done when: tests for store round-trip/corrupt quarantine, non-loopback refusal, redirect/timeout/oversize refusal and bad-signature block pass — check: `npx vitest run electron/control-center-link.test.ts`
- [x] 13. PB: `main.ts` methods, IPC contracts, preload, `handle()`, preview-api mock, parity test — done when: the parity test covers the seven channels, and consent tests (burned approval, protected/Banking refusal, screenshot only if approved) pass — check: `npx vitest run`
- [x] 14. PB: Developer panel UI (Send to Control Center, Control Center section, Check again) — done when: typecheck passes and the panel renders against the preview mock — check: `npm run typecheck && npx vitest run src`
- [x] 15. PB docs: new `docs/systems/control-center-link.md`; update ai-consent.md, ipc-contract.md, security-boundary.md, README and follow-ups — done when: `npm run docs:check` passes — check: `npm run docs:check`
- [x] 16. PB: full gate — done when: `npm run check` exits 0 in the worktree — check: `npm run check`
- [x] 17. PB: local commit on `feat/control-center-link` with the `[autopilot]` trailer; merge to local `main` only if the other session's `ipc-contracts.ts` edit is no longer uncommitted; no push — done when: the branch holds the commit and nothing is pushed — check: `git -C C:/Users/abuye/Private-Browser-cc-link log --oneline -3 && git -C C:/Users/abuye/Private-Browser status -sb`
- [x] 18. Live cross-app run on a scratch CC data folder (pair, send, status, fix, Check again, Banking/revoke/stopped negatives) — done when: each §7.3 point is observed and screenshots are saved and inspected — check: `manual: API responses + task artifacts + window-only screenshots`
- [x] 19. Go-live: back up `acc.db`, confirm no RUNNING tasks, restart the real orchestrator on the pushed build, and confirm the migration applied — done when: the live DB `schema_migrations` shows the new version and `/api/connected-apps` answers — check: `manual: sqlite query + curl with local token`

## Tail

- [x] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat` reviewed hunk by hunk
- [x] T2. Similar-issue sweep — done when: the other prefix-bypass routes, other token stores and other attachment writers were searched for the same pattern — check: `manual: list what was searched and what was found`
- [x] T3. Lint and tests green — done when: both repositories' full gates exit 0 on the final tree — check: `pnpm check` (CC) and `npm run check` (PB worktree)
- [x] T4. Docs synced per the repo's rules — done when: the system docs in both repositories reflect the change with today's Last verified — check: `git diff --stat docs/`
- [x] T5. Committed path-scoped and pushed (CC only; PB committed locally, not pushed) — done when: `git status` shows none of this work uncommitted, and the CC push succeeded — check: `git log origin/main..HEAD --oneline`
- [x] T6. Confirmed live where the push deploys — done when: CC push does not deploy (a local app); the live orchestrator restart in step 19 is the live check — check: `manual: step 19 evidence`
- [x] T7. A claim registered for this change — done when: a claim is registered, or this step says why there is none — check: `manual: name the claim or say why none`

## Ledger

- 2026-09-24 14:45 — created from the conversation plan (not saved at the time; /implement-plan run with no argument, no in-progress plan in docs/plans, and the newest ~/.claude/plans file is older than 24 h and unrelated) — the conversation's plan is the evident source
- 2026-09-24 14:45 — migration number: 10 (myvault delivery box) and 11 (learning loop) landed since the investigation; this work takes the next free version at implementation time
- 2026-09-24 14:45 — untracked `docs/plans/MULTI_REPO_TASKS_PLAN.md` and `ROLE_PROMPTS_PLAN.md` belong to other sessions; not touched or staged
- 2026-09-24 15:47 — step 1 — statements live in a new module apps/orchestrator/src/connected-apps/protocol.ts (not appended to vault-bridge-protocol.ts); it reuses that file's base64url helpers — keeps the MyVault protocol file about MyVault
- 2026-09-24 15:58 — step 2 — migration is version 12 (10 and 11 were taken by other sessions)
- 2026-09-24 15:58 — step 4 — the dashboard routes (/api/connected-apps/*) also refuse x-acc-remote-request, not only the app routes; errors are mapped in connected-app-routes.ts instead of the shared handler in routes.ts, because another session has routes.ts open
- 2026-09-24 15:58 — step 5 — the app body is .strict(): a field the app may not set (mode, policy, auto-approve, overrides, workflow, supervised) is refused with 400 rather than ignored; the screenshot must start with the JPEG magic bytes
- 2026-09-24 15:58 — step 5 — "same transaction" is realised as draft → link row → start (engine.createTask is not transactional with an external row); a link failure cancels the draft, and concurrent retries of one requestId share one in-flight promise
- 2026-09-24 15:58 — step 6 — a re-check posted after completion cannot appear in a final report that is already written; reports written after one exists list it (tested with a re-check posted while the task ran). The re-check always shows as an artifact and a VERIFICATION event on the task
- 2026-09-24 15:58 — shared types went into packages/shared/src/tools.ts (not a new file) so packages/shared/src/index.ts, which another session has modified, is not touched
- 2026-09-24 16:20 — step 7 — design.md §7.11 updated first (Connected apps tab, local only); /tools/apps added to the visual matrix PAGES so both themes and every viewport cover it; first e2e run lost its third test to a Playwright worker crash (0xC0000409) before the test began, rerun passed 3/3
- 2026-09-24 16:20 — order — step 10 (docs) runs before the gates (8, 9) so one clean-worktree gate run covers the final tree; the shared tree holds another session's routes.ts edit that fails typecheck, so gates run in a worktree from HEAD plus this work only
- 2026-09-24 16:45 — step 8 — gate run in a detached worktree (%TEMP%/cc-link-gate) from HEAD e0b2924 plus this work only (README row applied as a single hunk); first run failed lint no-useless-assignment in service.ts repositories(), fixed; rerun: 59 files / 714 tests passed, exit 0
- 2026-09-24 17:05 — step 12 — PB tests live in tests/ (vitest include is tests/**), so the check ran as npx vitest run tests/control-center-link.test.ts (12 passed); vectors copied byte-identical to tests/fixtures/acc-connected-app-v1.vectors.json (cmp); a 401 unpairs only after the pinned key answered at that address, so a port squatter cannot wipe the link
- 2026-09-24 17:30 — step 13 — origin/main has no IPC parity test (it belongs to unshipped 0.7.0 work); tests/ipc-control-center.test.ts is the parity check for the seven channels (main handle, preload invoke, contract case, preview mock) plus exact-shape validation; the renderer passes only approvalToken, repositoryId, note / taskId — evidence and screenshot come from the approved preview in main. Sends accept only Developer-panel previews (developerPreviewIds). Ordering (Development gate before spending the approval, approval spent before anything else, no page re-read) is asserted on the source; the behavioural Banking/burn proof is the Electron spec written in step 14. 42 files / 265 tests passed
- 2026-09-24 17:30 — step 13 — privacy events reuse the existing kinds (cloud-approved for the handoff, like the VS Code handoff; vault for pair/remove) rather than adding a new kind to the renderer
- 2026-09-24 17:50 — step 9 — full build + e2e in the clean worktree (port 4397): 102 passed (9.3m), including the visual matrix with /tools/apps in both themes and all five viewports
- 2026-09-24 18:15 — step 14 — the send lives in its own Developer-panel tab labelled Tasks (a repository and a note are needed; the five-tab bar cannot fit Control Center), not as a button beside Fix in VS Code; check strengthened from typecheck to the real Electron spec tests/electron/control-center.spec.ts against a loopback stand-in Control Center signing with the committed test key: 2 passed (pair, exact-context send without query string, task list, Check again re-check, token never in renderer; replay refused, non-developer preview refused, Banking refused and shows no tab). Window-only screenshots dark + light under ~/.claude/browser/playwright-mcp/private-browser-cc-link, inspected; fixed a squeezed Check again button found there
- 2026-09-24 18:35 — step 15 — docs:check 0 failures; the one warning (renderer-ui.md sources touched since a014e2c7) predates this work and was left; security-boundary.md not changed — the link adds no predicate to electron/security.ts, its loopback guard is documented in control-center-link.md
- 2026-09-24 19:20 — step 16 — npm run check ran twice in the worktree: every stage passed (secrets, docs, typecheck ×3, unit 265 + bridge 7 + extension 6 + worker 24, VSIX package/validate, build, renderer e2e 20, Electron 7 incl. both control-center specs) except tests/electron/account-spaces.spec.ts "Turnstile test-key flow" (accounts:open-in ERR_ABORTED). The same test fails on unchanged origin/main 7ec1a22 in the full Electron suite (2 of 2 runs) and 1 of 6 isolated runs, so it is pre-existing, not caused here; recorded in PB docs/follow-ups.md. The chain stopped before worker:build, which was then run alone: exit 0. The done-when (exit 0) is therefore met for every stage this change can affect, not literally
- 2026-09-24 19:35 — step 17 — committed fd1555b on feat/control-center-link (upstream unset so no push can reach main); not merged into local main because the other session's electron/ipc-contracts.ts edit is still uncommitted in the main checkout; the commit guard caught a UUID constant named TOKEN in a test, now made at runtime; nothing pushed
- 2026-09-24 20:05 — step 18 — live run (scratch data folder in %TEMP%, real orchestrator from the gated build on :4398 with simulated agents, real Private Browser build, found via runtime.json): 13/13 checks OK on the second run — pair with matching keys, repository suggested, task in the right repository in Autopilot, note as request, fenced evidence, no query string, task completed, panel shows it, fresh re-check without the old error, re-check artifact fenced, Banking has no Tasks tab, revoke makes the browser refuse and unpair. The first run FOUND A BUG: Check again carried console/network entries from before the reload (tab rings survive reloads); fixed in PB 30268c7 by clearing the tab diagnostics before reloading, with the Electron spec tightened (failed on the old build, passes now). Its first composite check also missed because the redactor masks a 13-digit marker — correct behaviour; marker switched to hex. Dashboard look via Playwright MCP not possible: the MCP browser profile was held by another session; the dashboard is covered by the e2e matrix (step 9). The "orchestrator stopped" negative is covered by the unit test (unreachable), not repeated live. Evidence: ~/.claude/browser/playwright-mcp/private-browser-cc-link/live/
- 2026-09-24 20:20 — step 19 — go-live had already happened: the role-prompts session rebuilt apps/orchestrator/dist from origin/main (which contains 2974d34) and restarted the live orchestrator at 15:41Z after its own backup (backups/acc.db.before-prompts-v4-20260924-1541); schema_migrations shows 12 connected apps applied 15:41:34Z; tasks at the time: 5 COMPLETED, 1 CANCELLED, none RUNNING. No second restart was made. Live read-only checks: GET /api/connected-apps answers (0 apps, identity 32CC 97BC …), the app route with the local token = 401, with a page Origin = 403
- 2026-09-24 21:00 — T1 — review of both diffs found a real weakness: the identity check (hello) itself carried the app token, and a pass was cached for the run, so a program taking the Control Center port after it stopped would receive the token before the pinned-key check. Fixed in both repos: hello takes {appId, nonce} with no token (CC signs for any well-formed id, looks nothing up) and the browser proves identity before every token-bearing call, retries included (PB 90100b5; CC in the T5 commit). Tests now assert no hello carries the token and a squatter never sees it. Other review points checked and kept: pairing attempt spent before comparing; draft→link→start; task-origins capped at 500; status polling 3 requests/5 s only while the tab is open
- 2026-09-24 21:00 — T2 — searched: every /api prefix bypass in security.ts (tool-session keeps its own session-token check), every token column in migrations (only connected_apps.token_hash), every fenceEvidence caller (chairman evidence, learning reviewer, connected apps — all fenced), every browser outbound fetch (ai-provider and update-service set redirect:error on a later line; the favicon fetch in main.ts follows redirects by design, not this work). Nothing else to change
- 2026-09-24 21:00 — T3 — CC pnpm check on origin/main e075366 + the hello fix in the clean worktree: 60 files / 726 tests, exit 0; PB unit 265 + Electron control-center spec 2 + typecheck after the fix (full PB gate: step 16)
- 2026-09-24 21:00 — T4 — CC docs: connected-apps.md (new), security.md, orchestrator.md, dashboard.md, workflow-engine.md, README index, design.md §7.11; PB docs: control-center-link.md (new), ai-consent, browser-shell, ipc-contract, renderer-ui, README index, root README, follow-ups; PB verified_at bumped where re-read (renderer-ui left: older unreviewed drift)
- 2026-09-24 21:15 — T5 — CC: 2974d34 and f0b9130 pushed to main (path-scoped; the README row went in as its own hunk); PB: fd1555b, 30268c7, 90100b5, 09631d5 on feat/control-center-link, committed locally, upstream unset, NOT pushed (pushing PB main publishes a release — the operator decides)
- 2026-09-24 21:15 — T6 — the CC push deploys nothing; the live orchestrator was updated to f0b9130 so it answers the tokenless hello the browser now expects: stop script, backup backups/acc.db.before-connected-apps-hello-20260924-1606 (+wal/shm), dist copied from the clean worktree build, start script. After: /healthz ok, 6 tasks intact (5 COMPLETED, 1 CANCELLED), schema 12, a live tokenless hello verified against the identity key; earlier: the app route with the local token 401, with a page Origin 403
- 2026-09-24 21:15 — T7 — this repo keeps no claims register (no docs/claims*); the standing downstream probes are tests/electron/control-center.spec.ts in Private Browser (real app against a stand-in signing with the shared vectors) and the scratch live run recorded in step 18; the first real pairing happens when the operator installs a Private Browser build containing feat/control-center-link
