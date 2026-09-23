# Systems index

| System | Doc | Code |
|---|---|---|
| Orchestrator (HTTP, WebSocket, persistence) | [orchestrator.md](orchestrator.md) | `apps/orchestrator` |
| Workflow engine | [workflow-engine.md](workflow-engine.md) | `apps/orchestrator/src/engine`, `packages/shared/src/workflow.ts`, `workflows/` |
| Chairman supervisor and chat | [chairman.md](chairman.md) | `apps/orchestrator/src/chairman`, `packages/shared/src/chairman.ts` |
| Agent adapters | [agents.md](agents.md) | `packages/agent-*`, `packages/executor` |
| Security | [security.md](security.md) | `packages/security`, `apps/orchestrator/src/http/security.ts` |
| Git integration | [git.md](git.md) | `packages/git` |
| Source Control (repository Git state, sync, journal) | [source-control.md](source-control.md) | `packages/git/src/source-control.ts`, `apps/orchestrator/src/source-control` |
| Repository automation (discovery, background sync) | [repository-automation.md](repository-automation.md) | `apps/orchestrator/src/services/repository-automation.ts` |
| Dashboard and design system | [dashboard.md](dashboard.md) | `apps/dashboard`, `packages/ui` |
| VS Code extension | [vscode-extension.md](vscode-extension.md) | `apps/vscode-extension` |
| Windows packaging and operations | [operations.md](operations.md) | `scripts/` |
| Tool system (registry, router, execution door, sessions, processes) | [tool-system.md](tool-system.md) | `packages/tools`, `apps/orchestrator/src/tools` |
| Shells (PowerShell, CMD, Bash, WSL) | [powershell.md](powershell.md) | `packages/executor/src/shells.ts`, `packages/tools/src/packs/shell.ts` |
| Interactive terminals | [pty.md](pty.md) | `packages/pty`, `apps/orchestrator/src/tools/terminals.ts` |
| Checkpoints and worktrees | [checkpoints.md](checkpoints.md) | `apps/orchestrator/src/chairman/checkpoints.ts`, `packages/git/src/worktrees.ts` |
| Tool-level recovery | [recovery.md](recovery.md) | `packages/tools/src/recovery.ts`, `apps/orchestrator/src/engine/runners.ts` |
| MCP (Control Center server, gateway) | [mcp.md](mcp.md) | `packages/mcp`, `apps/orchestrator/src/tools/mcp.ts` |
| Credential broker | [credential-broker.md](credential-broker.md) | `apps/orchestrator/src/tools/credentials.ts` |
| Execution policy and privileged helper | [autopilot.md](autopilot.md) | `packages/tools/src/policy.ts`, `scripts/windows/privileged-helper.ps1` |

Last verified: 2026-09-23
