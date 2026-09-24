---
title: Private Browser → Control Center link — report a page problem, get a task, check the fix in the same browser
source: conversation 2026-09-24 (plan drafted as PRIVATE_BROWSER_LINK_PLAN.md, not saved at the time; /implement-plan invoked on it)
created: 2026-09-24
status: in-progress
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

- [ ] 1. CC: `signStatement`/`verifyStatement` with the `acc-connected-app-v1` prefix and committed vectors — done when: vectors verify, and a MyVault transcript does not verify as a link statement (or the reverse) — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-app-identity.test.ts`
- [ ] 2. CC: migration `connected apps` (next free version) with three metadata tables — done when: it applies on a fresh DB and on a copy of the live-version DB, and existing rows are untouched — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-apps.test.ts -t migration`
- [ ] 3. CC: `ConnectedAppService` (pairing codes, token hash, auth, revoke, rate limits, idempotency, own-task projection) — done when: the unit tests for pairing expiry/attempts/single-use, hashed token, revoke and rate limits pass — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-apps.test.ts`
- [ ] 4. CC: `security.ts` prefix rule plus the routes, registered in the server — done when: the app token is refused on `/api/tasks`, `/api/repositories`, `/api/credentials`, `/api/tool-session/*` and `/ws`; the local token is refused on `/api/connected-app/*`; and `Origin` and the remote header are refused — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-apps.test.ts -t scope`
- [ ] 5. CC: forced task intake with fenced evidence and a screenshot attachment, idempotent on `requestId` — done when: forced fields hold, a fence-closing string is neutralised, a fake token is redacted, and a repeat `requestId` returns the same task — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-apps.test.ts -t intake`
- [ ] 6. CC: re-check evidence (artifact, event, and the report's Verification coverage line) — done when: the evidence post creates `browser-recheck-N.md`, the report lists it, and another app's task returns 404 — check: `pnpm --filter @acc/orchestrator exec vitest run test/connected-apps.test.ts -t evidence`
- [ ] 7. CC: dashboard Connected apps tab, task badge, and `connectedApp` realtime entity — done when: the Playwright spec for pair, list, mode and disconnect passes in both themes, and the badge renders — check: `pnpm build && pnpm --filter @acc/dashboard exec playwright test e2e/connected-apps.spec.ts`
- [ ] 8. CC: full gate — done when: `pnpm check` exits 0 — check: `pnpm check`
- [ ] 9. CC: e2e and visual matrix — done when: `pnpm build && pnpm e2e` exits 0 — check: `pnpm build && pnpm e2e`
- [ ] 10. CC docs: new `docs/systems/connected-apps.md`; update security.md, orchestrator.md and the README index — done when: the docs describe the built routes and tables — check: `git diff --stat docs/systems`
- [ ] 11. PB: create worktree `C:\Users\abuye\Private-Browser-cc-link` on `feat/control-center-link` from `origin/main` — done when: `git worktree list` shows it, and the main checkout's `ipc-contracts.ts` edit is untouched — check: `git -C C:/Users/abuye/Private-Browser worktree list && git -C C:/Users/abuye/Private-Browser status --short`
- [ ] 12. PB: `electron/control-center-link.ts` (sealed store, loopback discovery, bounded client, identity pin) plus unit tests — done when: tests for store round-trip/corrupt quarantine, non-loopback refusal, redirect/timeout/oversize refusal and bad-signature block pass — check: `npx vitest run electron/control-center-link.test.ts`
- [ ] 13. PB: `main.ts` methods, IPC contracts, preload, `handle()`, preview-api mock, parity test — done when: the parity test covers the seven channels, and consent tests (burned approval, protected/Banking refusal, screenshot only if approved) pass — check: `npx vitest run`
- [ ] 14. PB: Developer panel UI (Send to Control Center, Control Center section, Check again) — done when: typecheck passes and the panel renders against the preview mock — check: `npm run typecheck && npx vitest run src`
- [ ] 15. PB docs: new `docs/systems/control-center-link.md`; update ai-consent.md, ipc-contract.md, security-boundary.md, README and follow-ups — done when: `npm run docs:check` passes — check: `npm run docs:check`
- [ ] 16. PB: full gate — done when: `npm run check` exits 0 in the worktree — check: `npm run check`
- [ ] 17. PB: local commit on `feat/control-center-link` with the `[autopilot]` trailer; merge to local `main` only if the other session's `ipc-contracts.ts` edit is no longer uncommitted; no push — done when: the branch holds the commit and nothing is pushed — check: `git -C C:/Users/abuye/Private-Browser-cc-link log --oneline -3 && git -C C:/Users/abuye/Private-Browser status -sb`
- [ ] 18. Live cross-app run on a scratch CC data folder (pair, send, status, fix, Check again, Banking/revoke/stopped negatives) — done when: each §7.3 point is observed and screenshots are saved and inspected — check: `manual: API responses + task artifacts + window-only screenshots`
- [ ] 19. Go-live: back up `acc.db`, confirm no RUNNING tasks, restart the real orchestrator on the pushed build, and confirm the migration applied — done when: the live DB `schema_migrations` shows the new version and `/api/connected-apps` answers — check: `manual: sqlite query + curl with local token`

## Tail

- [ ] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat` reviewed hunk by hunk
- [ ] T2. Similar-issue sweep — done when: the other prefix-bypass routes, other token stores and other attachment writers were searched for the same pattern — check: `manual: list what was searched and what was found`
- [ ] T3. Lint and tests green — done when: both repositories' full gates exit 0 on the final tree — check: `pnpm check` (CC) and `npm run check` (PB worktree)
- [ ] T4. Docs synced per the repo's rules — done when: the system docs in both repositories reflect the change with today's Last verified — check: `git diff --stat docs/`
- [ ] T5. Committed path-scoped and pushed (CC only; PB committed locally, not pushed) — done when: `git status` shows none of this work uncommitted, and the CC push succeeded — check: `git log origin/main..HEAD --oneline`
- [ ] T6. Confirmed live where the push deploys — done when: CC push does not deploy (a local app); the live orchestrator restart in step 19 is the live check — check: `manual: step 19 evidence`
- [ ] T7. A claim registered for this change — done when: a claim is registered, or this step says why there is none — check: `manual: name the claim or say why none`

## Ledger

- 2026-09-24 14:45 — created from the conversation plan (not saved at the time; /implement-plan run with no argument, no in-progress plan in docs/plans, and the newest ~/.claude/plans file is older than 24 h and unrelated) — the conversation's plan is the evident source
- 2026-09-24 14:45 — migration number: 10 (myvault delivery box) and 11 (learning loop) landed since the investigation; this work takes the next free version at implementation time
- 2026-09-24 14:45 — untracked `docs/plans/MULTI_REPO_TASKS_PLAN.md` and `ROLE_PROMPTS_PLAN.md` belong to other sessions; not touched or staged
