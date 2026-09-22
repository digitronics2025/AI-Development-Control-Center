# AI Development Control Center

**Repository:** `digitronics2025/AI-Development-Control-Center`  
**Primary platform:** Windows 11 + VS Code  
**Project type:** Local-first AI development orchestrator  
**Status:** Phase 0 complete — repository created; implementation has not started yet.

---

## 1. Goal

Build one local control center that manages the complete AI-assisted software-development workflow without manual copy/paste between ChatGPT/Codex, Claude Code, VS Code, terminals, tests, and Git.

The target workflow is:

```text
User task
   ↓
Investigator
   ↓
Discussion / clarification when required
   ↓
Planner
   ↓
Implementer
   ↓
Tests
   ↓
Reviewer
   ↓
Fixer when required
   ↓
Verification
   ↓
Completion report
```

Every role must be configurable. Nothing is permanently tied to one provider.

Example default:

```text
Investigator → Codex
Planner      → Codex
Implementer  → Claude Code
Reviewer     → Codex
Fixer        → Claude Code
```

But the dashboard must also support:

```text
Investigator → Claude Code
Planner      → Claude Code
Implementer  → Codex
Reviewer     → Claude Code
Fixer        → Codex
```

The user controls the workflow from either:

1. a standalone local dashboard, or
2. a VS Code extension using the same backend and state.

---

## 2. Non-Negotiable Requirements

### 2.1 Subscription-first execution

The system is intended to use the user's existing authenticated CLI subscriptions wherever supported.

Initial adapters:

- Codex CLI
- Claude Code CLI

The application must **not silently switch to paid API usage**.

Subscription-only mode must be the default.

If an agent cannot continue because authentication or usage allowance is unavailable:

```text
Pause task
→ mark the stage blocked
→ show a clear message
→ wait for user action
```

Never silently:

```text
subscription unavailable
→ paid API fallback
```

### 2.2 Local-first

V1 runs locally on the user's Windows PC.

The orchestrator binds to localhost only by default.

Do not require:

- cloud database
- multi-user SaaS
- public server
- Kubernetes
- paid hosted queue
- custom model hosting

Cloud control can be added later.

### 2.3 One source of truth

The dashboard and VS Code must not maintain separate workflow state.

Both communicate with the same local orchestrator.

```text
Standalone Dashboard
          │
          ▼
 Local Orchestrator
          ▲
          │
      VS Code
```

A change made in one interface must appear in the other immediately.

### 2.4 Provider-independent roles

Workflow roles are generic:

- Investigator
- Planner
- Implementer
- Tester
- Reviewer
- Fixer
- Verifier
- Deployer
- Reporter

Agents, models, and effort levels are assigned to roles through configuration.

### 2.5 Verify repository reality before implementation

Plans are intent, not proof of repository state.

Every implementation stage must follow this rule:

> Inspect the current repository before changing code. Verify all assumptions. If the repository differs from the plan, preserve the requested outcome and adapt the implementation to the actual architecture.

### 2.6 Protect existing work

Never overwrite unrelated uncommitted user changes.

Before an implementation task:

- inspect Git status,
- record a baseline,
- distinguish pre-existing changes from AI-created changes,
- use a dedicated branch or worktree where appropriate.

---

## 3. Scope

### Included in V1

- local orchestrator service
- React dashboard
- VS Code extension
- Codex adapter
- Claude Code adapter
- agent registry
- model registry
- effort configuration
- workflow profiles
- editable workflow stages
- global defaults
- repository defaults
- per-task overrides
- task history
- local SQLite persistence
- real-time updates
- pause / resume / cancel
- retry stage
- reroute stage to another agent
- live task directives
- artifact storage
- Git integration
- test/build execution
- reviewer/fixer loop
- permissions and approvals
- subscription-only protection
- secret redaction
- restart recovery
- simple completion reports

### Explicitly out of V1

