# DESIGNER_ROUTING_PLAN.md — Autopilot delegates frontend work to the design specialist

Status: approved 2026-09-27 (operator: "run end-to-end on full autopilot"). Ledger at the end.

## 1. Goal

Full Autopilot should use the design specialist by itself when a task needs it —
pages, layout, styling, UI components, images — while backend work stays with
the implementer, and **plain backend tasks must not get slower**. Frontend
Design stays the workflow for real visual design work (new directions, generated
media); nothing here spends money.

## 2. How a task picks its workflow today (verified)

- The workflow is chosen once, at creation, and frozen: New Task sends the
  operator's pick, else the repository's default, else the Settings default
  (`apps/dashboard/src/pages/NewTaskPage.tsx:112`); the server requires it
  (`packages/shared/src/schemas.ts:334`) and stores a full snapshot in the task
  row (`apps/orchestrator/src/db/migrations.ts:100`). Only a Draft can change it
  (`apps/orchestrator/src/engine/engine.ts:333`). No Chairman action adds a stage
  or switches a workflow (`packages/shared/src/chairman.ts:13-33`).
- Nothing reads the task description or the changed files to choose a
  specialist. The work-unit `specialty` field is a free-text hint that "never
  chooses an agent today" (`packages/shared/src/stage-teams.ts:39-40`); no code
  reads it.
- Full Autopilot has no designer and no visual judge. Its App check fails only on
  console errors, failed requests and horizontal scroll, and it has been skipped
  on every live task (no app runtime on those repositories).
- The completion gate requires a PASS from **every** judge role that has a
  verdict stage (`apps/orchestrator/src/chairman/gate.ts:61-78`), so a visual
  critic simply added to Autopilot would make backend tasks run it too.
- Paid media runs only in a Level 3 stage through the spend-gated `media.*`
  tools; Frontend Design's Assets stage asks every attempt
  (`workflows/frontend-design.yaml:79-85`, `engine.ts:1046-1050`).

## 3. Options compared

| | (a) Suggest Frontend Design at creation | (b) Specialists inside Autopilot | (c) Chairman brings in the designer and learns |
|---|---|---|---|
| How | New Task reads the description and proposes the design workflow | The plan labels UI work; Implement runs it as the designer; a visual critique runs only when UI files changed and its failures go to a designer fix stage | The Chairman watches evidence (failures, changed files) and inserts designer work; outcomes teach it per repository |
| What you see | A suggestion under the workflow picker | "Implement · Designer", a Visual critique on UI tasks, "Skipped — no user-interface files changed" on backend tasks | Chairman decisions on the timeline |
| Speed | Frontend Design is heavier (3 brief agents, opus/max Build, 4 fix cycles) and has no Git, verify or release stages | Backend: unchanged. UI: one critique run per pass (a critique PASS is reused while UI files are unchanged), a design fix only when the critique fails | Late: acts only after something fails; "works but looks wrong" never fails today |
| Agent runs / approvals | Many more on UI tasks; plan review + asset approvals | +1 critique on UI tasks; no new approvals | +1 Chairman decision run per intervention |
| Risk | Loses Git checkpoint, verify and release | Gate change must be exact; a skipped stage must look skipped | Needs a workflow-mutation action and cross-task outcome data that do not exist |
| Effort | M | M (two phases) | L |

**Chosen: (b)**, with the evidence idea of (c) done deterministically (the
critique is the evidence, the design fix is the specialist). (a) and learned
routing are deferred (§8).

## 4. Speed, honestly

Measured on the live database (15 Full Autopilot tasks, 0 Frontend Design runs
yet): median Implement 4.5 min, Test 3.7 min (21 min on the largest repository),
Review 0.9 min.

- **Backend tasks: no added time.** The critique is skipped by a Git file check
  (milliseconds), no agent runs, no approval is asked.
- **UI tasks, first pass clean:** one critique run (estimated 1–5 min; no critic
  has run live yet). A later pass with no UI file changed reuses the earlier
  critique PASS instead of running it again.
- **UI tasks, critique fails:** a design fix, then the full Test stage and App
  check again: roughly 10–20 min on a small repository, 30–45 min on the largest.
  All loops share Full Autopilot's 3 fix cycles.
