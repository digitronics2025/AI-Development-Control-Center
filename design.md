# AI Development Control Center — Canonical Frontend Design Standard

**File:** `design.md`  
**Status:** Canonical / mandatory  
**Applies to:** Standalone Dashboard + VS Code WebView + all shared UI components  
**Product:** AI Development Control Center  
**Design direction:** Premium engineering control room — calm, precise, dense when useful, never visually noisy.

---

## 0. Design Contract — Read This Before Any UI Work

This file is the **single source of truth for frontend UX/UI**.

Any AI agent, developer, or designer changing the frontend must follow these rules:

1. **Do not invent a new visual language.** Use the layouts, tokens, patterns, components, and interaction rules defined here.
2. **Do not introduce new colors, spacing scales, shadows, radii, icon styles, typography, or component variants ad hoc.**
3. **Do not add a second design system or full UI kit.** Shared primitives belong in `packages/ui`.
4. **Do not redesign a screen independently.** New screens must look and behave like part of the same product.
5. **Do not trade clarity for decoration.** This is an operational control center, not a marketing site.
6. **Do not hide critical state.** Task state, current stage, blockers, approvals, provider health, and destructive actions must remain explicit.
7. **Do not use color alone to communicate status.** Always pair color with text and/or an icon.
8. **Do not make destructive or production-impacting actions visually similar to normal actions.**
9. **Do not break responsive behavior to preserve a desktop composition.** Recompose layouts at smaller widths.
10. **Do not weaken accessibility.** WCAG 2.2 AA is the minimum target.
11. **Do not create frontend-only workflow state.** The orchestrator remains the source of truth.
12. **If a genuine product requirement cannot fit this standard, update this file first**, explain the reason in the change, then implement the new pattern consistently.

When `PLAN.md` and this file overlap:
- `PLAN.md` owns **product behavior and architecture**.
- `design.md` owns **frontend presentation, interaction, layout, visual hierarchy, and UX consistency**.

---

# 1. Product Design Intent

The Control Center should feel like a modern professional development tool: fast, calm, reliable, and operationally clear.

The reference mental model is:

> **A premium engineering control room, not a collection of dashboard cards.**

The interface should help the user answer five questions within seconds:

1. What is running?
2. What stage is each task in?
3. Which agent/model is responsible?
4. Is anything blocked, failed, or waiting for me?
5. What can I safely do next?

The product must remain understandable during:
- one idle task,
- several concurrent tasks,
- a failing build,
- a provider usage limit,
- a permission approval,
- a reroute,
- a restart recovery,
- a long-running execution with large logs.

---

# 2. Core UX Principles

## 2.1 State first

The most important visual element is not the agent logo or a chart. It is the **current task state**.

Primary state hierarchy:

```text
Task status
→ current workflow stage
→ active agent/model/effort
→ progress / elapsed time
→ blocker or next transition
→ available user action
```

## 2.2 One obvious primary action

Each screen should have one clear primary action.

Examples:
- Home → **New Task**
- Draft task → **Start Task**
- Paused task → **Resume**
- Waiting approval → **Review Approval**
- Failed stage → **Retry Stage**
- Settings with unsaved edits → **Save Changes**

Secondary actions remain visually quieter.

## 2.3 Progressive disclosure

Keep default screens simple.

Advanced controls such as:
- per-stage model overrides,
- timeout,
- retry policy,
- permissions,
- environment details,
- developer logs,
- raw event payloads,

must be available without dominating the default view.

Use:
- expandable sections,
- inspector panels,
- tabs,
- popovers,
- drawers.

Do not bury critical blockers or approvals under “Advanced”.

## 2.4 Preserve context

The user should not lose orientation when moving between:
- task list,
- task detail,
- logs,
- Git diff,
- artifacts,
- settings.

Use:
- persistent global navigation,
- stable breadcrumbs,
- task header,
- predictable tab order,
- back navigation that returns to the prior context.

## 2.5 Safety is part of UX

Risk must be visible before action.

Permission Levels 1–5 must have clear labels and descriptions. Production-impacting actions must use a dedicated approval pattern, never a generic confirmation toast.

## 2.6 High information density, low visual noise

Use whitespace strategically, not excessively.

Avoid:
- giant cards,
- oversized headings,
- large empty hero areas,
- decorative charts,
- glowing gradients,
- glassmorphism,
- unnecessary animation,
- “AI magic” decoration.

## 2.7 Realtime without instability

Realtime updates must not cause:
- layout jumps,
- tabs to reset,
- scroll position loss,
- focus loss,
- log snapping when the user is reading older content.

---

# 3. Information Architecture

Primary navigation:

```text
Home
Tasks
Workflows
Agents
Tools
Repositories
Source Control
Approvals
Settings
```

Do not add more top-level navigation unless the product gains a genuinely separate domain.
Source Control is one: repository Git state (staged, unstaged, history, sync) is
not task state, and it must stay reachable while no task exists (§7.9).
Tools is another: what this machine can do (installed programs, their health,
background processes, terminals, MCP servers, credentials and the execution
policy) exists independently of any task (§7.10).

Secondary content belongs inside the relevant section.

## 3.1 Global shell