- public SaaS
- multi-user/team accounts
- Android/iOS companion app
- remote internet control
- automatic paid API fallback
- production deployment without approval
- many provider integrations at once
- automatic model benchmarking
- complex visual node editor before the core engine works

---

## 4. Architecture

Use three layers.

```text
┌─────────────────────────────────────────────┐
│                CONTROL PLANE                │
│                                             │
│ Dashboard + VS Code UI                      │
│ Workflows / Tasks / Models / Permissions    │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│             ORCHESTRATION ENGINE            │
│                                             │
│ Workflow state machine                      │
│ Agent routing                               │
│ Context builder                             │
│ Task persistence                            │
│ Event log                                   │
│ Approvals                                   │
│ Git/test coordination                       │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│              EXECUTION PLANE                │
│                                             │
│ Codex CLI                                   │
│ Claude Code                                 │
│ Git                                         │
│ npm / pnpm                                  │
│ Gradle                                      │
│ Wrangler                                    │
│ Playwright / test tools                     │
└─────────────────────────────────────────────┘
```

The orchestrator is the product core.

The dashboard and VS Code extension are clients of that core.

---

## 5. Recommended Stack

### Monorepo

- TypeScript
- pnpm workspaces

### Dashboard

- React
- Vite
- Tailwind CSS

### Orchestrator

- Node.js
- TypeScript
- Fastify
- Zod

### Persistence

- SQLite
- versioned migrations

### Realtime

- WebSocket

### Testing

- Vitest
- Playwright where useful

### Execution

- Node `child_process.spawn`
- native Git CLI
- provider CLIs

### VS Code

- VS Code Extension API
- WebView using shared React UI components

---

## 6. Repository Structure

Target structure:

```text
AI-Development-Control-Center/
│
├── apps/
│   ├── orchestrator/
│   ├── dashboard/
│   └── vscode-extension/
│
├── packages/
│   ├── core/
│   ├── workflow-engine/
│   ├── agent-sdk/
│   ├── agent-codex/
│   ├── agent-claude/
│   ├── executor/
│   ├── git/
│   ├── security/
│   ├── shared/
│   └── ui/
│
├── workflows/
│   ├── quick-change.yaml
│   ├── normal-development.yaml
│   ├── deep-investigation.yaml
│   ├── architecture.yaml
│   └── full-autopilot.yaml
│
├── prompts/
│   ├── investigator.md
│   ├── planner.md
│   ├── implementer.md
│   ├── reviewer.md
│   ├── fixer.md
│   └── verifier.md
│
├── docs/
├── tests/
├── PLAN.md
└── README.md
```

Do not create empty complexity just to match this tree. Add packages when their responsibility becomes real.

---

## 7. Configuration Model

Configuration precedence:

```text
GLOBAL DEFAULT
      ↓
REPOSITORY DEFAULT
      ↓
TASK OVERRIDE
```

Example:

Global:

```text
Implementer = Claude Code / Medium
```

Repository override:

```text
Phone Bridge
Implementer = Claude Code / High
```

Task override:

```text
TASK-0142
Implementer = Codex / High
```

Only the current task changes.

---

## 8. Agent, Model, and Effort Must Be Separate

Do not encode a model as one hard-coded provider string.

Correct:

```text
Agent:  Claude Code
Model:  configurable model ID
Effort: Medium
```

and:

```text
Agent:  Codex
Model:  configurable model ID
Effort: High
```

This lets future models be added without redesigning workflows.

---

## 9. Agent Adapter Contract

Create one provider-independent adapter interface.

Minimum contract:

```ts
interface AgentAdapter {
  id: string;

  detect(): Promise<AgentDetectionResult>;
  healthCheck(): Promise<AgentHealth>;
  getCapabilities(): Promise<AgentCapabilities>;
  listModels(): Promise<ModelDescriptor[]>;

  execute(input: AgentExecutionInput): Promise<AgentExecutionHandle>;
  cancel(executionId: string): Promise<void>;

  parseResult(result: RawAgentResult): Promise<AgentExecutionResult>;
}
```

