---
system: tool-system
sources:
  - packages/tools/**
  - apps/orchestrator/src/tools/service.ts
  - apps/orchestrator/src/tools/store.ts
  - apps/orchestrator/src/tools/environment.ts
  - apps/orchestrator/src/tools/processes.ts
  - apps/orchestrator/src/http/tool-routes.ts
verified_at: 351db1e
---

# Tool system

The Universal Tool & Autonomous Execution Layer ([plan](../plans/tool-layer-v2/PLAN.md)).
Agents ask for **capabilities**; the Control Center picks the program that
provides one, decides whether the call may run, runs it and records it.

## Model ([sdk.ts](../../packages/tools/src/sdk.ts))

- A **provider** is something the machine has (`git`, `powershell`,
  `playwright`, `wrangler`, `adb`…) with `detect()` and, for account-bound
  tools, `checkAuth()`.
- An **operation** is a capability id (`git.status`, `network.port_owner`)
  with a Zod input schema (also its JSON schema for MCP), a base permission
  level, a per-input `classify()` and `run()`.
- Several providers may offer one capability: `shell.run` (PowerShell, CMD,
  Git Bash, WSL), `network.port_owner` (Windows via PowerShell, netstat),
  `http.request` (built-in fetch, curl).

Built-in packs live in [packs/](../../packages/tools/src/packs): shell,
filesystem, git, github, runtime (Node/pnpm/npm/Python/uv/Java), browser
(Playwright), http (+curl), network, windows, cloudflare, database (SQLite,
psql, mysql), docker, android (adb, Gradle), hosted (processes, terminals,
checkpoints, privileged helper, VS Code), verify, credential-broker
(`credential.generate`). The orchestrator adds
`environment` and one `mcp:<id>` provider per healthy MCP server
([mcp.md](mcp.md)). About 110 capabilities in total.

## Registry, router, health

- [ToolRegistry](../../packages/tools/src/registry.ts): register/unregister,
  capability lookup, keyword search (for `acc_find_capability`).
- [ToolRouter](../../packages/tools/src/router.ts): filters by platform and
  installed state, then orders by caller preference (`shell: 'bash'`), recent
  failures of that provider in this task, provider preference. Every decision
  carries a readable reason stored as `tool_executions.route_reason`.
- [ToolHealthCache](../../packages/tools/src/health.ts): detection results
  persisted in `tool_health`, fresh for 6 hours, refreshed in the background
  at startup (`refreshStale`) and on **Check**; account checks only on
  request. A provider never checked is detected on first use, so routing never
  refuses a tool just because nobody looked yet.

## The execution door ([service.ts](../../apps/orchestrator/src/tools/service.ts))

`ToolService.invoke()` is the only way anything runs a tool:

1. route → 2. validate input → 3. classify (`classify()` may raise or lower
the level: a recursive delete is Level 5, a read-only shell script Level 1) →
4. policy ([autopilot.md](autopilot.md)): allow, **escalate** (outside the
stage's profile but within its level — recorded in `capability_escalations`
and as a `CAPABILITY_ESCALATED` event), needs approval, or deny →
5. checkpoint before high-impact work in a task (level ≥ 3, or database
writes) → 6. inject brokered credentials ([credential-broker.md](credential-broker.md))
→ 7. run with timeout and cancellation → 8. redact → 9. record a
`tool_executions` row, publish `toolExecution`, and add a `TOOL_CALL` event
for notable calls (level ≥ 3, long-running, failures, verification evidence).

Tool inputs are stored as redacted, bounded summaries; outputs are never
stored, only the one-line summary, evidence lines, artifact ids, files changed
and network targets.

## Sessions

`openSession(scope, 'agent' | 'operator')` returns a random token held only in
memory. Agent sessions are opened per agent execution and closed when it ends
([mcp.md](mcp.md)); operator sessions come from `POST /api/tool-sessions`.
`/api/tool-session/{tools,find,call}` accept **only** a session token (the
local API token is refused there, and a session token opens nothing else).
An agent's tool list is its profile within its level, minus capabilities it
already has natively (`fs.*`, `shell.*`, basic `git.*`), capped at 60; the
rest stays callable through `acc_call_capability`.

## Profiles ([profiles.ts](../../packages/tools/src/profiles.ts))

`analysis` (every Level 1 stage), `general`, `web-development`,
`cloudflare-worker`, `android-development`, `python`, `operator`. Chosen from
repository tooling; MCP capabilities are never in a profile except
`operator`.

## Environment discovery

Before a task's first stage: OS, CPU, memory, disk, branch, dirty files,
project type, installed tools with versions, listening ports, the task's
processes, agents and MCP servers → `environment.md` artifact, an
`ENVIRONMENT_DISCOVERED` event, and an "Environment" section in investigator,
planner and implementer prompts. Also callable as `environment.discover`.

## Task processes ([processes.ts](../../apps/orchestrator/src/tools/processes.ts))

`process.start` (and the verify stage, and `cloudflare.dev`) start long-running
commands owned by a task: a port already in use is reported with its owner
instead of fought over; readiness is an HTTP poll; child pids are learned so
"is this pid ours" covers the real server under a shell. Processes stop as a
tree when the task's loop exits in any state other than running/queued, on
completion and cancel, and at shutdown. After a crash, rows still marked live
are killed only if the pid's creation time is within 15 s of when we started
it; otherwise they are marked gone.

## Tables (migration 5)

`tools`, `tool_capabilities`, `tool_health`, `tool_executions`,
`task_processes`, `pty_sessions`, `recovery_attempts`, `mcp_servers`,
`capability_escalations`, `credential_references`; `task_checkpoints` gains
`type` and `metadata`; `tasks.policy_mode`, `repositories.policy_mode` and
`repositories.runtime`. Migration 4 belongs to the usage ledger developed in
parallel; the two apply in either order. Migration 7 adds the MyVault link,
trusted-origin and credential-event tables ([credential-broker.md](credential-broker.md)).

Secrets an agent needs but must not see go through `credential.generate`
(sealed in the orchestrator, returns metadata only) and are used by reference,
e.g. `cloudflare.secret_put {credential, secretName, environment}`, which feeds
the value to Wrangler on stdin and refuses a generated value MyVault has not
saved yet. `CredentialHost` gains optional `generate` and `deployGate` for this.

## API

`GET /api/tools`, `GET /api/tools/capabilities`, `GET /api/tools/:id`,
`POST /api/tools/:id/check {auth}`, `POST /api/tools/refresh`,
`POST /api/tools/call {repositoryId, capability, input, confirmation}`
(operator call; Level 5 runs only when `confirmation` equals the capability
id), `GET /api/tool-executions`, `GET /api/tasks/:id/execution`,
`GET /api/tasks/:id/processes`, `POST /api/tasks/:id/processes/:pid/stop`,
`GET /api/processes`, `POST /api/processes/:id/stop`, plus the terminal, MCP,
credential, checkpoint and session routes in their own docs. Realtime:
`tool`, `toolExecution`, `taskProcess`, `recovery`, `escalation`.

## Gotchas

- Routing depends on detection: tests and fresh data folders detect lazily,
  so the first call to a capability can take a second longer.
- `page.evaluate` code in the browser pack reaches DOM globals through
  `globalThis`; the package compiles without DOM types on purpose.
- `node-pty`, `playwright-core`, `better-sqlite3` and `axe-core` stay external
  to the orchestrator bundle and must be dependencies of `@acc/orchestrator`.

Last verified: 2026-09-23