Desktop shell:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Sidebar │ Top Bar: Breadcrumb / Search / Service / New Task / User actions │
├─────────┼────────────────────────────────────────────────────────────────────┤
│         │                                                                    │
│ Nav     │ Main content                                                       │
│         │                                                                    │
│         │                                                    Context panel   │
│         │                                                    when required   │
└─────────┴────────────────────────────────────────────────────────────────────┘
```

### Sidebar

Expanded width: **240px**  
Collapsed width: **72px**

Order:
1. Product mark + product name
2. Home
3. Tasks
4. Workflows
5. Agents
6. Tools
7. Repositories
8. Source Control
9. Approvals
10. flexible spacer
11. Settings
12. local service status

Rules:
- one icon family only,
- 20px icons,
- active item uses accent-tinted surface + stronger text,
- no pill-shaped floating navigation,
- no unnecessary section dividers,
- collapsed state must retain tooltips and accessible labels.

### Top bar

Height: **56px**

Contains:
- breadcrumb / page title,
- optional repository or task context,
- global search / command palette trigger,
- orchestrator connection indicator,
- **New Task** primary button.

Do not put task-specific destructive controls in the global top bar.

---

# 4. Visual Language

## 4.1 Theme

Default application theme: **Dark**.

Also support:
- Light
- System

The standalone dashboard may default to Dark for first launch.

The VS Code WebView must respect the VS Code theme while preserving the same semantic hierarchy.

## 4.2 Color tokens

All components must consume semantic CSS variables. Never hard-code application colors inside feature components.

### Dark theme

```css
:root[data-theme="dark"] {
  --bg-canvas: #090B0F;
  --bg-surface: #0F1319;
  --bg-elevated: #151A22;
  --bg-muted: #1B222C;

  --border-subtle: #232B36;
  --border-strong: #344050;

  --text-primary: #F4F7FB;
  --text-secondary: #A7B0BE;
  --text-tertiary: #758092;
  --text-inverse: #081018;

  --accent: #6EA8FE;
  --accent-hover: #8AB8FF;
  --accent-muted: rgba(110, 168, 254, 0.14);

  --success: #41D3A2;
  --success-muted: rgba(65, 211, 162, 0.14);

  --warning: #F6C85F;
  --warning-muted: rgba(246, 200, 95, 0.14);

  --danger: #FF6B6B;
  --danger-muted: rgba(255, 107, 107, 0.14);

  --info: #70B7FF;
  --info-muted: rgba(112, 183, 255, 0.14);

  --focus-ring: #8AB8FF;
}
```

### Light theme

```css
:root[data-theme="light"] {
  --bg-canvas: #F5F7FA;
  --bg-surface: #FFFFFF;
  --bg-elevated: #F9FAFB;
  --bg-muted: #EEF2F6;

  --border-subtle: #DDE3EA;
  --border-strong: #B8C2CF;

  --text-primary: #111827;
  --text-secondary: #4B5563;
  --text-tertiary: #6B7280;
  --text-inverse: #FFFFFF;

  --accent: #2563EB;
  --accent-hover: #1D4ED8;
  --accent-muted: rgba(37, 99, 235, 0.10);

  --success: #14805E;
  --success-muted: rgba(20, 128, 94, 0.10);

  --warning: #9A6700;
  --warning-muted: rgba(154, 103, 0, 0.10);

  --danger: #C83A3A;
  --danger-muted: rgba(200, 58, 58, 0.10);

  --info: #1D70B8;
  --info-muted: rgba(29, 112, 184, 0.10);

  --focus-ring: #2563EB;
}
```

### Status mapping

- Running → accent/info + activity icon
- Completed → success + check icon
- Paused → warning + pause icon
- Waiting for user → warning + person/attention icon
- Waiting for usage reset → warning + clock icon
- Failed → danger + error icon
- Cancelled → tertiary + stop icon
- Interrupted → warning + disconnected icon
- Draft → tertiary + draft icon
- Queued → info + queue icon

Never use provider-specific brand colors as major UI surfaces.

### Contrast rules (measured against the tokens above)

The token values were measured against WCAG 2.2 AA (4.5:1 for body and small text, 3:1 for icons and large text). They pass on `bg-canvas` and `bg-surface`; two combinations do not, so they are not allowed:

- **Tertiary text only on `bg-canvas` or `bg-surface`.** On `bg-elevated` and `bg-muted` it measures 4.0–4.4:1; use `text-secondary` there (hovered rows, cards on elevated panels, chips).
- **Semantic colors carry status through the icon and the tint, not the label text.** In the light theme, semantic text on its own `*-muted` tint measures 4.3–4.5:1. Status chips therefore render the icon in the semantic color, the background in the `*-muted` tint, and the label in `text-primary`. Semantic-colored *text* is allowed only on `bg-canvas`/`bg-surface` (≥4.5:1 in both themes).
- Primary buttons use `text-inverse` on `accent` (7.9:1 dark, 5.2:1 light).
- **`accent` is a fill color, not a text color.** In the VS Code mapping it becomes the editor's button background, which is not guaranteed to be readable as text on the sidebar (VS Code Dark Modern: 3.9:1). Text stays in `text-primary`/`text-secondary`; links are distinguished by underline.

## 4.3 Typography

Use the operating-system font stack. Do not depend on a remote font.

```css
--font-sans:
  "Segoe UI Variable",
  "Segoe UI",
  Inter,
  ui-sans-serif,
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  sans-serif;

--font-mono:
  "Cascadia Code",
  "Cascadia Mono",
  "SFMono-Regular",
  Consolas,
  "Liberation Mono",
  monospace;