Initial implementations:

- `CodexAdapter`
- `ClaudeCodeAdapter`

Future adapters should be possible without changing the workflow engine:

- Gemini CLI
- OpenCode
- Ollama
- Copilot or other supported agents

---

## 10. Agent Registry

The dashboard must show agent availability and capabilities.

Example:

```text
AGENTS

Codex
● Connected
Authentication: existing CLI session
Executable: detected
Models: discovered/configured

Claude Code
● Connected
Authentication: existing CLI session
Executable: detected
Models: discovered/configured
```

Capabilities can include:

- repository read
- repository write
- command execution
- images
- interactive execution
- non-interactive execution
- model selection
- effort selection

Do not assume every provider supports every capability.

---

## 11. Subscription-Only Guard

Provide a top-level setting:

```text
Billing Mode

● Subscription Only
○ Explicit API Mode
```

V1 default is:

```text
Subscription Only = ON
```

Before launching a provider, inspect the execution environment for credentials that could cause unintended API billing.

Potential variables include:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- other provider-specific API keys

In subscription-only mode:

- do not pass unnecessary API credentials to child processes,
- warn/block when a provider configuration would use explicit API billing,
- do not automatically purchase or switch to credits,
- do not store API credentials in SQLite.

The guard must be tested, not only documented.

---

## 12. Workflow Engine

A workflow is a stateful graph, not a fixed script.

Default flow:

```text
START
  ↓
INVESTIGATE
  ↓
PLAN
  ↓
IMPLEMENT
  ↓
TEST
  ↓
REVIEW
  ↓
┌─────────────┐
│ PASS ?      │
└──────┬──────┘
       │
   ┌───┴───┐
  YES     NO
   │       │
   │      FIX
   │       ↓
   │      TEST
   │       ↓
   │     REVIEW
   │       │
   └───────┘
       ↓
VERIFY
       ↓
COMPLETE
```

Each stage defines:

- role
- agent
- model
- effort
- permissions
- inputs
- output artifacts
- timeout
- retry policy
- next transition
- approval requirement

---

## 13. Workflow Profiles

### 13.1 Quick Change

For small UI or straightforward edits.

```text
Implement
→ Test
→ Review
→ Complete
```

### 13.2 Normal Development

Default profile.

```text
Investigate
→ Plan
→ Implement
→ Test
→ Review
→ Fix when required
→ Verify
```

### 13.3 Deep Investigation

For difficult bugs.

```text
Primary investigation
→ independent second investigation
→ consolidated plan
→ implementation
→ tests
→ independent review
```

### 13.4 Architecture

For significant structural changes.

```text
Architecture assessment
→ independent assessment
→ consolidated plan
→ implementation
→ tests
→ review
```

### 13.5 Full Autopilot

```text
Investigate
→ Plan
→ Implement
→ Tests
→ Review
→ Fix
→ Tests
→ Verify
→ Git checks
→ optional staging
→ smoke test
→ completion report
```

Production actions remain approval-gated.

---

## 14. Discuss First vs Autopilot

Task mode:

```text
● Discuss First
○ Autopilot
```

### Discuss First

```text
Task
↓
Investigation
↓
Discussion
↓
Plan
↓
User approves implementation
↓
Implementation pipeline
```

### Autopilot

```text
Task
↓
Investigation
↓
Plan
↓
Implementation
↓
Tests
↓
Review
↓
Fixes
↓
Verification
↓
Complete
```

This preserves the user's existing successful habit of discussing and planning before coding while allowing full automation when desired.

---

## 15. Task Model

Each task receives an ID such as:

```text
TASK-0142
```

Persist at minimum:

- title
- description
- repository
- workflow profile/version
- mode
- current stage
- status
- created/started/finished timestamps
- agent/model/effort assignments
- permissions
- user directives
- artifacts
- Git baseline and branch
- test results
- execution logs

Statuses:

```text
DRAFT
QUEUED
RUNNING
PAUSED
WAITING_FOR_USER
WAITING_FOR_USAGE_RESET
FAILED
CANCELLED
COMPLETED
INTERRUPTED
```

---

## 16. Task Workspace and Artifacts

Each task gets durable artifacts.

Recommended layout:

```text
.ai/tasks/TASK-0142/

request.md
investigation.md
plan.md
implementation-prompt.md
implementation-report.md
review.md
verification.md
tests.log
git-diff.patch
final-report.md
task.json
```

Artifacts provide durable context even when an agent conversation is lost.

---

## 17. Context Builder

Do not blindly dump the entire repository into every stage.

### Investigator receives

- original request
- attachments/screenshots
- repository metadata
- repository instructions
- relevant source tree
- Git status
- architecture docs

### Planner receives

- original request
- investigation report
- repository facts
- user directives

### Implementer receives

- original goal
- approved plan
- success criteria
- repository
- user directives
- testing requirements

### Reviewer receives

- original requirement
- plan
- Git diff
- changed files
- test/build results
- implementation report

The agent must inspect the repository directly when it needs code-level truth.

---

## 18. Standard Plan Template

Generated plans should use:

1. Goal
2. Scope
3. Success Criteria
4. Implementation Plan
5. Verification
6. Security and Data Check
7. Completion Report
8. Found for Later
9. Next Recommended Task
10. Final Autopilot Instruction

Prompt templates must be editable and versioned.

---

## 19. Dashboard

### Home

Show:

- active tasks
- stage progress
- current agent/model
- blocked tasks
- quick task creation
- provider connection status

### New Task

Inputs:

- repository
- workflow
- mode
- description
- attachments
- optional role/model overrides

Advanced options remain collapsed by default.

### Task Detail

Show:

- workflow timeline
- current stage
- agent/model/effort
- live logs
- changed files
- test state
- review state
- task directives
- artifacts
- Git diff

Controls:

- Pause
- Resume
- Cancel
- Retry stage
- Reroute
- Add directive
- Change future stage agent
- Open files
- View diff

### Settings

Manage:

- repositories
- agents
- models
- workflow profiles
- prompt templates
- permissions
- billing mode
- notification options

---

## 20. Live Intervention

The user can add a directive while a task is active.

Example:

> Do not modify the D1 schema.

Persist it with timestamp.

Do not pretend to mutate a model prompt mid-execution unless the provider safely supports that behavior.

Default behavior:

```text
Receive directive
→ persist it
→ optionally pause current stage
→ apply at the next safe execution boundary
```

---

## 21. Rerouting

If one agent fails or the user wants another one:

```text
Current:
Claude Code

Reroute:
Codex
```

The replacement agent receives:

- original task
- investigation
- plan
- previous implementation report
- current Git diff
- failed tests
- logs
- user directives

Do not restart from zero unless necessary.

---

## 22. Persistence and State Machine

Use SQLite with versioned migrations.

Core tables:

- repositories
- agents
- models
- workflow_profiles
- workflow_stages
- tasks
- task_stages
- executions
- task_events
- task_directives
- task_artifacts
- approvals
- git_snapshots
- test_runs
- settings

Task and stage state must be persisted independently of UI state.

Example stage lifecycle:

```text
READY
→ STARTING
→ RUNNING
→ SUCCESS
```

or:

```text
RUNNING
→ FAILED
→ RETRYING
```

or:

```text
RUNNING
→ WAITING_APPROVAL
```

or:

```text
RUNNING
→ CANCELLED
```

---

## 23. Event Log

Record meaningful events:

- TASK_CREATED
- TASK_STARTED
- STAGE_STARTED
- AGENT_STARTED
- COMMAND_STARTED
- USER_DIRECTIVE
- FILE_CHANGED
- TEST_STARTED
- TEST_FAILED
- TEST_PASSED
- STAGE_COMPLETED
- REVIEW_FAILED
- REROUTED
- APPROVAL_REQUESTED
- TASK_COMPLETED
- TASK_FAILED

