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
  - packages/tools/src/packs/media*.ts
verified_at: c5503d3
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

Every agent stage sets `toolProfile: frontend-design` (media, browser and
verify tools listed first), stage `instructions` (what each direction must
contain, what the art-direction plan must state including the media budget,
Assets = media only, Build = no paid generation and look before reporting,
review the running result in both themes), and `skills: [tenten-web-design]`
where it helps (ignored when that skill is not installed).

Every `onFail` goes to Build, and Build is Level 2, so a fix loop never pays
for media. When a workflow has no fixer, the completion gate's remedy
(protected paths) and the Chairman's repair stage go to the first write
stage at Level 2 or below, never to the paid Assets stage
([gate.ts](../../apps/orchestrator/src/chairman/gate.ts),
[policy.ts](../../apps/orchestrator/src/chairman/policy.ts)).

Designer edits count everywhere implementer and fixer edits count: the READY
gate ("tests have not run since the last change"), the report's Changed
section, and "undo last change".

## Media tools

Built-in capabilities in [media.ts](../../packages/tools/src/packs/media.ts),
[media-fal.ts](../../packages/tools/src/packs/media-fal.ts) and
[media-ffmpeg.ts](../../packages/tools/src/packs/media-ffmpeg.ts); shared file
handling in [media-files.ts](../../packages/tools/src/packs/media-files.ts).

| Capability | Level | What it does |
|---|---|---|
| `media.image.view` | 1 | Shows the model a repository image (PNG/JPEG as is; WebP, AVIF, GIF, SVG drawn by an isolated Chromium: scripts off, network refused, checkerboard for transparency) |
| `media.video.frames` | 1 (FFmpeg) | A contact sheet of frames, duration, size, audio yes/no; writes nothing into the repository |
| `media.job.status` | 1 | A generation job's state; free |
| `media.asset.fetch` | 2 | Downloads one image or video into the repository |
| `media.svg.optimize` | 2 | Sanitises and minifies an SVG |
| `media.asset.optimize` | 2 (FFmpeg) | AVIF/WebP (or JPEG) widths, never upscaled, with `srcset` and a `<picture>` snippet |
| `media.video.encode` / `media.video.poster` | 2 (FFmpeg) | WebM (VP9) + MP4 (H.264, `+faststart`), no audio unless asked, `<video>` snippet; a poster frame |
| `media.job.fetch` / `media.job.cancel` | 2 | Saves a finished job's files; cancels a queued job |
| `media.image.generate`, `.edit`, `.upscale`, `.remove_background`, `.vectorize`, `media.video.generate` | 3 (paid) | fal queue API; results saved as `<folder>/<name>-N.<ext>` |

**Files.** Every path is confined to the task's roots and never touches the
user's own uncommitted work (`protectedCheck`). A file's type comes from its
bytes and must match its extension; downloads are https (or loopback http),
redirects judged hop by hop and never into the Control Center, streamed to a
temporary file under a cap (25 MB image, 200 MB video) and moved into place
only when valid. Every SVG saved or optimised is sanitised: scripts, event
handlers, foreign objects, embedded documents, link-retargeting animations,
`javascript:` and external references, style imports, DOCTYPE and entity
declarations, comments, metadata and editor data are removed until nothing
changes.

**Generation (fal).** The key is the value of a `media` credential (default
name `fal`; the input `credential` names another), read by name for that call
only ([credential-broker.md](credential-broker.md)). A submission is never
retried: a timeout is reported as "may have been accepted and billed", with
the job id. Job ids carry fal's own status, result and cancel URLs, each
proven to be on the queue's origin before the key is sent. A result is
downloaded into the repository by its real type (a vendor's URL is never
shipped) and kept as a task artifact (`image`/`video`, up to 50 MB). Each
paid call returns a conservative cost estimate (`DEFAULT_MEDIA_PRICES`). The
default models are starting points (`fal-ai/flux/dev`, `fal-ai/flux-pro/kontext`,
`fal-ai/esrgan`, `fal-ai/bria/background/remove`, `fal-ai/recraft/vectorize`,
Kling 2.1 for video); `model` and `arguments` pass any fal endpoint and its
parameters. `ACC_FAL_API_BASE` may point the pack at a loopback stand-in (tests)
and nowhere else.

**FFmpeg.** Fixed argument templates, no shell; numbers and choices come from
the schema; every path is passed as `file:<absolute path>` with
`-protocol_whitelist file`, so a name can never be an option or another
protocol. Missing FFmpeg is `NOT_INSTALLED` with the install hint; it is in
the reviewed installer catalog (`Gyan.FFmpeg`).

## Spend gate

Every operation that declares `estimateCost` (the paid `media.*` tools) passes
a gate in `ToolService.invoke` after the policy decision and before it runs
([service.ts](../../apps/orchestrator/src/tools/service.ts),
[usage/media.ts](../../apps/orchestrator/src/usage/media.ts)). It fails
closed:

1. **Settings → Media → Allow paid generation** is off by default (PLAN §11):
   off refuses the call.
2. The estimate (conservative defaults, or the operator's per-model price in
   `media.prices`) must fit what the task has left of **Budget per task**
   (default $5), and every enabled `MEDIA` budget with policy
   `STOP_NEW_RUNS` for its day, week, month or total (Usage & Costs →
   Budgets). An estimate that cannot be computed refuses the call.
3. The check and a `reserved` row in `media_usage_events` (migration 20) are
   one transaction, so concurrent calls cannot both fit into the last dollar.
4. After the call the row is settled once: `charged` when the result carries
   the vendor's job id (or succeeded), `released` when the vendor refused it
   before billing (invalid input, no key, not installed, outside the
   repository), and `unknown` otherwise (a timeout or an unanswered
   submission may have been billed, so it stays counted).

Amounts are estimates; the fal bill is the truth. `GET /api/usage/media`
(`usage.media` from the cloud) lists them; the Usage page shows them under
Paid media generation. From the cloud, paid generation cannot be turned on,
the task budget raised, a price estimate changed, or a media budget loosened
([remote-node.md](remote-node.md)).

## Operator setup

1. **Media generation.** Paid generation is optional; without it the Assets
   stage writes an asset brief instead. The built-in `media.*` tools need
   only a Tools → Credentials entry of kind **media** named `fal` holding the
   fal key (no environment variable), and **Settings → Media → Allow paid
   generation** turned on with a budget per task; optionally a Paid media
   generation budget (Usage & Costs → Budgets, policy "Stop new runs") for a
   daily, weekly or monthly cap. The alternative below uses fal's own MCP
   server through the gateway (not covered by the spend gate: its tools
   declare no estimate).
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
     `acc_find_capability` / `acc_call_capability` (which names each tool's
     parameters). The gateway passes on text and PNG/JPEG pictures, so other
     results must come back as URLs; long video jobs go through submit +
     status, never repeated submits (each submission is billed).
   - Fallback: Replicate's local stdio MCP server with `REPLICATE_API_TOKEN`
     mapped from a credential.
2. **Media tools on the machine.** ffmpeg on PATH (optimising video, poster
   frames).
3. **The target repository.**
   - Repositories → App runtime: the dev command, URL and paths to verify, so
     the App check and the designer's browser checks can start the app; set
     Widths to "All five" and Themes to "Light and dark" for a design
     repository.
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