```

Scale:

| Token | Size | Line height | Weight | Use |
|---|---:|---:|---:|---|
| Display | 28px | 36px | 650 | rare top-level page heading |
| H1 | 24px | 32px | 650 | page title |
| H2 | 20px | 28px | 650 | section title |
| H3 | 16px | 24px | 600 | card/panel title |
| Body | 14px | 20px | 400 | default UI |
| Body strong | 14px | 20px | 600 | emphasis |
| Small | 12px | 18px | 400/600 | metadata |
| Code | 13px | 20px | 400 | logs/code/diff |

Rules:
- Do not use all caps for normal headings.
- All caps is allowed only for very short technical labels where scanability improves.
- Avoid text below 12px.
- Use tabular numerals for durations, counts, and timestamps where practical.

## 4.4 Spacing

Use this spacing scale only:

```text
2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64
```

Default content gap: 16px  
Default section gap: 24px  
Default page horizontal padding:
- desktop: 24px
- wide desktop: 32px
- tablet: 20px
- mobile: 16px

## 4.5 Radius

```text
4px  = small status chips / compact controls
6px  = inputs / buttons
8px  = cards / panels
12px = drawers / modal surfaces
```

Avoid excessive rounded “bubble” UI.

## 4.6 Borders and elevation

Primary separation method: **1px borders + surface contrast**.

Shadows are intentionally restrained.

```css
--shadow-float: 0 8px 28px rgba(0, 0, 0, 0.24);
--shadow-modal: 0 18px 60px rgba(0, 0, 0, 0.36);
```

Normal cards should not look like floating marketing cards.

## 4.7 Icons

Use **Lucide** as the single application icon family.

Rules:
- 16px in dense controls,
- 18–20px in navigation and buttons,
- 24px for empty-state/supporting visuals,
- consistent stroke width,
- no mixed emoji/icon libraries,
- do not use icons without accessible text when meaning is not obvious.

---

# 5. Layout System

## 5.1 Content width

Operational screens should use available space.

Do not force the whole application into a narrow marketing-style max-width container.

Recommended:
- default max readable content width for forms: **760px**
- settings content: **900px**
- dashboard/task operational views: fluid
- logs/diffs: fluid full width

## 5.2 Panels

Use three panel types:

1. **Surface panel** — normal grouped content.
2. **Inspector panel** — contextual controls/details on the right.
3. **Danger panel** — explicit high-risk action block using danger semantics.

Do not make every group a card.

## 5.3 Tables

Tables are appropriate for:
- tasks,
- agents,
- repositories,
- model registries,
- execution history,
- approvals.

Table requirements:
- sticky header for long lists,
- 44px minimum row height,
- row hover,
- keyboard focus,
- sort indicator,
- no hidden horizontal action menu for the most important action,
- responsive conversion to stacked rows/cards when a table becomes unreadable.

---

# 6. Responsive Strategy

Design desktop-first because the primary target is Windows + VS Code, but every core workflow must remain usable at narrow widths.

Breakpoints:

```text
>= 1440px  Wide desktop
1200–1439  Desktop
900–1199   Compact desktop / large tablet
600–899    Tablet / narrow VS Code
< 600px    Mobile / very narrow WebView
```

## Wide desktop

- sidebar: 240px
- optional inspector: 340–380px
- main content remains fluid

## Compact desktop

- sidebar may collapse to 72px
- right inspector becomes overlay drawer when space is insufficient
- task timeline remains visible

## Tablet / narrow VS Code

- navigation becomes compact rail or top-triggered drawer
- multi-column cards become one/two columns
- detail inspector becomes a drawer
- dense tables convert to stacked rows where required

## Mobile / very narrow WebView

Use a single-column composition.

Rules:
- no forced desktop tables,
- no horizontal page scrolling,
- primary actions remain reachable,
- task controls may use a sticky bottom action area,
- tabs may become horizontally scrollable only when necessary,
- long logs retain internal horizontal scrolling rather than breaking the page.

---

# 7. Page Blueprints

# 7.1 Home

Purpose: answer “What needs my attention now?”

Structure:

```text
Page title: Home                         [New Task]

Attention strip
- approvals waiting
- blocked tasks
- provider disconnected
(show only when relevant)

Active Tasks
- task title
- repository
- stage progress
- current stage
- agent/model
- elapsed
- status
- primary contextual action

Recent Tasks
- compact table/list

System Health
- Orchestrator
- Codex
- Claude Code
- Git / local execution readiness
```

Do not start with vanity metrics.

Allowed compact summary metrics:
- Active
- Waiting for me
- Failed
- Completed today

These are secondary, not the hero.

## Active task row

Each row must expose:
- task ID,
- task title,
- repository,
- status,
- current stage,
- active agent,
- elapsed time,
- last meaningful event.

Use a small workflow progress rail, not a decorative percentage donut.

---

# 7.2 New Task

The task creation UX must be fast for normal use and powerful when needed.

Default form order:

1. Repository
2. Task description
3. Workflow profile
4. Mode: Discuss First / Autopilot
5. Attachments
6. Start action

Advanced section collapsed by default:
- role overrides,
- agent,
- model,
- effort,
- permissions,
- retry policy,
- stage-specific options.

Layout:

```text
New Task

Repository        [ selector ]
Description       [ large textarea ]

Workflow          [ Normal Development v ]
Mode              [ Discuss First | Autopilot ]

Attachments       [ Add files ]

Advanced options  [ collapsed ]

                           [Save Draft] [Start Task]