The event log powers history, diagnostics, and realtime UI.

---

## 24. Realtime Sync

The orchestrator exposes:

### Local HTTP

For:

- task creation
- settings
- workflow management
- commands

### WebSocket

For:

- task progress
- logs
- stage changes
- configuration updates
- approvals
- dashboard/VS Code synchronization

Bind to `127.0.0.1` in V1.

---

## 25. VS Code Extension

The extension must remain thin.

It must not duplicate workflow logic.

Features:

- connect to local orchestrator
- show service health
- New Task
- Current Task
- Task History
- Workflow
- Agents
- Logs
- Artifacts
- Diff
- Pause/resume/cancel
- Add directive
- Status bar item

Status bar examples:

```text
AI: Idle
AI: Codex Investigating
AI: Claude Implementing
AI: Tests Running
AI: Waiting Approval
AI: Failed
AI: Complete
```

Clicking the status item opens the Control Center WebView.

Use shared UI components where practical so the standalone dashboard and VS Code view remain consistent.

---

## 26. Git Integration

Before implementation:

- run `git status`,
- detect current branch,
- capture baseline commit,
- detect pre-existing uncommitted changes.

Prefer a task branch:

```text
ai/TASK-0142-contact-sync
```

Store:

- baseline commit
- task branch
- changed files
- Git diff
- commits created

Do not automatically force-push.

### Worktrees

Worktree support is recommended after the basic flow is stable.

Benefits:

- protect the user's primary workspace,
- safely run parallel tasks later,
- easy rollback.

Do not make worktrees a blocker for the first milestone.

---

## 27. Testing and Verification

Repositories can define:

- lint command
- typecheck command
- unit tests
- integration tests
- build command
- E2E tests
- platform-specific verification

Examples:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

Android:

```text
gradlew test
gradlew assembleDebug
```

Cloudflare dry-run when appropriate:

```text
wrangler deploy --dry-run
```

An agent saying "done" is not proof of completion.

Completion requires actual verification.

---

## 28. Reviewer / Fixer Loop

Default:

```text
Review
  ↓
PASS ─────→ Verify
  │
 FAIL
  ↓
Fix
  ↓
Test
  ↓
Review
```

Set a maximum automatic retry count.

Recommended default:

```text
Maximum fix/review cycles: 3
```

After that:

```text
WAITING_FOR_USER
```

This prevents infinite loops and unnecessary subscription usage.

---

## 29. Permissions

Use five permission levels.

### Level 1 — Analyze

- read repository
- inspect Git
- investigate
- plan

### Level 2 — Develop

- edit files
- install dependencies
- run local commands
- tests/builds

### Level 3 — Git

- create branch
- commit
- push
- create PR

### Level 4 — Infrastructure

- staging deploy
- staging migration
- Cloudflare resource changes

### Level 5 — Production

- production deploy
- production migration
- destructive production operations

Recommended defaults:

```text
Auto allowed:
Levels 1–3

Approval required:
Levels 4–5
```

Potentially destructive commands always require stronger checks regardless of nominal level.

---

## 30. Security

### Secrets

Redact:

- API keys
- tokens
- passwords
- cookies
- private keys
- `.env` values
- Cloudflare secrets
- GitHub tokens

Do not store authentication secrets in SQLite.

### Local service

V1 must listen only on localhost unless explicitly changed.

### Commands

Classify commands.

Examples:

Normal:

- `git status`
- `git diff`
- `npm test`
- `npm run build`

Elevated:

- `git push`
- staging deployment

Dangerous:

- recursive deletion
- destructive database commands
- force push
- production deletion
- infrastructure destruction

Dangerous commands require explicit approval.

---

## 31. Failure Handling

Classify errors:

- AUTH_FAILURE
- USAGE_LIMIT
- COMMAND_FAILURE
- MODEL_UNAVAILABLE
- TIMEOUT
- PROCESS_CRASH
- TEST_FAILURE
- CONTEXT_FAILURE
- PERMISSION_DENIED
- UNKNOWN

