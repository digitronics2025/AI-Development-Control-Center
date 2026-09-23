# Universal Tool & Autonomous Execution Layer (V2)

**Project:** `digitronics2025/AI-Development-Control-Center`
**Plan type:** Focused upgrade plan (extends V1; does not replace it)
**Verified against current repository:** 2026-09-23 (`dd8704f`)
**Status:** Implemented — see [Implementation status](#implementation-status).

> The root `PLAN.md` stays the product-level architecture. This file records
> how the V2 upgrade maps onto the real code, the decisions taken, and what was
> verified. How each piece works today lives in `docs/systems/`.

---

## 1. What V2 adds, in one paragraph

The orchestrator becomes the execution authority between agents and the
machine. Agents ask for *capabilities* (`git.status`, `network.port_owner`,
`browser.check_page`, `http.request` …); the Control Center picks the tool that
provides it, decides whether the call is allowed under the task's policy,
injects credentials without showing them to the model, runs it, records
structured telemetry, and returns a redacted result. The same layer runs the
engine's own verification (tests with automatic repair of infrastructure
failures, real browser/HTTP checks), manages task-owned long-running processes,
interactive terminals, checkpoints and MCP servers.

## 2. Decisions (maintainable > scalable > secure > production-ready > sustainable)

| Topic | Decision | Why |
|---|---|---|
| Packages | `@acc/tools` (SDK, registry, router, profiles, policy, recovery classifier, verification matrix, environment discovery, and every built-in tool pack under `src/packs/`), `@acc/pty` (node-pty sessions), `@acc/mcp` (gateway client + Control Center MCP server + stdio bridge). Shell runners extend `@acc/executor`; the credential cipher and redaction registry extend `@acc/security`; checkpoint metadata extends `@acc/git`. | The plan's 20 suggested packages would mostly be a file each. The split follows real isolation boundaries: native dependency (PTY), external protocol (MCP), pure logic + packs (tools). |
| Tool model | A **provider** (`git`, `powershell`, `playwright`…) offers **operations**; an operation id is the capability (`git.status`). Each operation has a Zod input schema (also its MCP/JSON schema), a base permission level, a per-input risk classifier and an executor. | Capabilities are what agents ask for; providers are what the machine has. The router maps one to the other and records why. |
| Execution authority | Every call — agent (via MCP), engine, dashboard, Chairman — goes through `ToolService.invoke`: validate → route → classify → policy decision (allow / escalate / needs approval / deny) → credential injection → checkpoint when high-impact → run → redact → `tool_executions` row + realtime event. | One door means one audit trail and one place to harden. |
| Agents reach tools | A per-execution **tool session** (random token, in memory only, scoped to task, stage level and capability profile, revoked when the execution ends). Claude Code and Codex launch the stdio bridge `acc-mcp` (MCP protocol) which forwards to `/api/tool-session/*` with that token. | Stdio MCP works with both CLIs; the bridge holds no policy. A leaked session token can do only what that stage could already do, and dies with the run. |
| Permission | Existing five levels kept. A capability above the **stage's** level is refused (an Analyze stage never writes). A capability outside the stage's **profile** but within its level and the policy ceiling is enabled on the fly and recorded as an escalation. Dangerous or production-targeting calls always need a typed-confirmation approval; agents receive a structured refusal instead of hanging. | Keeps workflow semantics (Codex's read-only sandbox for L1 agrees), makes "Autopilot" mean "no questions for safe things". |
| Policy modes | `safe` (ceiling 2), `autopilot` (ceiling = auto-approve level, default 3), `full` (ceiling 4). Global in Settings, overridable per repository; stored on each task at creation. Level 5 / dangerous always asks. | The plan's Safe / Autopilot / Full Autopilot+; existing auto-approve semantics are preserved. |
| Classifier | Shell-aware: splits on `; && \|\| \| newline`, normalises PowerShell aliases, decodes `-EncodedCommand` and classifies the decoded script, reports **effects** (filesystem, git, network, credentials, privilege, database, infrastructure, production, process, persistence). `classifyCommand` keeps its shape and gains `effects`. | Regex-only matching missed aliases, encoded commands and download-and-execute chains. |
| PowerShell | `pwsh` preferred, `powershell.exe` fallback; scripts are written to a private temp `.ps1` and run with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File` (process scope only); structured operations end with `ConvertTo-Json -Compress` and UTF-8 console output. | `-Command -` misparses multi-line scripts in 5.1; `-EncodedCommand` has a length limit. |
| PTY | `node-pty` 1.1 (Microsoft, ships Windows prebuilds; `allowBuilds` only runs its prebuild check). Sessions are loopback-only (refused when the orchestrator binds remotely), cwd limited to registered repositories/worktrees, output redacted, bounded history, idle timeout, tree-kill on close and at startup. Agent-driven terminals classify every line before writing it. | The operator's "Open terminal" and interactive programs need a real TTY; this must never become a remote shell. |
| Processes | `task_processes` rows with pid **and** process creation time + command fingerprint. Cleanup (task end, cancel, startup) kills a pid only when all three still match. | Never kill a reused pid or a user process. |
| Checkpoints | One table: V1's `task_checkpoints` gains `type` (`git`, `database`, `deployment`) and `metadata` (branch, status, changed files, lockfile hashes, environment). Git checkpoints stay private-index commits under `refs/acc/`; SQLite checkpoints use the SQLite online backup API; deployment checkpoints record the live version for a later approved rollback. | Avoids a second checkpoint system; Git already gives cheap snapshots. |
| Recovery | Two layers. Tool level (this upgrade): classify command failures (missing dependency, port conflict, stale task process, transient network, file lock, missing browser) and apply a bounded repair (install with the repo's package manager, stop a task-owned port holder, back off, install Playwright's browser) then re-run; every attempt is a `recovery_attempts` row. Stage level (V1 Chairman): semantic failures, strategy changes, rollback. Real test failures are never "repaired" — they go to the fix loop. | Infrastructure noise stops burning fix cycles; the Chairman keeps owning judgement. |
| Worktrees | Repository Git mode `worktree`: the task runs in `<data>\worktrees\<repo>-<id>\<task>` on its own branch, the user's working tree is never touched, the task's work is committed to its branch at completion and the worktree removed (uncommitted leftovers are kept in a checkpoint ref first). Default mode stays `task-branch`. | Backward compatible; opt-in per repository or per task. |
| Verification | New stage kind `verify`: start the repository's dev server as a task-owned process, wait for HTTP health, drive Chromium (Playwright) at desktop and phone widths, record console errors, page errors, failed requests and screenshots, stop the server. Workers/APIs get HTTP checks. Optional stage in Full Autopilot; skipped when the repository has no runtime configured. | Completion evidence is observed by the orchestrator, not taken from an agent. |
| Credentials | AES-256-GCM ciphertext in `credential_references`; the key is DPAPI-protected (CurrentUser) on Windows, a mode-600 file elsewhere. Values are write-only through the API, injected into a child's environment only for the call that needs them, and registered with the redactor. Env vars the broker manages are stripped from agent environments. | No plaintext in SQLite, logs, prompts or artifacts. |
| Privileged helper | No elevated orchestrator. An allowlisted one-shot helper (`scripts/windows/privileged-helper.ps1`) runs elevated through UAC for three operation types (allowlisted `winget` package ids, `ACC-` firewall rules for a TCP port, start/stop of allowlisted services); requests are HMAC-signed with a key in the data folder, parameters validated, every run audited. | UAC consent is the real authorisation boundary on Windows; there is no generic elevated shell. |
| Dashboard | New top-level **Tools** section (a separate domain: machine capabilities, not tasks) with tabs Overview, Processes, Terminals, MCP servers, Credentials, Policy; task page gains an **Execution** tab (tool timeline, processes, checkpoints, recovery, escalations, verification evidence) and an **Open terminal** drawer. `design.md` is updated first. | design.md §3 allows a new top-level entry only for a separate domain. |

## 3. Phases

| # | Phase | Scope in this repository |
|---|---|---|
| 1 | Foundation | `@acc/tools` SDK, registry, discovery/health (cached, persisted), structured results; migration 5 |
| 2 | Shell runtime | executor shells (pwsh/powershell/cmd/bash/wsl/direct), `@acc/pty` |
| 3 | Filesystem & Git | fs pack with root confinement, git pack, worktree mode, checkpoint types |
| 4 | Router | profiles, routing reasons, escalation, policy integration, tool sessions |
| 5 | Recovery | classifier + repairs in the tests stage, `recovery_attempts` |
| 6 | Browser | Playwright pack, `verify` stage kind |
| 7 | HTTP & network | http pack, network/windows packs, port ownership |
| 8 | Cloudflare & databases | wrangler pack (local/preview/production separated), SQLite/D1 pack |
| 9 | Android & Docker | adb/gradle and docker packs (enabled only when installed) |
| 10 | MCP | gateway registry, Control Center MCP server + bridge, agent wiring |
| 11 | Credentials | broker, env audit |
| 12 | Autopilot policy | modes, per-repository override |
| 13 | Dashboard | Tools section, Execution tab, terminal drawer |
| 14 | Hardening | restart, cancellation, timeouts, orphan processes, worktree conflicts |
| 15 | Real E2E | broken fixture app fixed end to end by a real agent under Full Autopilot |

## Implementation status

Updated 2026-09-23. "Verified" means observed on this Windows 11 machine, not claimed.

| # | Phase | State | Evidence |
|---|---|---|---|
| 1 | Foundation | Done | Registry and router tests; migration 5 applied in the orchestrator tests; tool health persisted and re-checked lazily |
| 2 | Shell runtime | Done | Real PowerShell 5.1 (no `pwsh` installed, so the fallback is what ran), CMD, Git Bash and WSL; ConPTY terminal answering an interactive `Read-Host`, whole-tree kill |
| 3 | Filesystem & Git | Done | Path confinement incl. links; real Git operations; worktree isolation and cancellation tests |
| 4 | Router & sessions | Done | Scoped agent sessions (level refusal, escalation outside the profile, token separation, revocation) |
| 5 | Recovery | Done | Real `npm ci` → `npm install` repair in a test stage, then the test re-ran and passed |
| 6 | Browser | Done | Headless Chromium at desktop and phone width; a console error sent the task back to the fixer |
| 7 | HTTP & network | Done | Real HTTP calls; port ownership from Windows; task-owned process detection |
| 8 | Cloudflare & databases | Partly verified | SQLite and SQL classification tested; Wrangler, D1, Postgres and MySQL operations are built but were not run against real services |
| 9 | Android & Docker | Partly verified | Packs build and detect; no device or Docker daemon was exercised |
| 10 | MCP | Done | Real stdio MCP server through the gateway; a real Claude Code 2.1.280 run used the Control Center tools (below). Codex wiring built, not run live |
| 11 | Credentials | Done | DPAPI-wrapped key; value absent from API and raw SQLite; injected into one call; echo redacted |
| 12 | Autopilot policy | Done | Every decision path unit-tested; per-repository and per-task modes |
| 13 | Dashboard | Done | Tools page, Execution tab, terminal drawer; full Playwright matrix (57 tests, both themes, axe WCAG 2.2 AA) green |
| 14 | Hardening | Done | Restart cleanup kills a leftover only when pid and creation time match; cancel stops processes and removes the worktree |
| 15 | Real E2E | Done | See below |

**Phase 15 run.** A small Node shop app with four planted problems (a missing
`file:` dependency with no lockfile, a price total ignoring quantity, a typo
that throws in the page, a stylesheet link that 404s), registered on a separate
orchestrator (own port and data folder) in *Isolated worktree* mode, task on
**Full Autopilot** with every role on Claude Code. It completed in about six
minutes with no human input: Investigate found all four problems; during
Implement the agent itself called `process.start`, `http.request`,
`browser.check_page`, `browser.run_flow` and `process.stop` through the MCP
bridge; the orchestrator's own Test and App check stages passed; Review and
Verify passed; one commit (three one-line fixes) landed on
`ai/TASK-0001-fix-the-cart`; the worktree was removed, the user's checkout was
untouched and nothing was left listening. The run exposed three defects, fixed
afterwards: a misleading routing reason, a pointless locked install in a
worktree without a lockfile, and a coverage report that ignored the browser
check for a plain Node server.

## Found for Later

| Issue | Why it matters | Recommended fix | Priority | Blocks V2? |
|---|---|---|---|---|
| No scheduler for several isolated tasks in one repository | Worktrees make it safe, but tasks still queue one per repository | A per-repository concurrency limit in the engine's queue, worktree tasks only | Medium | No |
| Codex MCP bridge not run live | The Codex CLI here is too old for its default model and the workspace has no credits | Re-run `pnpm verify:agents --run` after updating Codex; then one tool call through the bridge | Medium | No |
| Wrangler, D1, Postgres, MySQL, Docker and Android not run against real services | Only detection, schemas and classification are proven | One smoke per pack on a machine with each service, behind an opt-in test flag | Medium | No |
| Privileged helper never elevated in a test | Elevation needs a person at the UAC prompt | A manual checklist run once per release (install one allowlisted package) | Low | No |
| Deployment checkpoints are metadata only | A rollback of a deploy still needs an approved deploy of the old version | Record the deployed version id from Wrangler and offer it as the rollback target | Low | No |
| Terminal output is redacted per chunk | A secret split across two output chunks could pass unredacted | Keep a small rolling tail between chunks when redacting | Medium | No |
| Machine memory pressure breaks e2e runs | With many sessions open, Windows refused process launches and Playwright workers crashed; reruns passed | Run the e2e suite with fewer concurrent sessions, or add a single retry for worker crashes only | Low | No |