```

### Workflow profile selection

Do not show profile names alone. Include one-line intent:

- Quick Change — small, low-risk edit
- Normal Development — standard implementation workflow
- Deep Investigation — difficult bug or uncertain cause
- Architecture — structural change
- Full Autopilot — full implementation/review/verification loop

### Mode control

Use a segmented control.

When mode changes, show concise helper text explaining what will happen before implementation.

No alarmist copy.

---

# 7.3 Task Detail — Primary Product Screen

This is the most important screen in the product.

## Header

Always show:
- task ID,
- task title,
- repository,
- status,
- workflow,
- mode,
- created/elapsed timestamps as appropriate.

Primary contextual action sits on the right.

Examples:
- Running → Pause
- Paused → Resume
- Waiting approval → Review Approval
- Failed → Retry Stage
- Completed → Open Report

Secondary controls use an overflow menu only when they are truly secondary.

## Stage timeline

Use a horizontal stepper on wide screens and a compact vertical list on narrow screens.

Each stage displays:
- stage name,
- state icon,
- assigned agent,
- duration when complete,
- active state when running.

Example:

```text
✓ Investigate ─ ✓ Plan ─ ● Implement ─ ○ Test ─ ○ Review ─ ○ Verify
  Codex          Codex       Claude
  1m 42s         56s         3m 18s
```

Rules:
- completed stages are visually quieter,
- current stage is strongest,
- future stages remain visible but subdued,
- failed stage shows reason without requiring a separate log search.

## Main task tabs

Order:

1. Overview
2. Activity
3. Changes
4. Tests
5. Artifacts
6. Logs
7. Execution

Keep this order consistent.

### Overview

Contains:
- current stage summary,
- latest meaningful event,
- stage output summary,
- blockers,
- directives,
- review state,
- final report when complete.

### Activity

Human-readable event timeline.

Default activity should read like:

```text
20:14  Codex started investigation
20:16  Investigation completed
20:16  Plan artifact created
20:17  Claude started implementation
20:19  Build failed
20:19  Fix cycle 1 started
20:21  Build passed
```

Raw events belong in Developer view.

### Changes

Use:
- changed file tree/list,
- additions/deletions,
- Git diff viewer,
- baseline branch and task branch,
- pre-existing-change warning when relevant.

Do not collapse all Git information into a generic “changed 8 files” badge.

### Tests

Show each command as a run item:

```text
✓ lint          8.2s
✓ typecheck     4.1s
✕ unit tests   12.7s   2 failed
○ build         not run
```

Selecting a row reveals output.

### Artifacts

Artifact rows:
- name,
- type,
- source stage,
- created time,
- preview/open/download action where applicable.

Primary artifact types:
- investigation,
- plan,
- implementation report,
- review,
- verification,
- final report.

### Logs

Default mode: **Simple**.

Toggle:
- Simple
- Developer

Developer mode:
- monospace,
- stdout/stderr distinction,
- timestamp,
- execution ID,
- command,
- exit code,
- copy action,
- filter/search.

Do not use terminal green-on-black styling for the entire screen.

### Execution

Answers "what did the Control Center actually run for this task?" — tool calls,
background processes, automatic repairs, capability escalations, checkpoints
and verification evidence. It is a record, not a control surface, with three
exceptions: **Stop** on a running background process, **Create checkpoint**,
and **Roll back** (danger styling, confirmation dialog that names the
checkpoint and says your own pre-existing work is left untouched).

```text
Policy: Autopilot · Worktree: worktrees/app/TASK-0012             [Open terminal]
Background processes   app under test  :5199  Healthy   [Stop]
Automatic repairs      Missing dependency → install (succeeded)
Tool calls             09:44 browser.check_page  Playwright  ✓ 2 widths clean
                       09:45 fs.delete           refused: needs approval (L5)
Checkpoints            3 · Before Implement                    [Roll back]
```

- Tool calls are a dense list, newest first: time, capability (monospace),
  provider, decision/status chip (icon + text), one-line summary. Refused and
  escalated calls stay visible — they are the audit trail.
- Screenshots from verification open in the Artifacts tab; the row links there.
- Below 900px each section stacks; the tool-call list becomes rows of
  capability + chip over the summary.

### Terminal drawer

"Open terminal" opens a right drawer (wide: min(960px, 100vw)) with an xterm
terminal in the task's working directory (its worktree when isolated). The
drawer header names the shell and folder, and says plainly that commands typed
here run as you. Closing the drawer closes the terminal. Terminal text uses the
code font and the log surface tokens; the cursor and selection use `--accent`.

## Task inspector

Wide desktop may show a persistent right inspector.

Order:
1. Current stage
2. Agent / model / effort
3. Stage controls
4. Directives
5. Permissions
6. Execution metadata

Controls:
- Pause / Resume
- Retry stage
- Reroute
- Add directive
- Change future stage assignment
- Cancel task

Cancel remains separated from normal controls.

## 7.3.1 Chairman drawer

The Chairman (the task's supervisor, see `docs/systems/chairman.md`) is reached
from a **Chairman** button in the task header, beside the primary action:

```text
[ Pause ] [ Chairman ● ] [ Details ] [ ⋯ ]
```

- The dot is decorative; the button's accessible name carries the state
  ("Chairman — Supervising"). While the Chairman evaluates or answers, the dot
  becomes the activity indicator (§10). Mobile shows the icon only.
- It opens the standard right **Drawer** (§8.8), 460px on desktop, full height
  and full width on mobile. It is contextual, never a modal decision.
- Drawer order: state chips (Chairman status, health) → recovery cycle and
  usage against limits → "rules only" info banner when no reasoning model is
  available → current strategy → active directives (each removable) →
  conversation (`role="log"`, polite live region) → composer in the footer.
- Conversation items: user messages (right-aligned, muted background),
  Chairman replies (Markdown, no raw HTML), **decision cards** (accent left
  border, trigger, "Rules"/"Model" badge, why and expected result) and
  **action cards** (action label + status chip: Running, Completed, Failed,
  Rejected — with the result or the reason).
- The composer has a visible label, Enter sends, Shift+Enter adds a line, and
  the helper lists the slash shortcuts. Sending is disabled while offline.
- The list follows new messages only while the reader is at the bottom (§9.3).
- Chairman interventions (decisions, recovery cycles, redirects, rollbacks,
  watchdog) appear in Activity with an accent or warning dot; checkpoints are
  technical events.
- Blockers set by the Chairman use the existing banner: "The Chairman needs
  you" (hard blocker) and "Paused at a limit", each with **Open Chairman**.

---

# 7.4 Approvals

Approvals deserve a dedicated top-level destination because they can stop autopilot.

Approval card must show:
- task,
- stage,
- requesting agent,
- requested action,
- permission level,
- why approval is needed,
- exact command/action when safe to display,
- affected repository/environment,
- risk explanation.

Action hierarchy:

```text
[Approve once]  [Deny]
```

For production or destructive actions, require a stronger confirmation step.

Never use ambiguous buttons such as:
- OK
- Continue
- Yes

Use explicit labels:
- Approve staging deploy
- Approve production migration
- Deny request

---

# 7.5 Workflows

V1 must **not** use a complex node editor.

Use a structured stage sequence editor.

Layout:

```text
Workflow: Normal Development        [Duplicate] [Save]

