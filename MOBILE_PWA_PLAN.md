# MOBILE_PWA_PLAN — the Control Center on a phone, installed like an app

Status: proposed 24/09/2026. Owner systems: [dashboard](docs/systems/dashboard.md),
[cloud-control](docs/systems/cloud-control.md). Read [design.md](design.md) first
(mandatory for any frontend change).

---

## 1. Goal

From the phone's home screen, the operator opens the cloud dashboard
(`acc.dr-badawi-abdalsalam.com`) full-screen and sees **live, correct** state.
It keeps that state correct after the phone sleeps, changes network, sits in
the background for hours, or outlives a release. When it can't show live state,
it says so plainly and never shows a stale screen as if it were current.

"Mobile friendly" is mostly **already built**. The investigation below shows
the missing parts are installability and the ways a long-lived phone session
goes stale without saying so. The plan fixes those root causes and doesn't
redo the layout.

## 2. Scope

### What the investigation found

| Area | Current state (verified in code) | Consequence on a phone |
|---|---|---|
| Layout | Every page is tested at 390×844 in Dark and Light: no page-level horizontal scroll, axe WCAG 2.2 AA, no console errors ([matrix.spec.ts](apps/dashboard/e2e/matrix.spec.ts), [helpers.ts](apps/dashboard/e2e/helpers.ts)) | Already mobile-sized. **No layout rework.** |
| Navigation | Phones get a drawer, tablets a rail ([Shell.tsx:392-418](apps/dashboard/src/app/Shell.tsx#L392-L418)); `h-dvh` / `min-h-dvh` are used | Works |
| Touch targets | `pointer-coarse:min-h-11` / `min-w-11` on buttons, inputs, menus, palette ([button.tsx](packages/ui/src/primitives/button.tsx), [controls.tsx](packages/ui/src/primitives/controls.tsx), [fields.tsx](packages/ui/src/primitives/fields.tsx)); no `group-hover`-only controls | Meets design.md's 44 px rule |
| Installability | [index.html](apps/dashboard/index.html) has no manifest, no `theme-color`, and no PNG or maskable icons (only `favicon.svg`) | **Cannot be installed.** Root cause #1 |
| Realtime liveness | [realtime.ts](apps/dashboard/src/api/realtime.ts) reconnects on `close` and on `online` only. The client **never sends `ping`**, although both servers answer it ([hub.ts:73](apps/cloud-control/src/hub.ts#L73) auto-responds; [ws.ts:73](apps/orchestrator/src/http/ws.ts#L73) replies `pong`). No `visibilitychange` handling. `refetchOnWindowFocus: false` ([App.tsx:88](apps/dashboard/src/app/App.tsx#L88)) | After the phone sleeps or switches from Wi-Fi to mobile data, the socket can be half-open: no `close` fires, the indicator says connected, and **updates stop arriving without any sign**. Root cause #2 |
| Sign-in expiry | The Access session is checked only at boot ([main.tsx](apps/dashboard/src/main.tsx)). Later, an expired session makes Access redirect `fetch` to the team domain. The cross-origin redirect throws, and [client.ts:64](apps/dashboard/src/api/client.ts#L64) reports "The control plane is not reachable. Check your connection." | An installed app left open for days tells the operator their **network** is broken when the real problem is the **sign-in**. Root cause #3 |
| Release skew | Routes are `lazy()` chunks ([App.tsx:15-24](apps/dashboard/src/app/App.tsx#L15-L24)). A Worker release replaces the asset set, and nothing handles a failed dynamic import | A page opened before a release and kept for days gets a blank or failed page on the next navigation. Root cause #4 |
| Serving | The Worker runs first for every asset ([wrangler.jsonc](apps/cloud-control/wrangler.jsonc)) and verifies Access on every request, assets included ([control.ts:57-91](apps/cloud-control/src/routes/control.ts#L57-L91)). HTML is `no-store` with `DASHBOARD_CSP` ([http.ts](apps/cloud-control/src/http.ts)) | By spec, a manifest is fetched **without cookies**, so it would get the Worker's 401 and install would silently fail. The link must use `crossorigin="use-credentials"` |
| Token exposure | Local mode injects `acc-token` into `index.html` ([server.ts:96](apps/orchestrator/src/http/server.ts#L96)); [main.tsx](apps/dashboard/src/main.tsx) removes it after reading | Any service worker that cached HTML would store the token on disk. **So: no service worker** |

### In scope

1. Web app manifest, icons and `theme-color` for the web build (cloud and local).
2. Realtime liveness: a heartbeat plus a check when the app returns to the foreground.
3. A clear "Sign-in expired → Sign in again" state in cloud mode.
4. Recovery from release skew (a stale chunk reloads once, then says so).
5. Tests for each, one extra check in the smoke script, and doc updates.

### Out of scope (and why)

- **Service worker, offline cache.** The Worker already serves offline reads from
  D1/R2 (`x-acc-source: cache`, [offline.ts](apps/cloud-control/src/offline.ts)).
  A service worker would add stale-bundle risk and, in local mode, would put the
  token at risk. Current Chrome installs a page without a service worker. (See §5
  for the fallback if the handset disagrees.)
- **Push notifications.** They need a service worker, VAPID keys through
  secret-custody, and a new D1 table. That can come later (§9).
- Layout rework, a new mobile navigation, a native wrapper, the VS Code
  webview build (it uses its own entry and never loads `index.html`).
- Any change to Access policy, the CSP's allowed origins, or auth.

## 3. Enhanced design / architecture

```
Phone home screen ──► https://acc.dr-badawi-abdalsalam.com/  (display: standalone)
                        │  Cloudflare Access (edge)  ──►  Worker verifyAccess (every path)
                        │
   index.html  ── <link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
                  <meta name="theme-color" …light/dark>  <link rel="apple-touch-icon" …>
   manifest.webmanifest, icons/*.png   (static, from apps/dashboard/public → dist/web)

   Runtime (dashboard, no new state owner — the orchestrator stays the only source of truth):
   RealtimeClient ─ ping every 25 s while visible; no pong within 10 s → close → existing
                    backoff/reconnect → existing onOpen(isReconnect) refetch
                  ─ visibilitychange→visible / pageshow(persisted) / online → probe now
   Cloud session watch ─ an API call fails UNREACHABLE/401 in cloud mode → GET /api/cloud/session
                    with redirect:'manual' → opaqueredirect | 401 | 403 ⇒ sessionExpired
                    → one Shell banner: "Your sign-in expired." [Sign in again] (full reload)
   Release skew  ─ window 'vite:preloadError' → reload once (sessionStorage guard, 60 s);
                    second failure within the guard → ErrorState "A new version is available" [Reload]
```

Design decisions (trade-off → pick):

- **Manifest as a static file in `public/`**, not a build plugin. It stays
  readable and diffable with no new dependency. The same file serves local
  mode, where installing on the desktop is harmless: the token is injected on
  every page load and is never part of the manifest.
- **`id: "/"`, `start_url: "/"`, `scope: "/"`.** A stable `id` means a later
  `start_url` change doesn't create a second installed app.
- **Colours come from design tokens** ([tokens.css](packages/ui/src/styles/tokens.css)):
  `background_color` = Dark canvas. `theme-color` uses two `<meta>` tags with
  `media="(prefers-color-scheme: …)"` holding the Dark and Light canvas values.
  No new colours.
- **Icons are rendered once from `favicon.svg` by a committed script** using the
  existing `@playwright/test` Chromium: 192, 512, a 512 maskable on the canvas
  colour with a 20% safe zone, and a 180 apple-touch-icon. PNGs are committed.
  No new dependency, and the script runs again whenever the logo changes.
- **The heartbeat reuses the existing `{type:'ping'}` / `{type:'pong'}` protocol.**
  No server change. `pong` is added to the shared `ServerMessage` type and
  consumed inside `RealtimeClient`, so it never reaches `sync.ts`.
- **Session expiry is detected by a probe, not by guessing** from one failed
  call. A real network outage keeps today's "not reachable" message.
- **No new routes, no migration, no Worker change** except one line in the
  smoke script.

## 4. Implementation steps

Each step is small, stands on its own, and keeps `pnpm check` green.

1. **Icons.** Add `scripts/render-app-icons.mjs`. It launches Chromium through
   `@playwright/test`, renders `apps/dashboard/public/favicon.svg` and writes
   `apps/dashboard/public/icons/{icon-192.png, icon-512.png,
   icon-maskable-512.png, apple-touch-icon.png}`. Run it once and commit the
   PNGs.
2. **Manifest.** Add `apps/dashboard/public/manifest.webmanifest` with `id`,
   `name` "AI Development Control Center", `short_name` "Control Center",
   `start_url` "/", `scope` "/", `display` "standalone", `orientation` "any",
   `background_color` and `theme_color` (Dark canvas token value), and `icons`
   (any + maskable).
3. **index.html.** Add the manifest link with `crossorigin="use-credentials"`,
   the two `theme-color` metas, `apple-touch-icon`, and
   `<meta name="mobile-web-app-capable" content="yes">`. Leave the viewport
   meta unchanged. `viewport-fit=cover` is deliberately not added, so no
   safe-area work is needed.
4. **Heartbeat.** In [realtime.ts](apps/dashboard/src/api/realtime.ts):
   - Add a `ping` every 25 s while `document.visibilityState === 'visible'`
     and the socket is open.
   - Arm a 10 s pong deadline. When it expires, close the socket, which runs
     the existing retry and `onOpen` refetch.
   - Add a `probe()` called on `visibilitychange` (visible), on
     `pageshow` (`persisted`), and from the existing `online` listener. If
     the socket isn't open, it runs `reconnectNow()`; if it is open, it sends
     a ping with the deadline.
   - `stop()` removes all listeners and timers.
   - Add `{ type: 'pong' }` to `ServerMessage` in
     [packages/shared/src/ws.ts](packages/shared/src/ws.ts) and handle it
     inside the client.
5. **Session watch (cloud only).** Add `apps/dashboard/src/api/session.ts`
   with a tiny `SessionWatch`: a state of `ok` or `expired`, `subscribe`, and
   `check()`. `check()` is de-duplicated so only one probe runs at a time,
   and at most one probe runs per 15 s.
   - In [client.ts](apps/dashboard/src/api/client.ts), cloud mode only: on
     `UNREACHABLE` or HTTP 401 call `check()`. The `ApiError` thrown to the
     caller is unchanged.
   - `RealtimeClient` calls `check()` after 2 consecutive failed connects in
     cloud mode.
   - [Shell.tsx](apps/dashboard/src/app/Shell.tsx) renders one sticky
     `Banner` (existing shared component, danger tone): "Your sign-in
     expired." with a **Sign in again** button that runs
     `location.reload()`. The reload goes through Access and lands back on
     the same URL.
6. **Release skew.** In [main.tsx](apps/dashboard/src/main.tsx), listen for
   `vite:preloadError`: `preventDefault()`, and reload once if
   `sessionStorage['acc.reloaded-for-chunk']` is older than 60 s or missing
   (wrapped in try/catch). Otherwise let the route's error state show a
   "A new version is available — Reload" message through the existing
   `ErrorState` component.
7. **Smoke.** In [smoke.mjs](apps/cloud-control/scripts/smoke.mjs), add a check
   that `GET /manifest.webmanifest` **without** sign-in is refused. This is the
   same fail-closed check as `/`: the manifest is covered by Access like
   everything else.
8. **Docs.** Update [dashboard.md](docs/systems/dashboard.md): an
   "Installable app (PWA)" section, the heartbeat, the session watch and
   release-skew behaviour, and a Gotcha: *"`crossorigin="use-credentials"` on
   the manifest link is load-bearing — without it, Access/the Worker 401 the
   manifest and install silently disappears."* Add a line to
   [cloud-control.md](docs/systems/cloud-control.md) under "Dashboard in cloud
   mode". Add `Last verified:` dates.
9. **Release.** `pnpm check`, `pnpm build && pnpm e2e`, `pnpm e2e:cloud`, then
   `pnpm cloud:deploy:production` (it serves the new `dist/web`), then
   `pnpm cloud:smoke`. Restart the local orchestrator so local mode serves the
   new build.

## 5. Failure handling and recovery

| Failure | Behaviour after this plan | Loud or quiet |
|---|---|---|
| Phone sleeps; socket half-open | Pong deadline passes → close → reconnect → `onOpen(true)` refetches everything | Loud: the connection indicator goes to "Reconnecting" |
| Wi-Fi → mobile data switch | `online`/`visibilitychange` probe → same as above | Loud |
| Access session expired | Probe sees a redirect/401 → banner **Sign in again** | Loud, with the correct cause |
| Real network outage | The probe itself fails with a network error, so no expiry banner. Today's "not reachable" message stays | Loud, as today |
| Probe storm (many failing calls) | One probe at a time, at most one per 15 s | — |
| Release while the app is open | The first stale chunk reloads once. A second failure within 60 s shows "A new version is available — Reload" | Loud. No reload loop |
| `sessionStorage` unavailable (private mode) | The guard is treated as "already reloaded", so there's no auto-reload and the Reload message shows | Loud. No loop |
| Handset refuses to install without a service worker (older Chrome) | Fallback, **only if seen on the device**: add `/sw.js` with **no `fetch` handler** (caches nothing), registered only when `detectMode() === 'cloud'`. Record the Chrome version in dashboard.md | — |
| Chrome won't fetch icons behind Access (DevTools Installability lists an icon error) | Fallback: inline the icons into the manifest as `data:` URIs (the CSP already allows `img-src data:`). Never open an Access bypass | — |
| Bad release | `wrangler rollback <version-id> --env production` (documented). The manifest and icons are static, so rollback restores the previous page fully | — |

Nothing in this plan writes data. There is no migration and nothing to back
up. Every step can be undone with a git revert and a new release.

## 6. Security and data protection

- **No service worker and no Cache Storage**, so no copy of any HTML, API
  response or local token exists on disk beyond what the browser already keeps.
- The manifest and icons stay **behind Access and the Worker's own check**.
  There's no bypass path and no public file, and step 7 proves it fails closed.
- `crossorigin="use-credentials"` sends the Access cookie **only to the same
  origin**. The CSP (`default-src 'self'`, which covers `manifest-src`) is
  unchanged.
- The session watch never reads, stores or forwards the Access cookie or
  token. It only reads a response status and type, and "Sign in again" is a
  plain reload through Access.
- The heartbeat sends a fixed `{"type":"ping"}`: no identity, no payload.
- The Host/Origin/token checks, the subscription-only guard, the tool policy
  and redaction are all untouched. Nothing here needs a test proving a
  weakened guard.
- No secrets and no new dependencies. The icon script uses the existing
  `@playwright/test`.

## 7. Testing and verification

Automated, all green before release:

- **Unit (vitest), `apps/dashboard`:**
  - The `RealtimeClient` heartbeat with a fake WebSocket and fake timers:
    ping while visible and silence while hidden; a missed pong closes the
    socket and reconnects; a `visibilitychange` probe while closed reconnects
    at once; `stop()` clears everything.
  - `SessionWatch`: an `opaqueredirect`, 401 or 403 means expired; a network
    error means ok; de-duplicated with the 15 s floor.
  - The chunk-reload guard: reload once, then no reload within 60 s, and no
    reload when storage throws.
- **e2e (`pnpm e2e`), new `apps/dashboard/e2e/pwa.spec.ts`:**
  - `/manifest.webmanifest` parses, has `id`, `start_url`, `display:
    standalone`, and 192 + 512 + maskable icons that each return 200 as
    `image/png`.
  - `index.html` has the manifest link with `crossorigin="use-credentials"`.
  - At 390×844 with `hasTouch: true`, Home, Tasks and Task Detail open, and
    New Task can be submitted by tap.
  - A heartbeat test: block the WS (route abort) while the page stays
    "visible", then assert the indicator leaves "Connected" within 40 s and
    recovers when unblocked.
- **Cloud e2e (`pnpm e2e:cloud`), [cloud.spec.ts](apps/dashboard/e2e-cloud/cloud.spec.ts):**
  - Manifest fetched **with** the test Access identity returns 200, and
    **without** it returns 401.
  - Clear the Access cookie mid-session and trigger a request: the "Your
    sign-in expired" banner appears, and "not reachable" doesn't.
- **Existing matrix** stays green in both themes: `pnpm e2e` covers
  1440/1280/1024/768/390, axe, and no overflow.
- `pnpm check` (typecheck, lint, tests). The pre-commit secret scan passes.

On real hardware (operator's PC and handset):

- **browser-autopilot:** open production in Simple Browser. With Playwright MCP,
  open DevTools → Application → Manifest. **Installability shows no errors**.
  Take a screenshot to `C:\Users\abuye\.claude\browser\playwright-mcp\`.
- **phone-autopilot:**
  1. Open the production URL in Chrome on the handset.
  2. Install it. The icon appears on the home screen.
  3. Launch it. It opens standalone with no URL bar and shows the Home page
     live.
  4. Lock the phone for 5 minutes, then unlock it. The indicator shows
     reconnecting and then live, and a task changed in the meantime shows its
     new state.
  5. Toggle Wi-Fi off and back on. Same result.
  6. Evidence goes under `$HOME/.claude/phone/`.

## 8. Success criteria

All must be verified, not assumed:

1. Chrome DevTools reports the production dashboard **installable with zero
   manifest or installability errors**.
2. On the operator's Android handset the app **installs, shows the Control
   Center icon, and launches standalone** into a live Home page.
3. After a **5-minute screen lock** and after a **Wi-Fi toggle**, the app
   reconnects by itself and shows current task state within 30 s of coming
   back. No manual reload.
4. With the Access session removed, the app shows **"Your sign-in expired"**
   (not "not reachable"). **Sign in again** returns to the same page signed
   in.
5. A stale-chunk load after a release causes **at most one automatic reload
   and never a loop**.
6. `GET /manifest.webmanifest` without sign-in is **refused in production**
   (`pnpm cloud:smoke` green).
7. `pnpm check`, `pnpm e2e` (full matrix, both themes), and `pnpm e2e:cloud`
   are all green. No existing test is weakened or skipped.
8. dashboard.md and cloud-control.md describe the new behaviour, with
   today's `Last verified:` dates.

## 9. Found for later

- **Push notifications for approvals and decision blockers.** Worth building
  only if an approval regularly waits more than an hour while the operator is
  away from the PC. It needs a service worker (push only, no fetch
  handler), VAPID keys via secret-custody, a D1 subscriptions table, and a
  Worker sender.
- **Access session length.** A phone app benefits from a longer Access session
  (for example 7 days) on the control application. That is a policy decision
  in the Zero Trust dashboard, not code.
- **iOS standalone sign-in.** Access redirects in iOS standalone PWAs use a
  separate cookie jar. Verify only if an iPhone is ever used.
- **Local-mode realtime.** The same half-open socket fix also helps laptops
  after sleep. It ships with this plan at no extra cost; no further work is
  needed.

## 10. Next recommended task

**Approval push notifications** (§9, first item). The point of a phone app for
this product is answering "needs your decision" and approvals without walking
to the PC. Start it only after this plan's criteria 2–3 hold on the real
handset for a week.

## 11. Final execution prompt

> Implement `MOBILE_PWA_PLAN.md` in `AI-Development-Control-Center`. Read
> `AGENTS.md`, `design.md`, `docs/systems/dashboard.md` and
> `docs/systems/cloud-control.md` first, and re-verify §2's findings against
> the current code before editing. Build steps 1–9 in order:
> - Add the icons and the manifest, plus the `index.html` links, with
>   `crossorigin="use-credentials"`.
> - Add the `RealtimeClient` heartbeat and visibility probe, and add `pong`
>   to the shared WS types.
> - Add the cloud-only `SessionWatch` with the Shell banner.
> - Add the one-shot `vite:preloadError` reload.
> - Add the manifest check to the smoke script.
> - Update the docs.
>
> Don't add a service worker, a dependency, a route, a migration, or any
> Access/CSP change. Take §5's fallbacks only if the handset proves they're
> needed.
>
> Add the unit, e2e and cloud-e2e tests in §7. Run `pnpm check`,
> `pnpm build && pnpm e2e` and `pnpm e2e:cloud`, then release with
> `pnpm cloud:deploy:production` and `pnpm cloud:smoke`. Verify installability
> with browser-autopilot, and verify install, standalone launch,
> lock/unlock and Wi-Fi-toggle recovery with phone-autopilot on the real
> handset.
>
> Stage explicit paths only (other sessions share this working tree). Commit
> with the `[autopilot]` trailer and push to `main`. Report each §8 criterion
> as checked, not verified, or couldn't check.

## Irreversible steps

- **Production release of the cloud Worker** (`pnpm cloud:deploy:production`).
  It can be rolled back with `wrangler rollback`, but every open dashboard
  reconnects, and the release is visible to anyone signed in.
- **Push to `origin/main`.** It becomes shared history.

## Assumptions

- Current Android Chrome installs a manifest-only page without a service
  worker. If this is false, §5 has a fetch-handler-free fallback.
- Chrome sends same-origin cookies when it fetches the manifest with
  `use-credentials`, and when it fetches icons. If icons fail, §5 inlines
  them as data URIs.
- Access answers an expired-session `fetch` with a redirect or 401, never a
  200 HTML page. If it returns 200 HTML, the session watch also treats a
  `text/html` response to `/api/cloud/session` as expired.

---

/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.