Example:

```text
USAGE_LIMIT
→ pause task
→ mark WAITING_FOR_USAGE_RESET
→ never switch to paid API automatically
```

---

## 32. Restart Recovery

If Windows or the orchestrator restarts:

```text
Service starts
↓
load active tasks from SQLite
↓
detect abandoned executions
↓
mark task/stage INTERRUPTED
↓
offer Resume / Retry
```

A restart must not lose task history or artifacts.

---

## 33. Logging

Provide two views.

### Simple

For normal use:

```text
Codex is investigating.
Plan completed.
Claude is implementing.
Build failed.
Claude is fixing the build.
Build passed.
Codex is reviewing.
Task completed.
```

### Developer

Show:

- stdout
- stderr
- command
- exit code
- timestamps
- durations
- execution IDs

Secrets must be redacted in both views.

---

## 34. Completion Report

Every completed task produces:

```text
TASK COMPLETED

Requested:
...

Changed:
...

Files changed:
...

Tests:
Passed / failed counts

Build:
Passed / failed

Review:
Passed / issues

Cloud:
Not deployed / staging / production

Git:
Branch / commit information

Remaining limitations:
...

Final status:
READY / NEEDS USER ACTION
```

---

## 35. Found for Later

Unrelated discoveries must not expand the current task.

Record:

```text
Issue:
...

Why it matters:
...

Recommended fix:
...

Priority:
...

Affects current task:
Yes / No
```

---

# 36. Implementation Roadmap

## Phase 0 — Repository Setup

**Status: COMPLETE**

Repository exists:

`https://github.com/digitronics2025/AI-Development-Control-Center`

Current repo state at plan update:

- GitHub repository exists
- default branch: `main`
- no implementation code yet
- project plan now added as `PLAN.md`

---

## Phase 1 — Foundation and CLI Proof

### Goal

Prove that one local TypeScript orchestrator can safely detect and run Codex CLI and Claude Code in a selected local repository and capture structured results.

### Build

- pnpm TypeScript monorepo foundation
- `apps/orchestrator`
- shared types
- basic agent SDK
- Codex adapter
- Claude Code adapter
- executable detection
- health checks
- working-directory selection
- child-process execution
- stdout/stderr capture
- exit codes
- cancellation
- execution IDs
- structured result object
- subscription-only environment guard
- secret redaction
- basic unit/integration tests
- README setup instructions

### Do NOT build yet

- dashboard
- VS Code extension
- full workflow graph
- SQLite task engine
- Git branch automation
- visual workflow editor
- cloud control

### Phase 1 success criteria

All must pass:

- orchestrator starts locally
- Codex executable detected
- Claude Code executable detected
- Codex can run a harmless test task through the orchestrator
- Claude Code can run a harmless test task through the orchestrator
- selected working directory is respected
- stdout/stderr captured
- exit code captured
- cancellation works
- secrets are redacted
- API credentials are not accidentally passed in subscription-only mode
- automated tests pass
- documentation explains how to verify both providers manually

---

## Phase 2 — One End-to-End Workflow

### Goal

Prove the central product idea with one hard-coded workflow before making the workflow system generic.

Implement:

```text
User task
↓
Codex investigates
↓
Codex writes plan artifact
↓
Claude implements
↓
repository tests run
↓
Codex reviews diff/results
↓
completion report
```

### Success criteria

One command can execute the whole flow against a safe test repository without manual copy/paste.

---

## Phase 3 — Persistence and Task State

Add:

- SQLite
- migrations
- tasks
- stages
- executions
- artifacts
- events
- directives
- restart recovery

### Success criteria

A task survives orchestrator restart without losing history or state.

---

## Phase 4 — Generic Workflow Engine

Replace the Phase 2 hard-coded flow with configurable stages, transitions, retries, roles, models, effort, permissions, and approvals.

### Success criteria