Stages
1. Investigate   Codex        Medium     Analyze
2. Plan          Codex        High       Analyze
3. Implement     Claude Code  High       Develop
4. Test          System       —          Develop
5. Review        Codex        High       Analyze
6. Fix           Claude Code  High       Develop
7. Verify        Codex        Medium     Analyze
```

Selecting a stage opens an inspector with:
- role,
- agent,
- model,
- effort,
- timeout,
- retry policy,
- permission level,
- approval requirement,
- next transition.

Drag reorder is allowed only if workflow semantics remain valid.

Validation errors must appear inline and block invalid save.

---

# 7.6 Agents

Use a compact operational list.

Each agent row/card shows:
- agent name,
- connection state,
- auth/session state,
- executable detected,
- available capabilities,
- models available,
- last health check.

Example:

```text
Codex
Connected
CLI detected · Subscription session available
Models: 3
Capabilities: Read · Write · Commands · Model selection

Claude Code
Connected
CLI detected · Subscription session available
Models: 2
Capabilities: Read · Write · Commands
```

Avoid giant provider logos.

Provider logos may appear as 20–24px supporting identifiers only.

---

# 7.7 Repositories

Repository list shows:
- name,
- local path,
- current branch,
- Git cleanliness,
- detected tooling,
- default workflow,
- last task,
- availability,
- remote position: up to date, commits to download, commits to upload,
  diverged, no upstream, unreachable, or remote deleted — always as text with
  an icon; unreachable and remote deleted carry the reason on hover.

Above the list, one quiet line states repository automation: whether new
repositories are found and downloads run automatically, when it last checked,
and what the last check changed. **Check now** is a secondary action beside
**Add repository** (which stays primary). Automatic sync only ever downloads;
the page never implies uploads happen on their own.

Repository detail:
- defaults,
- commands,
- permissions,
- Git behavior,
- task history.

A dirty working tree must be clearly visible.

---

# 7.8 Settings

Use a stable left sub-navigation within Settings:

```text
General
Appearance
Agents & Models
Chairman
Repositories
Workflows
Permissions
Billing
Notifications
Advanced
```

Repositories holds repository automation: finding new repositories (search
folders, depth, repositories never added automatically) and background sync
(on/off, interval). The sync switch states plainly that it downloads only.

Billing must clearly show:

```text
Billing Mode
● Subscription Only
○ Explicit API Mode
```

Subscription Only is visually marked as the safe default.

Do not use fear-based warning styling for the normal safe mode.

If Explicit API Mode is enabled later, show a concise persistent indicator.

---

# 7.9 Source Control

Purpose: answer, for one repository, "what changed, what will be committed,
what happened in history, and is it safely in sync?" It is repository Git
state, not a task view — task attribution appears only as a secondary badge.

## Header

```text
Source Control                                   [Repository ▾] [Refresh]
main @ 15fd24a · origin/main · ↑2 ↓0 Ahead · 24 changes · fetched 3m ago
                                        [Fetch] [Publish branch | Sync…]
