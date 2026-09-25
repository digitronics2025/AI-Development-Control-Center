---
system: operations
sources:
  - scripts/windows/**
  - scripts/demo.mjs
  - scripts/verify-agents.ts
verified_at: b9ce60f
---

# Operations and Windows packaging

## Launchers ([scripts/windows](../../scripts/windows))

| Script | Effect |
|---|---|
| `start-control-center.ps1 [-NoBrowser]` | Reuses a healthy orchestrator from `runtime.json`, otherwise starts `node apps/orchestrator/dist/main.js` hidden with logs in `<data>\orchestrator.log` (rotated at 10 MB) and waits for `/healthz`; opens the dashboard |
| `stop-control-center.ps1 [-Drain \| -Force]` | `POST /api/service/shutdown` with the token. With no switch it **refuses** while a task has a stage running: prints the task ids and stage names and exits 2. `-Drain` stops each task at its next stage boundary, then shuts down (waits up to `-DrainTimeoutMinutes`, default 180); supervised tasks resume by themselves after the next start. `-Force` interrupts running stages now and force-stops the process after 15 s — only if the PID in `runtime.json` is still a Node process started within 10 min before its `startedAt` (a reused PID is left alone) |
| `install.ps1 [-AutoStart]` | Start-menu shortcuts (start, and stop with `-Drain`: it runs hidden, where a refusal would go unseen); `-AutoStart` adds a sign-in shortcut with `-NoBrowser`. Per-user, no admin |
| `uninstall.ps1` | Removes those shortcuts; data is kept |

All scripts honour `ACC_DATA_DIR` and `ACC_PORT`.

**Setting up a release** ([release.md](release.md)): Repositories → the
repository → **Release** → *Push to a branch*; fill remote, branch (the branch
your host deploys) and the live URL; add the Cloudflare Pages project and/or a
public version URL; list paths that need a manual step (for example
`db/migrations/**`); **Check setup** must show every check passed; **Save
Changes**. A Pages proof needs a `cloudflare` credential scoped to the
repository with Pages read access (plus a `CLOUDFLARE_ACCOUNT_ID` credential
when the key sees several accounts). Full Autopilot then asks, after Smoke,
"Approve production release" with the task id to type; any completed task can
be released later with **Release…**.

**Restarting after a new build**: `stop-control-center.ps1 -Drain`, then
`start-control-center.ps1`. Another session must never force-stop an
orchestrator that is running someone's stages; `-Force` is for a drain that
cannot finish (a hung stage).

`privileged-helper.ps1` is not a launcher: the orchestrator starts it through
a UAC prompt for one signed, allowlisted request and it exits
([autopilot.md](autopilot.md#privileged-helper)). The orchestrator itself
never runs elevated.

## Other scripts

- `pnpm demo` ([demo.mjs](../../scripts/demo.mjs)): simulated agents, four sample repositories with tasks in every state plus `api-gateway` (a local bare `origin`, a merge, a tag, one unpushed commit, staged/unstaged/untracked work; no task ever runs there, so the Source Control e2e can rely on it); sets `ACC_REPOSITORY_AUTOMATION=0` so it never scans or fetches your real repositories; writes `<base>/ready` when seeded and keeps `<base>/orchestrator.log`. Used by the Playwright suite.
- `pnpm verify:agents [--run] [--only codex|claude] [--codex-model …] [--claude-model …] [--skills]` ([verify-agents.ts](../../scripts/verify-agents.ts)). `--skills` runs 5 real Claude Code probes proving skills stay inside a stage's limits; run it after every Claude Code update ([agents.md](agents.md#skills)).

## MCP for your own clients

`node apps/orchestrator/dist/acc-mcp.js --repository <path> [--profile …]`
exposes the Control Center's tools to any MCP client for a registered
repository; it needs a running orchestrator ([mcp.md](mcp.md)).

## Backups

Everything durable is in the data folder: stop the orchestrator and copy it.
Stored credentials are encrypted with a key that only this Windows account can
unwrap (`credential-key.dpapi`), so a copy restored under another account or
machine cannot read them — re-enter them there ([credential-broker.md](credential-broker.md)).

Last verified: 2026-09-25