- **Faster or better:** a routed Implement costs the same as today (same agent,
  one run) but reads the repository's design standard and gets the design tools;
  that is where fewer UI fix rounds should come from. Unproven until live UI
  tasks run; the unit rows now record role and specialty so it can be measured.

## 5. Phase 1 — UI-aware checks in Full Autopilot

1. **UI file classifier** (`packages/shared/src/ui-paths.ts`, pure):
   `isUiPath(repoRelativePath)`. UI: `.tsx .jsx .vue .svelte .astro .css .scss
   .sass .less .styl .html .htm`, images and fonts, the design standard
   (`design.md`, `DESIGN.md`, `docs/design.md`, `design/**`), Tailwind/PostCSS
   config, and `.ts/.js` files under a `components`, `pages`, `views`,
   `layouts`, `styles`, `theme(s)` or `ui` folder. Not UI: test and e2e files,
   other Markdown, lock files. Always the repository-relative path, never the
   multi-repository folder prefix.
2. **Stage condition `when: ui-changed`** (`stageDefinitionSchema`): allowed only
   on a Level 1 `visual-critic` verdict stage that comes after a write stage on
   the happy path (never on reviewer, verifier or write stages). Facts come from
   one engine helper, `taskChanges` (the task's own changes against each
   repository's baseline, pre-existing work excluded, any unreadable repository
   or missing Git baseline → unknown). Unknown → the stage runs and the gate
   requires it (fail closed).
3. **Engine:** before a stage starts, a condition that does not hold records the
   stage as SKIPPED ("No user-interface files changed in this task") through one
   `skipStage` helper (no agent on the row, no "started" event; also used for
   `requires` and release skips). A critique whose last PASS saw the same UI
   files (digest recorded on the stage row, migration 22
   `task_stages.condition_digest`) is recorded as a reused PASS instead of
   running again, as unchanged checks are.
4. **Completion gate:** a judge role is not required when every verdict stage of
   that role has a `when` that does not hold. Same facts as the engine.
5. **Report:** judge limitations role by role (the newest SUCCESS, FAILED or
   SKIPPED instance of each judge role decides); a skipped critique prints
   "Visual critique: not needed — no user-interface files changed".
6. **`{{review}}` by role:** a reviewer or visual critic reads its own role's
   previous review, never the other judge's; write stages keep reading the latest
   review (the one that sent the task to them).
7. **`workflows/full-autopilot.yaml`:** `app-check → critique → review`.
   - `critique`: visual critic, Level 1, verdict, `when: ui-changed`, onFail
     `design-fix`, tool profile `frontend-design`, Autopilot instructions (no art
     direction: judge against the repository's standard and the look before the
     change; only regressions this change introduced block; never block on a look
     not seen; no NEEDS OPERATOR; always `CAUSE: code`). No design skill: the
     repository's own standard binds.
   - `design-fix`: designer, Claude (as Frontend Design pins it), **Level 2**,
     next `test`, tool profile `frontend-design`, instructions: fix only what the
     critique marks blocking; no asset → existing file or sized placeholder,
     reported, never BLOCKED ON OPERATOR; no generation.
   - `maxFixCycles` stays 3.
8. **Money guard in the execution door:** a design session (designer role or the
   `frontend-design` profile) is refused every outside MCP tool at any level —
   those declare no cost, so the spend gate cannot see them. Paid generation
   stays the spend-gated `media.*` tools in a Level 3 stage that asks first.
   The validator also requires `requiresApproval` and one attempt on any Level ≥3
   designer or `frontend-design` stage.
9. **Cloud guard:** a workflow saved from the cloud may not add or change `when`,
   nor turn a verdict stage's `verdict` off (both loosen the gate).
10. **Learning:** design friction from non-critic judges counts only when the
    task's write stages were all designers (Frontend Design); an accessibility
    rule counts only when it fails in two different stage runs.
11. **Dashboard:** a SKIPPED stage shows the skip icon and the word "Skipped"
    with its reason, no agent, and does not count as a run; the workflow editor
    shows "Runs only when user-interface files change" and clears `when` when a
    stage stops being an agent stage.

## 6. Phase 2 — Implement goes to the right specialist

1. **`team.specialists`** on an adaptive team: `{ specialty, description, role,
   toolProfile?, instructions }` (≤4). Validation: adaptive teams only, on a
   Level 2 write stage that is not a fixer (Fix splits its own work), the
   specialist's role a write role (plan and judge roles refused), unique
   specialties, instructions required.
