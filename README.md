# AI Development Control Center

One local control center for AI-assisted software development on Windows: it
runs **Codex** and **Claude Code** through a configurable workflow —
investigate → plan → implement → test → review → fix → verify — with real test
runs, Git change tracking, approvals for risky steps, and live control from a
dashboard or VS Code. No copy/paste between tools.

- **Subscription-first.** Agents run on your signed-in Codex and Claude
  subscriptions. API keys are stripped from their environment, an agent signed
  in with API billing is refused, and a usage limit pauses the task — it never
  falls back to paid API usage.
- **Local-first.** One orchestrator on `127.0.0.1`, SQLite state, artifacts in
  your user data folder. The dashboard and the VS Code extension are clients of
  the same state.
- **Verified, not claimed.** A task completes only after the repository's own
  lint/typecheck/test/build commands ran; the completion report is built from
  recorded results, not from an agent saying "done".

The product plan is [PLAN.md](PLAN.md); the frontend standard is
[design.md](design.md).

## Requirements

- Windows 11 (Linux/macOS work for development), **Node.js 22.12+**, **pnpm 11**, Git
- Codex CLI (`codex login`) and/or Claude Code (`claude`, signed in with claude.ai)
- Visual Studio Build Tools only if `better-sqlite3` has no prebuilt binary for your Node

## Quick start

```powershell
pnpm install
pnpm build          # dashboard (web + VS Code WebView), orchestrator bundle, extension
pnpm start          # http://127.0.0.1:4317
```

Open <http://127.0.0.1:4317>, add a repository (**Repositories → Add repository**),
then **New Task**. The dashboard receives its access token from the page the
orchestrator serves; other websites cannot read it.

### Everyday use on Windows (no terminals)

```powershell
.\scripts\windows\install.ps1 -AutoStart   # Start-menu shortcuts + start at sign-in
```

- **AI Control Center** (Start menu) starts the orchestrator in the background and opens the dashboard.
- **Stop AI Control Center** stops it gracefully; running stages are marked *Interrupted* and can be resumed.
- `.\scripts\windows\uninstall.ps1` removes the shortcuts (task history is kept).

### VS Code

```powershell
pnpm package:vscode
code --install-extension apps/vscode-extension/acc-vscode.vsix
```

The extension adds an **AI: …** status-bar item (e.g. *AI: Claude Implementing*,
*AI: Waiting Approval*), notifications, the Control Center view (activity bar
and editor panel), and commands: New Task, Pause/Resume, Cancel, Add Directive,
Retry Stage, Reroute, Open Logs/Artifacts/Diff. It finds the orchestrator
through `%LOCALAPPDATA%\AIDevControlCenter\runtime.json`.

### Source Control

**Source Control** in the sidebar shows one registered repository's Git state:
staged, unstaged, untracked and conflicted files with per-file diffs, a commit
composer (with an optional suggested message and a read-only AI review of what
is staged), paginated history with a branch graph, and Fetch / Sync / Publish
branch. Sync fetches first and only pushes or fast-forwards when that is safe;
it never merges, rebases or force-pushes. Commits and pushes that include
environment files, keys or credential-shaped values are blocked. While a task
is editing the repository, Git actions wait and everything stays readable.
Details: [docs/systems/source-control.md](docs/systems/source-control.md).

### Tools

Agents and workflows reach the machine through one tool layer: PowerShell,
CMD, Git Bash and WSL; files, Git and GitHub; Node and Python; a real
Chromium for checking pages; HTTP; Cloudflare, databases, Docker, Android and
Windows tools; interactive terminals; and any MCP server you add. Every call
goes through the same policy (Safe · Autopilot · Full Autopilot+), is
classified and recorded, and never sees your secrets in plain text. Full
Autopilot starts your app after the tests and checks it in a browser at
desktop and phone width; environment problems (missing dependencies, a busy
port, a missing browser) are repaired and the check re-run. Repositories can
run each task in its own Git worktree. **Tools** in the sidebar shows what is
installed, running processes, terminals, MCP servers, credentials and the
policy. Details: [docs/systems/tool-system.md](docs/systems/tool-system.md).

### Try it without spending any subscription usage

```powershell
pnpm demo   # simulated agents, sample repositories, tasks in every state
```

## Verification

| Command | What it checks |
|---|---|
| `pnpm check` | typecheck, lint and unit/integration tests (engine, API security, adapters with fake CLIs, Git attribution, redaction) |
| `pnpm e2e` | Playwright against a real orchestrator: every page at 5 viewports × Dark/Light, axe WCAG 2.2 AA, keyboard and realtime flows, VS Code WebView |
| `pnpm verify:agents` | real CLI detection and subscription check; add `--run` for a one-word prompt through each agent |

## Repository layout

```text
apps/orchestrator       Fastify API + WebSocket, SQLite, workflow engine
apps/dashboard          React dashboard; also builds the VS Code WebView bundle
apps/vscode-extension   Thin VS Code client
packages/shared         Domain types, Zod schemas, workflow validation
packages/security       Redaction, subscription-only env guard, command classification
packages/executor       Child processes: streaming, timeouts, tree-kill
packages/agent-sdk      Adapter contract, failure classification, simulated agent
packages/agent-codex    Codex CLI adapter
packages/agent-claude   Claude Code adapter
packages/git            Baselines, change attribution, diffs, commits, worktrees
packages/tools          Tool SDK, registry, router, policy, recovery, tool packs
packages/pty            Interactive terminals (ConPTY)
packages/mcp            MCP gateway and the Control Center's own MCP server
packages/ui             Design system (tokens, primitives, components)
workflows/              Built-in workflow profiles (YAML)
prompts/                Built-in role prompt templates
scripts/                Demo server, agent verification, Windows launchers
docs/systems/           How each subsystem works
```

## Found for later

Deliberately out of scope (PLAN §40): running several tasks at once in one
repository (worktree isolation exists; a scheduler for it does not), remote/phone control, more agent adapters (Gemini, OpenCode,
Ollama), automatic effort selection, production deploy automation, a signed
installer. See [docs/systems/README.md](docs/systems/README.md) for known
limitations per subsystem.
