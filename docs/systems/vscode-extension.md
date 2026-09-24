---
system: vscode-extension
sources:
  - apps/vscode-extension/**
verified_at: 2d516aa
---

# VS Code extension

Thin client ([extension.ts](../../apps/vscode-extension/src/extension.ts)); no
workflow logic. Package: `pnpm package:vscode` →
`apps/vscode-extension/acc-vscode.vsix`.

## Discovery

Reads `runtime.json` and `auth-token` from the data folder (setting
`acc.dataDirectory`, default `%LOCALAPPDATA%\AIDevControlCenter`); only loopback
URLs are accepted. If the orchestrator is not running it re-checks every 10 s;
**Start Orchestrator** launches `apps/orchestrator/dist/main.js` (or
`acc.orchestratorPath`) detached. `acc.autoStart` does that on startup.

## Surfaces

- **Status bar** ([status.ts](../../apps/vscode-extension/src/status.ts)): `AI: Idle`, `AI: <Agent> <Activity>`, `AI: Tests Running`, `AI: Waiting Approval`, `AI: Failed`, `AI: Complete`, `AI: Offline`. Click opens the relevant task.
- **Notifications** for approvals, failures and completions (`acc.notifications`).
- **Control Center** WebView in the activity bar and as an editor panel. HTML from [webview.ts](../../apps/vscode-extension/src/webview.ts): CSP with a nonce, assets from `media/`, `connect-src` limited to the orchestrator.
- **Commands**: Open Control Center, New Task, Pause/Resume, Cancel (modal confirm), Add Directive, Retry Stage, Reroute, Open Logs/Artifacts/Diff, Review Approvals, Start Orchestrator, Reconnect.
- **URI**: `vscode://digitronics2025.acc-vscode/open?route=/tasks/TASK-0001`.

The WebView posts `openDiff`, `openArtifact`, `openFile` and
`pickRepositoryFolder` to the host, which opens real editors / the native
folder picker; the host sends `navigate` to change route without reloading.

Source Control runs in the same WebView page. Host messages
`openSourceControlDiff` and `openCommitDiff` open the orchestrator's (redacted,
bounded) diff in an editor tab; `revealRepository` reveals the folder. VS Code's
own SCM API is not used as a second source of truth.

## Tests

Unit tests run under the root Vitest projects. The package is CommonJS (no
`"type": "module"`, as VS Code loads the extension with `require`), so its
Vitest config is [vitest.config.mts](../../apps/vscode-extension/vitest.config.mts).

## Verified

2026-09-23 in an Extension Development Host (VS Code 1.138): status bar showed
live state, the WebView connected over WebSocket from its `vscode-webview://`
origin and rendered Task Detail in the editor theme.

Last verified: 2026-09-24