```

- Branch, short HEAD, upstream and relation always visible; Detached HEAD,
  No upstream, Diverged and Upstream gone are named states, never implied.
- A task editing the repository shows a persistent warning banner with
  **Open task** and **Pause task**; Git actions are disabled with the reason.
- Merge/rebase in progress, index lock, conflicts and errors are persistent
  banners, never toasts (§8.6).

## Tabs

Exactly two: **Changes** and **History**. No PR, stash, branch or deploy tabs.

## Changes

```text
┌──────────────────────┬──────────────────────────────────────┐
│ Conflicts (0)        │ path/to/file.ts      [Staged|Unstaged]│
│ Staged (3)  [Unstage all]                                    │
│ ☐ M routes.ts  −     │ diff viewer (lazy, per file)          │
│ Changes (7) [Stage all]                                      │
│ ☐ ?? new.ts    +     │ [Open file] [Open diff in editor]     │
├──────────────────────┴──────────────────────────────────────┤
│ Commit message [..........................................] │
│ [Suggest message] [Review staged]           [Commit 3 files] │
└──────────────────────────────────────────────────────────────┘
```

- Rows show the status letter with its name for screen readers, the path,
  line counts, and badges: attribution (Task change / Your change / Mixed —
  Mixed uses the warning border) and Sensitive (danger icon + text).
- Per-row Stage/Unstage are compact icon buttons with accessible names;
  checkboxes enable "Stage selected" / "Unstage selected".
- **Commit** is the page's one primary action. Suggest message is ghost;
  Review staged is secondary.
- Stage All that includes Mixed files opens a dialog listing them exactly.
- Commit failures (hook output, secret findings) are a persistent danger
  banner listing each file and reason. Success is a toast with the short SHA.
- Below the composer, "Recent Git operations" (collapsed) is the audit trail.
- Below 900px the list, diff and composer stack in one column.

## History

- Rows: graph lane cell (SVG, token colours, decorative — `aria-hidden`),
  subject, ref badges, short SHA, author, relative time, and a TASK badge only
  when the orchestrator recorded the commit.
- "Load more" pages; selecting a commit opens a drawer with its files and a
  per-file diff.

## Sync

Sync opens a dialog that states the plan before anything runs — e.g.
"Fetch origin, then push 2 commits to origin/main" — with an explicit
**Sync now** label. Its result is shown inline: pushed, fast-forwarded, up to
date, or stopped (diverged / uncommitted changes) with the reason. Publish
branch is its own dialog with the remote named. There is no force option.

---

# 7.10 Tools

Purpose: answer "what can the Control Center do on this machine right now, and
what is it allowed to do on its own?"

## Header

```text
Tools                                              [Check all]
28 of 34 ready · 2 need sign-in · 4 not installed · policy: Autopilot
```

## Tabs

Overview · Processes · Terminals · MCP servers · Credentials · Policy.

## Overview

A table (stacked below 900px): name, category, status chip (Ready / Not
installed / Sign-in required / Error / Not checked — icon + text), version,
path (monospace, truncated with a tooltip), capabilities count, last checked.
Row actions: **Check** (secondary) and, for tools with accounts, **Check
sign-in**. "Not installed" never uses danger styling: a missing optional tool
is information, not a fault. A row expands to list its capabilities with
their permission badges.

## Processes / Terminals

Processes: every background process the Control Center started, with task,
port, status and **Stop**. Terminals: running terminals with task/repository
and **Open**; **New terminal** asks for a repository.

## MCP servers

A list with health chip, transport, tool count and **Check**; **Add server**
opens a dialog (name, stdio command + arguments or HTTP URL, permission level,
environment variables mapped to stored credentials — never raw values).

## Credentials

Names, kind, environment variable, scope and fingerprint only. Values are
write-only: the add/replace dialog uses a password field and the value is
never shown again. Delete uses a confirmation dialog.

## Policy

The execution policy as a segmented control — **Safe · Autopilot · Full
Autopilot+** — each option with its one-sentence description; Autopilot is
marked as the recommended default. Below it: switches for giving agents the
tools, terminals, automatic repairs and environment discovery. Level 5 and
destructive actions always ask; the page says so and offers no switch for it.

---

# 8. Component Standards

## 8.1 Buttons

Variants:
- Primary
- Secondary
- Ghost
- Destructive

Sizes:
- Compact: 30px
- Default: 36px
- Touch/mobile: minimum 44px target

Primary buttons use accent background.

Destructive buttons use danger styling only for destructive actions.

Never create multiple competing primary buttons in one local action group.

## 8.2 Inputs

Height: 36px desktop default.

Requirements:
- visible label,
- optional helper text,
- inline validation,
- disabled state,
- focus ring,
- no placeholder-only labels.

Textarea task description starts at approximately 140px height.

## 8.3 Select / Combobox

Use searchable combobox for:
- repositories,
- models,
- large agent/model lists.

Use simple select for very short fixed choices.

## 8.4 Segmented control

Use for mutually exclusive short modes:
- Discuss First / Autopilot
- Simple / Developer logs
- Light / Dark / System when presented inline

## 8.5 Status chip

Compact, semantic, never decorative.

Format:

```text
[icon] Running
[icon] Failed
[icon] Waiting for user
```

## 8.6 Toasts

Toasts confirm transient outcomes:
- saved,
- copied,
- directive queued,
- retry requested.

Do not use toast-only feedback for:
- failures requiring action,
- approval requests,
- disconnected orchestrator,
- destructive failures.

Those need persistent inline UI.

## 8.7 Dialogs

Use modal dialogs only when the user must stop and decide.

Good:
- cancel running task,
- approve destructive command,
- confirm production action.

Bad:
- viewing details,
- editing routine metadata,
- logs,
- artifacts.

Use drawers/inspectors for non-blocking detail.

## 8.8 Drawers

Use right-side drawer for contextual information at reduced widths.

Typical width:
- desktop: 360–420px
- mobile: full width

## 8.9 Tooltips

Tooltips explain:
- compact icon buttons,
- collapsed navigation,
- uncommon technical labels.

Do not place critical instructions only in a tooltip.

## 8.10 Empty states

Use compact text + one clear next action.

Example:

```text
No tasks yet
Create your first task to start an AI development workflow.
[New Task]
```

No giant illustration is required.

---

# 9. Realtime and Loading States

## 9.1 Initial loading

Use skeletons matching the final layout.

Avoid full-screen spinners except during the first app bootstrap when no shell can render.

## 9.2 Realtime updates

When a stage changes:
- update status in place,
- use a restrained 120–180ms transition,
- avoid re-mounting the page.

## 9.3 Logs

If the user is at the bottom, new lines may auto-follow.

If the user scrolls up:
- stop auto-follow,
- show “New output” control,
- never force scroll to bottom.

## 9.4 Connection loss

Show a persistent banner:

```text
Orchestrator disconnected. Showing last known state.   [Reconnect]
```

Disable actions that cannot safely be queued.

Do not pretend an action succeeded while disconnected.

## 9.5 Optimistic updates

Optimistic UI is allowed only for low-risk reversible changes.

Do not optimistically mark:
- deploy approved,
- task cancelled,
- task completed,
- stage passed,
- Git push succeeded.

Wait for orchestrator confirmation.

---

# 10. Motion

Motion is functional, not decorative.

Durations:
- hover/focus: 100–140ms
- panel/dialog: 160–220ms
- status transition: 120–180ms

Easing:
- standard ease-out for entering,
- standard ease-in for leaving.

Respect `prefers-reduced-motion`.

Do not use:
- bouncing,
- pulsing large surfaces,
- looping decorative animations,
- animated gradients,
- layout-shifting status transitions.

A subtle activity indicator is allowed for an actively running stage.

---

# 11. Accessibility Standard

Minimum target: **WCAG 2.2 AA**.

Mandatory:

- full keyboard navigation,
- visible focus state,
- correct semantic HTML,
- accessible names for icon buttons,
- form labels associated with controls,
- live region for meaningful task status changes,
- no color-only state communication,
- contrast-compliant text and controls,
- logical tab order,
- Escape closes dismissible overlays,
- focus returns to trigger after dialog/drawer close,
- error messages linked to fields,
- reduced motion support,
- touch targets at least 44px on touch layouts.

Keyboard expectations:

```text
Ctrl/Cmd + K      Command palette
Ctrl/Cmd + Enter  Primary submit in task composer when safe
Esc               Close transient overlay
Arrow keys        Navigate menus/tabs where standard
Enter/Space       Activate focused control
```

Do not override browser/OS shortcuts unnecessarily.

---

# 12. Content and Microcopy

Tone:
- direct,
- technical when useful,
- calm,
- specific,
- non-theatrical.

Prefer:

```text
Build failed
2 unit tests failed. Open test output for details.
```

Avoid:

```text
Oops! Something went wrong with your AI magic.
```

Prefer explicit action labels:

```text
Retry stage
Reroute to Codex
Approve once
Open Git diff
Add directive
```

Avoid ambiguous labels:

```text
Go
OK
Fix it
Do thing
```

Timestamps:
- recent: relative + tooltip absolute,
- older/history: clear local date/time,
- logs: precise timestamp.

---

# 13. VS Code WebView Rules

The VS Code extension is a thin client of the same product.

It must use shared components from `packages/ui` where practical.

The WebView must preserve:
- information hierarchy,
- component behavior,
- status semantics,
- iconography,
- spacing rhythm,
- task workflow terminology.

Adaptation rules:
- map semantic color tokens to VS Code theme variables where possible,
- do not force the standalone dark palette over the editor theme,
- use compact navigation,
- prefer a single-column composition in narrow panels,
- use drawers/accordion sections instead of shrinking controls beyond usability,
- maintain parity for core task actions.

Core actions that must remain available in VS Code:
- New Task
- Pause / Resume
- Cancel
- Add directive
- Retry stage
- Reroute
- Open logs
- Open artifacts
- Open diff

---

# 14. Frontend Implementation Rules

Target stack from `PLAN.md`:
- React
- Vite
- Tailwind CSS
- TypeScript

## Shared UI

Create/maintain:

```text
packages/ui/
  components/
  primitives/
  tokens/
  hooks/
  styles/