The same engine can execute multiple workflow profiles without source-code changes.

---

## Phase 5 — Workflow Profiles

Implement:

- Quick Change
- Normal Development
- Deep Investigation
- Architecture
- Full Autopilot

### Success criteria

Switching the workflow profile changes behavior through configuration only.

---

## Phase 6 — Context and Artifact System

Build:

- role-specific context builder
- prompt templates
- task artifacts
- template versioning
- plan format enforcement

### Success criteria

Each stage receives only the context it needs, and important output remains durable.

---

## Phase 7 — Git Integration

Build:

- Git status
- baseline commit
- branch handling
- changed-file tracking
- diff capture
- user-change protection
- rollback information

### Success criteria

AI-created changes can be distinguished reliably from pre-existing user work.

---

## Phase 8 — Test/Build Engine

Build:

- repository-specific commands
- lint
- typecheck
- tests
- build
- structured results

### Success criteria

A task cannot be marked complete solely from the agent's claim.

---

## Phase 9 — Reviewer/Fixer Loop

Implement:

```text
Review
↓
Fail
↓
Fix
↓
Test
↓
Review
```

with bounded retries.

### Success criteria

Failures can be automatically corrected without infinite loops.

---

## Phase 10 — Dashboard MVP

Build:

- Home
- New Task
- Task Detail
- Agents
- Workflows
- Repositories
- Logs
- Artifacts
- Settings
- realtime WebSocket updates

### Success criteria

The full current workflow can be controlled without manually editing configuration files.

---

## Phase 11 — VS Code Extension

Build a thin extension connected to the same local orchestrator.

### Success criteria

The user can create, observe, pause, resume, reroute, and review a task inside VS Code, while changes remain synchronized with the standalone dashboard.

---

## Phase 12 — Live Intervention

Add:

- add directive
- pause
- resume
- retry
- reroute
- change future stage agent/model/effort

### Success criteria

The workflow can be redirected without restarting the full task.

---

## Phase 13 — Permission and Approval System

Implement Levels 1–5, command classification, approval prompts, and production protection.

### Success criteria

Autopilot remains useful without giving agents uncontrolled production access.

---

## Phase 14 — Reliability Hardening

Test at minimum:

- orchestrator restart
- Windows restart
- provider process crash
- expired login
- usage limit
- unavailable model
- malformed output
- command failure
- test failure
- dirty Git workspace
- user cancellation
- missing executable
- interrupted stage

### Success criteria

Failures do not corrupt task state or repository state.

---

## Phase 15 — Windows Packaging

Provide a practical Windows experience:

- simple install/start
- optional launch on login
- local background orchestrator
- dashboard launcher
- VS Code extension auto-discovery

### Success criteria

Normal use does not require manually starting several terminals.

---

# 37. V1 Acceptance Scenario

Open a real but safe repository in VS Code.

Create a task:

> Integrate a feature. First inspect the current architecture and determine the safest implementation.

Choose:

```text
Workflow: Normal Development
Mode: Discuss First or Autopilot
```

Expected:

```text
Codex investigates
↓
plan appears in the task
↓
Claude implements
↓
tests run
↓
Codex reviews actual diff
↓
Claude fixes issues if required
↓
tests rerun
↓
success criteria verified
↓
task completes
```

No manual prompt copying between apps.

---

# 38. Global Success Criteria

V1 is complete only when:

- Codex can be controlled through its adapter
- Claude Code can be controlled through its adapter
- the system can operate in subscription-only mode
- no automatic paid API fallback occurs
- any compatible provider can be assigned to any compatible workflow role
- model and effort are configurable independently
- workflows can be changed without source edits
- task state persists
- pause/resume/cancel work
- rerouting works
- task directives work
- Git changes are tracked
- existing uncommitted work is protected
- tests/builds are actually executed
- review/fix loops are bounded
- secrets are not exposed in logs
- production actions require approval
- dashboard and VS Code share the same state
- final completion reports are generated

