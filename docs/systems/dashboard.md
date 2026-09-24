---
system: dashboard
sources:
  - apps/dashboard/**
  - packages/ui/**
  - design.md
verified_at: 2d516aa
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

## State

The orchestrator is the only source of truth. Queries load snapshots;
[sync.ts](../../apps/dashboard/src/api/sync.ts) patches entities in place from
WebSocket messages and refreshes list membership in one debounced batch; a
reconnect invalidates everything. `useRepositoryAutomation` also polls every
5 s while a run is in progress, so a missed end-of-run message cannot leave
"Checking now…" on screen. Mutations are never optimistic for
orchestrator-owned state. Tab choice lives in the URL (`?tab=`); only per-viewer
conveniences (sidebar collapsed, log mode) use `localStorage`.

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
cannot run now — `capacityBlock`, [usage.md](usage.md#capacity)), Tasks, New Task (execution policy, isolated worktree; typing `/` in the description opens the skill picker — [SlashTextarea](../../packages/ui/src/components/slash-textarea.tsx), `useSkills`, design.md §8.3 — and a line under the field names the skills the text requests; the Directive box on Task Detail has the same picker via `useSkillPicker`), Task Detail
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
inspector — see [usage.md](usage.md)), Settings (10 sections, including Repositories; Workflows
edits the role prompt templates with the placeholder list and an unknown-placeholder
warning, see [prompts.md](prompts.md)). Routes are
lazy-loaded; logs are virtualised; diffs load per file. The Tests tab shows
each command's recorded summary — the runner's totals line when it passed,
the failure line when it failed.

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
hides Settings → Remote access and disables attachments. Local mode shows
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

Last verified: 2026-09-24
