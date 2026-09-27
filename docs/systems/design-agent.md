---
system: design-agent
sources:
  - prompts/designer.md
  - prompts/art-director.md
  - prompts/visual-critic.md
  - workflows/frontend-design.yaml
  - workflows/full-autopilot.yaml
  - packages/shared/src/constants.ts
  - packages/shared/src/ui-paths.ts
  - apps/orchestrator/src/engine/task-changes.ts
  - apps/orchestrator/src/chairman/gate.ts
  - apps/orchestrator/src/chairman/policy.ts
  - apps/orchestrator/src/engine/runners.ts
  - packages/security/src/env-guard.ts
  - packages/tools/src/packs/media*.ts
verified_at: 57af61a
---

# Design agent (designer role, Frontend Design workflow)

Plan and decisions: [frontend-design-agent.md](../plans/frontend-design-agent.md).

An "agent" in the Control Center is a role, its prompt template, a workflow
stage, the tools that stage's level allows, the operator's skills and a
model. The design agent is:

| Piece | Where |
|---|---|
| Role `designer` (write class, like implementer and fixer) | `ROLES`, `ROLE_CLASS`, `isWriteRole` in [constants.ts](../../packages/shared/src/constants.ts) |
| Role `art-director` (plan class, like planner) and `visual-critic` (judge class, verdict kind `review`, like reviewer) | `ROLE_CLASS`, `isPlanRole`, `judgeKind` in the same file |
| Prompts | [prompts/designer.md](../../prompts/designer.md): mode by the `Stage:` header line (`assets` = media only; any other key = build); [prompts/art-director.md](../../prompts/art-director.md); [prompts/visual-critic.md](../../prompts/visual-critic.md) |
| Workflow | [workflows/frontend-design.yaml](../../workflows/frontend-design.yaml) |
| Reports | `design-report.md`, type `implementation-report` (`ROLE_ARTIFACT` in [runners.ts](../../apps/orchestrator/src/engine/runners.ts)), so reviewers, verifiers and fixers read it as `{{implementation_report}}`; `art-direction.md` (type `plan`, read as `{{plan}}`); `visual-review.md` (type `review`) |
| Default assignment | Claude, effort high for all three (`DEFAULT_ROLE_DEFAULTS`); the workflow pins opus at `max` for Build, `xhigh` for Assets and opus for Art direction |

## How a design task flows

1. **Design brief** (investigator, Level 1, fixed team of three): bold, calm
   and contrarian directions side by side, each drawn as a style tile with
   `browser.render_html` in light and dark (scripts off, nothing fetched;
   [browser-and-web.md](browser-and-web.md)). The tiles are screenshot
   artifacts, so the art director opens them through `{{screenshots}}`.
2. **Art direction** (art director, Level 1): picks or merges one and
   states concrete design values for both themes, the components and pages,
   the asset list and the media budget. It is a plan-class role, so run the
   task in **Discuss First**: this plan is approved (`plan_review`) before
   anything is generated, and the Chairman re-plans here.
3. **Assets** (designer, **Level 3**, `requiresApproval`, one attempt):
   generates, downloads and optimises the approved media and writes
   `manifest.json`. The only stage where a Level 3 generation tool can run;
   it asks again on every attempt because each run can spend.
4. **Build** (designer, Level 2): design values, components, pages; opens
   the page in the Control Center browser at several widths and both themes
   and critiques its own screenshots.
5. **Checks and visual matrix** (tests: lint, typecheck, test, build, e2e) and
   **App check** (verify). Failures return to Build.
6. **Visual critique** (visual critic, Level 1, verdict): the screenshots,
   `browser.visual_matrix` and `browser.accessibility` in both schemes,
   judged against the approved direction. A FAIL returns to Build.
7. **Code review** (reviewer, verdict): correctness and the repository's
   rules. Both verdicts are of kind `review`, but the completion gate asks
   each judge role for its own pass since the last change (`completionGate`
   in [gate.ts](../../apps/orchestrator/src/chairman/gate.ts)): a critique
   PASS does not stand for the code review, and the role's latest verdict
   run decides, so a re-review after a fix stands for the review before it.
   The Chairman judges a strategy by the same judge role's next verdict
   ([chairman.md](chairman.md)).

Every agent stage sets `toolProfile: frontend-design` (media, browser and
verify tools listed first), stage `instructions` (what each direction must
contain, what the art direction must state including the media budget,
Assets = media only, Build = no paid generation and look before reporting,
the critique looks in both themes, the review checks the code), and `skills: [tenten-web-design]`
where it helps (ignored when that skill is not installed).

