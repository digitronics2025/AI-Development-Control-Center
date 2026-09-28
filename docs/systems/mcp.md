---
system: mcp
sources:
  - packages/mcp/**
  - apps/orchestrator/src/tools/mcp.ts
  - packages/agent-claude/src/index.ts
  - packages/agent-codex/src/index.ts
verified_at: 57af61a
---

# MCP

Two directions, one package ([`@acc/mcp`](../../packages/mcp/src)).

## The Control Center as an MCP server (agents → Control Center)

[bridge.ts](../../packages/mcp/src/bridge.ts) is a stdio MCP server bundled as
`apps/orchestrator/dist/acc-mcp.js`. It holds no policy and no secrets: it
lists and calls tools through `/api/tool-session/*` with a session token
([tool-system.md](tool-system.md#sessions)). A call's answer is its text plus, when the
tool took a screenshot, up to three MCP `image` blocks the model looks at
([browser-and-web.md](browser-and-web.md#pictures-the-model-sees)).

**Agent stages.** When Settings → Execution → *Give agents the Control Center
tools* is on and the bridge is built, each agent execution gets a session
scoped to its task, stage level and profile, closed when the execution ends.
The token and URL travel only in the agent's environment
(`ACC_TOOL_SESSION`, `ACC_TOOL_URL`):

- Claude Code: `--mcp-config <temp file>` naming the variables as
  `${ACC_TOOL_SESSION}` (never the value), and `mcp__acc` added to
  `--allowedTools`; the file is deleted when the run ends.
- Codex: `-c mcp_servers.acc.command=…`, `args=…`,
  `env_vars=["ACC_TOOL_URL","ACC_TOOL_SESSION"]` to forward them, and
  `default_tools_approval_mode="approve"`: `codex exec` otherwise refuses every
  tool not marked read-only, and the Control Center judges each call itself
  ([agents.md](agents.md)).

The prompt gains a "Control Center tools" section (at Level 1 it also says to read Git
through `git__status`/`git__diff`/`git__log`/`git__show`: Claude Code has no shell there,
[agents.md](agents.md)). Tool names are the
capability id with `.` → `__` (`network__port_owner`); two meta tools,
`acc_find_capability` and `acc_call_capability`, reach capabilities that are
not listed (escalation, [autopilot.md](autopilot.md)).

**Personal MCP servers are never loaded into agent runs.** Claude Code
always gets `--strict-mcp-config`, so servers from the operator's own or
plugin config do not start in a run; their tools would bypass the policy
above. Codex has no such flag: the adapter asks Codex which servers it would
load in the run's folder (`codex mcp list --json`), switches each off by name,
and turns off the features that add servers on their own — ChatGPT apps,
plugins (including plugins installed on the ChatGPT account, which load even
with `--ignore-user-config`) and skill-requested installs. If it cannot tell,
the run is refused. Measured layers and the real-run check
(`pnpm verify:agents --only codex --mcp`):
[agents.md](agents.md#mcp-servers-in-a-codex-run).
To give agents an outside server, register it in the gateway below
(Tools → MCP servers); agents reach it through `acc_call_capability`.

**Your own MCP client.** `node apps/orchestrator/dist/acc-mcp.js --repository <path> [--profile web-development]`
reads the local API token and `runtime.json` from the data folder and opens
an operator session for that registered repository, e.g.
`claude mcp add acc -- node <checkout>\apps\orchestrator\dist\acc-mcp.js --repository C:\code\app`.

## The MCP gateway (Control Center → other servers)

[gateway.ts](../../packages/mcp/src/gateway.ts): stdio and streamable-HTTP
clients, lazily connected, pooled per server, closed after 5 idle minutes,
every call with a timeout. [mcp.ts](../../apps/orchestrator/src/tools/mcp.ts)
keeps `mcp_servers` and turns each enabled, healthy server into a provider
`mcp:<id>` with capabilities `mcp.<server-slug>.<tool>` at the server's
permission level (tools the server marks destructive need at least Level 3).
Environment variables (stdio) or headers (HTTP) are filled from named
credentials by the broker (never a `media` key: a read that names no kind gets
none, [credential-broker.md](credential-broker.md#flow), so a mapping that names
one is refused when the server is saved); `allowedTools`
narrows what is exposed.

**What passes through.** Text content is joined (and redacted); other content
is named in the text (`[image image/png]`). PNG and JPEG image blocks (bytes
checked, 3 MB each, three per call) are also returned as pictures for the
model (`OperationResult.images`) and, in a task, kept as `image` artifacts.
Each tool's own input schema (16 KB at most) is stored with the server's
health and published: agents see it in the tool list once the capability is
listed, and `acc_find_capability` names its parameters (`Input: text (string,
required)`); calls are still validated as an untyped object. A tool the
server marks `readOnlyHint` (and not `destructiveHint`) is a read
(`readOnly`), so a read-only session can call it when it is on the session's
allow-list.

A server whose calls are billed (image or video generation) is not seen by
the media spend gate: its tools declare no cost estimate. Register one at
Level 3 so only a Level 3 stage can reach it, but note that a Level 3 stage
with auto-approval enables it by escalation. Frontend Design generates through the
built-in `media.*` tools instead: its profile lists no generation server and
the designer is told never to call one
([design-agent.md](design-agent.md#operator-setup)).

API: `GET/POST /api/mcp`, `PATCH/DELETE /api/mcp/:id`, `POST /api/mcp/:id/check`,
`POST /api/mcp/:id/oauth/start`, `POST /api/mcp/:id/oauth/sign-out`, and the
token-free `GET /oauth/mcp/callback` (below).
Realtime: `mcpServer`, `mcpServer.deleted`.

## OAuth

An HTTP server registered with `auth: "oauth"` (Tools → MCP servers → Add
server → **Sign in with OAuth**, optional scopes) is one the operator signs
in to once in the browser: Canva, Figma remote, Higgsfield and other servers
that accept no static key.

- **The protocol is the MCP SDK's** ([oauth.ts](../../packages/mcp/src/oauth.ts)):
  protected-resource and authorization-server discovery, dynamic client
  registration (`token_endpoint_auth_method: none`), PKCE S256, the code
  exchange and refresh. `McpOAuthProvider` only keeps what they produce and
  never opens a browser. Its requests never go to the Control Center's own
  address.
- **Sign-in** (`POST /api/mcp/:id/oauth/start`): a random single-use state
  (ten minutes, at most 20 pending, in memory) and the authorization address,
  which the dashboard opens in a new tab and also shows as a link. One
  sign-in per server at a time: starting again forgets the earlier state
  (its code verifier is replaced), so its link answers "start again". The
  callback address is `http://127.0.0.1:<port>/oauth/mcp/callback`, the port
  the operator reached the orchestrator on (its listen port when the Host
  names none). A client registered for another port is registered again. Start and sign-out are refused with 403
  `REMOTE_FORBIDDEN` when relayed from the cloud, and the cloud dashboard
  disables both buttons.
- **The callback** (`GET /oauth/mcp/callback`) is outside `/api`, so it needs
  no API token. The Host check still applies (421 for any non-loopback host),
  and the state is the proof: unknown, used or expired → 400; an
  authorization-server refusal (`error=`) → 400 with its reason. The code is
  never echoed. On success the code becomes tokens, the server is checked and
  a small page says so.
- **Storage** (migration 21): `mcp_servers.auth` and `oauth_scope`;
  `mcp_oauth` holds the whole sign-in (client registration, tokens, any
  verifier in progress) as one JSON value sealed with the credential broker's
  key (`sealValue`, bound to `mcp-oauth:<server id>`). Beside it are the
  plain `signed_in_at` and `expires_at`, so the view shows the status
  (`oauth: { signedIn, signedInAt, expiresAt }`) without decrypting; the list
  shows when access renews only while that time is ahead (tokens renew when the
  server is next used). The tokens are registered with the redactor whenever
  they are loaded or saved. They never appear in a response, an event or the
  database in plain text.
- **Background calls** (check, tool calls) use the saved tokens and refresh
  them silently. A server nobody signed in to is never contacted: no client
  registration and no discovery. Its check reports "Not signed in", and its
  tools answer `AUTH_REQUIRED`. When a refresh fails the gateway stops with
  `McpSignInRequired` (the call answers `AUTH_REQUIRED`) instead of starting a
  sign-in. Signing out, a new URL, or turning OAuth off forgets the sign-in;
  removing the server deletes it.

## Verified

A real stdio fixture server was registered, health-checked, its tools
discovered, called through the policy (`mcp.echo_fixture.echo`) and removed;
the bridge was driven by a real MCP client over an in-memory transport. A
stand-in OAuth 2.1 + MCP server ([oauth-server.ts](../../packages/mcp/test/fixtures/oauth-server.ts))
proves sign-in with PKCE, the callback (forged, replayed and non-loopback
answers refused), a tool call with the tokens, silent refresh, the stop when
refresh fails, sign-out, and that no token is in any response or in the
database file.

Last verified: 2026-09-27