```

Feature applications consume shared primitives instead of copying markup/styles.

## Allowed supporting libraries

Preferred:
- **Lucide React** — icons
- **Radix UI primitives** — accessible behavior for complex primitives where native HTML is insufficient
- **TanStack Table** — only where tables need sorting/filtering/large-data behavior
- **React Hook Form + Zod** — complex forms when justified
- **xterm.js (`@xterm/xterm`, `@xterm/addon-fit`)** — the terminal drawer only (§7.3); it is the terminal VS Code itself uses, themed from the tokens

Do not add a heavyweight competing component framework such as Material UI, Ant Design, or another full design system unless this document is deliberately replaced.

## Styling rules

- define semantic CSS variables centrally,
- expose variables through Tailwind theme mapping,
- feature components use semantic tokens,
- avoid arbitrary color literals,
- avoid repeated one-off `style={{}}` rules,
- use shared variants for button/input/status components,
- use class composition helper consistently.

## Data/state rules

- orchestrator state is authoritative,
- frontend store may cache and derive presentation state,
- do not model a second workflow engine in React,
- reconnect must reconcile with server state,
- use stable IDs for tasks/stages/executions.

---

# 15. Command Palette

Provide `Ctrl/Cmd + K`.

Initial commands:
- New Task
- Open Task
- Open Repository
- Go to Agents
- Go to Workflows
- Go to Approvals
- Pause current task
- Resume current task
- Add directive
- Open Settings

Commands must be filtered by context and permission.

Do not expose destructive actions in a way that bypasses confirmation.

---

# 16. Critical Edge Cases

The UI must explicitly support these states.

## Provider unavailable

Show:
- affected agent,
- reason,
- last health result,
- action to re-check.

## Usage limit

Show:
- stage paused,
- `WAITING_FOR_USAGE_RESET`,
- no paid API fallback,
- resume/retry once availability returns.

## Dirty repository

Before implementation:
- identify pre-existing changes,
- show persistent warning,
- distinguish task-created changes from pre-existing work.

## Restart recovery

After restart:
- mark interrupted execution clearly,
- explain last known stage,
- offer Resume / Retry based on backend capability.

## Failed test with successful implementation process

Task must still look incomplete.

Do not visually imply success until verification criteria pass.

## Reroute

Show history:

```text
Implementer rerouted
Claude Code → Codex
Reason: user action
```

## Directive queued during active execution

Show:
- directive text,
- timestamp,
- state: queued / applied,
- safe-boundary behavior.

---

# 17. Design Anti-Patterns — Forbidden

Do not implement:

- neon “cyberpunk AI” dashboard styling,
- heavy gradients as primary surfaces,
- glassmorphism everywhere,
- giant KPI cards,
- rounded pills for every container,
- provider-logo-driven navigation,
- emoji as primary product icons,
- separate visual styles for each page,
- destructive actions next to primary actions without separation,
- “success” solely because an agent said it completed,
- auto-scrolling logs while user reads history,
- hidden approval state,
- dense forms with all advanced options expanded,
- node-graph workflow editor in V1,
- modal dialogs for routine detail viewing,
- horizontal page overflow,
- tiny 10–11px UI text,
- low-contrast gray-on-gray text,
- status conveyed by color alone,
- duplicate frontend task state independent of orchestrator,
- ad hoc component variants created in feature folders.

---

# 18. Screen-Level Acceptance Criteria

## Home

Pass when:
- current operational state is understandable within seconds,
- blocked/waiting items are obvious,
- new task action is clear,
- provider/service problems are visible without dominating healthy state.

## New Task

Pass when:
- a normal task can be started without opening Advanced,
- workflow and mode are understandable,
- advanced overrides remain available,
- validation is clear and keyboard-friendly.

## Task Detail

Pass when:
- current stage is immediately obvious,
- agent/model/effort are visible,
- the user can find logs, tests, diff, and artifacts without hunting,
- pause/resume/retry/reroute are contextually available,
- failed or waiting states show a concrete next action.

## Settings

Pass when:
- safe subscription-only mode is obvious,
- defaults vs repository/task overrides are distinguishable,
- risky configuration requires explicit action.

## Responsive

Pass when:
- every core flow works at 390px width,
- no page-level horizontal scroll exists,
- desktop space is used effectively at 1440px+,
- VS Code narrow view remains usable.

---

# 19. Visual QA Matrix

Every significant frontend change must be checked at minimum at:

```text
1440 × 900   desktop
1280 × 800   compact desktop
1024 × 768   narrow desktop/tablet
768 × 900    narrow panel
390 × 844    mobile/narrow WebView
```

Test both:
- Dark
- Light

And relevant states:
- loading,
- empty,
- populated,
- running,
- paused,
- waiting approval,
- failed,
- completed,
- disconnected.

Use Playwright screenshot tests for stable core surfaces once implemented.

Do not approve a screen only from one happy-path desktop screenshot.

---

# 20. Accessibility and Behavior QA

Before frontend work is considered complete:

- keyboard-only flow tested,
- visible focus verified,
- labels verified,
- dialog focus trap verified,
- drawer focus return verified,
- screen-reader names checked for icon-only controls,
- contrast checked,
- reduced motion checked,
- no uncaught overflow,
- no focus loss during realtime updates,
- no scroll jumps during log updates,
- no duplicate primary actions,
- no ambiguous destructive controls.

Automated accessibility checks are useful, but manual keyboard verification is still required.

---

# 21. Performance UX

The UI should feel immediate even when background execution is heavy.

Targets:
- app shell renders quickly,
- navigation responds immediately,
- large logs are virtualized or otherwise bounded,
- long task histories paginate or virtualize,
- expensive diff rendering is lazy-loaded,
- realtime event bursts are batched to avoid UI thrash,
- typing in task description or directives never lags because logs update.

Do not load full artifact bodies, giant logs, and full Git diffs on every task-detail request by default.

---

# 22. Change Governance

When adding a new UI pattern:

1. Confirm an existing pattern cannot solve it.
2. Define the pattern at the shared design-system level.
3. Add/update its token/component rules here.
4. Implement it in `packages/ui`.
5. Reuse it from feature screens.
6. Verify responsive + accessibility behavior.

A new page is **not** permission to create a new design style.

---

# 23. Definition of Done — Frontend

Frontend work is complete only when all applicable points pass:

- follows this `design.md`,
- preserves product behavior from `PLAN.md`,
- uses shared design tokens,
- uses shared UI components,
- no ad hoc visual system was introduced,
- responsive layouts verified,
- Dark and Light verified,
- VS Code constraints considered,
- loading/empty/error/offline states implemented,
- keyboard navigation works,
- accessibility checks pass,
- realtime updates do not cause focus/scroll/layout instability,
- dangerous actions use correct approval UX,
- core task state is always explicit,
- Playwright/UI tests added where valuable,
- actual behavior was verified, not only code reviewed.

---

# 24. Final Design Direction

The finished product should feel:

**Precise. Quiet. Fast. Trustworthy. Technical. Premium.**

It should not feel:

**Flashy. Experimental. Game-like. Generic SaaS. Card-heavy. AI-themed for decoration.**

The UI exists to make complex AI development orchestration understandable and controllable. Every visual decision must improve one of these outcomes:

- comprehension,
- speed,
- confidence,
- safety,
- consistency,
- recovery from failure.

If a design decision does not improve one of them, it probably does not belong.
