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

## Pages

Home, Tasks, New Task, Task Detail (Overview/Activity/Changes/Tests/Artifacts/
Logs + inspector), Source Control (Changes/History, see
[source-control.md](source-control.md)), Approvals, Workflows (stage-sequence editor with inline
validation), Agents, Repositories (+ detail; a Remote column, the automation summary
line and **Check now**, see [repository-automation.md](repository-automation.md)),
Settings (10 sections, including Repositories). Routes are
lazy-loaded; logs are virtualised; diffs load per file. The Tests tab shows
each command's recorded summary — the runner's totals line when it passed,
the failure line when it failed.

## Quality gates

`pnpm e2e` ([e2e/](../../apps/dashboard/e2e)) runs the design.md §19 matrix:
every page at 1440/1280/1024/768/390 px in Dark and Light, asserting no
page-level horizontal scroll, no console errors and zero axe WCAG 2.2 AA
violations; plus keyboard/dialog/realtime/disconnection flows and the VS Code
WebView harness. A global teardown shuts the demo orchestrator down through
`/api/service/shutdown`, because on Windows Playwright stops `demo.mjs` but not
the orchestrator it spawned, which would hold the port for the next run.

## Gotchas

- Context values consumed in effects must have stable identities: an unstable
  `register` in the command registry once caused an infinite render loop that
  silently froze in-page navigation.
- Controlled Radix dialogs/drawers return focus to the element that opened them
  via `useReturnFocus` in [overlays.tsx](../../packages/ui/src/primitives/overlays.tsx).
- Scrollable regions without focusable content need `tabIndex={0}`.

Last verified: 2026-09-23
