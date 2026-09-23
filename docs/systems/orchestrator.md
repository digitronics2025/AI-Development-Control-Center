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
`task_checkpoints` (migration 2, [chairman.md](chairman.md)). Access goes through
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
| Agents | `GET agents`, `POST agents/refresh`, `POST agents/:id/refresh`, `PATCH agents/:id`, `POST/DELETE agents/:id/models` |
| Workflows | `GET workflows[/:id]`, `POST workflows/validate`, `PUT workflows/:id`, `POST workflows/:id/duplicate`, `DELETE workflows/:id` |
| Repositories | `GET/POST repositories`, `GET/PATCH/DELETE repositories/:id`, `POST repositories/:id/redetect` |
| Source Control | `repositories/:id/source-control[/…]` — see [source-control.md](source-control.md) |
| Settings | `GET/PATCH settings`, `GET prompts`, `PUT prompts/:role`, `POST prompts/:role/reset` |

`GET /healthz` is unauthenticated and returns only `{ok:true}`. The built
dashboard is served at `/` with the token injected as a `<meta>` tag and a
strict CSP.

## Realtime

`/ws?token=` pushes complete entities (`task`, `stage`, `event`, `execution`,
`approval`, `directive`, `artifact`, `testRun`, `agents`, `settings`,
`repository`, `workflow`) plus `sourceControl` (`{repositoryId}` only: refetch that
repository's Git state; sent by `RepositoryService.invalidate` and every Source
Control mutation) and the Chairman's `chairman`, `chairman.message`,
`chairman.decision`, `chairman.action`, `checkpoint`. Log lines (`logs`) go only to clients that sent
`subscribeLogs` for that execution; slow clients (>8 MB buffered) skip log
batches and refetch. Log lines are batched every 150 ms or 250 lines.

## Coordination

[RepositoryCoordinator](../../apps/orchestrator/src/services/repository-coordinator.ts)
is shared by the engine and Source Control: a stage with permission level ≥ 2
registers as a writer (waiting for any Git mutation in flight), and Source
Control refuses mutations while a writer is active. Startup runs Source
Control reconciliation in the background after `listen`.

## Startup

`main.ts` runs `services.recover()` (engine reconciliation, then the
Chairman resumes interrupted supervised tasks and answers pending chat),
schedules queued tasks, starts Source Control reconciliation and the
Chairman's watchdog (15 s).

## Gotchas

- Refused WebSocket upgrades must close their raw socket (see
  [security.ts](../../apps/orchestrator/src/http/security.ts)) or shutdown hangs.
- `forceCloseConnections` is on so shutdown never waits on idle clients.
- On Windows a background process cannot receive Ctrl+C; stop it with
  `POST /api/service/shutdown` (the stop script does this).

Last verified: 2026-09-23
