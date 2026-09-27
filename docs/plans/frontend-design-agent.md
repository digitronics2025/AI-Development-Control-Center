---
title: A frontend-design agent (designer role, Frontend Design workflow, media tools, visual QA) runs inside the Control Center within its guardrails
source: conversation 2026-09-27 — verified design-agent plan (workflow wf_2e0cae06-acf, 9 agents), delivered as design-agent-plan.md
created: 2026-09-27
status: in-progress
---

# A frontend-design agent runs inside the Control Center within its guardrails

## Context

Copied verbatim from the verified plan produced in the 2026-09-27 conversation
(headings demoted two levels). Paths are repository-relative.

### Frontend-design agent for the AI Development Control Center: verified plan

This is a discussion only; I edited no files. Paths are relative to `/home/user/AI-Development-Control-Center`. I re-opened every codebase claim below in the source. Vendor names, prices and model status come from the research map dated 2026-09-27; they are marked *(external, unverified)*.

---

#### 1. What "an agent" means in this Control Center

There is no agent object to create. An agent here is made of six parts:

- **A workflow stage.** YAML with `role` (from a closed list of 9), `kind`, `permissionLevel` 1-5, an optional agent/model/effort pin, and an optional Stage Team (`packages/shared/src/schemas.ts:98-131`).
- **A role prompt.** `prompts/<role>.md` is chosen by role only (`context.ts:338`, `services/prompts.ts:52`). A stage's `description` is never put into the prompt.
- **Sections the engine adds.** Skills, Requested skills, Environment (investigator, planner and implementer only) and Control Center tools (`engine/tooling.ts:322-334`).
- **Tools limited by stage level.** Claude gets a closed built-in set with no WebFetch, WebSearch, Agent or PowerShell (`agent-claude/src/index.ts:128-147`), plus the `acc` MCP bridge to ToolService. The capability profile comes from repository tooling and level (`packages/tools/src/profiles.ts:98-106`). Outside MCP servers are reachable only through the gateway, because runs always get `--strict-mcp-config` (`index.ts:445-447`).
- **Skills.** The operator's `~/.claude` skills load when "Load my CLI customisations" is on (the default, `schemas.ts:395`). Learned plugin folders are added as `--plugin-dir`.
- **Model and effort.** Set by `resolveAssignment` in this order: role default, stage pin, repository, task (`packages/shared/src/workflow.ts:247-255`).

So a design agent is:

- a `designer` role and `prompts/designer.md`;
- a `frontend-design` workflow;
- generation servers registered in the gateway now, and a first-party `media` tool pack later;
- Claude pinned to opus or fable at `xhigh`/`max`.

---

#### 2. Recommended architecture

##### Phase 1: this week (about 1 hour of operator setup plus about 2.5 developer days)

**1. One new role, `designer`.** Add a shared `WRITE_ROLES = ['implementer','fixer','designer']` constant. The READY gate, the report's Changed section and "undo last change" then count designer edits.

Only `ROLE_LABEL` and `ROLE_ACTIVITY` are typed so the compiler forces an entry (`labels.ts:42,55`). `ROLE_ARTIFACT` is `Partial<Record<Role,…>>` (`runners.ts:166`) and `DEFAULT_ROLE_DEFAULTS` is a partial record, so the remaining places must be edited by hand (list in §7).

**2. `prompts/designer.md`.** One template with two modes, chosen by the `Stage: <key>` header line (`context.ts:414`): an `assets` mode and a `build` mode.

**3. `workflows/frontend-design.yaml`** (§6). It is loaded and validated at startup (`services/workflows.ts:35-66`).

**4. Image and video generation through fal's remote MCP in the existing gateway.** Store one unscoped broker credential of kind `http` with `envVar` empty and the value `Bearer <key>`. Register fal twice:

| Registration | Level | Tools | Purpose |
|---|---|---|---|
| `fal` | **3** | `run_model`, `submit_job`, `upload_file` | Paid calls |
| `fal jobs` | 2 | search, schema, pricing, recommend, `check_job`, `get_job_result`, `cancel_job` | Free calls |

The `slug()` function turns these into `mcp.fal.*` and `mcp.fal_jobs.*` (`apps/orchestrator/src/tools/mcp.ts:20-22`). No built-in workflow has an agent stage at Level 3; the only Level 3 stage is the `git` stage in `full-autopilot.yaml`. So paid generation can run only in the new workflow's `assets` stage (Level 3, `requiresApproval: true`).

**5. Media vendor keys added to `AMBIENT_CREDENTIAL_ENV_VARS`.** Today `FAL_KEY`, `REPLICATE_API_TOKEN` and similar keys are on no strip list, so every agent, terminal and hook inherits them (`packages/security/src/env-guard.ts:56-101`).

**6. Operator setup:**

- install ffmpeg;
- set the target repository's Runtime (dev command, URL, verify paths);
- add a Playwright theme × viewport matrix to the target repository and register it as an `e2e` command;
- keep the tenten skills loaded.

**How spend is controlled this week, from hardest to softest:**

1. The fal prepaid balance. It is the only hard cap.
2. Level 3 confinement plus `requiresApproval`. The approval covers one attempt only, so any retry or fix cycle asks again (`engine.ts:1010-1022`).
3. A checkpoint and a `TOOL_CALL` timeline event for every Level ≥3 call (`tools/service.ts:486-490, 537-541`).
4. A budget written into the approved plan, which the prompt enforces with `get_pricing`.

##### Phase 2: media pack and visual-QA tools (about 2-3 weeks)

- **A first-party `media` pack** (`packages/tools/src/packs/media.ts`): download into the repository, view, generate (key read from the broker by name), optimise, and video poster/frames. Details in §3.
- **Spend gate.** Add `estimateCost`, a reservation in `ToolService.invoke` between the policy step and the run step that fails closed, and a media ledger (new migration 20; the latest is 19, `migrations.ts:1253`). Once this exists, generation can drop to Level 2.
- **Gateway image passthrough.** The gateway replaces image blocks with the text `[image]` today (`packages/mcp/src/gateway.ts:156-158`). Also publish each outside tool's stored input schema.
- **Browser upgrades:** `colorScheme`, `reducedMotion`, `deviceScaleFactor`, the 1440 and 1024 viewports, `browser.accessibility` returning selectors and added to the look-only tool set (LOOK), and `browser.visual_matrix` (a contact sheet of viewports × themes).
- **New stage fields `instructions`, `toolProfile`, `skills`.** Add a `frontend-design` profile. Add `{{screenshots}}` and `{{design_context}}` placeholders. Pass image attachments to Codex with `-i`.

##### Phase 3: maximum capability

- **Competing art directions.** A fixed Level 1 Stage Team writes three directions, each rendered as a style tile with `browser.render_html`. A judge stage then picks one.
- **Optional roles.** `art-director` (plan class) and `visual-critic` (judge class), behind a `ROLE_CLASS` refactor.
- **Design memory.** A `design/` folder in the target repository, fed through `{{design_context}}`.
- **Learning signals** (repeated critic failures, repeated axe rules, overspend), which produce a repository-scoped `design-system` skill.
- **Platform work:**
  - OAuth in the gateway (Higgsfield, Canva, Figma remote, Recraft official);
  - a `team.mode: variants` tournament (needs a new plan, because `STAGE_TEAMS_PLAN.md` excludes it);
  - specialty routing;
  - a design pack (contrast matrix, token lint);
  - visual diff and a performance audit.

---

#### 3. Toolbelt

