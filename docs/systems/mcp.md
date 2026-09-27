---
system: mcp
sources:
  - packages/mcp/**
  - apps/orchestrator/src/tools/mcp.ts
  - packages/agent-claude/src/index.ts
  - packages/agent-codex/src/index.ts
verified_at: 351db1e
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
- Codex: `-c mcp_servers.acc.command=…`, `args=…`, and
  `env_vars=["ACC_TOOL_URL","ACC_TOOL_SESSION"]` to forward them.

The prompt gains a "Control Center tools" section. Tool names are the
capability id with `.` → `__` (`network__port_owner`); two meta tools,
`acc_find_capability` and `acc_call_capability`, reach capabilities that are
not listed (escalation, [autopilot.md](autopilot.md)).

**Personal MCP servers are never loaded into agent runs.** Claude Code
always gets `--strict-mcp-config`, so servers from the operator's own or
plugin config do not start in a run; their tools would bypass the policy
above. To give agents an outside server, register it in the gateway below
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
credentials by the broker; `allowedTools` narrows what is exposed.

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

A server whose calls are billed (image or video generation) is registered at
Level 3 so it runs only in a Level 3 agent stage, such as Frontend Design's
Assets stage; its free tools (search, pricing, job status) can be a second
registration at Level 2 ([design-agent.md](design-agent.md#operator-setup)).

API: `GET/POST /api/mcp`, `PATCH/DELETE /api/mcp/:id`, `POST /api/mcp/:id/check`.
Realtime: `mcpServer`, `mcpServer.deleted`.

## Verified

A real stdio fixture server was registered, health-checked, its tools
discovered, called through the policy (`mcp.echo_fixture.echo`) and removed;
the bridge was driven by a real MCP client over an in-memory transport.

Last verified: 2026-09-24
