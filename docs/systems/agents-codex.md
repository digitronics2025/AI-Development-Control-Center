---
system: agents-codex
sources:
  - packages/agent-codex/**
verified_at: 57af61a
---

# Codex adapter

Part of [Agent adapters](agents.md).

## Codex ([agent-codex](../../packages/agent-codex/src/index.ts))

- Run: `codex exec --json --color never --skip-git-repo-check -C <repo> --disable apps --disable plugins --disable skill_mcp_dependency_install [-c mcp_servers.<name>={enabled=false,…}]… --sandbox read-only|workspace-write --ignore-rules [-m model] [-c model_reasoning_effort="…"] -c forced_login_method="chatgpt" [--ignore-user-config] [-c mcp_servers.acc.command=… -c mcp_servers.acc.args=[…] -c mcp_servers.acc.env_vars=[…] -c mcp_servers.acc.default_tools_approval_mode="approve"] [-i <image>]… -`
- Level 1 stages use the read-only sandbox; higher levels `workspace-write`.
- Images: `launchAgent` passes the task's image attachments (PNG, JPEG, WebP,
  GIF; five at most, 10 MB each) as `images` to any adapter whose
  capabilities say `images: true` — Codex, as `-i <path>` — so reference
  pictures reach the model without the agent copying anything out of the data
  folder. Claude Code (`images: false`) reads them by path from
  `{{attachments}}` ([design-agent.md](design-agent.md)).
- `--ignore-rules` on every run: Codex's execpolicy `.rules` files (the operator's
  `~/.codex/rules`, the repository's `.codex/rules/`) are never loaded. An `allow`
  match for every segment of a command skips approval **and runs it outside the
  sandbox** (`exec_policy.rs`: `Skip { bypass_sandbox }`), so a repository could
  lift a read-only stage. Measured on 0.156.1 (2026-09-27): a repository rule —
  confirmed matching with `codex execpolicy check` — did not escape the sandbox in
  any run (Codex wraps commands in `powershell.exe -Command` and matches the parsed
  script), so the bypass is closed from the source, not reproduced. With user
  config off no Windows sandbox mode is set and a writing command is refused
  ("blocked by policy"); with it on (`[windows] sandbox = "unelevated"`) the
  command runs and the write is denied. A CLI older than the flag fails with
  "unexpected argument" → `MODEL_UNAVAILABLE` (update the CLI).
- Auth: `codex login status` — "Logged in using ChatGPT" = subscription.
- Models: read from `$CODEX_HOME/models_cache.json` (visible entries, per-model effort levels).
- Output: JSONL events (`agent_message`, `command_execution`, `file_change`, `turn.failed`).
  A run that exits 0 without a `turn.completed` — the event that ends every
  successful turn and carries its usage — fails `PROTOCOL_DRIFT` instead of
  succeeding (`codexProtocolDrift`; a `thread.started` alone holds no turn): a
  changed event format is never counted as a success. A run that failed anyway
  (`turn.failed`, a non-zero exit) keeps its own class.

### MCP servers in a Codex run

Codex has no `--strict-mcp-config`, and MCP servers run outside its sandbox:
any server but `acc` would hand an agent tools that skip `ToolService.invoke`
and the stage's level. Measured on Codex 0.156.1 (2026-09-27, real
`codex exec` runs with the adapter's flags, Codex's own log at
`RUST_LOG=info`), a run without the isolation below loads:

| Source | With `--ignore-user-config` | Switched off by |
|---|---|---|
| `$CODEX_HOME/config.toml` `[mcp_servers]` (7 here, incl. `node_repl`, the desktop app's computer-use runtime) | not loaded | name |
| A trusted repository's `.codex/config.toml` (`tenten-d1` in tenten-accounting-in) | not loaded: trust lives in the user config | name |
| `codex_apps`, ChatGPT connectors (reports itself as `plugin-runtime`) | **loaded** | `--disable apps` |
| Plugin servers, including plugins installed on the ChatGPT account (`cloudflare-api` → mcp.cloudflare.com) | **loaded** (account plugins) | `--disable plugins` |
| Servers a mentioned skill asks to install and enable | not reproduced | `--disable skill_mcp_dependency_install` |
| System (`%ProgramData%\OpenAI\Codex\config.toml`) and workspace-managed config | loaded by design; none exist here | name |

How ([index.ts](../../packages/agent-codex/src/index.ts) `buildArgs`):

- Before each run, `codex mcp list --json` with the same three `--disable`
  flags runs in the run's folder (~2 s), so Codex itself resolves every layer
  and the repository's trust. `mcp list` has no `--ignore-user-config`, so it also
  lists user servers when the run ignores them; switching those off is harmless.
- Every listed server but the run's bridge gets
  `-c mcp_servers.<name>={enabled=false,command="acc-disabled"}` (`url=…` for
  HTTP). A `-c` table merges into the loaded layers — `-c mcp_servers={}`
  changes nothing — so servers are named one by one, and the entry restates a
  transport because Codex refuses one without ("invalid transport"), which it
  would be when its layer is not loaded.
- Refused, never run open (`AgentGuardError`): the listing fails or is
  unreadable, or names a server a `-c` key cannot address (names outside
  `[A-Za-z0-9_-]`, transports other than `stdio`/`streamable_http`). A CLI
  that does not know one of the flags fails the listing with "Unknown feature
  flag" → `MODEL_UNAVAILABLE` (update the CLI).
- Price: plugin skills and ChatGPT connectors are not available in Codex runs.

**Tripwire:** after every Codex update run `pnpm verify:agents --only codex
--mcp [--codex-mcp-repo <trusted repository with a .codex MCP server>]`. With
the operator's real config it runs the shipped argv with a stand-in `acc`
server, config loaded and ignored, and passes only when Codex's log names `acc`
alone at session start, no other server starts or fails to start, and the
stand-in was started; then a tool not marked read-only must run on a stand-in
`acc` (the approval setting in [agents-contract.md](agents-contract.md)). 2026-09-27: 3/3 pass, `tenten-d1` switched off by name in
tenten-accounting-in. 2026-09-28 (0.156.1, the operator's config): all three
checks pass, the tool not marked read-only among them.

Last verified: 2026-09-28