| Capability | Source | Level | Phase |
|---|---|---|---|
| Read, Grep, Glob, LS, Skill, ToolSearch, TodoWrite, read-only git/`ls` Bash | Claude built-in | 1 | now |
| Edit, Write, NotebookEdit, Bash. Denied: `rm -r`, force-push and similar; git writes at L2; deploys (`index.ts:96-146`) | Claude built-in | 2 (at 3, `git commit` is allowed) | now |
| `web.search`, `web.read` (reference research; stand in for the missing WebFetch) | acc web pack | 1 | now |
| `browser.open/snapshot/screenshot/check_page/logs/close`: ≤3 images per call, PNG/JPEG only, ≤3 MB each (`tool-routes.ts:25`, `bridge.ts:62`, `browser.ts:110`) | acc (LOOK set) | 1 | now |
| `browser.accessibility` (axe; returns id, impact, help and node count only) | acc | 1 (outside LOOK, reached by escalation) | now; v2 in P2 |
| `browser.act/evaluate/run_flow` (switch theme, hover and focus states, seek video frames) | acc | 2 | now |
| `verify.web` / `process.start` | acc | 1 without a start command, 2 with one (`verify.ts:98-103`) / 2 | now |
| `mcp.fal.run_model`, `submit_job`, `upload_file` | Gateway (http, static Bearer header) | 3 | P1 |
| `mcp.fal_jobs.*` (search, schema, pricing, recommend, check, result, cancel) | Gateway | 2 | P1 |
| `curl -o` download, ffmpeg, `npx svgo@4`, sharp | Host, through Claude Bash | 2/3 | P1 stopgap, Claude only |
| `media.asset.fetch`: confined download with content-type and size caps | New media pack | 2 | P2 |
| `media.image.view`: repository file or artifact id → JPEG ≤3 MB, rendered in the existing Chromium from a `data:` URL | New | 1 | P2 |
| `media.image.generate/edit/upscale/remove_background/vectorize`, `media.video.generate` | New; key read by name from the broker | 3, then 2 once the spend gate exists | P2 |
| `media.job.status` / `media.job.fetch` | New | 1 / 2 | P2 |
| `media.asset.optimize` (sharp AVIF/WebP + srcset), `media.svg.optimize`, `media.video.encode/poster` (fixed ffmpeg templates), `media.video.frames` | New | 2 (frames 1) | P2 |
| Theme, reduced motion, DPR and the 1440/1024 viewports on browser tools; `browser.visual_matrix` | Browser pack | as today / 1 | P2 |
| `browser.audit` (LCP, CLS, image weight) | Browser pack | 1 | P2-P3 |
| `design.contrast_matrix`, `design.lint_tokens`; `browser.render_html`; `browser.visual_diff` | New | 1 (baseline write 2) | P3 |
| Chrome DevTools MCP (Lighthouse, performance traces) | Gateway, stdio | 2 | Optional, see risk 14 |
| Figma, Canva, Higgsfield MCP | Gateway once it has OAuth | — | P3 |
| `/tenten-web-design`, `/tenten-ad-motion` | `~/.claude`, when loadUserConfig is true | — | P1 |

---

#### 4. Image and video providers

**Why fal is the hub.** One key covers many image and video models, and its remote MCP takes a static `Authorization: Bearer` header *(external, unverified)*.

On the Control Center side this fits today (verified):

- the gateway supports streamable HTTP with static headers (`gateway.ts:91`);
- `Authorization` passes the header-name rule `^[A-Za-z_][A-Za-z0-9_]*$` (`packages/shared/src/tools.ts:324`);
- the header value is the raw credential, so the credential must contain `Bearer …` (`mcp.ts:62`);
- the credential must be unscoped, because the server config resolves credentials with a null repository (`mcp.ts:53`, `credentials.ts:609-611`);
- fal routes around the subscription guard's `OPENAI_API_KEY` and `GEMINI_API_KEY` names.

Two things a day-0 smoke test must confirm:

- **Results must arrive as URLs.** Image blocks become the text `[image]` (verified), so results must come back as URLs in text or structured output *(external)*. Redaction leaves `*.fal.media` URLs intact; I ran a scratch copy of `redact.ts` to check.
- **Video must use jobs.** The gateway timeout defaults to 60 s with a maximum of 600 s (`tools.ts:337`). So video must go through `submit_job` once, then `check_job`, never repeated submits (fal: each resubmit is billed, *external*).

**Fallback:** Replicate's local stdio `replicate-mcp` with `REPLICATE_API_TOKEN` mapped through envCredentials. A stdio child receives only `getDefaultEnvironment()` plus its mapped variables (`gateway.ts:83`, verified).

**Models by job** *(all external, unverified; confirm with `get_pricing` at run time)*:

| Job | First choice | Alternatives / notes |
|---|---|---|
| Cheap explorations | FLUX.2 Klein (~$0.015), gpt-image-1.5 low (~$0.009) | Generate 2-4 per slot |
| Photoreal hero and product | FLUX.2 Pro (from ~$0.03/MP) | gpt-image-2 (best text and UI mockups) |
| Icons and spot illustrations | Recraft V4 Vector, native SVG (~$0.08) | Then SVGO v4 |
| Transparent cut-outs | gpt-image-1.5 transparent PNG/WebP | Ideogram 3.0 transparent endpoint; gpt-image-2 transparency not confirmed in docs |
| Text-heavy promos | Ideogram 3.0 | In UI, always use live HTML text (FR/AR/RTL) |
| Background loops and product clips | Image-to-video from the approved still: Veo 3.1 Lite ($0.05-0.08/s, preview), Kling 3.0 Pro (~$0.112/s, audio off) | Keep brand consistency by starting from the still |
| Not available | Sora 2 (shut down 2026-09-24); Imagen 4 in the Gemini API (shut down) | — |

**Direct OpenAI or Google keys:** only inside the Phase 2 media pack, read by name.

- **Never** set a credential's envVar to `OPENAI_API_KEY` or `GEMINI_API_KEY`. `syncManagedEnv` adds every credential's envVar to the broker-managed set, which is stripped from every child in every mode (`credentials.ts:239-241`, `env-guard.ts:136`). Manual create has no check for this; the reserved-variable list applies only to generate and import (`credentials.ts:90-98`).
- **Never** use kind `other`. `envFor` injects the first in-scope credential for each envVar of that kind (`credentials.ts:647-661`).

**Higgsfield, Canva, Figma remote, Recraft and BFL official servers** are OAuth-only *(external)*. The gateway has no OAuth (verified), so for now they are operator-attended: generate in the operator's own session and attach the results (≤10 files, ≤14 MB base64 each, `schemas.ts:314-317`). Gateway OAuth is Phase 3.

**Typical landing page:** about $2-3 *(estimate from external prices)*. Suggested default budget: $5 per task.

---

#### 5. Designer prompt outline (`prompts/designer.md`)

**Contract** (`apps/orchestrator/test/prompts.test.ts:20-47`):

- more than 5 placeholders, all from the existing 27;
- report headings written as list items ``- `## Heading` ``, with `Summary` first and `Skills used` included;
- the exact line `BLOCKED ON OPERATOR: <the decision needed, the options, and your recommendation>`;
- never `NEEDS OPERATOR`;
- never a `## Skills` or `## Requested skills` heading.

**Inputs (Phase 1 placeholders):**

- `{{request}}`
- `{{attachments}}`: reference images are listed by path; tell the agent to Read them
- `{{investigation}}`: the competing directions
- `{{plan}}`: the approved art direction, asset list and budget
- `{{implementation_report}}`
- `{{directives}}`, `{{repository_facts}}`, `{{verification_commands}}`
- `{{changed_files}}`, `{{diff}}`, `{{diff_coverage}}`
- `{{test_results}}`, `{{verification_report}}`, `{{review}}`
- `{{fix_cycle}}`/`{{max_fix_cycles}}`, `{{previous_attempt}}`, `{{preexisting_changes}}`

Phase 2 adds `{{screenshots}}` and `{{design_context}}`.

**Sections:**

1. **Which standard applies (hard branch).**
   - If the repository is the Control Center (it has `design.md` and `packages/ui`), design.md binds. That means:
     - semantic tokens and `packages/ui` components only;
     - no new colours, radii or type;
     - OS fonts only (design.md:393);
     - "not a marketing site" (design.md:21): **no generated hero media and no looping decorative motion** (design.md:1779, §17 at 2042+);
     - WCAG 2.2 AA, both themes, the §19 matrix;
     - change design.md first.
   - Otherwise, find the repository's own standard (tokens, Tailwind theme, component library). If there is none, propose one before building.
2. **Mode by stage key.**
   - `assets` (Level 3): media only; write only under the asset folder and the manifest.
   - Any other key (Level 2): build and fixes. Generation is refused here by design. If an asset is unusable, raise `BLOCKED ON OPERATOR` recommending an Assets re-run.
3. **Craft rules (short and checkable):**
   - **System first:** colour roles for both themes (dark is its own palette, not an inversion), a type scale with at most 2 families, spacing, radius and motion tokens. Then components with every state (hover, focus-visible, active, disabled, loading, empty, error). Then pages.
   - **Readability:** measure of 45-75 characters; contrast 4.5:1 for text and 3:1 for UI and large text; never colour alone; 44 px touch targets.
   - **Responsive:** mobile-first, no horizontal scroll at 390 px, logical CSS properties, a `dir="rtl"` pass when the product ships Arabic.
   - **Motion:** 120-300 ms, transform/opacity only, `prefers-reduced-motion` honoured.
