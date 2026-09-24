---
system: orchestrator
sources:
  - apps/orchestrator/src/*.ts
  - apps/orchestrator/src/db/**
  - apps/orchestrator/src/http/**
  - apps/orchestrator/src/store/**
  - apps/orchestrator/src/services/**
verified_at: 2d516aa
---

# Orchestrator

The product core (PLAN §4). One Node process: Fastify HTTP API, a WebSocket
hub, SQLite persistence and the workflow engine. Entry:
[main.ts](../../apps/orchestrator/src/main.ts); composition root:
[app.ts](../../apps/orchestrator/src/app.ts).

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `ACC_DATA_DIR` | `%LOCALAPPDATA%\AIDevControlCenter` (Windows), `$XDG_DATA_HOME/ai-control-center` | Database, token, artifacts, `runtime.json` |
| `ACC_PORT` | `4317` | Listen port |
| `ACC_HOST` | `127.0.0.1` | Refuses non-loopback hosts unless `ACC_ALLOW_REMOTE=1` |
| `ACC_SIMULATED_AGENTS` | unset | `1` registers simulated agents (tests, demos) |
| `ACC_REPOSITORY_AUTOMATION` | on | `0` never starts repository discovery or background sync (the demo and e2e set it) |
| `ACC_ALLOWED_ORIGINS` | empty | Extra browser origins allowed to call the API |
| `ACC_LOG_LEVEL` | `info` | Fastify/pino level |

## Data folder

| Path | Content |
|---|---|
| `acc.db` | SQLite (WAL). Schema in [migrations.ts](../../apps/orchestrator/src/db/migrations.ts) |
| `auth-token` | Local API token (created once, mode 600) |
| `runtime.json` | `{url, port, pid}` while running; removed on clean shutdown. Used by the extension and launchers |
| `tasks/TASK-NNNN/` | Artifacts (`request.md`, `plan.md`, `review.md`, `final-report.md`, `git-diff.patch`, `task.json`, attachments). Outside the repository so they never appear in its diff |

## Tables

`settings`, `repositories`, `agents`, `models`, `workflow_profiles`,
`workflow_stages`, `prompt_templates`, `tasks`, `task_stages`, `executions`,
`execution_logs`, `task_events`, `task_directives`, `task_artifacts`,
`approvals`, `git_snapshots`, `test_runs`, `git_operations` (Source
Control journal, migration 3, [git-operations.ts](../../apps/orchestrator/src/store/git-operations.ts)),
and the Chairman's `task_contracts`, `chairman_sessions`, `chairman_messages`,
`chairman_decisions`, `chairman_actions`, `failure_signatures`,
`task_checkpoints` (migration 2) and `chairman_strategy_runs` (migration 8,
[chairman.md](chairman.md)), the usage ledger's
`usage_events`, `usage_event_lines`, `usage_cost_revisions`, `usage_pending`,
`pricing_versions`, `capacity_snapshots`, `budgets` (migration 4, append-only by
trigger, [usage.md](usage.md)), and the tool
layer's `tools`, `tool_capabilities`, `tool_health`, `tool_executions`,
`task_processes`, `pty_sessions`, `recovery_attempts`, `mcp_servers`,
`capability_escalations`, `credential_references` (migration 5,
[tool-system.md](tool-system.md), [tools/store.ts](../../apps/orchestrator/src/tools/store.ts)),
the MyVault bridge's `credential_vault_links`, `vault_bridge_origins`,
`credential_events` (migration 7, metadata only), `vault_bridge_identity`
(migration 9, the bridge's sealed identity key) and `vault_deposit_targets`,
`vault_deposits` (migration 10, MyVault's delivery box;
[credential-broker.md](credential-broker.md)), and the connected apps'
`connected_apps`, `connected_app_tasks`, `connected_app_evidence` (migration 12,
metadata only; [connected-apps.md](connected-apps.md)). Access goes through
[store.ts](../../apps/orchestrator/src/store/store.ts). Secrets are redacted
before any row is written.

## HTTP API (all under `/api`, bearer token required)

| Area | Endpoints |
|---|---|
| Service | `GET health`, `GET overview`, `POST service/shutdown` |
| Tasks | `GET/POST tasks`, `GET/PATCH tasks/:id`, `POST tasks/:id/{start,pause,resume,cancel,retry,reroute,assignments,directives}`, `GET tasks/:id/{events,executions,tests,artifacts,approvals,directives,changes,diff}` |
| Chairman | `GET tasks/:id/chairman`, `GET/POST tasks/:id/chairman/messages`, `POST tasks/:id/chairman/actions` ([chairman.md](chairman.md)) |
| Logs | `GET executions/:id`, `GET executions/:id/logs?after&limit&stream&q&tail` |
| Artifacts | `GET artifacts/:id/content` (≤2 MB), `GET artifacts/:id/download` (text types sent with `charset=utf-8`) |
| Approvals | `GET approvals?status=`, `POST approvals/:id/{approve,deny}` |
| Agents | `GET agents` (each with `capacityBlock` — why a signed-in agent cannot run now, [usage.md](usage.md#capacity)), `POST agents/refresh`, `POST agents/:id/refresh`, `PATCH agents/:id`, `POST/DELETE agents/:id/models` |
| Workflows | `GET workflows[/:id]`, `POST workflows/validate`, `PUT workflows/:id`, `POST workflows/:id/duplicate`, `DELETE workflows/:id` |
| Repositories | `GET/POST repositories`, `GET/PATCH/DELETE repositories/:id`, `POST repositories/:id/redetect` |
| Source Control | `repositories/:id/source-control[/…]` — see [source-control.md](source-control.md) |
| Repository automation | `GET repository-automation`, `POST repository-automation/run` — see [repository-automation.md](repository-automation.md) |
| Settings | `GET/PATCH settings` (a PATCH changes only the keys sent; a section sent in part keeps its other fields — `mergeSettings` in [settings.ts](../../apps/orchestrator/src/services/settings.ts)), `GET prompts`, `PUT prompts/:role`, `POST prompts/:role/reset` |
| Learning | `GET learning`, `GET learning/tasks/:id`, `POST learning/tasks/:id/review`, `POST learning/improvements/:id/revert`, `POST learning/findings/:id/{dismiss,act}`; tables `learning_*` (migration 11); see [learning.md](learning.md#api) |
| Usage & Costs | `usage/…` — overview, breakdowns, task ledger, attempts, providers, budgets, pricing, export, reconcile; see [usage.md](usage.md#api-apiusage-bearer-token) |
| Tools | `tools…`, `tool-executions`, `tasks/:id/{execution,processes,checkpoints,restore}`, `processes…`, `terminals…`, `mcp…`, `credentials…`, `privileged/validate`, `tool-sessions` — see [tool-system.md](tool-system.md) |
| Tool sessions | `tool-session/{tools,find,call}` — session token only, never the local API token ([mcp.md](mcp.md)) |
| Connected apps | `connected-apps[/…]` (dashboard) and `connected-app/*` — the paired app's token only ([connected-apps.md](connected-apps.md)) |

`GET /healthz` is unauthenticated and returns only `{ok:true}`. The built
dashboard is served at `/` with the token injected as a `<meta>` tag and a
strict CSP. `index.html` is re-read whenever its mtime changes and assets are
looked up per request, so rebuilding the dashboard needs no restart; while
the build folder is empty the page answers 503 with `Retry-After`.

## Realtime

`/ws?token=` pushes complete entities (`task`, `stage`, `event`, `execution`,
`approval`, `directive`, `artifact`, `testRun`, `agents`, `settings`,
`repository`, `workflow`, `repositoryAutomation`) plus `sourceControl` (`{repositoryId}` only: refetch that
repository's Git state; sent by `RepositoryService.invalidate` and every Source
Control mutation) and the Chairman's `chairman`, `chairman.message`,
`chairman.decision`, `chairman.action`, `checkpoint`, `usage` (a recorded or
re-costed attempt; clients refetch usage views), and the tool layer's
`tool`, `toolExecution`, `taskProcess`, `terminal`, `mcpServer(.deleted)`,
`credential(.deleted)`, `recovery`, `escalation`, `connectedApp` (never relayed to the cloud). `terminal.output` goes only
to clients that sent `subscribeTerminal`, which may then send `terminal.input`
and `terminal.resize` for it ([pty.md](pty.md)). Log lines (`logs`) go only to clients that sent
`subscribeLogs` for that execution; slow clients (>8 MB buffered) skip log
batches and refetch. Log lines are batched every 150 ms or 250 lines.

## Coordination

[RepositoryCoordinator](../../apps/orchestrator/src/services/repository-coordinator.ts)
is shared by the engine and Source Control: a stage with permission level ≥ 2
registers as a writer (waiting for any Git mutation in flight), and Source
Control refuses mutations while a writer is active. Startup runs Source
Control reconciliation in the background after `listen`.

## Startup

`main.ts` runs `services.recover()` (tool executions left running are marked
stopped, leftover terminals exited, leftover task processes killed only if
still the same process; then engine reconciliation, then the Chairman resumes
interrupted supervised tasks and answers pending chat), gives the tool layer
its listen URL (agent tool sessions need it), refreshes stale tool detection
and loads stored credentials into the redactor in the background,
schedules queued tasks, starts Source Control reconciliation (then
repository automation, once it settles) and the Chairman's watchdog (15 s).

## Remote execution node

Migration 6 (`remote execution node`) adds `remote_config`,
`remote_sync_state`, `remote_outbox`, `remote_commands_received` and
`remote_artifact_sync`. `RemoteNodeService` starts at the end of
`services.recover()` and stops first in `close()`. Local-only routes:
`GET/PATCH /api/remote`, `POST /api/remote/pair|unpair|rotate|reconnect`
(refused when a request carries `x-acc-remote-request`). Cloud requests reach the
normal routes in process (Fastify `inject`), never through the network; the
listener stays on loopback. Details: [remote-node.md](remote-node.md).

## Gotchas

- Refused WebSocket upgrades must close their raw socket (see
  [security.ts](../../apps/orchestrator/src/http/security.ts)) or shutdown hangs.
- `forceCloseConnections` is on so shutdown never waits on idle clients.
- Repository status (`GET repositories`) costs one `git status --porcelain=v2
  --branch` per repository, cached 5 s and capped at 8 concurrent Git
  processes in [repositories.ts](../../apps/orchestrator/src/services/repositories.ts).
  Separate `rev-parse`/`symbolic-ref` calls per repository made a cold list of
  48 repositories take ~6 s on Windows; keep it to one process.
- On Windows a background process cannot receive Ctrl+C; stop it with
  `POST /api/service/shutdown` (the stop script does this).

Last verified: 2026-09-24