Every `onFail` goes to Build, and Build is Level 2, so a fix loop never pays
for media. The completion gate's remedy (protected paths) and the
Chairman's implicit repair stage go only to a fixer or write stage at
Level 2 or below, never to the paid Assets stage or a Level 3 fixer; when no
such stage exists there is no automatic remedy (a stage's own `onFail` still
wins)
([gate.ts](../../apps/orchestrator/src/chairman/gate.ts),
[policy.ts](../../apps/orchestrator/src/chairman/policy.ts)).

Designer edits count everywhere implementer and fixer edits count: the READY
gate ("tests have not run since the last change"), the report's Changed
section, and "undo last change"; in a supervised task's completion report a
Build run in a fix cycle counts as a fix attempt (`buildFinalReport` in
[report.ts](../../apps/orchestrator/src/engine/report.ts)).

## In Full Autopilot

Plan: [DESIGNER_ROUTING_PLAN.md](../plans/DESIGNER_ROUTING_PLAN.md). Full
Autopilot brings the design specialist in only for user-interface work:

- **Visual critique** (`critique`, visual critic, Level 1) after the App
  check, with `when: ui-changed`: it runs only when the task's own changes
  touch UI files ([ui-paths.ts](../../packages/shared/src/ui-paths.ts)), and
  the completion gate then requires its PASS; otherwise it is skipped and not
  required ([workflow-engine.md](workflow-engine.md#profiles)). A PASS stands
  while the UI files are unchanged. Its stage instructions replace the art
  direction: judge against the repository's standard and the look before the
  change, block only regressions this change introduced, never on a look not
  seen (no running app: judge the changed files with `design.lint_tokens` and
  `design.contrast_matrix`), never NEEDS OPERATOR, always `CAUSE: code`.
- **Design fix** (`design-fix`, designer on Claude, Level 2): the critique's
  `onFail`; fixes only what the critique marks blocking, never generates, and
  a missing asset becomes a placeholder, not a question. Then Test again.
- No design skill is loaded on these stages: Autopilot runs on every
  repository, whose own standard binds.
- Backend tasks: the critique is one Git file check, no agent run, no
  approval. For both themes and all widths in the critique's screenshots, set
  Repositories → App runtime → Themes "Light and dark" and Widths "All five".

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
| `media.asset.optimize` | 2 (FFmpeg) | AVIF/WebP (or JPEG) widths, never upscaled, with `srcset` and a `<picture>` snippet (AVIF sizes from ffprobe, else the requested width) |
| `media.video.encode` / `media.video.poster` | 2 (FFmpeg) | WebM (VP9) + MP4 (H.264, `+faststart`), no audio unless asked, `<video>` snippet; a poster frame |
| `media.job.fetch` / `media.job.cancel` | 2 | Saves a finished job's files; cancels a queued job |
| `media.image.generate`, `.edit`, `.upscale`, `.remove_background`, `.vectorize`, `media.video.generate` | 3 (paid) | fal queue API; results saved as `<folder>/<name>-N.<ext>` |
| `browser.visual_diff`, `browser.audit` | 1 (a baseline write 2) | A page against its saved picture (red = what moved), and LCP, CLS, weight and image habits ([browser-and-web.md](browser-and-web.md#design-checks-browserts)) |
| `design.contrast_matrix` | 1, read-only | WCAG 2 contrast of colour roles per theme: a stylesheet's custom properties (light `:root`; dark `prefers-color-scheme: dark`, `.dark`, `[data-theme=dark]`; `var()` followed) or given colours. A role is read by its head: `on-X` is a foreground, otherwise the last role word decides (`card-foreground` foreground, `card-border` UI boundary, `link-hover-bg` background). Foregrounds (`fg`, `text`, `foreground`…) and UI boundaries (`border`, `ring`, `focus`, 3:1) are paired with background roles (`bg`, `surface`, `canvas`…), or named pairs are checked; a foreground named for a background (`card-foreground` → `card`, `on-surface` → `surface`, `md-sys-color-on-primary` → `md-sys-color-primary`) is checked on that one only, listed first. Hex, `rgb()`, `hsl()` (in the modern syntax saturation and lightness may drop `%`; out of range is refused), `oklch()`; translucent layers painted first; AA and AAA decided on the exact ratio, the ratio shown cut (not rounded) to two decimals ([design.ts](../../packages/tools/src/packs/design.ts)) |
| `design.lint_tokens` | 1, read-only | Colours written as literals (hex, `rgb()`/`hsl()`/`oklch()`…), Tailwind default-palette classes and pixel font sizes in stylesheets, outside token/theme/variables files, `tailwind.config` and custom-property definitions (all their lines); a hex on a continuation line of a multi-line value (a wrapped `box-shadow`) counts; anchors and id selectors are not colours; never follows links; `allow` for deliberate literals. Minified files, files over 512 KB, lines over 4096 characters and folders nested deeper than 12 are not read and are listed in `output.skipped`; past 5000 files it stops and says so (`output.stoppedAtFiles`) |

**Files.** Every path is confined to the task's roots and never touches the
user's own uncommitted work (`protectedCheck`). A file's type comes from its
bytes and must match its extension; downloads are https (or loopback http),
redirects judged hop by hop and never into the Control Center, streamed to a
temporary file under a cap (25 MB image, 200 MB video) through one stream
pipeline (a write error is a tool failure, never an unhandled stream error)
and moved into place only when valid. Reading a repository file sniffs a
64 KB prefix first and applies the image or video limit by type; a video's
body is never buffered. Every SVG saved or optimised is sanitised until
nothing changes: attribute values are read with character references decoded
(`hr&#x65;f`), then scripts, event handlers, foreign objects, embedded
documents, every SMIL animation (`animate*`, `set`, `discard`), styles that
use CSS escapes, `javascript:` and external references under any namespace
prefix (`foo:href` for a renamed xlink), style imports, DOCTYPE and entity
declarations, comments, metadata and editor data are removed.

**Generation (fal).** The key is the value of a `media` credential (default
name `fal`; the input `credential` names another), read by name for that call
only ([credential-broker.md](credential-broker.md)). A submission is never
retried: one that does not answer is reported as "may still have been
accepted and billed" (no job id is known). Once fal has accepted a job, every
later failure (a dropped status or result connection, a failed write, an
artifact-store error) returns its job id with status `UNKNOWN` or
`COMPLETED` and says to poll `media.job.status` or save it with
`media.job.fetch`, never to submit again. Job ids carry fal's own status, result and cancel URLs, each
proven to be on the queue's origin before the key is sent. A result is
downloaded into the repository by its real type (a vendor's URL is never
shipped) and kept as a task artifact (`image`/`video`, up to 50 MB). Each
paid call returns a conservative cost estimate (`DEFAULT_MEDIA_PRICES`). The
default models are starting points (`fal-ai/flux/dev`, `fal-ai/flux-pro/kontext`,
`fal-ai/esrgan`, `fal-ai/bria/background/remove`, `fal-ai/recraft/vectorize`,
Kling 2.1 for video); `model` and `arguments` pass any fal endpoint and its
parameters. `arguments` go first and the validated fields after them, and a
key that sets what is billed (`num_images`, `n`, `batch_size`, `duration`,
`num_frames` and the like) is refused there: the count and `durationSec`
decide the estimate and the call. `ACC_FAL_API_BASE` may point the pack at a loopback stand-in (tests)
and nowhere else.

**FFmpeg.** Fixed argument templates, no shell; numbers and choices come from
the schema; every path is passed as `file:<absolute path>` with
`-protocol_whitelist file`, so a name can never be an option or another
protocol. A path with `%`, input or output, is refused: FFmpeg's image
reader and writer read it as a sequence pattern (`x%d` is `x1`), so the file
touched would not be the one checked; single JPEG outputs are written with
`-update 1`. Missing FFmpeg is `NOT_INSTALLED` with the install hint; it is in
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
   (default $5; Settings takes whole cents, such as 0.50), and every enabled `MEDIA` budget with policy
   `STOP_NEW_RUNS` for its day, week, month or total (Usage & Costs →
   Budgets). An estimate that cannot be computed refuses the call.
3. The check and a `reserved` row in `media_usage_events` (migration 20) are
   one transaction, so concurrent calls cannot both fit into the last dollar.
4. After the call the row is settled once: `charged` when the result carries
   the vendor's job id (every failure after fal accepted the job does) or
   succeeded, `released` when the vendor refused it before billing (invalid
   input, no key, not installed, outside the repository), and `unknown`
   otherwise (an unanswered submission may have been billed, so it stays
   counted; so does a call `ToolService.invoke`'s own timeout or stop cuts
   off, even after fal accepted it).

Amounts are estimates; the fal bill is the truth. `GET /api/usage/media`
(`usage.media` from the cloud) lists them; the Usage page shows them under
Paid media generation, refreshed after every `media.*` tool event (the ledger
publishes nothing of its own), after a settings change and every minute. From the cloud, paid generation cannot be turned on,
the task budget raised, a price estimate changed, or a media budget loosened
([remote-node.md](remote-node.md)).

## Operator setup

1. **Media generation.** Paid generation is optional; without it the Assets
   stage writes an asset brief instead. The built-in `media.*` tools need
   only a Tools → Credentials entry of kind **media** named `fal` holding the
   fal key (no environment variable), and **Settings → Media → Allow paid
   generation** turned on with a budget per task; optionally a Paid media
   generation budget (Usage & Costs → Budgets, policy "Stop new runs") for a
   daily, weekly or monthly cap. Use a dedicated fal account with a prepaid
   balance: the balance is the hard cap behind the estimates.
   - Do not route generation through an outside MCP server (fal's own, or
     Replicate's): its tools declare no cost estimate, so the spend gate
     cannot see them. A design stage (the designer role or the
     `frontend-design` profile) is refused every outside MCP tool at any level
     in `ToolService.invoke` (`designSession`,
     [tool-system.md](tool-system.md)), and does not see them listed. Other
     stages can still reach a registered server by escalation within their
     level (Level 2 by default), so do not register a paid generation server
     at all while tasks run unattended.
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

## Design memory and learning

`{{design_context}}` ([context.ts](../../apps/orchestrator/src/engine/context.ts)
`designContext`) lists the repository's design standard (`design.md`,
`DESIGN.md`, `docs/design.md`, a Tailwind config) and every file in
`design/` by path and size, and inlines `design/brief.md` (8 KB, redacted);
in a multi-repository task, each repository's by folder.
The designer keeps that memory: when the repository has a `design/` folder,
or it proposed the standard in this task, it writes the approved direction,
its design values and lasting decisions to `design/brief.md`, so the next
design task starts from them.

Review coverage knows generated media (`coverageOf` and `readManifestEntries`
in [context.ts](../../apps/orchestrator/src/engine/context.ts)). An added or
changed image or video counts as a file the diff did not show. When a changed
`manifest.json` names it (entries in an array or under `assets`/`files`, with
`path` relative to the repository or the manifest's folder), and its bytes
match the entry's SHA-256 when one is given, reviewers see its size, weight
and use and need not list it under Files reviewed. A picture no manifest
names, or whose bytes differ from the manifest, must be viewed and named like
any other unseen file. Pre-existing user files the task never touched are
never required.

The learning loop reads design friction — a visual critique failing twice,
the same axe rule in two checks, paid media near its budget — and proposes a
repository-scoped `design-system` skill after one such task, written after a
second ([learning.md](learning.md#design)). In a task whose write stages were
not all designers (Full Autopilot) only the critique's failures count, and an
axe rule must fail in two stage runs: one critique's two themes are one finding.

## Guardrails

- **Media keys are ambient credentials.** `FAL_KEY`, `REPLICATE_API_TOKEN`,
  `STABILITY_API_KEY`, `BFL_API_KEY`, `IDEOGRAM_API_KEY`, `RECRAFT_*`,
  `LEONARDO_API_KEY`, `RUNWAYML_API_SECRET`, `LUMAAI_API_KEY`, `KLING_*`,
  `MINIMAX_API_KEY`, `ELEVENLABS_API_KEY` and `HIGGSFIELD_*` are stripped
  from every agent, command, terminal and hook in every billing mode
  ([env-guard.ts](../../packages/security/src/env-guard.ts)).
- **A media key opens only for the media tools.** A `media` credential is
  returned only to `value(name, {kind: 'media'})`; a read without that kind
  (`http.request`, a secret put, an MCP server's variables) gets nothing, so a
  paid key never leaves past the spend gate
  ([credentials.ts](../../apps/orchestrator/src/tools/credentials.ts)).
- **Level 3 allows `git commit` in Claude's Bash**; the designer prompt
  forbids committing, pushing and deploying in every mode.
- **The Control Center's own UI** follows design.md: the prompt's first rule
  forbids generated hero media and decorative loops there.
- **Design value names** built on token, secret, auth or key are secret names
  to the redactor: the value after one is masked in logs and in the
  reviewer's diff unless the whole value is a colour, `var()` or a length
  (`accentToken: #3355ff` stays readable, `#Bad!Pass99` does not;
  [redact.ts](../../packages/security/src/redact.ts)). The prompt asks for
  plain names.

## Not yet

- Higgsfield, Canva, Figma remote and other OAuth-only MCP servers can now
  be registered and signed in to ([mcp.md](mcp.md#oauth)), but a paid
  generation server among them is not budget-gated (see Operator setup), so
  the design stages do not use one. Generate in your own session and attach
  the files to the task (up to 10), or use the `media.*` tools.
- Whether `claude -p` shows a local PNG to the model when the designer reads
  it has not been observed (`pnpm verify:agents --images` asks the signed-in
  CLIs); the Control Center browser's screenshots do
  reach the model (MCP image blocks, three per call).

Last verified: 2026-09-27