4. **Assets method:**
   1. No budget in the plan → `BLOCKED ON OPERATOR`.
   2. Discover: `acc_find_capability`, then `mcp.fal_jobs.recommend_model`, then `get_model_schema`. Gateway tool inputs are an untyped object (`mcp.ts:127`), so read the schema first.
   3. Call `get_pricing` before every paid call.
   4. Explore cheap (2-4 candidates), download, Read and critique each, then make one final.
   5. Video: image-to-video from the approved still, ≤8 s, muted. `submit_job` once, poll, `cancel_job` when abandoning.
   6. Download into the repository. Never ship vendor URLs as runtime sources.
   7. Optimise: AVIF/WebP widths with `srcset`/`sizes` and width/height; WebM listed first, then H.264 `+faststart` with `-an`; poster frame.
   8. Write `…/generated/manifest.json` (file, sha256, size, dimensions, model, prompt, seed, cost, used-in).
   9. Stop at 80% of the budget.
5. **Build method:**
   1. Read the standard and every file before editing.
   2. Tokens, then components, then pages.
   3. **Look at it:** `process.start`, then `browser.open` at desktop, tablet and phone; `browser.evaluate` to switch the theme, then `browser.snapshot` with a screenshot; `browser.check_page`; `browser.accessibility`.
   4. Critique against a rubric: hierarchy, alignment, rhythm, type, contrast, theme parity, image quality and crops, motion, reflow, states, a11y, media weight.
   5. At most 3 rounds of about 12 screenshots each.
   6. Extend the repository's Playwright matrix: themes × 5 viewports, axe, no overflow, no console errors.
6. **Rules:**
   - Never commit, push or deploy. This matters: at Level 3 Claude's Bash allows `git commit` (`index.ts:145`).
   - Never handle API keys; generation goes only through `mcp.fal*`.
   - Avoid names like `designToken:` and phrases like "token <name>". The redactor masks them in logs and in the reviewer's diff (`redact.ts:28-55`, `context.ts:231`; tested with a scratch run).
   - A tool refusal is an operator decision, never something to work around.
7. **Report headings:** `## Summary`, `## Design decisions`, `## Assets`, `## Spend`, `## Changes`, `## Visual verification`, `## Verification performed`, `## Known limitations`, `## Skills used`.

**Operator brief template** (the planner is generic, so the brief carries the design requirements):

```
Design brief: <product/page>, audience, 3 brand words, reference URLs, must-keep elements.
Deliverables: pages/sections, both themes, breakpoints, locales (FR/AR → RTL).
Media: ≤N images, ≤M loops ≤8 s, hard budget $X, provider fal, no text inside images.
/tenten-web-design
```

---

#### 6. Workflow YAML (Phase 1; real fields only)

I checked this by hand against `validateWorkflow` (`packages/shared/src/workflow.ts:25-50, 115-185`):

- `onFail` appears only on tests, verify and verdict stages;
- the `next` chain is acyclic and every stage is reachable;
- fixed teams are Level 1 only;
- the verdict team has exactly one primary, and the non-verdict team has none;
- every worker focus is ≤60 characters (`stage-teams.test.ts:495-501`).

Run it in **Discuss First** mode (a planner stage raises `plan_review`, `engine.ts:1274-1290`) with the **Autopilot** policy, which is the default (`tools.ts:291`), and auto-approve ≥3. Safe mode's ceiling is min(2, …), so it denies Level 3 calls (`policy.ts:41-45`).

```yaml
id: frontend-design
name: Frontend Design
description: Art direction, generated media, build, visual QA and design review
maxFixCycles: 4            # one counter shared by every onFail loop (engine.ts:1318-1326)
stages:
  - key: brief
    name: Design brief
    role: investigator
    effort: high
    permissionLevel: 1
    timeoutSec: 2700
    retry: { maxAttempts: 2 }
    next: direction
    team:
      mode: fixed
      maxWorkers: 3
      workers:
        - key: bold
          focus: "Bold direction: type, colour, imagery, motion"
          agentId: claude
          model: opus
        - key: calm
          focus: "Calm product-led direction: tokens, space, a11y"
          agentId: claude
          model: fable
        - key: contrarian
          focus: Contrarian direction, UX flows, states and RTL
          agentId: codex        # swap to claude until Codex is observed working (agents.md:130-133)
  - key: direction
    name: Art direction
    role: planner
    model: opus
    effort: high
    permissionLevel: 1
    retry: { maxAttempts: 2 }
    next: assets
  - key: assets
    name: Assets
    role: designer             # NEW role (Phase 1 code)
    agentId: claude
    effort: xhigh
    permissionLevel: 3         # the only place mcp.fal.* (Level 3) can run
    requiresApproval: true     # asks again on every attempt
    timeoutSec: 5400
    retry: { maxAttempts: 1 }  # a retry would bill again
    description: Generate, download and optimise the approved media (paid)
    next: build
  - key: build
    name: Build
    role: designer
    agentId: claude
    model: opus
    effort: max
    permissionLevel: 2         # cannot generate: fix loops never spend
    timeoutSec: 5400
    retry: { maxAttempts: 2 }
    next: checks
  - key: checks
    name: Checks and visual matrix
    role: tester
    kind: tests
    commandKinds: [lint, typecheck, test, build, e2e]
    permissionLevel: 2
    next: app-check
    onFail: build
  - key: app-check
    name: App check
    role: tester
    kind: verify
    permissionLevel: 2
    timeoutSec: 900
    next: review
    onFail: build
  - key: review
    name: Design review
    role: reviewer
    effort: high
    permissionLevel: 1
    verdict: true
    retry: { maxAttempts: 2 }
    next: complete
    onFail: build
    team:
      mode: fixed
      maxWorkers: 2
      workers:
        - key: correctness
          focus: Correctness of the diff and the design rules
          primary: true
        - key: craft
          focus: Visual craft, a11y, both themes, media weight
```

**Notes:**

- A tests stage with no matching command asks for a `skip_tests` approval (`runners.ts:682-700`). Register the e2e command first.
- Only the last finished tests stage counts toward READY (`report.ts:119-147`).
- The build is a single agent on purpose. Adaptive units inherit one agent (`stage-team.ts:221-222`) and must own disjoint paths, which would split tokens from components.

**Day-0 fallback with no code:** duplicate this as a custom profile with `role: implementer` on assets and build, and add a separate `fix` stage (`role: fixer`, L2) as the `onFail` target. Without it, the Chairman gate's remedy target `fixDef` falls to the **first** implementer stage, which is the paid `assets` stage (`chairman/gate.ts:42`).

**Phase 2 changes to this YAML (new fields):**

- `toolProfile: frontend-design` and `instructions:` on assets, build and review;
- `skills: [tenten-web-design]`;
- `assets` drops to `permissionLevel: 2` once the spend gate exists;
- verify gains `colorSchemes`.

---

#### 7. File-by-file change list

The AGENTS.md rules touched are: **guard** (subscription guard, policy, confinement, broker or redaction: a test is required), **tool** (packs only, through ToolService), **migration** (new migrations only), **UI** (semantic tokens, packages/ui, Playwright matrix in both themes), **secret-scan** (test credentials assembled at runtime).

##### Phase 1

| File | Change | Effort | Rule / test |
|---|---|---|---|
| `packages/shared/src/constants.ts:47-57` | Append `'designer'`; export `WRITE_ROLES` | S | Enum values are stored verbatim: add, never rename |
| `packages/shared/src/labels.ts:42,55` | Designer / Designing (compiler-enforced) | S | — |
| `apps/orchestrator/src/services/settings.ts:6-16` | `designer: {agentId:'claude', effort:'high'}` | S | — |
| `apps/orchestrator/src/engine/runners.ts:166-173` | `designer → implementation-report, design-report.md, design-prompt.md`. Without it the report is saved as stage-output and `{{implementation_report}}` (`context.ts:389`) never shows it | S | — |
| `chairman/gate.ts:42-44`, `engine/report.ts:120,184`, `chairman/checkpoints.ts:197` | Use `WRITE_ROLES`. `fixDef`: fixer, else the last write-role agent stage at ≤L2 | S | Gate/report tests: a designer write without later tests is not READY; a review FAIL goes to `build`, never `assets` |
| `chairman/policy.ts:114`, `chairman/intent.ts:33-39` | Include designer in the fallback; chat keyword | S | — |
| `engine/tooling.ts:327,363` | Environment section for designer; routing sentence names design stages | S | — |
| `packages/agent-sdk/src/simulated.ts:291` | `case 'designer'` for demo and e2e | S | — |
| `prompts/designer.md` (new) | §5 | S | `prompts.test.ts:12,21,51-57`: seven templates, designer in WORK_ROLES and the loop-context lists |
| `workflows/frontend-design.yaml` (new) | §6 | config | Workflow validation test; a test that `mcp.fal.*` (L3) is denied in an L2 stage (policy unchanged) |
| `packages/security/src/env-guard.ts:56-101` + `test/security.test.ts` | Add `FAL_KEY`, `REPLICATE_API_TOKEN`, `STABILITY_API_KEY`, `RUNWAYML_API_SECRET`, `LUMAAI_API_KEY`, `ELEVENLABS_API_KEY` and Higgsfield key names | S | **guard** + **secret-scan**: test with values assembled at runtime |
| `docs/systems/{prompts,workflow-engine,mcp,security,agents}.md`; fix `tool-system.md:118-120` | Document the new behaviour; the tool-system sentence contradicts `profiles.ts:77-78` | S | AGENTS.md docs rule |

