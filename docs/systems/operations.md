# Operations and Windows packaging

## Launchers ([scripts/windows](../../scripts/windows))

| Script | Effect |
|---|---|
| `start-control-center.ps1 [-NoBrowser]` | Reuses a healthy orchestrator from `runtime.json`, otherwise starts `node apps/orchestrator/dist/main.js` hidden with logs in `<data>\orchestrator.log` (rotated at 10 MB) and waits for `/healthz`; opens the dashboard |
| `stop-control-center.ps1` | `POST /api/service/shutdown` with the token; force-stops after 15 s |
| `install.ps1 [-AutoStart]` | Start-menu shortcuts (start, stop); `-AutoStart` adds a sign-in shortcut with `-NoBrowser`. Per-user, no admin |
| `uninstall.ps1` | Removes those shortcuts; data is kept |

All scripts honour `ACC_DATA_DIR` and `ACC_PORT`.

## Other scripts

- `pnpm demo` ([demo.mjs](../../scripts/demo.mjs)): simulated agents, four sample repositories, tasks in every state; writes `<base>/ready` when seeded and keeps `<base>/orchestrator.log`. Used by the Playwright suite.
- `pnpm verify:agents [--run] [--only codex|claude] [--codex-model …] [--claude-model …]` ([verify-agents.ts](../../scripts/verify-agents.ts)).

## Backups

Everything durable is in the data folder: stop the orchestrator and copy it.

Last verified: 2026-09-23
