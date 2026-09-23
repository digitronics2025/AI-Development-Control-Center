---
system: agents
sources:
  - packages/agent-sdk/**
  - packages/agent-claude/**
  - packages/agent-codex/**
  - packages/executor/**
verified_at: 892299f
---

# Agent adapters

Contract: [contract.ts](../../packages/agent-sdk/src/contract.ts)
(`detect, healthCheck, getCapabilities, listModels, execute, cancel,
parseResult`). CLI plumbing shared by providers:
[cli-adapter.ts](../../packages/agent-sdk/src/cli-adapter.ts). Prompts always
travel on **stdin**; argv holds only fixed flags and validated model/effort
values. Processes are killed as a tree on cancel/timeout
([process.ts](../../packages/executor/src/process.ts)).

**Line lengths.** `runProcess` splits lines longer than `maxLineLength`
(default 8,000 characters) for display. Agent CLIs stream one JSON event per
line, and a single event — a long final answer, a large file read — exceeds
that, so `CliAgentAdapter.execute` raises the limit to
`PROTOCOL_MAX_LINE_LENGTH` (32 MiB) and bounds only the lines the parser logs.
When events were split, the `result` event never parsed and a successful run
was reported as "finished without producing any output".

**Control Center tools.** `AgentExecutionInput.toolBridge` adds the
Control Center's stdio MCP server to a run; its session token is put in the
agent's environment only ([mcp.md](mcp.md)). Claude Code gets a temporary
`--mcp-config` file referencing the variable by name and `mcp__acc` in its
allowed tools; Codex gets `-c mcp_servers.acc.*` with `env_vars`. The file is
removed when the run ends.

## Codex ([agent-codex](../../packages/agent-codex/src/index.ts))

- Run: `codex exec --json --color never --skip-git-repo-check -C <repo> --sandbox read-only|workspace-write [-m model] [-c model_reasoning_effort="…"] -c forced_login_method="chatgpt" [--ignore-user-config] -`
- Level 1 stages use the read-only sandbox; higher levels `workspace-write`.
- Auth: `codex login status` — "Logged in using ChatGPT" = subscription.
- Models: read from `$CODEX_HOME/models_cache.json` (visible entries, per-model effort levels).
- Output: JSONL events (`agent_message`, `command_execution`, `file_change`, `turn.failed`).

## Claude Code ([agent-claude](../../packages/agent-claude/src/index.ts))

- Run: `claude -p --output-format stream-json --verbose --no-session-persistence --permission-prompts none --permission-mode … --allowedTools … --disallowedTools … [--model] [--effort] [--setting-sources project,local --strict-mcp-config]`
- Permission mapping (`claudeToolPolicy`): L1 `dontAsk` + read-only tools; L2 `acceptEdits`, no git commit/push/deploy; L3 adds git; L4+ adds deploy. Force push, `git reset --hard`, `git clean`, `rm -rf` are always denied.
- Auth: `claude auth status` JSON; `authMethod: claude.ai` + `apiProvider: firstParty` = subscription.
- Runtime tripwire: if the init event reports `apiKeySource` other than `none` in Subscription Only mode, the run is stopped.
- Usage limits: `rate_limit_event` with `status: rejected`, or `api_error_status: 429`.

## Usage reporting

Every result carries `usage` (token lines per model; `null` when the CLI
reported none) and `capacity` observations, and every adapter declares
`usageCapabilities`. Claude Code: `result.modelUsage` (cumulative, with
`costUSD`) and `rate_limit_event` windows; Codex: `turn.completed.usage`
(cached input is inside `input_tokens`) and no cost. Runs are launched only
through `AgentRegistry.launch`, which records them — see [usage.md](usage.md).

## Failure classification ([classify.ts](../../packages/agent-sdk/src/classify.ts))

Structured provider messages are classified before log noise: `USAGE_LIMIT`
("out of credits", "hit your limit", 429…), `AUTH_FAILURE`,
`MODEL_UNAVAILABLE` ("requires a newer version"…), `PERMISSION_DENIED`,
`CONTEXT_FAILURE`; otherwise `PROCESS_CRASH`.

## Simulated agents

[simulated.ts](../../packages/agent-sdk/src/simulated.ts) is registered only
with `ACC_SIMULATED_AGENTS=1` and labelled in the UI. Markers in a task
description steer it: `[sim:review-fail-once]`, `[sim:review-fail-always]`,
`[sim:usage-limit]`, `[sim:fail:<role>]`, `[sim:slow]`,
`[sim:needs-operator]` (verifier names an operator decision),
`[sim:verify-plan-mismatch]`, `[sim:chairman-down]`, `[sim:chairman-bad-json]`.
Role `chairman` answers the Chairman's recovery and chat prompts with JSON.

## Observed on the operator's machine (2026-09-23)

- Claude Code 2.1.278 (Max subscription): runs end to end through the orchestrator.
- Codex 0.150.0 (ChatGPT login): the configured default model `gpt-6-astra` is
  rejected ("requires a newer version of Codex") → `MODEL_UNAVAILABLE`; other
  models return "workspace is out of credits" → `USAGE_LIMIT`. Update Codex and
  restore credits, or reroute Codex roles to Claude Code in Settings.
- Loading the user's own Claude customisations costs ~150k cached tokens per
  run; turn off **Load my CLI customisations** per agent for leaner runs.

Last verified: 2026-09-23
