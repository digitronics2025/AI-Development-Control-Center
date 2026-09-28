---
system: autopilot
sources:
  - packages/tools/src/policy.ts
  - packages/tools/src/profiles.ts
  - packages/shared/src/tools.ts
  - apps/orchestrator/src/engine/tooling.ts
  - scripts/windows/privileged-helper.ps1
  - apps/orchestrator/src/tools/privileged.ts
verified_at: 57af61a
---

# Execution policy (Safe · Autopilot · Full Autopilot+)

[policy.ts](../../packages/tools/src/policy.ts) — one pure function decides
every tool call.

## Modes

| Mode | Runs on its own up to | Meaning |
|---|---|---|
| Safe | Level 2 (never above the auto-approve level) | reads, analysis, local tests, edits |
| Autopilot (default) | the task's auto-approve level (default 3, capped at 4) | investigate, edit, install project dependencies, test, repair, commit |
| Full Autopilot+ | Level 4 | also staging deploys and cloud resource changes |

Level 5 (production, destructive, privilege) always needs a person with a
typed confirmation, in every mode. The mode is Settings → Execution (Tools →
Policy), overridable per repository, and fixed on each task at creation
(`tasks.policy_mode`; older tasks use the current setting). The same ceiling
also gates stages (`stageGate`) and repository commands, so a Full Autopilot+
task runs an L4 stage without asking.

## Decisions

In order: dangerous / Level 5 / production → **approval** (typed), or
**deny** for an agent (it cannot wait; it reports an operator decision) →
above the stage's own level → **deny** (an Analyze stage never writes) →
a `leak` (SEC-4: the outbound check found a stored credential going outside
its audience, or a known secret or token in what the call sends; named by
kind, name and host, never the value,
[tool-system.md](tool-system.md#the-execution-door-servicets)) →
**approval** without a typed confirmation (operator/engine) or **deny**
(agent), whatever the mode would run on its own →
above the mode's ceiling → **approval** (operator/engine) or **deny** (agent);
a call that passes `approvedLevel` (only the native shell precheck: its stage
is running, so it passed `stageGate` at its level) has that level as its
ceiling when it is higher ([tool-system.md](tool-system.md#sessions))
→ outside the stage's profile (its `toolProfile`, else the one the
repository's tooling suggests; [tool-system.md](tool-system.md#profiles-profilests))
→ **escalate**: allowed and recorded → otherwise **allow**. An allowed or
escalated call whose operation states a cost (the paid `media.*` tools) must
then pass the spend gate in `ToolService.invoke`, which fails closed
([design-agent.md](design-agent.md)).

A read-only session (Ask, [ask.md](ask.md)) is decided before all of that:
off its allow-list, carrying a `leak` (an Ask `web.search` or `web.read`
holding a stored secret included), not declared a read (`writes !== false`),
or dangerous → **deny**; otherwise **allow**, whatever the level. Nothing is
escalated.

## Privileged helper

The orchestrator never runs elevated. [privileged-helper.ps1](../../scripts/windows/privileged-helper.ps1)
runs one allowlisted operation through a UAC prompt and exits:
`install_package` (winget ids: PowerShell, Git, GitHub CLI, Node LTS,
Python 3.12, Android Studio), `firewall_allow_port` / `firewall_remove_rule`
(`ACC-<name>`, TCP 1024–65535, private profile), `service_start|stop|restart`
(`com.docker.service`, `ssh-agent`), and `agent_account_create` /
`agent_account_remove` — the agent account of [security.md](security.md#agent-os-boundary):
the orchestrator fills in the account Settings names, the work root and the
program folders it must read (`read1`–`read6`,
[agent-isolation.ts](../../apps/orchestrator/src/services/agent-isolation.ts));
the helper refuses a name that is not 3–20 plain characters, an existing account
without its description, and any folder that is relative, not in plain form,
near a drive root, a system, program or user-folder root, the data folder, in it
or above it, or a credential folder (`.ssh`, `.aws`, `.claude`, …). A request is an HMAC-SHA256-signed JSON
file (key `<data>/privileged-key`), valid for five minutes, single use, every
parameter validated, every run appended to `<data>/privileged-audit.log`.
As a capability it is `system.privileged` (Level 5). `POST /api/privileged/validate`
runs the helper's own validation without elevation (`-ValidateOnly`).

## Verified

Unit tests cover every decision path and ceiling; integration tests showed an
agent session refused a Level 2 write in a Level 1 stage, an out-of-profile
read escalated, and the privileged helper accepted allowlisted requests and
refused unknown operations, unlisted packages, bad ports, unlisted services,
a tampered signature, and each agent-account name and folder rule above
([agent-isolation.test.ts](../../apps/orchestrator/test/agent-isolation.test.ts)).
Actual elevation was not exercised in tests (it needs a person at the UAC
prompt), so neither agent-account operation has run anywhere yet.

## Team workers

`execution.teamWorkerLimit` (1–4, default 3; Tools → Policy → Team workers at once) caps Stage Team workers running at once across every task. A worker's permission level is always its stage's; a variants judge runs read-only at Level 1 ([stage-teams.md](stage-teams.md)).

Last verified: 2026-09-26
