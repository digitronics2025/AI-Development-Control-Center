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
([tool-system.md](tool-system.md#sessions)).

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

API: `GET/POST /api/mcp`, `PATCH/DELETE /api/mcp/:id`, `POST /api/mcp/:id/check`.
Realtime: `mcpServer`, `mcpServer.deleted`.

## Verified

A real stdio fixture server was registered, health-checked, its tools
discovered, called through the policy (`mcp.echo_fixture.echo`) and removed;
the bridge was driven by a real MCP client over an in-memory transport.

Last verified: 2026-09-23