---

# 39. Security and Data Verification

Before declaring V1 complete, verify:

- no provider API keys stored in SQLite
- no auth tokens logged
- no secret files committed
- no `.env` contents exposed unnecessarily
- subscription-only environment sanitation works
- no silent API fallback
- no force push automatically
- no destructive database operation automatically
- no production deployment without approval
- localhost binding confirmed
- Git rollback information available
- database migrations tested
- restart recovery tested

---

# 40. Found for Later

Do not block V1 on:

- remote phone control
- Cloudflare-hosted dashboard
- multi-PC synchronization
- multi-user/team mode
- Gemini/OpenCode/Ollama adapters
- automatic AI effort selection
- workflow marketplace
- usage optimization engine
- Android companion app
- voice task creation
- automatic production deployment
- unrestricted parallel tasks in one repository

The architecture should not prevent these, but V1 should stay focused.

---

# 41. Next Recommended Task

**Implement Phase 1 only.**

Do not start with the dashboard.

The first engineering milestone is:

```text
Local orchestrator
      ├── detects Codex
      ├── detects Claude Code
      ├── runs Codex safely
      ├── runs Claude safely
      ├── captures structured output
      ├── supports cancellation
      └── enforces subscription-only safeguards
```

Once this works reliably, proceed to Phase 2.

---

# 42. Phase 1 Implementation Prompt

Use this prompt for the first coding session:

> Read `PLAN.md` completely before making changes. Implement **Phase 1 — Foundation and CLI Proof only**. Do not build the dashboard, VS Code extension, full workflow engine, SQLite task system, Git automation, or advanced features yet.
>
> First inspect the local environment and verify all assumptions. Create the smallest maintainable TypeScript/pnpm monorepo foundation needed for the long-term architecture. Implement a local orchestrator plus a provider-independent agent adapter contract, then implement Codex CLI and Claude Code adapters.
>
> The orchestrator must detect each CLI, perform a health check, execute a harmless task in a caller-selected working directory, capture stdout, stderr, exit code, timing, and execution ID, support cancellation, and return a structured result.
>
> Add strict subscription-only safeguards. Do not deliberately use OpenAI or Anthropic API billing. Do not expose provider credentials in logs. Sanitize child-process environments where appropriate so API credentials cannot accidentally override the intended subscription-authenticated CLI behavior. If safe subscription-authenticated execution cannot be verified, stop with a clear error instead of silently falling back to paid API usage.
>
> Add focused automated tests, clear setup documentation, and a simple manual verification procedure for both agents. Verify actual behavior rather than only compiling code.
>
> Stay strictly inside Phase 1. Record unrelated improvements under **Found for Later** instead of expanding scope.
>
> Do not stop for routine confirmation. Decide normal implementation details yourself using the simplest secure, maintainable, scalable long-term option. Stop only for a genuine external blocker, missing authorization, unavailable local dependency, or a security-sensitive action that genuinely requires user input.
>
> Finish only when every Phase 1 success criterion in `PLAN.md` has been verified, and provide a simple completion report explaining what was built, what was tested, what passed, any limitation, and the final status.

---

# 43. Final Autopilot Instruction

For later full-project implementation phases:

> **/goal Run the selected phase end-to-end on full autopilot. First inspect the current repository and environment and verify every assumption before changing code. Treat this plan as the intended architecture and outcome, not as proof that the current repository already matches it. Decide normal implementation details yourself using the most secure, maintainable, scalable, and simple long-term approach. Stay strictly within the selected phase and target. Fix only issues that directly block or materially affect that target. Implement, test, fix, retest, and verify actual behavior. Protect existing user work, secrets, authentication, subscription billing, data integrity, and production systems. Never silently fall back to paid API usage. Stop only for a genuine external blocker, missing authorization, or an action explicitly requiring user approval. Record unrelated discoveries under Found for Later instead of expanding scope. Finish only when all applicable acceptance criteria have been verified and provide the required simple completion report.**