##### Phase 2

| File | Change | Effort | Rule / test |
|---|---|---|---|
| `packages/tools/src/packs/media.ts` (new), `src/index.ts:50-72`, `src/sdk.ts:14-36,114-117,221-238` | Media pack; `'media'` category; `image`/`video` added to the ArtifactSink union; optional `estimateCost`. Vendor JSON through `restRequest` (manual redirects, 4 MB UTF-8 cap, loopback-only `apiBase` override for tests, `rest.ts:27-50`). Binary downloads through `guardedFetch({crossOrigin:'follow'})` (`net-guard.ts:45`), streamed to disk with a media cap, because `readCapped` buffers up to 16 MB (`net-guard.ts:12,77`). Writes through `resolveInside` plus the protected-path check. Mark the providers `builtin` and return `AUTH_REQUIRED` when the key is missing (pattern at `cloudflare-api.ts:41`) | L | **tool** + **guard**: confinement (`..`, symlinks, protected paths), a stand-in vendor server, wrong MIME / over-cap / redirect into the Control Center refused, credential read by name |
| `packages/tools/src/packs/filesystem.ts:38` | Export `protectedCheck` | S | **guard** |
| `packages/shared/src/constants.ts:205-226`; `apps/orchestrator/src/services/artifacts.ts:9-21` | `image`/`video` artifact types (`task_artifacts.type` is TEXT, no migration); MIME types webp, avif, webm, gif, svg (SVG download-only) | S | — |
| `packages/shared/src/tools.ts:161-172`; `apps/orchestrator/src/tools/credentials.ts:291-300` | Optional `media` credential kind with env null (`credential_references.kind` is TEXT). Refuse `API_BILLING_ENV_VARS` names as a credential envVar at create time | S | **guard** (broker and subscription guard) |
| `packages/shared/src/learning.ts:68-76` | ffmpeg (winget `Gyan.FFmpeg`) in `INSTALLABLE_TOOLS` | S | — |
| `packages/mcp/src/gateway.ts:153-160`, `apps/orchestrator/src/tools/mcp.ts:106-139` | Keep image blocks, map PNG/JPEG ≤3 MB into `images` and save them as artifacts; keep `inputSchema` in the `health` JSON (TEXT, no migration) and publish it; `readOnlyHint` → `readOnly` | S | Test next to `packages/mcp/test/mcp.test.ts` |
| `packages/tools/src/packs/browser.ts:19-23,139,430-462`, `browser-session.ts:357-395` | colorScheme, reducedMotion, DPR, `wide` 1440×900 and `narrow-desktop` 1024×768; accessibility returns `nodes[].target` and is added to LOOK; `browser.visual_matrix` (contact sheet composed in Chromium, ≤3 images) | M | **tool**; profile tests in `packages/tools/test/core.test.ts` |
| `packages/tools/src/packs/verify.ts:14-22`, `shared/src/tools.ts:307-317`, `engine/runners.ts:1276-1283` | Theme and viewport loop in `verify.web`; runtime schema fields forwarded | M | Test (verify.web is a classified operation) |
| `packages/shared/src/schemas.ts:98-131`, `workflow.ts`, `engine/context.ts:414-428`, `engine/tooling.ts:133,261`, `packages/tools/src/profiles.ts` | Stage fields `instructions` (≤2000, appended after the template), `toolProfile` (a profile id, never `operator` for agents), `skills`; a `frontend-design` profile ordered `media.*, browser.*, verify.*, mcp.fal.*, …CORE…` (60-tool cap, `service.ts:142`) | M | **guard** (tool policy scope) + validation tests |
| `packages/shared/src/prompts.ts:8-36`, `context.ts:376-413`, `prompts/reviewer.md`, `verifier.md` | `{{screenshots}}`, `{{design_context}}`; reviewer and verifier also get `{{attachments}}` | S | `prompts.test.ts` |
| `engine/runners.ts:564-576` | `images` from image attachments when `getCapabilities().images` (Codex `-i`, `agent-codex/src/index.ts:185`) | S | Test |
| `engine/tooling.ts:266,546` | Name the visual loop in the tools section; count `visual_matrix`/`accessibility` as browser evidence | S | — |
| `apps/orchestrator/src/tools/service.ts:468-492`, `usage/*`, `packages/shared/src/usage.ts`, `db/migrations.ts` (v20) | Spend gate that fails closed; "Allow paid generation" **off by default** (PLAN §11: never purchase or switch to credits automatically); append-only `media_usage_events`; `MEDIA` budget scope; Usage page | L | **guard** + **migration** + **UI** |
| `packages/security/src/redact.ts:28-58` | Mask only signature parameters of signed URLs; stop the assignment rule at `&`; narrow, tested exceptions for design-token phrasing | S | **guard** (redaction) with regression tests |
| `packages/agent-claude` + `verify:agents` | Probe: does `claude -p` Read show PNG/JPEG; does Codex render MCP image blocks | S | — |

##### Phase 3

| Item | Where | Effort | Rule |
|---|---|---|---|
| `ROLE_CLASS` refactor; `art-director` and `visual-critic` roles; `plan_review` for plan-class roles | `constants.ts`, the sites above, `engine.ts:1274`, `gate.ts:57` (reviewer/verifier literals) | M | Gate tests |
| `browser.render_html` style tiles (network blocked except `data:`, JS off, size cap) | Browser pack | M | **guard**: isolation tests |
| Design memory `design/` + learning signals → repository-scoped skill | `context.ts`, `learning/signals.ts` | S-M | — |
| Gateway OAuth (tokens sealed in the broker) | `gateway.ts:90-93`, `tools.ts:329` | M | **guard** |
| `team.mode: variants` + judge unit; specialty routing | `schemas.ts:91-95`, `stage-team.ts`, new plan doc | L | Tests |
| Design pack; `visual_diff`; `browser.audit`; asset-aware review coverage | Packs, `runners.ts:442-472` | M | Gate tests |

---

#### 8. Key risks and operator decisions

##### Risks

1. **Spend is not enforced in the product until Phase 2.** Tool calls have no cost field (`sdk.ts:203-219`), and budgets are checked only when an agent is launched. The fal balance is the only hard cap.
2. **A Level 3 assets stage allows `git commit` in Claude's Bash** (`index.ts:145`). The prompt forbids it. The alternative, fal at Level 2, would let every L2 implement stage spend.
3. **Double billing.** Retries, gateway timeouts (60 s default, 600 s maximum) and resubmits can all bill again. Mitigations: `retry: 1`, `submit_job` plus polling, approval on every attempt.
4. **The gateway drops images.** fal must return URLs, or its images vanish. Smoke-test on day 0.
5. **Generated binaries in review.** A PASS must name every changed file the diff did not show, and binaries appear only as "Binary files differ" (`runners.ts:442-472`). Keep asset counts small and point reviewers at the manifest.
6. **Redaction garbles design text** ("token --color-x", `accentToken: "#3355ff"`; verified by running `redact.ts`) until the Phase 2 redaction change.
7. **Ambient media keys leak today.** Remove them from the orchestrator's shell until the env-guard change ships.
8. **design.md conflict.** Generated hero media is wrong for the Control Center's own UI. The prompt's first branch handles this.
9. **Unverified image viewing.** Whether Claude `-p` can view local images, and whether Codex shows MCP images, is unverified. Docs say Codex is out of credits.
10. **H.264 playback.** The browser pack prefers Playwright's bundled Chromium (`browser.ts:41-51`), which may not decode H.264 *(unverified)*. List WebM first.
11. **Attachments.** They live in `<dataDir>/tasks/<id>/attachments` (`engine.ts:310`). ToolService refuses agent inputs that name the data folder (`service.ts:462`, `security/commands.ts:185-213`). Reading the listed path with native Read is the product's current design. Do **not** tell agents to `cp` from the data folder through Bash, which goes against the F-02 intent. In Phase 2, have the orchestrator copy or pass the images.
12. **Day-0 fallback.** With implementer roles, the gate's `fixDef` can target the paid stage. Add a fixer stage, or ship the gate change.
13. **Role blast radius.** Only two role maps are compiler-enforced. The VS Code extension and remote clients were not audited for role switches.
14. **Chrome DevTools MCP.** Its browser has no `guardBrowserContext`. A literal `:4317` in its input is blocked, but indirect routes (page JavaScript, redirects) are not. Prefer the native `browser.audit`.

