# Systems index

| System | Doc | Code |
|---|---|---|
| Orchestrator (HTTP, WebSocket, persistence) | [orchestrator.md](orchestrator.md) | `apps/orchestrator` |
| Workflow engine | [workflow-engine.md](workflow-engine.md) | `apps/orchestrator/src/engine`, `packages/shared/src/workflow.ts`, `workflows/` |
| Role prompts (templates, placeholders, marker lines, prompt artifacts) | [prompts.md](prompts.md) | `prompts/`, `packages/shared/src/prompts.ts`, `apps/orchestrator/src/engine/context.ts` |
| Chairman supervisor and chat | [chairman.md](chairman.md) | `apps/orchestrator/src/chairman`, `packages/shared/src/chairman.ts` |
| Learning loop (task reviews, findings, improvements the Chairman adopts) | [learning.md](learning.md) | `apps/orchestrator/src/learning`, `packages/shared/src/learning.ts`, `packages/tools/src/packs/installer.ts` |
| Agent adapters | [agents.md](agents.md) | `packages/agent-*`, `packages/executor` |
| Security | [security.md](security.md) | `packages/security`, `apps/orchestrator/src/http/security.ts` |
| Git integration | [git.md](git.md) | `packages/git` |
| Source Control (repository Git state, sync, journal) | [source-control.md](source-control.md) | `packages/git/src/source-control.ts`, `apps/orchestrator/src/source-control` |
| Repository automation (discovery, background sync) | [repository-automation.md](repository-automation.md) | `apps/orchestrator/src/services/repository-automation.ts` |
| Usage, cost and capacity (ledger, pricing, budgets, limits) | [usage.md](usage.md) | `apps/orchestrator/src/usage`, `packages/shared/src/usage.ts`, `apps/dashboard/src/pages/usage` |
| Dashboard and design system | [dashboard.md](dashboard.md) | `apps/dashboard`, `packages/ui` |
| VS Code extension | [vscode-extension.md](vscode-extension.md) | `apps/vscode-extension` |
| Windows packaging and operations | [operations.md](operations.md) | `scripts/` |
| Tool system (registry, router, execution door, sessions, processes) | [tool-system.md](tool-system.md) | `packages/tools`, `apps/orchestrator/src/tools` |
| Shells (PowerShell, CMD, Bash, WSL) | [powershell.md](powershell.md) | `packages/executor/src/shells.ts`, `packages/tools/src/packs/shell.ts` |
| Interactive terminals | [pty.md](pty.md) | `packages/pty`, `apps/orchestrator/src/tools/terminals.ts` |
| Tasks across repositories (task workspace, linked repositories, per-repository stages) | [multi-repository-tasks.md](multi-repository-tasks.md) | `apps/orchestrator/src/engine/task-repositories.ts`, `apps/orchestrator/src/engine` |
| Checkpoints and worktrees | [checkpoints.md](checkpoints.md) | `apps/orchestrator/src/chairman/checkpoints.ts`, `packages/git/src/worktrees.ts` |
| Tool-level recovery | [recovery.md](recovery.md) | `packages/tools/src/recovery.ts`, `apps/orchestrator/src/engine/runners.ts` |
| MCP (Control Center server, gateway) | [mcp.md](mcp.md) | `packages/mcp`, `apps/orchestrator/src/tools/mcp.ts` |
| Browser pages, web research, past Worker logs, pictures for the model | [browser-and-web.md](browser-and-web.md) | `packages/tools/src/packs/browser-session.ts`, `packages/tools/src/packs/web.ts` |
| Credential broker (MyVault bridge, generated secrets, secret deploy gate) | [credential-broker.md](credential-broker.md) | `apps/orchestrator/src/tools/credentials.ts`, `apps/orchestrator/src/tools/vault-bridge*.ts`, `apps/dashboard/src/pages/VaultBridgePage.tsx` |
| Connected apps (Private Browser pairing, task intake, re-checks) | [connected-apps.md](connected-apps.md) | `apps/orchestrator/src/connected-apps`, `apps/orchestrator/src/http/connected-app-routes.ts` |
| Remote execution node (pairing, outbound link, typed commands, egress) | [remote-node.md](remote-node.md) | `apps/orchestrator/src/remote`, `packages/shared/src/remote*.ts` |
| Cloud control plane (Worker, D1, R2, hub, Access, deploy and recovery) | [cloud-control.md](cloud-control.md) | `apps/cloud-control`, `apps/dashboard/src/app/mode.ts` |
| Execution policy and privileged helper | [autopilot.md](autopilot.md) | `packages/tools/src/policy.ts`, `scripts/windows/privileged-helper.ps1` |
| Pre-release audit (2026-09-24, findings F-01 to F-54, production snapshot) | [../security/prerelease-audit-2026-09-24.md](../security/prerelease-audit-2026-09-24.md) | whole repository, both Cloudflare hostnames, D1 `acc-control-production` |

Last verified: 2026-09-24
