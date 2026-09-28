---
system: agents
sources:
  - packages/agent-sdk/src/contract.ts
  - packages/agent-*/package.json
verified_at: 57af61a
---

# Agent adapters

## Agent Brief

**Scope.** How the Control Center runs the agent CLIs — Claude Code, Codex, and
the simulated agents of the demo and e2e — through one adapter contract: each
CLI's command line, permission mapping and guards, the skills a run loads, what
a run reports, and how a failed run is classified. This file is a map; the facts
live in the children listed under [Where to look](#where-to-look). Open the one
the task names, not all of them.

**Not here** (neighbours):

- The tool layer an agent calls, its sessions and the precheck endpoint →
  [tool-system.md](tool-system.md#sessions).
- The Control Center's MCP server and the bridge a run gets → [mcp.md](mcp.md).
- The subscription-only guard, permission levels and the agent account boundary
  as a whole → [security.md](security.md#subscription-only-guard-env-guardts),
  [security.md](security.md#permission-levels),
  [security.md](security.md#agent-os-boundary).
- The usage ledger, pricing and capacity → [usage.md](usage.md).
- Role prompts and their placeholders → [prompts.md](prompts.md).
- Several workers for one stage → [stage-teams.md](stage-teams.md).

### Invariants

1. **Prompts travel on stdin.** argv holds only fixed flags and validated
   model/effort values. → [agents-contract.md](agents-contract.md), conformance
   check `promptOnStdin`
2. **One launch door.** Runs start only through `AgentRegistry.launch`, which
   records usage and refuses a run above the adapter's `maxPermissionLevel`.
   → [Declared capabilities](agents-contract.md#declared-capabilities)
3. **Decide by what an adapter declares, never by its id.** No
   `agentId === 'claude'` branch exists in `apps/orchestrator/src`.
   → [Declared capabilities](agents-contract.md#declared-capabilities)
4. **Fail closed, never fall back.** A Subscription Only Claude Code run whose
   init event does not report `apiKeySource: none` is stopped; a run that exits 0
   without the events every successful run shows is `PROTOCOL_DRIFT`; a Codex MCP
   listing that fails or is unreadable is refused; a run as the agent account
   never falls back to the operator. → [Claude Code](agents-claude-code.md#claude-code-agent-claude),
   [Codex](agents-codex.md#mcp-servers-in-a-codex-run),
   [Failure classification](agents-contract.md#failure-classification-classifyts)
5. **Only `acc` joins a run.** Claude Code always gets `--strict-mcp-config`;
   Codex switches every other listed server off by name.
   → [MCP servers in a Codex run](agents-codex.md#mcp-servers-in-a-codex-run)
6. **A repository's settings cannot widen a stage.** Level 1 Claude Code has no
   shell and runs no hooks; the Control Center itself is denied natively at every
   level. → [Claude Code](agents-claude-code.md#claude-code-agent-claude)
7. **Re-run the tripwires after every CLI update**, and widen a tested range
   only after `pnpm verify:agents --run --only <id>` passes on the new version.
   → [Tested CLI versions](agents-contract.md#tested-cli-versions)

### Where to look

| Open | When the task is about |
|---|---|
| [agents-contract.md](agents-contract.md) | the adapter contract and launch path (prompts on stdin, running as the agent account, line lengths, the Control Center tool bridge), declared capabilities and tested CLI versions, Stage Team workers, usage reporting, the adapter conformance kit, failure classification, what was observed on the operator's machine |
| [agents-claude-code.md](agents-claude-code.md) | Claude Code's command line, the native denies and precheck hook (SEC-3), the permission mapping and tool set per level, repository settings and hooks, the Subscription Only tripwire, usage-limit events |
| [agents-codex.md](agents-codex.md) | Codex's command line, sandbox and `--ignore-rules`, images, auth, models, protocol drift, and keeping every MCP server but `acc` out of a Codex run |
| [agents-skills.md](agents-skills.md) | which skills a run loads and why the tool set is closed, learned skills, the skill list and `/name` requests, the skills lookup trigger, the Claude Code skill and permission tripwires |
| [agents-simulated.md](agents-simulated.md) | the simulated agents and the `[sim:…]` markers that steer them in the demo and e2e |

Last verified: 2026-09-28
