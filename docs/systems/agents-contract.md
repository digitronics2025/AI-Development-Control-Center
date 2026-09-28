---
system: agents-contract
sources:
  - packages/agent-sdk/**
  - '!packages/agent-sdk/src/simulated.ts'
  - '!packages/agent-sdk/src/skills.ts'
  - '!packages/agent-sdk/test/skills.test.ts'
  - packages/executor/**
  - packages/agent-claude/test/conformance.test.ts
  - packages/agent-codex/test/conformance.test.ts
verified_at: 57af61a
---

# Agent adapter contract

Part of [Agent adapters](agents.md).

Contract: [contract.ts](../../packages/agent-sdk/src/contract.ts)
(`detect, healthCheck, getCapabilities, listModels, execute, cancel,
parseResult`). CLI plumbing shared by providers:
[cli-adapter.ts](../../packages/agent-sdk/src/cli-adapter.ts). Prompts always
travel on **stdin**; argv holds only fixed flags and validated model/effort
values. Processes are killed as a tree on cancel/timeout
([process.ts](../../packages/executor/src/process.ts)).

**As the agent account.** With agent isolation on ([security.md](security.md#agent-os-boundary)),
a stage's run carries `AgentExecutionInput.runAs` (only stage runs:
[runners.ts](../../apps/orchestrator/src/engine/runners.ts) `launchAgent`, Stage
Team workers included; Ask, the Chairman and commit-message drafts stay Level 1
runs as the operator). `CliAgentAdapter.execute` then refuses with
`PERMISSION_DENIED` before anything starts when it is not Windows, the relay is
missing or the password record is missing (`runAsRefusal`,
[run-as.ts](../../packages/agent-sdk/src/run-as.ts)); otherwise it starts
Windows PowerShell on [agent-relay.ps1](../../scripts/windows/agent-relay.ps1)
with the run's environment plus `ACC_AGENT_RELAY` (base64 JSON: account, record,
the program and the exact command line `runProcess` would have used —
`windowsLaunch`: cross-spawn's `cmd.exe /d /s /c` for a `.cmd` shim, libuv's
quoting otherwise — and the folder; nothing secret). The relay starts the
program as the account, copies stdin to it and its output back byte for byte,
holds it in a kill-on-close job (ending the relay's tree on cancel or timeout
ends everything the run started, and a run's leftovers end with it), and exits
with its code. A relay refusal (exit 31436, one `Agent isolation:` line) becomes
`PERMISSION_DENIED` with that line. Never a fallback to the operator. Claude
Code's `--mcp-config` is inline JSON in such a run (the account cannot open the
operator's temp folder). Without `runAs` the launch is unchanged.

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
allowed tools; Codex gets `-c mcp_servers.acc.*` with `env_vars` and
`default_tools_approval_mode="approve"`, and every other MCP server switched off
([agents-codex.md](agents-codex.md#mcp-servers-in-a-codex-run)). Codex asks before any MCP tool not
marked read-only and `exec` refuses every such prompt ("MCP tool call requires
approval, but approval policy is never"): measured on 0.156.1 (2026-09-28), a
read-only tool ran and any other was refused, so a Codex critic, reviewer or
verifier could not use the Control Center's tools at all (TASK-0022). The
Control Center judges each call itself (level, profile, approvals, spend gate,
self-reference), so its tools are approved in Codex, as Claude Code allows
`mcp__acc`. The file is removed when the run ends.

## Declared capabilities

`getCapabilities()` returns `AgentCapabilities`
([types.ts](../../packages/shared/src/types.ts)). The orchestrator decides by
what an adapter declares, never by its id: no `agentId === 'claude'` branch
exists in `apps/orchestrator/src`. Decisions read the adapter itself
(`AgentRegistry.capabilities(id)`); `GET /api/agents` serves the copy the last
health check stored, filled with defaults for fields a copy stored before they
existed (`providerLabel` empty, `maxPermissionLevel` 1).

| Field | Claude Code | Codex | Used by |
|---|---|---|---|
| `pluginDirs` | yes (`--plugin-dir`) | no | the learning loop: a run that loads plugin folders is told a learned skill "is loaded for this run", others get its file to read ([learning.md](learning.md)) |
| `providerLabel` | Anthropic (Claude Code) | OpenAI (Codex) | the dashboard's provider names; `AgentInfo.provider` is the usage provider key it names |
| `maxPermissionLevel` | 5 | 5 | `AgentRegistry.launch` refuses a run above it before anything starts (`PERMISSION_DENIED`, "<agent> can run at most Level n (…), and this run needs Level m (…)"; and every run when the adapter declares no ceiling: "<agent> declares no permission ceiling…"); the Chairman's recovery never hands a stage above it to that agent, and a provider-wide move leaves such stages where they are ([chairman.md](chairman.md)) |

The refusal sits in the one launch door, so a stage (`runners.launchAgent`,
Stage Team workers included) fails with the message in its execution and waits
for the operator like any other `PERMISSION_DENIED`. Simulated agents declare 5,
`Simulated agents`, and `pluginDirs` only for the simulated `claude`.

### Tested CLI versions

[agents.compat.json](../../packages/agent-sdk/agents.compat.json) names, per
agent id, the inclusive range of CLI versions the adapter was verified against:
Claude Code 2.1.280–2.1.283 and Codex 0.156.1. `cliCompat(id, version)`
([compat.ts](../../packages/agent-sdk/src/compat.ts)) compares plain `x.y.z`
versions by number and fails closed: a version outside the range, one with a
suffix (`-beta`, `+build`), or an agent with no range is `unverified`.
`GET /api/agents` carries the verdict as `AgentInfo.compat` (`{ tested, status }`;
null when no version was detected, and for simulated agents), and
Settings → Agents & Models shows it ([dashboard.md](dashboard.md#pages)). An
unverified version still runs: the fail-closed checks (the billing tripwire,
`PROTOCOL_DRIFT`) guard it. `pnpm verify:agents` prints the range and the verdict;
widen a range only after `pnpm verify:agents --run --only <id>` passes on the new
version. The fake Claude Code reports `FAKE_CLAUDE_VERSION` (default 9.9.9, like
the fake Codex: unverified).

## Stage Team workers

A Stage Team runs each worker as an ordinary run of its adapter through
`AgentRegistry.launch` — one execution, one tool session, one usage attempt —
never through a provider's own sub-agents. A write worker's cwd and only tool
root is its own checkout ([stage-teams.md](stage-teams.md)).

## Usage reporting

Every result carries `usage` (token lines per model; `null` when the CLI
reported none) and `capacity` observations, and every adapter declares
`usageCapabilities`. Claude Code: `result.modelUsage` (cumulative, with
`costUSD`) and `rate_limit_event` windows; Codex: `turn.completed.usage`
(cached input is inside `input_tokens`) and no cost. Runs are launched only
through `AgentRegistry.launch`, which records them — see [usage.md](usage.md).

## Adapter conformance kit

[test-kit](../../packages/agent-sdk/test-kit/index.ts) (`@acc/agent-sdk/test-kit`)
holds the security-critical behaviour every adapter must show.
`adapterConformance(target)` registers one test per check; the adapters run it
([agent-claude](../../packages/agent-claude/test/conformance.test.ts),
[agent-codex](../../packages/agent-codex/test/conformance.test.ts)) against their
fake CLIs (`tests/fixtures/fake-*.mjs`), so `pnpm check` runs it for both:

| Check | Holds when |
|---|---|
| `promptOnStdin` | the prompt arrives on stdin, and no piece of it (12 consecutive characters or more) is in argv or the displayed command line |
| `apiBillingBlocked` | an API-key sign-in in Subscription Only mode is `api_billing_blocked` and `execute` refuses (`AUTH_FAILURE`) before the CLI starts; API Mode connects |
| `billingEnvStripped` | no `API_BILLING_ENV_VARS` name reaches the CLI's environment |
| `sessionTokenPrivate` | the tool session token (bridge and shell guard) is in the CLI's environment only: not argv, not a file the arguments name, not a file under a temp entry new or changed since the check began; the run gets its own empty temp folder, so a reused name counts. Looked for as the run starts and after it ends (a file removed at the end counts) |
| `strictMcp` | with the operator's own servers (and Codex account plugins) configured, a run loads only `acc` with a bridge and nothing without |
| `levelOneReadOnly` | a Level 1 run cannot change files, user config on or off |
| `failureClasses` | the fake's usage-limit, sign-in and model failures end `USAGE_LIMIT`, `AUTH_FAILURE`, `MODEL_UNAVAILABLE` |
| `usageNullNotZero` | usage is `null`, never a zero report, when none was reported (a usage-limit run, a run stopped before its summary) |
| `declaredCapabilities` | a non-empty `providerLabel`, a `maxPermissionLevel` of Level 1–5, and, when it declares `pluginDirs`, a run given a plugin folder names it in argv |

Each check carries a positive control (the prompt did arrive, the environment
was seen, Level 2 can write…), so it cannot pass vacuously. A fake takes part
by writing a launch record to `$FAKE_ARGS_FILE` when a run starts: argv, cwd,
the environment's variable names, stdin, the files its arguments name, and what
the real CLI would make of the arguments — the MCP servers it would load and
whether it could change files, by the semantics measured in
[agents-claude-code.md](agents-claude-code.md) and [agents-codex.md](agents-codex.md)
(`--strict-mcp-config`, `--tools`/`--disallowedTools`; `-c mcp_servers.*`,
`--disable apps|plugins`, `--sandbox`, `--ignore-rules`); Claude's variadic
`--tools`/`--disallowedTools`/`--mcp-config` count every value and repeat.
`runConformanceCheck(id,
target)` runs one check as a function that throws `ConformanceFailure`: each
adapter's test proves deliberately broken variants (the prompt, or its opening
words, in argv; the session token in a temp folder of the adapter's own, kept,
removed at the end or reused, or in a temp file already there; `--strict-mcp-config` or `--disable plugins` dropped, a second `--mcp-config`, Level 1 given Level 2's
arguments or a second `--tools`, a key forwarded through the guard environment, plugin folders
dropped, a Level 6 ceiling…) fail the check that
guards them, in that check's words. Adapter-specific guards — Claude Code's
shell precheck and billing tripwire, Codex's execpolicy flag and protocol
check — stay in each adapter's own tests.

## Failure classification ([classify.ts](../../packages/agent-sdk/src/classify.ts))

Structured provider messages are classified before log noise: `USAGE_LIMIT`
("out of credits", "hit your limit", 429…), `AUTH_FAILURE`,
`MODEL_UNAVAILABLE` ("requires a newer version", a CLI's own "error: unknown
option '--…'" line when it is older than the adapter's flags…), `PERMISSION_DENIED`,
`CONTEXT_FAILURE`; otherwise `PROCESS_CRASH`.

`PROTOCOL_DRIFT` ("Agent output not recognised") is set by a parser, not by
text: the run exited 0 but its output lacked what every successful run shows
(`RawAgentResult.protocolDrift`, applied by `parseResult` only when nothing else
failed; today Codex's missing `turn.completed`, and a Subscription Only Claude Code
run with no init event). For the engine it is an ordinary
error: retried, then `FAILED` — or, supervised, handed to the Chairman, which
files it under Agent or tool (`WORKER_OR_TOOL`, recovery `worker_failure`:
change agent first). The task's banner offers **Open Agents**, where the CLI
version is.

Only plain output lines count as evidence from the output tail
(`isProtocolEvent`): stdout protocol events (`{"type":…}`, matched by prefix
because the tail truncates long lines) carry what the agent read and ran, and
the parsers already lift structured errors out of them. Before this, a crash
right after reading a file that mentions "out of credits" — or line 429 of any
file — was classified `USAGE_LIMIT`, and the task waited for a reset that would
never come. A failure with no explaining line reads as `describeExit`: "Claude
Code crashed (fatal internal error) · Windows status 0xC0000409", not a raw
protocol line.

## Observed on the operator's machine (2026-09-24)

- Codex 0.156.1 accepts the default model; with credits back it runs end to
  end (2026-09-27).
- Claude Code 2.1.280 occasionally exits with `0xC0000409` mid-review with no
  result event; the stage retry recovers it.

## Observed on the operator's machine (2026-09-23)

- Claude Code 2.1.278 (Max subscription): runs end to end through the orchestrator.
- Codex 0.150.0 (ChatGPT login): the configured default model `gpt-6-astra` is
  rejected ("requires a newer version of Codex") → `MODEL_UNAVAILABLE`; other
  models return "workspace is out of credits" → `USAGE_LIMIT`. Update Codex and
  restore credits, or reroute Codex roles to Claude Code in Settings.
- Loading the user's own Claude customisations cost ~150k cached tokens per
  run while personal MCP servers were loaded; with `--strict-mcp-config` and the
  closed tool set a run with 794 skills starts at ~65k (2026-09-24). Turn off
  **Load my CLI customisations** per agent for leaner runs.

Last verified: 2026-09-28
