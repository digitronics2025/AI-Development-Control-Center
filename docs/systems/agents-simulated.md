---
system: agents-simulated
sources:
  - packages/agent-sdk/src/simulated.ts
verified_at: 57af61a
---

# Simulated agent adapter

Part of [Agent adapters](agents.md).

## Simulated agents

[simulated.ts](../../packages/agent-sdk/src/simulated.ts) is registered only
with `ACC_SIMULATED_AGENTS=1` and labelled in the UI. Markers in a task
description steer it: `[sim:review-fail-once]`, `[sim:review-fail-always]`,
`[sim:usage-limit]`, `[sim:fail:<role>]`, `[sim:slow]`,
`[sim:needs-operator]` (verifier names an operator decision), `[sim:hang]` (every run keeps working until cancelled),
`[sim:needs-decision]` (implementer stops with `BLOCKED ON OPERATOR:` until a directive says `ANSWER:`),
`[sim:verify-plan-mismatch]`, `[sim:chairman-down]`, `[sim:chairman-bad-json]`,
`[sim:big-diff]` (the implementer also writes three 60 KB files),
`[sim:source-only]` (implementer and fixer change `sim-output.ts` instead of `sim-output.md`),
`[sim:review-miss-coverage]` / `[sim:review-miss-coverage-once]` (reviewer and verifier
leave out the files the diff did not show; by default they name the ones to read, never media to view, under `## Files reviewed`).
Role `designer` changes files like the implementer (the same markers apply) and
reports with `## Summary` and `## Design decisions` ([design-agent.md](design-agent.md));
`[sim:assets]` makes it also write two PNGs in `public/generated/` and a
`manifest.json` naming both with their SHA-256, `[sim:assets-unnamed]` adds a
PNG the manifest does not name, `[sim:assets-bad-hash]` gives `hero-2.png` a
wrong SHA-256. `[sim:ui]` makes the implementer and the designer also change
`src/components/SimOutput.tsx` (a user-interface file, so Full Autopilot's visual
critique runs); `[sim:ui-in-fix]` makes only the fixer do it. Specialists
([stage-teams.md](stage-teams.md#specialists)): `[sim:plan-frontend]` makes the
planner write one unit labelled `Frontend`, `[sim:plan-mixed]` an API unit and a
frontend unit that depends on it; with `[sim:team]`, `[sim:team-frontend]` labels
alpha `frontend`, `[sim:team-unknown-label]` labels it `ui`, and `[sim:team-email]`
labels beta `email`. Role `art-director` answers with a direction and a $0 media
budget; role `visual-critic` passes unless `[sim:critic-fail-once]` /
`[sim:critic-fail-always]`, and names unshown files like the reviewer. Stage
Teams: `[sim:team]` (units alpha and beta), `[sim:team-chain]`, `[sim:team-three]`, `[sim:team-overlap]`, `[sim:team-out-of-scope]`,
`[sim:fail-unit-once:<key>]` ([stage-teams.md](stage-teams.md)); a variant
(`- Your approach:`) writes `sim-output.md` and `variant-<key>.md`, and role
`judge` answers `WINNER:` with the first variant, the last with
`[sim:judge-last]`, none with `[sim:judge-none]`. The simulated `codex`
declares `images: true` like the real one and logs the pictures it receives;
the simulated `claude` declares `pluginDirs` like the real one.
Role `chairman` answers the Chairman's recovery and chat prompts with JSON.
Role `ask` answers "Simulated answer to: <question>" and names the repository
and any task it was shown ([ask.md](ask.md)). `[sim:lookup:<capability>:<json>]`
in the question makes it call that capability through its tool session
(`ACC_TOOL_URL`/`ACC_TOOL_SESSION` from `toolBridge.env`) and report OK or
REFUSED with the summary. `[sim:call:<role>:<capability>:<json>]` in a task
does the same for any role's stage run, on one line (the prompt also shows the
title cut short): an implementer starting a dev server it leaves running, for
the stage-end cleanup test
([stage-processes.test.ts](../../apps/orchestrator/test/stage-processes.test.ts)).
It needs a tool route over HTTP, as a real bridge does.

Last verified: 2026-09-28
