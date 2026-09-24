---
system: browser-and-web
sources:
  - packages/tools/src/packs/browser.ts
  - packages/tools/src/packs/browser-session.ts
  - packages/tools/src/packs/web.ts
  - packages/tools/src/packs/cloudflare.ts
  - packages/mcp/src/bridge.ts
  - apps/orchestrator/src/http/tool-routes.ts
verified_at: 748cd29
---

# Browser pages, web research and past Worker logs

The capabilities that let an agent work the way the operator does in VS Code:
look at a page, act on what it sees, look again; search and read the web; read
a Worker's past logs. They are ordinary providers behind `ToolService.invoke`
([tool-system.md](tool-system.md)): routed, policy-checked, recorded, redacted.
Chosen from the operator's own VS Code history (60 days, 1,235 sessions):
browser driving, Cloudflare data and logs, and web reading were the most-used
things the agents could not do.

## Pages an agent keeps open ([browser-session.ts](../../packages/tools/src/packs/browser-session.ts))

| Capability | Level | Does |
|---|---|---|
| `browser.open` | 1 | Open a URL in a page that stays open; returns its `pageId`, the snapshot and a screenshot |
| `browser.snapshot` | 1 | Look again: snapshot, problems since the last look, optional screenshot (`fullPage`, `depth`) |
| `browser.act` | 2 | One action, then the new snapshot: click, double_click, hover, fill, type, press, select, check, uncheck, upload, scroll, goto, back, forward, reload, wait, set_viewport, dialogs |
| `browser.evaluate` | 2 | Run a JS expression or function in the page; JSON result |
| `browser.logs` | 1 | Console, page errors, dialogs, responses with status; `onlyProblems` |
| `browser.close` | 1 | Close; `saveSession` keeps cookies/storage under a name |

- **Snapshot.** `page.ariaSnapshot({ mode: 'ai' })` (Playwright 1.63): the
  accessibility tree with `[ref=e12]` handles, the same mechanism the
  Playwright MCP server uses. `browser.act {ref}` resolves through the
  `aria-ref=` selector engine. Refs only hold for the latest snapshot; a stale
  one fails with a hint to look again. `selector` works too.
- **Isolation.** One shared Chromium per mode (headless, visible); every page
  gets its own empty `BrowserContext` with downloads refused. Nothing is read
  from any Chrome profile, and never from Private Browser (see Gotchas). A
  named session loads `stateDir/browser-sessions/<name>.json`, the same files
  `browser.run_flow` uses.
- **Ownership and limits.** A page belongs to `taskId` (or `operator`); another
  task gets "No open page". At most 4 pages per owner and 12 in total. Pages
  close on `browser.close`, in the engine's task cleanup
  ([tooling.ts](../../apps/orchestrator/src/engine/tooling.ts) `cleanup` and
  `stopProcesses` call `closeBrowserPages`), after 10 idle minutes, and the
  browser closes with its last page.
- **What the agent is told.** Each result's `stdout` is the page line, problems
  logged since the last look (errors, failed requests, dialogs, each reported
  once) and the snapshot, cut at 14,000 characters.
- **Popups.** A click or key press waits up to 400 ms for a new tab; if one
  opens, it becomes the page being driven.
- **Dialogs** are dismissed unless `browser.act {action: 'dialogs', value:
  'accept'}` says otherwise, and are logged either way.
- **`visible: true`** shows the window on the operator's desktop; with no
  desktop it falls back to headless and says so.

## Pictures the model sees

`OperationResult.images` ([sdk.ts](../../packages/tools/src/sdk.ts)) carries
PNGs of at most 3 MB for the model: `browser.open`, `browser.snapshot`/`act`
with `screenshot`, `browser.screenshot`, `browser.check_page` and the
screenshot steps of `browser.run_flow` fill it. `POST /api/tool-session/call`
returns up to 3 of them base64-encoded; the bridge
([bridge.ts](../../packages/mcp/src/bridge.ts)) turns each into an MCP `image`
content block after the text. They are never stored; the screenshot is also
saved as a task artifact as before. Before this, agents got only a file name.

## Web research ([web.ts](../../packages/tools/src/packs/web.ts))

- `web.search {query, max, site?, region}` (Level 1, network): POSTs to
  DuckDuckGo's no-JavaScript page `html.duckduckgo.com/html/`, no key and no
  cost; adverts dropped, `uddg` redirects unwrapped. If DuckDuckGo asks for a
  human check the call fails `UNAVAILABLE` and says to read a known URL.
- `web.read {url, maxChars, links}` (Level 1): two providers. Playwright
  (preferred) renders the page and returns the text of `main`/`article`/body
  plus up to 60 links; the built-in `web` provider (preference 60) fetches and
  strips HTML when no browser exists.
- Profiles: `web.*` is in every profile's inspect set; `browser.open`,
  `snapshot`, `logs`, `close` are in `analysis` and `general`; `act` and
  `evaluate` need a building stage (`web-development`, `cloudflare-worker`
  include `browser.*`) or escalation.

## Past Worker logs ([cloudflare.ts](../../packages/tools/src/packs/cloudflare.ts))

`cloudflare.logs_query {worker?, allWorkers, sinceMinutes ≤ 7 days, search?,
onlyErrors, limit ≤ 200, accountId?}` (Level 2, like `cloudflare.tail`) calls
`POST /accounts/{id}/workers/observability/telemetry/query` with
`CLOUDFLARE_API_TOKEN` (brokered `cloudflare` credential or the inherited
environment). Worker and account default to the repository's Wrangler config
(`name`, `account_id`), then `CLOUDFLARE_ACCOUNT_ID`, then the token's only
account. One line per event: time, level, Worker, trigger, status, message.
Verified against the operator's account on 2026-09-24.

## Gotchas

- **Private Browser is not an agent surface.** Its bridge accepts no
  extension-initiated browser request and has no debugging port by design
  (Private-Browser `docs/systems/vscode-bridge.md`). It is where the operator
  watches; agents use these isolated pages. Do not add a route into it.
- `aria-ref=` is not in Playwright's public types; it is the engine behind
  `mode: 'ai'` refs. A Playwright upgrade must keep
  [browser-pages.test.ts](../../packages/tools/test/browser-pages.test.ts) green.
- Page text, logs and evaluate results pass through `redact` in the pack;
  the service only redacts `summary`, `stdout` and `stderr`.


## Network guards ([net-guard.ts](../../packages/tools/src/net-guard.ts))

- `http.request`, `web.read` and `web.search` follow redirects by hand, one
  hop at a time (at most 5). A hop into the Control Center's own address, from a
  remote site into this machine, or to a non-http(s) URL is refused (`DENIED`).
  `http.request` reports a redirect to another origin instead of following it
  (`output.redirectedTo`), so that host is classified on its own; a 303, or a
  301/302 after a non-GET, continues as a GET without a body; credentials never
  follow a request to another origin. curl runs without `-L`.
- Response bodies are read up to 16 MB (`http.request`), 8 MB (`web.read`) and
  4 MB (`web.search`); curl has `--max-filesize`.
- Every browser context the tools create aborts any request to the Control
  Center's own address (`guardBrowserContext`): its dashboard page carries the
  local token.

Last verified: 2026-09-24
