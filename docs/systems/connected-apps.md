---
system: connected-apps
sources:
  - apps/orchestrator/src/connected-apps/**
  - apps/orchestrator/src/http/connected-app-routes.ts
  - apps/dashboard/src/pages/tools/ConnectedAppsTab.tsx
  - apps/dashboard/src/api/connected-apps.ts
verified_at: e0b2924
---

# Connected apps

A local app the operator paired — **Private Browser** today — can turn a page
problem the operator approved there into a task, follow the tasks it created,
and attach re-check evidence to them. Plan:
[private-browser-control-center-link.md](../plans/private-browser-control-center-link.md).

The arrow points one way. The Control Center never sends the app a request,
and nothing here drives the browser, its sessions or its vault. Private
Browser is not an agent surface.

## Trust model

- **Pairing.** In the dashboard, Tools → Connected apps → **Pair Private
  Browser** → **Make a pairing code**. The code:
  - has eight digits;
  - is held in memory, with one on offer at a time;
  - lasts 5 minutes, allows 5 attempts and works once;
  - is withdrawn when the dialog closes.

  The app redeems it with `POST /api/connected-app/pair {code, name, nonce}`.
  An attempt is spent before the comparison, which is constant time.
- **Token.** 256 random bits (base64url), returned once. Only its SHA-256 is
  stored (`connected_apps.token_hash`). It is registered with the redactor, and
  `last_used_at` is updated at most once a minute.
- **Identity.** Responses to `pair` and `hello {nonce}` are signed with the
  Control Center identity key, the same sealed ECDSA P-256 key MyVault pins
  ([credential-broker.md](credential-broker.md#myvault-bridge)).
  - The statements are `acc-connected-app-v1 pair|hello\n<appId>\n<nonce>`
    ([protocol.ts](../../apps/orchestrator/src/connected-apps/protocol.ts)).
  - The prefix is distinct, so no MyVault transcript or deposit signature
    verifies as a statement, and the reverse.
  - Test vectors: `apps/orchestrator/test/fixtures/acc-connected-app-v1.vectors.json`,
    copied byte-for-byte into Private Browser. ECDSA is randomised, so the
    vectors are verified, not reproduced.
  - The app pins the key at pairing and checks a fresh `hello` before it sends
    anything. First contact is trust on first use: the dialog shows the
    fingerprint for the operator to compare.
- **Reach.** [security.ts](../../apps/orchestrator/src/http/security.ts) lets
  `/api/connected-app/*` through without the local token, and refuses it with
  **any** `Origin` header, so a web page can't guess codes or ride a token.
  Each route checks the app token itself.
  - The local API token opens none of these routes.
  - An app token opens nothing else: `/api/tasks`, `/api/tool-session/*` and
    `/ws` all answer 401.
  - Every route in both groups refuses `x-acc-remote-request`.
  - None are tools, MCP tools or remote operations, and `connectedApp`
    realtime messages are never relayed to the cloud.
- **Disconnect** (`POST /api/connected-apps/:id/revoke`) stops the token at
  once. The rows and the tasks it created stay.

## Routes ([connected-app-routes.ts](../../apps/orchestrator/src/http/connected-app-routes.ts))

**Dashboard routes (local token):**

| Route | Behaviour |
|---|---|
| `GET /api/connected-apps` | `{apps, pairing: {kind, expiresAt, attemptsLeft} \| null, identity}` — never the code |
| `POST /api/connected-apps/pairings {kind}` | returns the code, its expiry and the identity (201) |
| `DELETE /api/connected-apps/pairings` | withdraws the code on offer |
| `PATCH /api/connected-apps/:id {defaultMode}` | sets `discuss` or `autopilot` |
| `POST /api/connected-apps/:id/revoke` | disconnects the app |
| `GET /api/connected-apps/task-origins` | the last 500 `{taskId, appId, kind, name}`, for the badge |

**App routes (app token):**

| Route | Behaviour |
|---|---|
| `POST /api/connected-app/pair` | no token; the code guards it |
| `POST /api/connected-app/hello {nonce}` | returns a fresh signed statement |
| `GET /api/connected-app/repositories` | `{id, name, devOrigin}`: the origin of `runtime.devUrl`, so the app can suggest one. No paths. |
| `POST /api/connected-app/tasks` | see below; 201 when created, 200 when the `requestId` already made one |
| `GET /api/connected-app/tasks` | the app's last 20 tasks |
| `GET /api/connected-app/tasks/:id` | one of its own tasks; 404 for any other task, including a dashboard-made one |
| `POST /api/connected-app/tasks/:id/evidence {requestId, evidence}` | a re-check; 201 or 200 |

A task as the app sees it contains only: `id`, `title`, `repositoryName`,
`status`, `currentStageName`, `blocker` (the message, redacted),
`finalStatus`, `createdAt`, `updatedAt` and `dashboardPath`.

Errors are `{error: {code, message}}`:

| Code | Status |
|---|---|
| `UNAUTHORIZED` | 401 |
| `NOT_FOUND` | 404 |
| `INVALID` | 400 |
| `CODE_REJECTED` | 400 |
| `RATE_LIMITED` | 429, with `retry-after` |
| `IDENTITY_UNAVAILABLE` | 503 |
| validation | 400 |

## Task intake ([service.ts](../../apps/orchestrator/src/connected-apps/service.ts))

The body is `.strict()`:

| Field | Limit |
|---|---|
| `requestId` | — |
| `repositoryId` | — |
| `note` | 1–2000 characters, the operator's own words |
| `sourceUrl` | http(s) only; reduced to origin and path |
| `evidence` | ≤ 30,000 characters |
| `screenshotJpegBase64` | optional, ≤ 1.5 M characters, must start with the JPEG magic bytes |

Any other field is refused (400). The app never chooses the mode, policy,
auto-approve level, overrides, workflow, supervision or worktree. The server
builds the task:

- **Workflow:** the repository default, else the Settings default, else
  `normal-development`.
- **Mode:** the app's `default_mode`, which only the dashboard sets. The
  default is Discuss First.
- **Description:** the note (redacted), plus one line naming the page and the
  untrusted attachment.
- **Attachments:**
  - `browser-evidence.md`: the evidence passed through `fenceEvidence`, so the
    page can't close its own `<untrusted_evidence>` fence, and redacted again.
  - `page.jpg`, when a screenshot was sent.
- **Order:** the task is created as a draft, then the link row is written,
  then the task starts. If the link fails, the draft is cancelled.
  Simultaneous retries of one `requestId` share one in-flight creation, so
  there is never a second task.

## Re-check evidence

A re-check becomes an artifact `browser-recheck-N.md` (type `browser-report`,
fenced like the intake evidence) and a `VERIFICATION` event. A final report
written after a re-check exists lists it under Verification coverage as
*Operator-observed browser evidence*. That line is informational and never
changes `READY`. A report written before the re-check is not rewritten.

## Limits

- 10 tasks per app per hour.
- 60 re-checks per app per hour, and 20 per task.
- Counts come from the tables, so they survive a restart.

## Tables (migration 12)

| Table | Contents |
|---|---|
| `connected_apps` | id, kind, name, token hash, default mode, created/last-used/revoked times |
| `connected_app_tasks` | app, task, `request_id` (unique per app), sanitised source, time |
| `connected_app_evidence` | app, task, `request_id` (unique per app), artifact, time |

These tables hold metadata only. Evidence lives in task attachments and
artifacts.

## Dashboard

- Tools → **Connected apps** ([ConnectedAppsTab.tsx](../../apps/dashboard/src/pages/tools/ConnectedAppsTab.tsx)).
  It exists on the local dashboard and in VS Code only; the cloud has no such
  tab, and `/tools/apps` falls back to Overview there.
- A **From Private Browser** badge in the task list row and the task header
  (`useTaskOrigin`).
- Realtime: `connectedApp` invalidates the `connected-apps` queries.

## Verified

- [connected-apps.test.ts](../../apps/orchestrator/test/connected-apps.test.ts)
  and [connected-app-identity.test.ts](../../apps/orchestrator/test/connected-app-identity.test.ts)
  cover:
  - the migration on top of the previous version;
  - pairing: single use, five-attempt burn, withdraw;
  - the token absent from the raw SQLite and WAL;
  - the scope matrix;
  - Origin and remote-header refusals;
  - revoke;
  - forced fields and the fence;
  - idempotent concurrent retries;
  - the hourly limit;
  - own-task isolation;
  - re-checks and the report line;
  - the statement vectors and cross-protocol refusal.
- [connected-apps.spec.ts](../../apps/dashboard/e2e/connected-apps.spec.ts)
  covers pairing, mode and disconnect in both themes, and the badge.
  `/tools/apps` is in the visual matrix.

## Gotchas

- An app token is the only credential that opens the app routes. A request
  with the local API token gets 401 there, by design.
- Clients must not send `Origin`. Electron main-process `fetch` and
  Playwright's request context don't; a page's `fetch` does, and is refused.

Last verified: 2026-09-24
