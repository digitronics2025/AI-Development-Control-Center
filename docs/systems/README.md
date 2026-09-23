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
| Dashboard and design system | [dashboard.md](dashboard.md) | `apps/dashboard`, `packages/ui` |
| VS Code extension | [vscode-extension.md](vscode-extension.md) | `apps/vscode-extension` |
| Windows packaging and operations | [operations.md](operations.md) | `scripts/` |

Last verified: 2026-09-23
