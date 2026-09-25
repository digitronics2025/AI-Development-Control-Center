---
system: dashboard
sources:
  - apps/dashboard/**
  - packages/ui/**
  - design.md
verified_at: b9ce60f
---

# Dashboard and design system

Implements [design.md](../../design.md). React 19 + Vite 8 + Tailwind 4,
React Router 7, TanStack Query. Shared primitives and tokens:
[packages/ui](../../packages/ui/src).

## Builds

| Mode | Output | Entry |
|---|---|---|
| web | `apps/dashboard/dist/web` (served by the orchestrator at `/`) | [main.tsx](../../apps/dashboard/src/main.tsx), `BrowserRouter` |
| webview | `apps/dashboard/dist/webview/webview.{js,css}` (copied into the extension) | [webview-main.tsx](../../apps/dashboard/src/webview-main.tsx), `MemoryRouter`, `data-theme="vscode"` |

`pnpm --filter @acc/dashboard dev` runs Vite on 5173 with `/api` and `/ws`
proxied to the orchestrator and the token read from the data folder.

## Chairman

The task header's **Chairman** button opens
[ChairmanDrawer.tsx](../../apps/dashboard/src/pages/task/ChairmanDrawer.tsx)
(design.md §7.3.1): state and health chips, limits, active directives (remove
via the actions endpoint), the conversation with decision and action cards,
and the composer (client message ids make sends idempotent). Data:
`useChairman` (`/api/tasks/:id/chairman`) patched live by `sync.ts`. Settings →
Chairman edits `settings.chairman`.

## Ask

The **Ask** sidebar item (local and VS Code only) opens `/ask`. The palette's
**Ask a question** and `?question` open the Ask drawer in the Shell. Turn into
task pre-fills New Task through router state. Settings → Ask (local only)
chooses the read-only keys, owners, account, masking default and data map and
runs Check access; each answer lists its lookups under "Sources". See
[ask.md](ask.md).

## State

The orchestrator is the only source of truth. Queries load snapshots;
[sync.ts](../../apps/dashboard/src/api/sync.ts) patches entities in place from
WebSocket messages and refreshes list membership in one debounced batch; a
reconnect invalidates everything. `useRepositoryAutomation` also polls every
5 s while a run is in progress, so a missed end-of-run message cannot leave
"Checking now…" on screen. Mutations are never optimistic for
orchestrator-owned state. Tab choice lives in the URL (`?tab=`); only per-viewer
conveniences use `localStorage`: sidebar collapsed, log mode, the resolved theme,
the selected cloud node, the last Source Control repository and per-repository
commit-message drafts.

## Tokens

[tokens.css](../../packages/ui/src/styles/tokens.css) holds the exact design.md
values for Dark and Light and a VS Code mapping. Tailwind's default palette is
removed, so only semantic colours exist (`bg-surface`, `text-fg-secondary`,
`bg-danger-muted`…). Contrast rules are in design.md §4.2.

A theme change applies at once: [theme.ts](../../apps/dashboard/src/app/theme.ts)
sets `data-theme-switching` on `<html>` for two frames and
[index.css](../../packages/ui/src/styles/index.css) turns transitions off while
it is present. Otherwise every `transition-colors` control animated from the old
palette, and an accessibility scan taken in that moment (CI, Chairman e2e)
measured mixed, low-contrast colours. The e2e `setTheme` helper waits for the
new `data-theme` before any check.

## Pages

A task stopped on blocker `decision` shows "<Stage> needs your decision" with
the question, and its primary action is **Answer**: the directive dialog
becomes "Answer the question" (the question, "Your answer", **Answer and
continue**); the task resumes on its own ([task-actions.tsx](../../apps/dashboard/src/components/task-actions.tsx),
[dialogs.tsx](../../apps/dashboard/src/pages/task/dialogs.tsx)).

Home (System Health marks a signed-in agent whose last run reported it
cannot run now — `capacityBlock`, [usage.md](usage.md#capacity)), Tasks, New Task (execution policy, isolated worktree; **Also work in** adds linked repositories — local only, the worktree switch then locked on — [multi-repository-tasks.md](multi-repository-tasks.md); typing `/` in the description opens the skill picker — [SlashTextarea](../../packages/ui/src/components/slash-textarea.tsx), `useSkills`, design.md §8.3 — and a line under the field names the skills the text requests; the Directive box on Task Detail has the same picker via `useSkillPicker`), Task Detail
(Overview/Activity/Changes/Tests/Artifacts/Logs/Execution + inspector), Source Control (Changes/History, see
[source-control.md](source-control.md)), Approvals, Workflows (stage-sequence editor with inline
validation), Agents, Repositories (+ detail; a Remote column, the automation summary
line and **Check now**, see [repository-automation.md](repository-automation.md)),
Tools (`/tools/:tab`: Overview, Processes, Terminals, MCP servers,
Credentials, Connected apps (local and VS Code only), Policy — see
[tool-system.md](tool-system.md); Connected apps is
[pages/tools/ConnectedAppsTab.tsx](../../apps/dashboard/src/pages/tools/ConnectedAppsTab.tsx),
see [connected-apps.md](connected-apps.md), and tasks a connected app created
carry a From Private Browser badge in the task row and header; Credentials lives in
[pages/tools/CredentialsTab.tsx](../../apps/dashboard/src/pages/tools/CredentialsTab.tsx), and the
bare `/vault-bridge` page is MyVault's popup relay, rendered outside the Shell —
see [credential-broker.md](credential-broker.md)),
Usage & Costs (`/usage`: Overview, Tasks, Models, Agents, Providers, Budgets,
Attempts; `/usage/tasks/:id` cost ledger; a live Usage panel in the task
inspector — see [usage.md](usage.md)), Settings (12 sections, including Repositories; Workflows
edits the role prompt templates with the placeholder list and an unknown-placeholder
warning, see [prompts.md](prompts.md); a settings broadcast replaces the draft only
when there are no unsaved edits, otherwise a "changed elsewhere" banner offers Load
or Keep; the API-billing dialog's typed phrase is sent to and checked by the server). Routes are
lazy-loaded; logs are virtualised; diffs load per file. The Tests tab shows
each command's recorded summary — the runner's totals line when it passed,
the failure line when it failed — plus the first failing test ids; a failure
the baseline commit already had gets a warning icon and a **pre-existing**
badge (and is counted apart in the run header), a pass taken from identical
files a **reused** badge, and checks the operator waived an info banner
quoting the directive ([workflow-engine.md](workflow-engine.md#gates-that-tell-the-truth)).
The Answer and Add directive dialogs show **Don't gate this task on**: one
checkbox per check kind that failed in this task and is not waived yet; a
ticked box sends rule `waive_check` with the directive (an empty text becomes
"Don't gate this task on …"). The task header says where the task works: its
isolated worktree, or plainly "your own folder". A repository not in worktree
mode shows **Tasks run in your working folder** with **Use isolated
worktrees** on its page.

**Releases** ([release.md](release.md)). Repository detail has a **Release**
panel ([ReleasePanel.tsx](../../apps/dashboard/src/pages/ReleasePanel.tsx)):
Off / Push to a branch, remote, branch, live URL, the proofs (Cloudflare Pages
project, version URL — at least one), manual paths and the wait, validated
with the orchestrator's own `releaseConfigSchema`, saved with **Save
Changes**; **Check setup** checks the form as it is (saved or not) and lists
each read-only check with an icon and words. The task list and task header
carry a `ReleaseStateChip` (Live, Sent — checking, Sent — not confirmed,
Release failed, Not released). On a completed task of a releasing repository
the header offers **Release…** (secondary; it only requests the typed approval
and opens Approvals, where the card reads "Approve production release"), and
Overview opens with a **Release** card
([ReleaseCard.tsx](../../apps/dashboard/src/pages/task/ReleaseCard.tsx)):
state, commit, target, times, each proof with its evidence, and **Check
again** for a release that was sent and is not Live. Repository data from the
cloud may lack `release`; the UI then offers no Release actions.

Once a task has started, Overview shows **Where the time went**
(`TimeCard` in [OverviewTab.tsx](../../apps/dashboard/src/pages/task/OverviewTab.tsx),
`useTaskTime` → `GET /api/tasks/:id/time`, refetched every 30 s while the task
runs): one duration per bucket, the baseline comparison inside Checks, and how
often agents ran a full suite themselves ([workflow-engine.md](workflow-engine.md)).

## Tool layer views

- **Execution tab** ([ExecutionTab.tsx](../../apps/dashboard/src/pages/task/ExecutionTab.tsx)):
  the task's policy and working directory, tool calls, processes (with
  **Stop**), recovery attempts, capability escalations and checkpoints (with
  **Create checkpoint** and **Roll back**), from `/api/tasks/:id/execution`.
- **Terminal** ([terminal.tsx](../../apps/dashboard/src/components/terminal.tsx)):
  xterm in a drawer (Execution tab → **Open terminal**, Tools → Terminals).
  Output arrives only after `subscribeTerminal`; keystrokes and resizes go
  back over the same WebSocket ([pty.md](pty.md)). xterm ships only in the
  lazy Task Detail and Tools route chunks.
- Repository detail edits the repository's policy, Git mode *Isolated
  worktree* and the **App runtime** used by the App check.

## Installable app (PWA)

The web build is installable to a phone's home screen (and as a desktop app).
It's meant for the cloud dashboard; installing the local one is harmless
because the token arrives with each page load and is never part of the
manifest. Plan: [MOBILE_PWA_PLAN.md](../../MOBILE_PWA_PLAN.md).

- **Manifest and icons.** They live in
  [public/](../../apps/dashboard/public/):
  - [manifest.webmanifest](../../apps/dashboard/public/manifest.webmanifest)
    has `id` and `start_url` set to `/`, `standalone`, and colours from the
    Dark canvas token.
  - `icons/` holds 192, 512, 512 maskable and a 180 apple-touch icon.
  - The icons are rendered from `favicon.svg` by
    [render-app-icons.mjs](../../apps/dashboard/scripts/render-app-icons.mjs)
    (Playwright's Chromium). Re-run it and commit the PNGs whenever the logo
    changes.
- **Status-bar colour.** One `theme-color` meta, set by
  [theme.ts](../../apps/dashboard/src/app/theme.ts) to the canvas colour of the
  theme the app actually shows. It isn't keyed to the phone's light/dark
  setting, which put a white status bar over the dark app on a light-mode
  phone.
- **No service worker, no Cache Storage, on purpose.** The cloud already
  answers offline reads from D1/R2. A cached `index.html` would hold the local
  token, and a cached bundle would outlive releases. Current Chrome installs a
  page without one.
- **Realtime liveness** ([realtime.ts](../../apps/dashboard/src/api/realtime.ts)).
  A phone that slept or changed network can keep a socket that never closes.
  - While the page is visible, it sends `{"type":"ping"}` every 25 s and
    waits up to 10 s for any answer. It also pings at once on
    `visibilitychange` (visible), `pageshow` and `online`.
  - When nothing answers, the socket is replaced, which runs the normal
    reconnect and full refetch.
  - The ping is sent **undecorated**: the cloud hub answers that exact string
    itself, and the orchestrator replies `pong`. A `pong` never reaches
    `sync.ts`.
- **Expired sign-in (cloud)** ([session.ts](../../apps/dashboard/src/api/session.ts)).
  - Each of these asks `SessionWatch` for a check: a request that got no
    answer, a 401, a non-JSON reply, or a second failed socket reconnect.
  - The check is at most one probe per 15 s. It sends `GET /api/cloud/session`
    with `redirect: 'manual'`. An Access redirect, 401, 403 or HTML page means
    expired. A network error doesn't.
  - Expired shows one Shell banner, "Your sign-in expired.", with **Sign in
    again** (a reload through Access). Before, this looked like "The control
    plane is not reachable."
- **Release skew** ([reload.ts](../../apps/dashboard/src/app/reload.ts),
  [PageErrorBoundary.tsx](../../apps/dashboard/src/app/PageErrorBoundary.tsx)).
  A page open across a release asks for route chunks that no longer exist.
  - `vite:preloadError` reloads once (guarded for 60 s in `sessionStorage`,
    and never without storage).
  - A repeat reaches the per-page error boundary: "A new version is
    available." with **Reload**. The Shell stays usable.
  - Any other render error now stays inside the page instead of blanking the
    app.
- Tests: [pwa.spec.ts](../../apps/dashboard/e2e/pwa.spec.ts) covers the
  manifest, taps at 390 px, a silent socket and a missing chunk. Cloud test 16
  in [cloud.spec.ts](../../apps/dashboard/e2e-cloud/cloud.spec.ts) covers the
  manifest behind sign-in and the expired banner. It also asks Chrome for its
  installability verdict (`Page.getInstallabilityErrors` must be empty) in a
  real, non-incognito profile, because Chrome reports `in-incognito` for every
  Playwright test context. Unit tests are
  `realtime.test.ts`, `session.test.ts` and `reload.test.ts`.

## Quality gates

`pnpm e2e` ([e2e/](../../apps/dashboard/e2e)) runs the design.md §19 matrix:
every page at 1440/1280/1024/768/390 px in Dark and Light, asserting no
page-level horizontal scroll, no console errors and zero axe WCAG 2.2 AA
violations; plus keyboard/dialog/realtime/disconnection flows and the VS Code
WebView harness. [journey.spec.ts](../../apps/dashboard/e2e/journey.spec.ts)
walks the whole product once against a real Git repository it creates: add
the repository and its App runtime in the UI, a Discuss First task on Full
Autopilot, plan approval, a failed review and one fix cycle, the repository's
real `node --test` suite, the app started and checked in Chromium, the Git
checkpoint commit — then checks the commit, branch and working tree on disk
against what the task page, Source Control and Usage show. A global teardown shuts the demo orchestrator down through
`/api/service/shutdown`, because on Windows Playwright stops `demo.mjs` but not
the orchestrator it spawned, which would hold the port for the next run.

## Cloud mode

The same build runs in two modes ([mode.ts](../../apps/dashboard/src/app/mode.ts)):
**local** when the page carries the `acc-token` meta tag (orchestrator, VS Code
webview), **cloud** when served by the cloud Worker without it. `ApiConfig.auth`
is `{kind:'local', token}` or `{kind:'cloud', node()}`; cloud requests send
`x-acc-node` and an `Idempotency-Key`, and a command still running surfaces as
`REMOTE_PENDING` (decided by `x-acc-command-status`, not the 202). Cloud mode adds
the Nodes page (`/nodes`), the top-bar node selector (remembered in
localStorage), offline and update-required banners, New Task "Run on" /
"Run when the node is back", and a confirmation before a remote terminal; it
hides Settings → Remote access, Learning, Tools → Connected apps and the vault
bridge page, and disables attachments. Local mode shows
Settings → Remote access instead. Tests: `pnpm e2e:cloud`
([e2e-cloud/](../../apps/dashboard/e2e-cloud/)). See
[cloud-control.md](cloud-control.md#dashboard-in-cloud-mode).

## Gotchas

- Context values consumed in effects must have stable identities: an unstable
  `register` in the command registry once caused an infinite render loop that
  silently froze in-page navigation.
- Controlled Radix dialogs/drawers return focus to the element that opened them
  via `useReturnFocus` in [overlays.tsx](../../packages/ui/src/primitives/overlays.tsx).
- Scrollable regions without focusable content need `tabIndex={0}`.
- `crossorigin="use-credentials"` on the manifest link in
  [index.html](../../apps/dashboard/index.html) is load-bearing. Browsers
  fetch a manifest without cookies by default, and the Worker (and Access)
  refuse it with 401, so the install option quietly disappears.
- With an expired cloud sign-in, a route chunk also fails with 401. The
  one-time reload then goes through Access, which is the right recovery. In
  the local cloud e2e harness, which has no Access in front, it lands on the
  Worker's JSON 401 instead.

Last verified: 2026-09-25
