---
system: autopilot
sources:
  - packages/tools/src/policy.ts
  - packages/tools/src/profiles.ts
  - packages/shared/src/tools.ts
  - apps/orchestrator/src/engine/tooling.ts
  - scripts/windows/privileged-helper.ps1
  - apps/orchestrator/src/tools/privileged.ts
verified_at: 351db1e
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
above the mode's ceiling → **approval** (operator/engine) or **deny** (agent)
→ outside the stage's profile → **escalate**: allowed and recorded →
otherwise **allow**.

A read-only session (Ask, [ask.md](ask.md)) is decided before all of that:
off its allow-list, not declared a read (`writes !== false`), or dangerous →
**deny**; otherwise **allow**, whatever the level. Nothing is escalated.

## Privileged helper

The orchestrator never runs elevated. [privileged-helper.ps1](../../scripts/windows/privileged-helper.ps1)
runs one allowlisted operation through a UAC prompt and exits:
`install_package` (winget ids: PowerShell, Git, GitHub CLI, Node LTS,
Python 3.12, Android Studio), `firewall_allow_port` / `firewall_remove_rule`
(`ACC-<name>`, TCP 1024–65535, private profile), `service_start|stop|restart`
(`com.docker.service`, `ssh-agent`). A request is an HMAC-SHA256-signed JSON
file (key `<data>/privileged-key`), valid for five minutes, single use, every
parameter validated, every run appended to `<data>/privileged-audit.log`.
As a capability it is `system.privileged` (Level 5). `POST /api/privileged/validate`
runs the helper's own validation without elevation (`-ValidateOnly`).

## Verified

Unit tests cover every decision path and ceiling; integration tests showed an
agent session refused a Level 2 write in a Level 1 stage, an out-of-profile
read escalated, and the privileged helper accepted allowlisted requests and
refused unknown operations, unlisted packages, bad ports, unlisted services
and a tampered signature. Actual elevation was not exercised in tests (it
needs a person at the UAC prompt).

Last verified: 2026-09-23