##### Decisions for the operator (recommended default in brackets)

1. Enable paid generation, and with what budget? [Yes. $5 per task and a $25/week prepaid top-up on a dedicated fal account and key.]
2. Which vendor keys? [fal only in Phase 1, Replicate as fallback. Direct OpenAI/Google only through the Phase 2 media pack, read by name.]
3. Permission level for generation? [Level 3 with `requiresApproval` now; Level 2 plus the fail-closed spend gate after Phase 2.]
4. Default mode for design tasks? [Discuss First (the art-direction sign-off) with the Autopilot policy, auto-approve 3.]
5. Where does media live? [Optimised derivatives committed under the repository's convention, e.g. `public/generated/`; masters kept as artifacts; ≤10 MB of generated media per task; revisit LFS or R2 for video.]
6. How many new roles? [Only `designer` in Phase 1. Add the `instructions` stage field in Phase 2 before adding art-director or visual-critic.]
7. Which targets first? [User products first. The Control Center UI only under the strict design.md branch, with generated media off.]
8. Is FR/AR/RTL a standing requirement? [Yes when the locales include Arabic: a `dir="rtl"` pass and no text inside images.]
9. Chrome DevTools MCP for agents? [No. Build the native `browser.audit` in Phase 2.]
10. Higgsfield or Canva? [Operator-attended through attachments now; gateway OAuth in Phase 3.]
11. Designer model and effort? [Build: opus or fable at `max`. Assets: `xhigh`. Watch the subscription windows.]
12. May the designer add `@playwright/test` and `@axe-core/playwright` to target repositories? [Yes, if the approved plan lists them. No pixel baselines in week 1.]
13. Is it acceptable that the free `mcp.fal_jobs.*` tools are reachable from any L2 stage? [Accept. They are free and do not change anything.]

---

#### 9. Verification notes

##### Verified in source

**Roles and prompts**

- `ROLES` has 9 values (`constants.ts:47-57`) and `roleSchema` validates stages (`schemas.ts:39,101`). `ROLE_LABEL` and `ROLE_ACTIVITY` are exhaustive; `ROLE_ARTIFACT` and `DEFAULT_ROLE_DEFAULTS` are partial.
- `prompt_templates.role`, `task_artifacts.type`, `credential_references.kind` and `mcp_servers.health` are TEXT columns with no CHECK constraint. The latest migration is 19.
- Templates are chosen by role; `description` is not rendered; `Stage:` is in the header (`context.ts:338,414`). There are 27 placeholders. Non-text attachments are listed by path. Saving a template with an unknown placeholder returns 400 (`routes.ts:536`).
- Seeding goes through `prompts.ts:39-46`. The template contract test is at `prompts.test.ts:12-62`, including the ``- `## X` `` heading format and the exact six-file list.
- `BLOCKED ON OPERATOR` is read from every role except reviewer and verifier; `parseVerdict` takes the last match; the PASS coverage follow-up and REVIEW_INCOMPLETE are at `runners.ts:427-478`.

**Gates and workflows**

- The literals `'implementer' || 'fixer'` appear at `gate.ts:42,44`, `report.ts:120,184`, `checkpoints.ts:197`, `policy.ts:114` and `tooling.ts:327`.
- `plan_review` is raised only for the `planner` role (`engine.ts:1274`). The shared fix counter, the fix limit leading to WAITING_FOR_USER, and "no onFail means FAILED" are at `engine.ts:1295-1327`.
- The stage gate and approval for one attempt are at `engine.ts:1010-1052`.
- `teamIssues`: fixed teams only at L1, exactly one primary on a verdict team, no teams at L4+. `onFail` only on verdict, tests, git or verify stages. The `next` graph must be acyclic.
- Adaptive manifests are read from the latest plan by stage key, units inherit the stage's assignment, and the silent fallbacks are at `stage-team.ts:180-223,428-433`. Worker focus is rendered (`stage-team.ts:1071-1096`).
- No built-in workflow has an agent stage at Level 3.

**Agent adapters**

- The Claude tool policy, `BASE_TOOLS`/`EDIT_TOOLS`, no WebFetch/WebSearch/Agent/PowerShell, `--strict-mcp-config`, `--setting-sources project,local` only when loadUserConfig is false, `--plugin-dir`, `images:false`, and git commit allowed at L3 are all in `agent-claude/src/index.ts:79-147,340-351,419-447`.
- Codex has `images:true` and `-i`, a read-only sandbox at L1 and workspace-write above (`agent-codex/src/index.ts:132,171,185`). `launchAgent` never sets `images` (`runners.ts:564-576`).

**Tools, gateway and security**

- Profiles, LOOK, `mcp.*` only by explicit pattern, and L1 = `analysis` (`profiles.ts`). The policy ceiling and `decide()` (`policy.ts:41-79`); default policy mode `autopilot` and auto-approve 3.
- ToolService: self-reference guard, checkpoint and TOOL_CALL at ≥L3, broker env merged after sanitising, redaction of summary, stdout and stderr (`service.ts:440-544`); 60-tool cap.
- Images: ≤3 per call (`tool-routes.ts:25,256`), PNG/JPEG only in the bridge (`bridge.ts:62,105-108`), 3 MB model cap (`browser.ts:110`); viewports are desktop, phone and tablet only; DPR 1; no colorScheme.
- Gateway: stdio child env = default environment plus mapping; HTTP with static headers, no OAuth; non-text content becomes `[type]` (`gateway.ts:78-94,153-160`). MCP servers: unscoped credential resolution, level (≥3 if destructive), untyped input, no images returned (`mcp.ts`). envName regex, timeout 60 s default and 600 s maximum (`tools.ts:324-339`).
- The env-guard lists contain no media keys; `syncManagedEnv` strips credential envVars everywhere; `envFor` behaviour; the reserved list applies only to generate and import.
- `http.request`: remote POST is Level 3 and the body is UTF-8 cut at 64 KB (`http.ts:49-55,132`). Recursive `fs.delete` is Level 5. `INSTALLABLE_TOOLS` has no ffmpeg. The artifact MIME map lacks webp, webm, avif and svg.
- Redaction: I ran a scratch copy of `redact.ts` under Node 22. It masks "token --color-…", "Basic typography-scale", `designToken: x` and `accentToken: "#…"`, and leaves `fal.media` URLs and Azure `sig=` URLs intact.

**Design standard**

- design.md:21, 393, 1779, 2042 and 2141 say what the proposals quote. `helpers.ts:4-10` has the five viewports. `matrix.spec.ts` runs dark and light, with axe only at desktop and mobile, and has no pixel baselines.

##### Refuted or corrected

1. **"MCP structuredContent reaches the model unredacted."** Partly refuted. The model-facing text is `redact(ToolService.formatForModel(outcome))`, which includes `output` (`tool-routes.ts:257`, `service.ts:709-721`), and `output` is not persisted. What is true: `gateway.ts:159` and `service.ts:530` leave `output` unredacted inside the result object.
2. **Line references `rest.ts:298-334` and `net-guard.ts:197-280` do not exist.** The files are 65 and 104 lines long. The behaviour is correct at `rest.ts:24-50` and `net-guard.ts:12,45,77,102`.
3. **"An agent cannot delete a losing folder"** (Proposal 1) is overstated. Only prefix rules (`rm -r`, `rm -rf`, `rmdir /s`, …) and recursive `fs.delete` (L5) block it; `rm dir/*` plus `rmdir dir` are not denied. Keeping explorations out of the worktree is still the right call.
4. **"Codex: no skills"** (Proposal 2) is overstated. Codex loads `~/.codex/skills` and `~/.agents/skills` itself (`docs/systems/agents.md:128-133`). What it lacks is `listSkills`, so `/name` requests are recognised only through Claude's catalog, and plugin folders. Runtime loading has not been observed.
5. **"Chrome DevTools MCP can navigate to 127.0.0.1:4317"** (Proposal 1) is partly refuted. A literal `:4317` address in the call input is denied by `referencesSelf`. The indirect risk remains, and the API still needs its token.
6. **`docs/systems/tool-system.md:118-120`** is stale: it says MCP capabilities are never in a non-operator profile, but `profiles.ts:77-78` allows explicit `mcp.<slug>.*` patterns.

##### Unverified (not checkable here)

**External (vendors and runtimes)**

- fal: MCP endpoint, tool names, Bearer acceptance, whether results carry URLs, and billing on resubmission.
- Every model price and availability; Sora 2 and Imagen 4 shutdowns; gpt-image-2 transparency.
- OAuth-only status of Higgsfield, Canva, Figma, Recraft and BFL.
- Whether Playwright's bundled Chromium decodes H.264.

**Runtime behaviour not observed here**

- Whether Claude `-p` Read displays local images, and whether Claude and Codex show MCP image blocks to the model. The bridge is designed for Claude; I did not observe it.
- Whether Codex's workspace-write sandbox allows network access.
- Per-call MCP timeouts inside the agent CLIs.
- Whether team write workers can resolve repository-scoped credentials.
- Whether `mcp-remote` works as an OAuth shim.
- Whether the Figma desktop server needs auth.

**Not audited or not run**

- VS Code extension and remote-client role switches.
- No test suite was run: `node_modules` is absent.
### Decisions taken (implement-plan autopilot, 2026-09-27)

The operator invoked `/implement-plan` without answering §8's questions, so
each takes the plan's recommended default:

1. Paid generation is supported but **off by default** ("Allow paid generation"), with a $5 per-task media budget default once enabled; fal prepaid balance remains the outside hard cap.
2. Vendor: fal only (first-party pack + gateway recipe); Replicate documented as the gateway fallback. No direct OpenAI/Google keys.
3. Generation at Level 3 with `requiresApproval` in the Phase 1 workflow; after the spend gate exists, generation is confined per stage by `toolProfile`, not by level alone.
4. Design tasks run Discuss First with the Autopilot policy (documented in the runbook; no default change).
5. Generated media: optimised derivatives committed under the target repository's convention (default `public/generated/`); ≤10 MB per task; masters as artifacts.
6. Only `designer` in Phase 1; `art-director` and `visual-critic` in Phase 3 after `ROLE_CLASS`.
7. User products first; on the Control Center itself the prompt's design.md branch forbids generated media.
8. FR/AR/RTL: `dir="rtl"` pass when locales include Arabic; no text inside images.
9. No Chrome DevTools MCP for agents; native `browser.audit` instead.
10. Higgsfield/Canva: operator-attended via attachments; gateway OAuth in Phase 3.
11. Designer: build opus/fable at `max`, assets `xhigh`.
12. The designer may add `@playwright/test` and `@axe-core/playwright` to target repositories when the approved plan lists them.
13. Free `mcp.fal_jobs.*` reachable from L2 stages: accepted.

Push target: this session is bound to branch `claude/design-agent-media-generation-p6wtd7` (not `main` as AGENTS.md's branch model says); a PR is opened for it.

## Steps

### Phase 1 — designer role, prompt, workflow, guard

- [x] 1. Add the `designer` role: `ROLES` + exported `WRITE_ROLES`, `ROLE_LABEL`/`ROLE_ACTIVITY`, `DEFAULT_ROLE_DEFAULTS` — done when: typecheck passes and a stage with `role: designer` validates — check: `pnpm typecheck && pnpm vitest run packages/shared/test/workflow.test.ts`
- [x] 2. `ROLE_ARTIFACT` maps designer to an implementation report (`design-report.md`, `design-prompt.md`) so `{{implementation_report}}` shows it — done when: a test proves a designer stage's report is saved as `implementation-report` and rendered into a later stage's prompt — check: `pnpm vitest run apps/orchestrator/test/report-artifacts.test.ts apps/orchestrator/test/prompts.test.ts`
- [x] 3. Gate, report and checkpoints use `WRITE_ROLES`; the Chairman's remedy target is the fixer, else the last write-role agent stage at ≤L2 — done when: tests prove a designer write with no later tests is not READY and a review FAIL remedy targets `build`, never the L3 `assets` stage — check: `pnpm vitest run apps/orchestrator/test/autopilot-gates.test.ts apps/orchestrator/test/chairman.test.ts apps/orchestrator/test/chairman-units.test.ts`
- [x] 4. Chairman policy fallback and chat intent include the designer — done when: tests cover the designer in the fallback and the chat keyword — check: `pnpm vitest run apps/orchestrator/test/chairman.test.ts apps/orchestrator/test/chairman-units.test.ts`
- [x] 5. `engine/tooling.ts`: Environment section for the designer; requested-skills routing sentence names design stages — done when: a tooling prompt test shows both for a designer stage — check: `pnpm vitest run apps/orchestrator/test/tools.test.ts apps/orchestrator/test/skills.test.ts`
- [x] 6. Simulated agent answers the designer role (demo and e2e) — done when: a simulated designer run produces a report with `## Summary` — check: `pnpm vitest run apps/orchestrator/test/engine.test.ts`
- [x] 7. `prompts/designer.md` per §5 (standard branch, stage-key modes, craft rules, assets method, build method, rules incl. never commit, report headings) — done when: the template contract test passes with designer in the work-role lists — check: `pnpm vitest run apps/orchestrator/test/prompts.test.ts`
- [x] 8. `workflows/frontend-design.yaml` per §6 — done when: it loads and validates, and a test proves an L3 `mcp.fal.*` capability is denied in an L2 stage (policy unchanged) — check: `pnpm vitest run packages/shared/test/workflow.test.ts apps/orchestrator/test/tools.test.ts`
- [x] 9. Subscription guard strips media vendor keys (`FAL_KEY`, `REPLICATE_API_TOKEN`, `STABILITY_API_KEY`, `RUNWAYML_API_SECRET`, `LUMAAI_API_KEY`, `ELEVENLABS_API_KEY`, Higgsfield names) as ambient credentials — done when: a test with runtime-assembled values shows them removed from child environments — check: `pnpm vitest run packages/security/test/security.test.ts`
- [x] 10. Risk 13: audit role switches in the VS Code extension, dashboard, cloud control and remote clients so `designer` renders everywhere — done when: every `Role`-keyed switch/map outside the compiler-enforced ones handles designer (or falls back sanely), listed in the Ledger — check: `rg -n "'implementer'|\"implementer\"" apps packages --glob '!**/test/**'` reviewed
- [x] 11. Operator runbook for the design agent (fal gateway registration twice with an unscoped `Bearer` credential, ffmpeg, Runtime, Playwright matrix, skills, Discuss First, brief template) — done when: a system doc section documents every Phase 1 operator step — check: `node scripts/docs-guard.mjs`
- [x] 12. Fix the stale `docs/systems/tool-system.md` Profiles sentence (explicit `mcp.<slug>.*` patterns are allowed) and sync Phase 1 docs (prompts, workflow-engine, mcp, security, agents) — done when: the docs describe the designer role, workflow and guard change — check: `node scripts/docs-guard.mjs`

### Phase 2 — media pack, spend gate, visual-QA tools

- [x] 13. Export `protectedCheck` from `packages/tools/src/packs/filesystem.ts` for reuse — done when: the media pack can import it and filesystem tests still pass — check: `pnpm vitest run packages/tools/test/packs.test.ts`
- [x] 14. `image`/`video` artifact types and MIME map entries (webp, avif, webm, gif, svg download-only) — done when: a test stores and serves an image artifact with the right type, and SVG is served as a download — check: `pnpm vitest run apps/orchestrator/test/report-artifacts.test.ts`
- [x] 15. Broker: optional `media` credential kind with no envVar; refuse `API_BILLING_ENV_VARS` names as a credential envVar at create time — done when: tests prove create with envVar `OPENAI_API_KEY` is refused and a `media` credential never reaches a child env — check: `pnpm vitest run apps/orchestrator/test/tools.test.ts`
- [x] 16. ffmpeg in `INSTALLABLE_TOOLS` — done when: the installer lists ffmpeg with its winget id — check: `pnpm vitest run apps/orchestrator/test/learning.test.ts apps/orchestrator/test/learning-units.test.ts`
- [x] 17. Media pack core: `media.asset.fetch` (confined, streamed, content-type and size caps, protected paths) and `media.image.view` (repository file → JPEG ≤3 MB image for the model) — done when: tests prove confinement (`..`, symlink, protected path), wrong MIME / over-cap / redirect to the Control Center refused, and view returns an image — check: `pnpm vitest run packages/tools/test/media.test.ts`
- [x] 18. Media pack generation through fal: `media.image.generate/edit/upscale/remove_background/vectorize`, `media.video.generate`, `media.job.status/fetch`; key read by name from the broker; `AUTH_REQUIRED` without a key — done when: tests against a stand-in vendor server cover submit, poll, fetch into the repo, missing key and vendor errors — check: `pnpm vitest run packages/tools/test/media.test.ts`
- [x] 19. Media pack optimisation: `media.asset.optimize` (AVIF/WebP widths + srcset), `media.svg.optimize` (sanitise + minify), `media.video.encode/poster` (fixed ffmpeg templates), `media.video.frames` — done when: tests prove fixed argv (no injection), SVG scripts/handlers stripped, and outputs confined; ffmpeg-backed ones skip cleanly without ffmpeg — check: `pnpm vitest run packages/tools/test/media.test.ts`
- [x] 20. Spend gate: `estimateCost` on capabilities, fail-closed reservation in `ToolService.invoke`, "Allow paid generation" off by default, migration 20 `media_usage_events`, `MEDIA` budget scope, Usage page row — done when: tests prove a paid call is refused when disabled, refused over budget, recorded when allowed, and the migration applies — check: `pnpm vitest run apps/orchestrator/test/tools.test.ts apps/orchestrator/test/migrations.test.ts apps/orchestrator/test/usage.test.ts`
- [x] 21. Gateway keeps image blocks (PNG/JPEG ≤3 MB → `images`, saved as artifacts), stores and publishes each tool's `inputSchema`, maps `readOnlyHint` — done when: an MCP fixture tool returning an image reaches the caller as an image and its schema is listed — check: `pnpm vitest run packages/mcp/test/mcp.test.ts apps/orchestrator/test/tools.test.ts`
- [x] 22. Browser upgrades: `colorScheme`, `reducedMotion`, `deviceScaleFactor`, `wide` 1440×900 and `narrow-desktop` 1024×768 viewports; `browser.accessibility` returns node targets and joins LOOK; `browser.visual_matrix` contact sheet — done when: browser tests cover each option and the matrix returns ≤3 images — check: `pnpm vitest run packages/tools/test/browser-pages.test.ts packages/tools/test/core.test.ts`
- [x] 23. `verify.web` loops themes and viewports; runtime schema fields forwarded — done when: a test shows a verify run per theme × viewport — check: `pnpm vitest run packages/tools/test/packs.test.ts apps/orchestrator/test/tools.test.ts`
- [x] 24. Stage fields `instructions`, `toolProfile`, `skills`; a `frontend-design` capability profile — done when: validation tests accept them (rejecting `operator` for agents) and the prompt/tool session honour them — check: `pnpm vitest run packages/shared/test/workflow.test.ts apps/orchestrator/test/prompts.test.ts apps/orchestrator/test/tools.test.ts packages/tools/test/core.test.ts`
- [x] 25. Placeholders `{{screenshots}}` and `{{design_context}}`; reviewer and verifier templates get `{{attachments}}` — done when: the prompt contract test passes with the new placeholders rendered — check: `pnpm vitest run apps/orchestrator/test/prompts.test.ts`
- [x] 26. Image attachments passed as `images` when the agent supports them (Codex `-i`), orchestrator-side (risk 11) — done when: a test shows `launchAgent` passes image attachment paths to an images-capable adapter only — check: `pnpm vitest run apps/orchestrator/test/engine.test.ts`
- [x] 27. Tools prompt section names the visual loop; `visual_matrix`/`accessibility` count as browser evidence — done when: tooling tests cover both — check: `pnpm vitest run apps/orchestrator/test/tools.test.ts`
- [x] 28. Redaction: mask only signature parameters of signed URLs, stop the assignment rule at `&`, narrow tested exceptions for design-token phrasing — done when: regression tests prove secrets still masked and design text/`fal.media` URLs readable — check: `pnpm vitest run packages/security/test/security.test.ts packages/security/test/sensitive.test.ts`
- [x] 29. `verify:agents` probe for image viewing (Claude Read of PNG/JPEG, MCP image blocks) — done when: `pnpm verify:agents --images` exists and typechecks; the real run is the operator's — check: `pnpm typecheck`
- [x] 30. Frontend Design workflow Phase 2 revision: `toolProfile`, `instructions`, `skills`, verify `colorSchemes`, generation confined to the assets stage by profile — done when: the YAML validates with the new fields and a test proves the build stage cannot reach `media.*.generate` — check: `pnpm vitest run packages/shared/test/workflow.test.ts apps/orchestrator/test/tools.test.ts`

### Phase 3 — maximum capability

- [x] 31. `ROLE_CLASS` refactor; `art-director` (plan class) and `visual-critic` (judge class) roles with prompts; `plan_review` for plan-class roles — done when: gate/engine tests pass using role classes instead of literals — check: `pnpm vitest run apps/orchestrator/test`
- [x] 32. `browser.render_html` style tiles (network blocked except `data:`, JS off, size cap) — done when: isolation tests prove no network and no script — check: `pnpm vitest run packages/tools/test/browser-pages.test.ts`
- [x] 33. Design memory: `design/` folder in the target repository fed through `{{design_context}}`; learning signals (repeated critic failures, axe rules, overspend) propose a repository-scoped `design-system` skill — done when: tests prove the context renders and a signal produces a proposal — check: `pnpm vitest run apps/orchestrator/test/prompts.test.ts apps/orchestrator/test/learning.test.ts`
- [x] 34. Gateway OAuth for remote MCP servers (tokens sealed in the broker) — done when: tests against a stand-in OAuth + MCP server complete authorisation, call a tool, and never expose tokens — check: `pnpm vitest run packages/mcp/test/mcp.test.ts apps/orchestrator/test/tools.test.ts`
- [x] 35. `team.mode: variants` tournament + judge unit; specialty routing — done when: a new plan exists (the source says STAGE_TEAMS_PLAN.md excludes it) and is either implemented with tests or closed per its own gate — check: `node <skill>/scripts/plan-check.mjs docs/plans/stage-team-variants.md`
- [x] 36. Design pack: `design.contrast_matrix`, `design.lint_tokens` — done when: tests prove contrast math and token-lint findings on fixtures — check: `pnpm vitest run packages/tools/test/design.test.ts`
- [ ] 37. `browser.visual_diff` (baseline write L2) and `browser.audit` (LCP, CLS, image weight) — done when: tests cover diff and audit output — check: `pnpm vitest run packages/tools/test/browser-pages.test.ts`
- [ ] 38. Asset-aware review coverage: binary changed files (images/video) are named to reviewers with the manifest, not "Binary files differ" — done when: a test shows a PASS review with generated assets is not REVIEW_INCOMPLETE when the manifest names them — check: `pnpm vitest run apps/orchestrator/test/engine.test.ts`

## Tail

- [ ] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat origin/main...HEAD` reviewed hunk by hunk
- [ ] T2. Similar-issue sweep — done when: every other `'implementer' || 'fixer'` literal, every role-keyed map, every image/MIME list and every env-guard list was searched for the same gap — check: `manual: list what was searched and what was found`
- [ ] T3. Lint, typecheck, docs guard and tests green; Playwright matrix green in both themes for UI changes — done when: `pnpm check` exits 0 and `pnpm build && pnpm e2e` passes — check: `pnpm check && pnpm build && pnpm e2e`
- [ ] T4. Docs synced per AGENTS.md (the relevant docs/systems file for each changed behaviour) — done when: each touched subsystem's doc reflects the change and docs-guard passes — check: `git diff --stat origin/main...HEAD -- docs/ && node scripts/docs-guard.mjs`
- [ ] T5. Committed path-scoped and pushed to `claude/design-agent-media-generation-p6wtd7`; PR opened — done when: `git status` shows none of this work uncommitted and the push succeeded — check: `git log origin/claude/design-agent-media-generation-p6wtd7..HEAD --oneline` is empty
- [ ] T6. Confirmed live where the push deploys — done when: this step says whether the push deploys — check: `manual: .github/workflows (ci.yml on push to main/PR; deploy-cloud.yml manual only)`
- [ ] T7. A claim registered for this change — done when: the repo's claims register holds an entry, or this step says why not — check: `manual: name the claim and its deadline, or say why the change has no observable outcome`

## Ledger

- 2026-09-27 — created from the conversation's verified design-agent plan (invoked with no argument; `docs/plans` had no in-progress plan and `~/.claude/plans` was empty, so the source is the plan above in the conversation).
- 2026-09-27 — decisions §8 taken at their recommended defaults (see "Decisions taken"); the operator gave no answers before invoking autopilot.
- 2026-09-27 — push target is the session's branch `claude/design-agent-media-generation-p6wtd7`, not `main`: the session's git instructions override AGENTS.md's direct-to-main model.
- 2026-09-27 — step 3 — remedy target is the fixer, else the FIRST write-role agent stage at ≤L2 (else the first write stage), not the plan's 'last': 'first' keeps today's choice (first implementer) for every existing workflow, and still never picks Frontend Design's L3 assets stage.
- 2026-09-27 — step 4 — repairStage falls back fixer → implementer → an editing (≤L2) designer; chat intent gains design/designer/redesign words.
- 2026-09-27 — step 10 — audit: dashboard (RepositoryDetailPage, SettingsPage, WorkflowsPage, EventsTab) iterate ROLES, so designer appears with no change; VS Code status uses the typed ROLE_ACTIVITY ('AI: Claude Designing'); remote prompt routes validate with roleSchema; cloud-control has no role list. Not changed: learning/signals.ts fix_loops and usage/anomalies.ts count only 'fixer' rounds, so a design workflow's build loops are not counted as fix rounds — covered by step 33 (design learning signals).
- 2026-09-27 — step 8 — the brief team uses claude for all three workers (opus, fable, sonnet) instead of the plan's codex contrarian: the plan itself says to swap to claude until Codex is observed working.
- 2026-09-27 — T4 (pending) — the docs hook flagged chairman.md (gate/policy/intent), credential-broker.md (env-guard), checkpoints.md, orchestrator.md, autopilot.md, recovery.md, multi-repository-tasks.md as describing touched code; merge the designer changes into chairman.md and credential-broker.md at T4 and review the rest.
- 2026-09-27 — step 16 — learning-units tests used ffmpeg as their 'not in the catalog' example; now that ffmpeg is in the catalog they use imagemagick instead (same intent).
- 2026-09-27 — step 20 — paid media tools stay at Level 3 even with the spend gate (the plan allowed dropping them to Level 2): Level 3 plus the gate is the safer of the two readings; stage-level confinement is added in step 30 with toolProfile. Also added (not in the plan, same intent): remote guards so the cloud cannot turn paid generation on, raise the task budget, change a price estimate, or loosen/remove a MEDIA budget; a GET /api/usage/media read route (and the usage.media remote read op) behind the Usage page's Paid media panel; the fal MCP-gateway path is not covered by the gate (its tools declare no estimate), documented in the runbook.
- 2026-09-27 — step 20 — media_usage_events rows are written once and settled once (reserved → charged | unknown | released) rather than strictly append-only: one row per paid call keeps the budget sum a single SELECT; rows are never deleted.
- 2026-09-27 — found for later (not changed) — POST /api/tools/call (operator calls) returns result.images as JSON-serialised Buffers (arrays of numbers) instead of base64 like /api/tool-session/call; pre-existing for browser screenshots, now also for MCP pictures. Out of scope; noted.
- 2026-09-27 — step 22 — found and fixed a pre-existing bug: browser.check_page's horizontal-overflow test compared scrollWidth with innerWidth, which under mobile emulation grows to the content width, so phone overflow was never reported (measured: scrollWidth 600, innerWidth 600, clientWidth 390). It now compares with documentElement.clientWidth; check_page, verify.web and the visual matrix report phone overflow. Also: media.image.view and media.video.frames join the LOOK set with browser.accessibility and browser.visual_matrix (Level 1 viewing tools).
- 2026-09-27 — step 24 — toolProfile chooses the stage's listing profile and does not forbid escalation: what may run stays decided by the stage level and policy (e.g. Build at Level 2 can never reach the Level 3 paid tools). Also added the Workflows page editor fields (instructions, tool profile, skills) so the new fields are editable, not only in YAML.
- 2026-09-27 — step 29 — the real-CLI run of pnpm verify:agents --images needs the operator's signed-in CLIs (not run here); its fixture is proven through the gateway in packages/mcp tests. Listed under What you need to do.
- 2026-09-27 — step 30 — verify colorSchemes are a repository App runtime setting (verifyColorSchemes, step 23), not a workflow field: the YAML comment and runbook tell the operator to choose Light and dark; the Assets stage stays Level 3 (see step 20).
- 2026-09-27 — step 31 — the Frontend Design workflow now uses the new roles (the plan left it open): Art direction is an art-director stage (plan_review in Discuss First, re-plan target), and the review team's craft worker became a separate visual-critic stage (Visual critique, verdict, onFail build) before a single-reviewer Code review, so the agent count per cycle is unchanged. Found while wiring it: the completion report read NEEDS OPERATOR lines from the latest review artifact only, so the critic's items were hidden by the code review after it; latestOperatorItems now takes the latest review of each review stage (ArtifactService.latestTextPerStage). Also: roleClass uses Object.hasOwn so a prototype key such as toString is no role.
- 2026-09-27 — step 32 — browser.render_html lives in the browser pack (provider playwright) at Level 1, read-only, in the LOOK set. Isolation is three layers, not only request routing: its own Chromium with a proxy on a closed port that loopback does not bypass and DNS prefetch off, a context with scripts off and service workers blocked, and every routed request refused and named. Found while testing: aborting a meta-refresh navigation replaced the tile with Chromium's error page (an 8 px tall picture), so refused navigations answer 204 instead. Also wired it in (same intent, not named by the step): the Frontend Design brief draws each direction as a style tile, the art-director template gets {{screenshots}} to open them, and the tools prompt line names it.
- 2026-09-27 — T4 (pending) — the docs hook on a96ef34 also flagged agents.md (simulated.ts), autopilot.md, checkpoints.md, multi-repository-tasks.md, orchestrator.md, recovery.md, stage-teams.md and tool-system.md; review each at T4.
- 2026-09-27 — step 33 — design memory already reached prompts through {{design_context}} (Phase 2); this step adds the writing half: the designer keeps design/brief.md when the repository has design/ (or it proposed the standard). Signals: design_critique (a judge stage failing ≥2 times on design work), a11y_rule (an axe rule in ≥2 accessibility summaries; such calls no longer count as tool_failures, since the tool worked) and media_spend (≥80% of the task budget, or a media call refused for the budget). The rule finding's AUTHOR_SKILL body is built from recorded values only (validated keys, counts) and fixed text, never agent words, so planted text cannot become a standing skill; MEDIUM + observed means it is proposed after one task and written after two, which matches the plan's 'propose'. fix_loops now names designer runs in a fix cycle as its stage keys. Found for later (not changed): usage/anomalies.ts review_fix_loop counts fixer usage rows only, so a design workflow's rebuild loops are not flagged as a cost anomaly.
- 2026-09-27 — PR #4 review (Codex bot, 13 findings on c5503d3…fda1400, all verified and fixed outside the plan's steps): completion remedy and implicit repair limited to ≤L2 stages (none when every candidate could spend); fal arguments can no longer set billed quantities (refused keys, validated fields win); downloads stream through one pipeline (write errors are failures); readMedia sniffs a 64 KB prefix and applies image/video limits by type, never buffering video; SVG sanitiser decodes attribute character references, drops every SMIL animation, escaped styles and any-prefix href; the paid-media panel refreshes on media.* tool events and every minute; AVIF outputs carry widths (ffprobe, else the requested width); a refused credential update no longer unregisters the stored value from the redactor; design memory reads are confined after following links; the media budget takes cents; mcp.fal.* removed from the frontend-design profile and the designer told never to call an outside generation server; Authorization headers and Bearer/Basic/Token values are masked in any case again (design spellings still readable). Found for later (not changed): a paid MCP server stays reachable by escalation from a Level 3 stage with auto-approval; enforceable gating needs a per-server paid flag with approval on every call.
- 2026-09-27 — step 34 — design: the MCP SDK's own client auth does discovery, registration, PKCE, exchange and refresh; the gateway only supplies McpOAuthProvider over a store (async, so the orchestrator seals it with the broker's sealValue, AAD mcp-oauth:<id>, in a new mcp_oauth table, migration 21, with plain signed_in_at/expires_at for status). The callback is GET /oauth/mcp/callback outside /api (token-free by the existing security hook; Host/Origin checks still apply), proven by a single-use in-memory state (10 min, ≤20 pending): a restart asks the operator to start again. Start and sign-out refuse cloud-relayed requests (403 REMOTE_FORBIDDEN) and are not in the remote catalog. Found while testing: a background check of an unsigned server registered a client with the authorization server, so an unsigned OAuth server is now never contacted (check reports 'Not signed in', tools answer AUTH_REQUIRED). The OAuth store interface became async in the same step (the gateway half was committed first as 86c3f9b with a sync store).
- 2026-09-27 — step 35 — new plan docs/plans/stage-team-variants.md: team.mode variants implemented (competing attempts in their own checkouts, a Level 1 judge keeps one, only the winner integrated); specialty routing deferred by that plan's own gate (STAGE_TEAMS_PLAN §9.2/§10: no trustworthy per-worker outcome data yet). Found for later: a running app per variant so a visual judge can open each build.
- 2026-09-27 — step 36 — design pack as provider 'design' (category verification, Level 1, read-only): contrast is WCAG 2 relative luminance with translucent layers composited first (dark themes over black, light over white); oklch via Ottosson's matrices, clipped to sRGB. Both tools return ok with findings in the output (like a check that ran), not a tool failure, so the learning loop's tool_failures signal does not count contrast or lint findings. lint_tokens never follows links, skips token/theme/variables files, tailwind.config, custom-property definitions, comments, tests/stories and dependency folders. Added to the LOOK set and the frontend-design profile; the tools prompt line and the visual critic's prompt name them.