2. **A specialist changes what the worker is told and which tools it sees,
   never which agent runs it.** The stage's assignment, reroutes and model or
   effort changes apply unchanged. (Choosing agents per specialty stays deferred
   until outcome data exists, as STAGE_TEAMS_PLAN §10 says.)
3. **Planner:** `{{team_stages}}` lists each stage's specialties and the rule,
   generated in code. When part of the work is what a listed specialty covers,
   the plan ends with the `acc-work-units` block — one unit is fine — and labels
   those units; labels are normalised like keys; an unknown label routes nowhere
   and says so on the timeline.
4. **Stage Teams:** a routed unit is built and launched with the routed stage
   definition (template, design context, instructions, tool profile, usage
   role); artifact and prompt names, reuse, limits and the integration pass stay
   the stage's own. Routing never adds a run: units that need different
   specialists but cannot run in parallel (a chain, shared paths, no isolated
   worktree) run as one agent in the stage's own role, as today, and the
   visual critique still judges the UI part.
5. **One agent:** when the team does not run and every unit of the plan's block
   carries the same specialty, the single agent runs as that specialist; the
   stage row records `routedRole`.
6. **Record:** migration 23 adds `task_stages.routed_role`,
   `stage_work_units.role` and `stage_work_units.specialty`.
7. **Full Autopilot:** Implement gets `frontend → Designer` (pages, layout,
   styling, UI components and images) with Autopilot designer instructions (stay
   inside the unit's paths; no Assets stage; no generation).
8. **Dashboard:** "Implement · Designer" on a routed stage; each unit's specialty
   and role; plan review shows the work units as a readable list instead of JSON.

## 7. Decisions (defaults chosen)

| Decision | Chosen | Why |
|---|---|---|
| Which approach | (b), phased | Fast for backend, deterministic, no new approvals |
| When does the critique run | Only when the task's own changes touch UI files | Backend tasks stay as fast as today |
| Unknown facts (no Git baseline) | Run and require the critique | Fail closed; its instructions pass when nothing visual changed |
| Critique rerun after a backend-only fix | Reuse the earlier PASS | Saves a run per loop |
| Designer agent | Claude on design fix (as Frontend Design); the stage's own agent on routed Implement | Only Claude's screenshot path is verified; routing agents is deferred |
| Design skill on Autopilot stages | None | Autopilot runs on every repository; its own standard binds |
| Fix cycles | Stay 3 | Backend unchanged; stated plainly |
| Paid media in Autopilot | Never | Every Autopilot design stage is Level 2; outside MCP refused to design sessions |
| Operator retry of a skipped critique | Still skipped, with the reason shown | Engine and gate must agree |
| Per-repository UI patterns | Later | Needs a repository setting |

## 8. Deferred

- New Task suggests Frontend Design (roadmap DEC-6).
- Chairman- or history-driven routing and per-specialty agent choice (roadmap
  DEC-3, needs the outcome data Phase 2 starts recording).
- Per-repository UI path patterns; the Fix decomposer labelling specialties.
- Whether `codex exec` exposes a built-in image generation tool (not verified;
  design stages pin Claude).

## 9. Safety invariants (each has a test)

- A backend-only task never runs, requires or asks about the critique.
- A UI change always runs the critique, and the gate blocks until it passes.
- Pre-existing UI files never count; a multi-repository folder name never counts.
- `when` is refused on reviewer, verifier and write stages, and from the cloud.
- No design session reaches an outside MCP tool; Level 2 never reaches `media.*`
  generation; a Level ≥3 design stage without approval does not validate.
- A specialist never changes a stage's level, agent, approvals or gates.

## 10. Irreversible steps

- Migrations 22 and 23 on the live database (additive columns; a shipped
  migration is never edited).
- Push to `main` (direct-push repository).
- Restart of the local orchestrator so the new Full Autopilot reloads (running
  tasks keep their frozen workflow).

## Ledger

- [ ] Phase 1 — classifier, `when`, skipStage, gate, report, review-by-role, YAML, money guard, cloud guard, learning, dashboard, docs
- [ ] Phase 2 — specialists, planner, Stage Teams routing, single-agent route, migration 22, dashboard, docs
