---
system: design-agent
sources:
  - prompts/designer.md
  - workflows/frontend-design.yaml
  - packages/shared/src/constants.ts
  - apps/orchestrator/src/chairman/gate.ts
  - apps/orchestrator/src/chairman/policy.ts
  - apps/orchestrator/src/engine/runners.ts
  - packages/security/src/env-guard.ts
verified_at: 8c6cbf7
---

# Design agent (designer role, Frontend Design workflow)

Plan and decisions: [frontend-design-agent.md](../plans/frontend-design-agent.md).

An "agent" in the Control Center is a role, its prompt template, a workflow
stage, the tools that stage's level allows, the operator's skills and a
model. The design agent is:

| Piece | Where |
|---|---|
| Role `designer` (a write role, like implementer and fixer) | `ROLES`, `WRITE_ROLES`, `isWriteRole` in [constants.ts](../../packages/shared/src/constants.ts) |
| Prompt | [prompts/designer.md](../../prompts/designer.md): mode by the `Stage:` header line (`assets` = media only; any other key = build) |
| Workflow | [workflows/frontend-design.yaml](../../workflows/frontend-design.yaml) |
| Report | `design-report.md`, type `implementation-report` (`ROLE_ARTIFACT` in [runners.ts](../../apps/orchestrator/src/engine/runners.ts)), so reviewers, verifiers and fixers read it as `{{implementation_report}}` |
| Default assignment | Claude, effort high (`DEFAULT_ROLE_DEFAULTS`); the workflow pins opus at `max` for Build and `xhigh` for Assets |

## How a design task flows

1. **Design brief** (investigator, Level 1, fixed team of three): bold, calm
   and contrarian directions side by side.
2. **Art direction** (planner, Level 1): picks or merges one, names the
   asset list and the media budget. Run the task in **Discuss First**: this
   plan is approved before anything is generated.
3. **Assets** (designer, **Level 3**, `requiresApproval`, one attempt):
   generates, downloads and optimises the approved media and writes
   `manifest.json`. The only stage where a Level 3 generation tool can run;
   it asks again on every attempt because each run can spend.
4. **Build** (designer, Level 2): design values, components, pages; opens
   the page in the Control Center browser at several widths and both themes
   and critiques its own screenshots.
5. **Checks and visual matrix** (tests: lint, typecheck, test, build, e2e) and
   **App check** (verify). Failures return to Build.
6. **Design review** (reviewer, fixed team: correctness primary, craft).

Every `onFail` goes to Build, and Build is Level 2, so a fix loop never pays
for media. When a workflow has no fixer, the completion gate's remedy
(protected paths) and the Chairman's repair stage go to the first write
stage at Level 2 or below, never to the paid Assets stage
([gate.ts](../../apps/orchestrator/src/chairman/gate.ts),
[policy.ts](../../apps/orchestrator/src/chairman/policy.ts)).

Designer edits count everywhere implementer and fixer edits count: the READY
gate ("tests have not run since the last change"), the report's Changed
section, and "undo last change".

## Operator setup

1. **Media generation (fal through the MCP gateway).** Paid generation is
   optional; without it the Assets stage writes an asset brief instead.
   - Create a dedicated fal account and key with a prepaid balance; the
     balance is the hard spending cap.
   - Tools → Credentials: add an **unscoped** credential (no repositories:
     MCP servers resolve credentials with no repository) of kind `http`, no
     environment variable, whose value is the **whole header value** fal's
     MCP server expects (for example `Key <key>` or `Bearer <key>`, as its
     documentation says). Never give it the variable name `OPENAI_API_KEY`
     or `GEMINI_API_KEY`: the broker strips a credential's variable from
     every process, which would break the subscription CLIs' own checks.
   - Tools → MCP servers: register fal's MCP URL (streamable HTTP) **twice**,
     mapping the header name (for example `Authorization`) to that
     credential:
     - `fal`, **Level 3**, `allowedTools` = the paid tools (run, submit, upload);
     - `fal jobs`, Level 2, `allowedTools` = the free tools (search, schema,
       pricing, job status, job result, cancel).
   - Agents reach them as `mcp.fal.*` and `mcp.fal_jobs.*` through
     `acc_find_capability` / `acc_call_capability`. The gateway returns text
     only, so results must come back as URLs; long video jobs go through
     submit + status, never repeated submits (each submission is billed).
   - Fallback: Replicate's local stdio MCP server with `REPLICATE_API_TOKEN`
     mapped from a credential.
2. **Media tools on the machine.** ffmpeg on PATH (optimising video, poster
   frames).
3. **The target repository.**
   - Repositories → Runtime: the dev command, URL and paths to verify, so the
     App check and the designer's browser checks can start the app.
   - A Playwright matrix (both themes × phone to wide-desktop widths, axe, no
     horizontal overflow, no console errors) registered as an `e2e` command.
     The designer may add `@playwright/test` and `@axe-core/playwright` when
     the approved plan lists them.
4. **Skills.** Keep "Load my CLI customisations" on for Claude so the
   operator's design skills (for example `/tenten-web-design`) load; name
   them as `/skill` in the brief.
5. **Policy.** Autopilot policy with auto-approve 3 (the default). Safe mode
   caps tools at Level 2 and refuses Level 3 generation.

### Brief template

```
Design brief: <product/page>, audience, three brand words, reference URLs, must-keep elements.
Deliverables: pages/sections, both themes, breakpoints, locales (FR/AR → RTL).
Media: ≤N images, ≤M loops ≤8 s, hard budget $X, no text inside images.
/tenten-web-design
```

## Guardrails

- **Media keys are ambient credentials.** `FAL_KEY`, `REPLICATE_API_TOKEN`,
  `STABILITY_API_KEY`, `BFL_API_KEY`, `IDEOGRAM_API_KEY`, `RECRAFT_*`,
  `LEONARDO_API_KEY`, `RUNWAYML_API_SECRET`, `LUMAAI_API_KEY`, `KLING_*`,
  `MINIMAX_API_KEY`, `ELEVENLABS_API_KEY` and `HIGGSFIELD_*` are stripped
  from every agent, command, terminal and hook in every billing mode
  ([env-guard.ts](../../packages/security/src/env-guard.ts)).
- **Level 3 allows `git commit` in Claude's Bash**; the designer prompt
  forbids committing, pushing and deploying in every mode.
- **The Control Center's own UI** follows design.md: the prompt's first rule
  forbids generated hero media and decorative loops there.
- **Design value names** built on token, secret, auth or key followed by a
  value are masked by the redactor in logs and in the reviewer's diff; the
  prompt asks for plain names.

## Not yet

- Higgsfield, Canva, Figma remote and other OAuth-only MCP servers cannot be
  registered in the gateway (no OAuth): generate in your own session and
  attach the files to the task (up to 10).
- Whether `claude -p` shows a local PNG to the model when the designer reads
  it has not been observed; the Control Center browser's screenshots do
  reach the model (MCP image blocks, three per call).

Last verified: 2026-09-27
