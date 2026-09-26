# STAGE_TEAMS_PLAN.md

> Production plan for provider-independent sub-agents / stage teams in the AI Development Control Center.
>
> This plan is based on direct inspection of the current repository implementation, not on a generic agent architecture.

## 1. Goal

Make workflows materially faster without weakening correctness, safety, observability, recovery, or cost control by allowing selected workflow stages to run a bounded team of Control Center-managed workers.

The target behavior is:

- keep the existing workflow and fix-cycle model;
- keep one logical stage outcome for transitions, approvals, Chairman supervision, and completion gates;
- allow a stage to execute several independent work units concurrently when parallel work is genuinely safe;
- keep small or tightly coupled tasks on the current single-agent path;
- keep deterministic tests and app verification authoritative;
- make every worker visible, metered, cancellable, recoverable, and auditable;
- never enable opaque recursive delegation through Claude/Codex native hidden agents.

### Verified current-state findings

The current implementation already has strong foundations, but stage execution is serial:

- Built-in workflows are YAML under `workflows/`. `workflows/architecture.yaml` currently runs:
  1. Codex architecture assessment
  2. Claude independent assessment
  3. consolidated plan
  4. implement
  5. test
  6. review
  7. fix loop
- `packages/shared/src/schemas.ts` models one agent/model/effort assignment per stage. There is no team/work-unit definition.
- Workflow stage definitions are stored as JSON in `workflow_stages`; every task stores a workflow snapshot, so future workflow changes do not mutate running or historical tasks.
- `apps/orchestrator/src/engine/engine.ts::runLoop()` executes one stage at a time and `StageRunners.runAgent()` launches one agent execution for an agent stage.
- `RunControl` currently represents one active execution via one `cancelCurrent` callback.
- `apps/orchestrator/src/engine/runners.ts::runCommands()` executes configured check jobs sequentially.
- `RepositoryCoordinator` protects repository-changing stages from Source Control mutations, but it does not provide safe coordination for several writers inside one stage/worktree.
- The project already has the primitives needed for safe worker isolation:
  - task worktrees in `packages/git/src/worktrees.ts`;
  - hidden checkpoint commits in `packages/git/src/index.ts::createCheckpoint()`;
  - exact working-tree capture;
  - task-scoped MCP/tool sessions;
  - per-execution logs;
  - usage accounting through the single `AgentRegistry.launch()` boundary.
- Claude's native `Agent` tool is intentionally absent from Control Center agent runs. The current closed Claude tool set excludes hidden nested agents. Preserve that design.
- The current SQLite migration list ends at migration 18 (`affected tests`) in the inspected code. Implementation must re-check the repository before choosing the next migration number.
- Existing task APIs already expose events, executions, tests, artifacts, assignments and rerouting. Dashboard task pages already have workflow timeline, logs and execution views that can be extended rather than replaced.

### Root cause

The limitation is not simply "Claude/Codex cannot spawn sub-agents."

The real constraint is that the Control Center data model and execution loop treat a workflow stage as one serial unit with one active worker. There is no durable work-unit model, no bounded intra-stage scheduler, no isolated writer workspace per worker, no deterministic worker-result integration step, and no worker-level attribution in executions/usage.

The fix is therefore an orchestrator-owned **Stage Team** abstraction, not enabling provider-native recursive agents.

---

## 2. Scope

### In scope

1. Optional Stage Teams for agent stages.
2. Two team modes:
   - **fixed**: explicitly configured independent workers, ideal for architecture assessment and parallel reviews;
   - **adaptive**: work units are derived from the plan/current failure context and only fan out when safe.
3. Bounded parallel worker scheduling.
4. Read-only worker parallelism in the same task workspace.
5. Write-capable worker isolation in disposable child worktrees.
6. Deterministic validation and integration of worker changes into the parent task worktree.
7. Planner awareness of the Stage Team system and a validated execution manifest.
8. One short integration/reconciliation pass after multiple write workers are merged.
9. Worker persistence, execution/log attribution, usage/cost attribution and realtime status.
10. Chairman/restart/cancel behavior that remains correct with multiple active worker processes.
11. Dashboard workflow configuration and task progress UI for Stage Teams.
12. Conservative test-command parallelism only when a command is explicitly configured as parallel-safe.
13. Update the built-in Architecture workflow to use the new capability after the framework is verified.
14. Preserve all current single-agent behavior when team mode is off or cannot safely run.

### Explicitly out of scope

- Enabling Claude Code's native `Agent` tool or equivalent opaque nested provider agents.
- Unlimited recursive agent delegation.
- Replacing the current workflow engine with a general distributed DAG engine.
- Running Release, production deployment, Git checkpoint, or approval stages as teams.
- Allowing several write workers to edit the same parent task worktree.
- Automatically parallelizing arbitrary repository commands without an explicit safety declaration.
- Cross-machine distributed workers in this task.
- Multi-repository **write** teams in the first implementation. Multi-repository tasks must safely fall back to the existing single-agent writer path. Read-only teams may still run.
- Automatic model benchmarking/routing by specialty; the design must leave a clean extension point for it.

---

## 3. Enhanced design/architecture

### 3.1 Core rule: the Control Center owns the team

A Stage Team is part of the orchestrator:

```text
Workflow
  -> Stage
      -> Stage Team scheduler
          -> Work unit A -> AgentRegistry.launch()
          -> Work unit B -> AgentRegistry.launch()
          -> Work unit C -> AgentRegistry.launch()
      -> deterministic aggregation / integration
  -> existing next/onFail transition
```

The parent stage is still the workflow boundary. Existing transition rules, `maxFixCycles`, approvals, completion gates, task snapshots, reporting and Chairman supervision continue to operate at stage level.

Workers are never allowed to create further workers. Maximum delegation depth is one.

### 3.2 Extend `StageDefinition` additively

Add an optional `team` object to `stageDefinitionSchema` in `packages/shared/src/schemas.ts`.

Proposed shape:

```ts
team?: {
  mode: 'fixed' | 'adaptive';
  maxWorkers: number; // 2..4
  workers?: Array<{
    key: string;
    focus: string;
    agentId?: string;
    model?: string;
    effort?: string;
    primary?: boolean;
  }>;
}
```

Rules:

- absent `team` = exact current single-agent behavior;
- allowed only on `kind: agent`;
- `fixed` requires 2..4 workers;
- `adaptive` does not store a static worker list;
- worker permission level always inherits the parent stage and can never elevate it;
- `maxWorkers` is also capped by a small orchestrator-wide team concurrency setting;
- Level 4/5 stages cannot use team mode;
- workflow validation rejects duplicate worker keys and invalid assignments;
- built-in workflow YAML remains the source of built-in configuration; custom workflows continue to store stage definitions in the existing JSON column, so the team configuration itself needs no separate workflow DB table.

### 3.3 Adaptive execution manifest

The planner must understand that later stages may run as teams.

Update the planner prompt so it produces a normal human-readable plan plus a bounded machine-readable execution manifest when there are genuinely independent work streams.

The manifest describes work, not provider selection:

```json
{
  "version": 1,
  "stage": "implement",
  "units": [
    {
      "key": "backend",
      "title": "Backend changes",
      "goal": "Implement the API and persistence changes",
      "specialty": "backend",
      "dependsOn": [],
      "pathPrefixes": ["apps/orchestrator/", "packages/shared/"],
      "checks": ["typecheck", "test"]
    },
    {
      "key": "frontend",
      "title": "Dashboard changes",
      "goal": "Implement the workflow and task UI",
      "specialty": "frontend",
      "dependsOn": [],
      "pathPrefixes": ["apps/dashboard/", "packages/ui/"],
      "checks": ["typecheck"]
    }
  ]
}
```

Validation requirements:

- schema-validated;
- bounded number of units;
- unique slug keys;
- acyclic `dependsOn`;
- no dependency on unknown units;
- repository-relative path prefixes only;
- no `..`, absolute paths or shell text;
- independent ready units may not claim overlapping path prefixes;
- the planner must prefer one cohesive unit instead of artificial splitting;
- planner cannot grant permissions or choose credentials;
- planner cannot select production actions.

If the plan has no valid manifest, has only one useful unit, has ambiguous/overlapping ownership, or the task is not eligible for safe write isolation, the stage automatically uses the existing single-agent path. Team failure to plan is an optimization failure, not a task failure.

For adaptive Fix stages, where the original implementation manifest may no longer match the failure, allow one bounded read-only decomposition run using fresh test/review evidence. If decomposition fails or does not find two independent fixes, use one fixer.

### 3.4 Durable work-unit model

Add one new persisted work-unit model instead of trying to infer teams from log text.

At the currently inspected schema, append the next available additive migration (19 if still free at implementation time).

Proposed table:

```text
stage_work_units
- id
- task_id
- stage_id
- stage_key
- unit_key
- title
- focus
- status
- ordinal
- dependencies_json
- path_scope_json
- manifest_hash
- base_commit
- result_commit
- agent_id
- model
- effort
- attempt
- reused_from
- summary
- error_class
- error_message
- started_at
- finished_at
- created_at
```

Add nullable `work_unit_id` to `executions`.

Add nullable `work_unit_key` to `usage_events` / the usage attribution types so worker usage is visible without abusing `workflow_step`.

All changes are additive:

- old rows remain valid with `NULL`;
- existing queries continue to work;
- task deletion cascades worker rows;
- migrations must never rewrite historical task/workflow data.

Add Store methods for insert/update/get/list work units. Keep work-unit status transitions explicit and testable.

Suggested statuses:

`QUEUED`, `RUNNING`, `SUCCESS`, `FAILED`, `CANCELLED`, `SKIPPED`, `REUSED`.

### 3.5 Bounded scheduler, not a second workflow engine

Create a small Stage Team scheduler used only from `StageRunners.runAgent()` when `def.team` is present.

Do not modify top-level workflow transitions to understand arbitrary work-unit graphs.

Scheduler behavior:

1. resolve/validate the work-unit manifest;
2. persist the units;
3. find units whose dependencies are satisfied;
4. start at most `min(stage.maxWorkers, globalTeamLimit)` ready units;
5. execute ready units in waves;
6. wait for the wave;
7. aggregate read-only outputs or integrate write outputs;
8. continue with newly-unblocked units;
9. return one normal `StageOutcome` to `runLoop()`.

This keeps the existing engine's stage/fix/review semantics intact.

### 3.6 Read-only team execution

For Level 1 stages:

- workers may share the task worktree because the stage cannot write;
- every worker receives the same frozen stage context plus its own focus/work-unit contract;
- every worker uses its own:
  - `Execution` row;
  - MCP session;
  - logs;
  - usage event;
  - artifact;
- `RunControl.cancelCurrent` becomes a composite cancellation that stops all active workers;
- fixed assessment/review workers can run truly concurrently.

Aggregation:

- store every full worker report separately;
- produce one bounded parent-stage aggregate artifact containing worker headings and summaries;
- no extra synthesis agent is required for architecture assessment because the next Planner stage is already the synthesizer;
- for verdict teams, define one `primary` full-coverage reviewer and optional specialist reviewers;
- any required reviewer `FAIL` makes the parent stage `FAIL`;
- `PASS` requires the primary reviewer to satisfy the existing diff-coverage rules.

### 3.7 Write-team isolation

Never run two write-capable workers in the same parent worktree.

A write team is eligible only when:

- the task is already in isolated worktree mode;
- the task is single-repository in the first implementation;
- the stage is Level 2 or 3;
- at least two independent work units have non-overlapping declared path scopes.

Otherwise use the existing single-agent path.

For each parallel wave:

1. create a hidden checkpoint commit of the parent task working tree using the existing checkpoint primitives;
2. create one disposable detached child worktree per ready worker from that exact checkpoint commit;
3. start each worker with its child worktree as:
   - CLI cwd;
   - MCP cwd;
   - only filesystem/tool root;
4. worker may change anything inside the disposable child worktree, but the result is not trusted yet;
5. capture the worker result as another hidden commit so untracked/new/deleted/binary files are included;
6. compare base vs result and validate all changed paths against that unit's declared scope;
7. if any worker touches undeclared paths, mark it failed and integrate nothing from that wave;
8. after every required worker in the wave succeeds, apply worker deltas to the parent task worktree in deterministic manifest order;
9. before applying each delta, verify the parent has not changed those paths since the wave base;
10. any overlap/conflict becomes an explicit integration failure rather than overwriting data;
11. remove child worktrees after result capture/integration; keep hidden result refs long enough for retry/recovery, then clean them at task completion/cancellation.

Add a focused Git helper in `packages/git` for "apply result tree delta if target paths still equal base". Reuse the existing private-index/checkpoint patterns; do not implement this with shell string concatenation or unsafe force checkout.

### 3.8 Integration pass after several writers

Parallel patches can be individually correct but semantically incompatible.

After two or more write units are integrated, run one short lead integration pass on the real parent task worktree.

Its prompt is narrowly scoped:

- read all worker summaries;
- inspect the integrated diff;
- reconcile contracts/types/imports/interfaces;
- fix only integration issues;
- run only targeted checks for the touched areas;
- produce the normal role artifact expected by downstream stages.

This is not a second full implementation. It is the stage's final consistency pass.

The existing system Test stage remains authoritative after it.

### 3.9 Reuse existing assignment/routing logic

Do not let the planner choose provider credentials or bypass role defaults.

Resolution order for a worker:

1. explicit fixed-worker assignment, when configured;
2. parent stage resolved assignment;
3. existing repository/task overrides continue to apply.

Adaptive workers initially inherit the parent stage assignment. The schema must leave room for a future specialty-aware routing policy without implementing it here.

If a provider is unavailable:

- use the current agent error classification;
- retry only within existing bounded retry policy;
- stage retry may reuse completed work units only when the manifest hash and stage-base checkpoint are unchanged;
- otherwise rerun the stage safely;
- Chairman still sees one parent-stage failure and uses the existing recovery/action gateway.

### 3.10 Usage, budgets and limits

Every worker must still launch through `AgentRegistry.launch()`.

Therefore current subscription guard, usage meter, pricing/cost ledger and budget policy remain the only provider-attempt boundary.

Enhance attribution with `workUnitKey`.

Chairman `maxAgentRuns` must count every worker/decomposer/integration agent execution. Do not create a separate counter that bypasses existing limits.

Expose in task/usage views:

- parent stage;
- work-unit name;
- agent/model/effort;
- worker duration;
- wall-clock stage duration;
- summed agent time;
- worker count;
- failed/retried/reused workers.

Do not claim "parallel savings" unless computed from recorded timings. If shown, define it as `sum(worker durations) - team wall-clock duration`, never as provider cost savings.

### 3.11 Conservative parallel test execution

Keep orchestrator-observed tests as the source of truth.

Extend `repositoryCommandSchema` with an optional `parallelSafe: boolean = false`.

Rules:

- current commands remain sequential by default;
- only commands explicitly marked parallel-safe may run concurrently;
- destructive/deploy/staging commands are never parallelized by this mechanism;
- command classification/approval still happens before dispatch;
- each command keeps its own `Execution` and `TestRun`;
- first hard failure cancels unfinished siblings where cancellation is supported, then uses the existing classification/recovery logic;
- test reuse, baseline classification, affected-tests selection and release `tree_id` guarantees must remain unchanged.

Do not replace deterministic tests with AI "test agents." AI workers may create tests or review failures, but PASS still comes from actual repository commands/app checks.

### 3.12 Chairman and recovery behavior

Keep the Chairman at stage level and feed it worker evidence.

Add to Chairman evidence/snapshot:

- number of work units;
- running/succeeded/failed unit summaries;
- failed unit key + provider/error class;
- integration conflict/scope violation when present.

Restart rules:

- any `RUNNING` work unit whose execution was interrupted becomes interrupted/failed consistently with current execution recovery;
- child worktrees/results already recorded as successful may be reused only after validating their base and manifest hash;
- never integrate a partially-written child worktree after restart;
- stale child worktrees are cleaned or quarantined, not silently reused;
- resume/retry must never start a second worker beside a still-live old process.

Cancellation/pause:

- cancel stops all active workers;
- pause-current-stage stops all workers and leaves the parent task worktree unchanged for an unintegrated wave;
- pause-after-stage lets the current team finish, integrate, and then pauses at the normal stage boundary.

### 3.13 API and realtime

Reuse the existing task APIs and realtime channel.

Add a read endpoint:

`GET /api/tasks/:id/work-units`

No work-unit mutation API is required in the first implementation.

Add a realtime message for work-unit changes, or the equivalent existing invalidation path if inspection during implementation finds a cleaner established pattern.

Remote/cloud behavior must be updated so work-unit progress is visible for remotely controlled tasks without exposing local filesystem paths beyond the same rules already used for task details/executions.

Keep existing task reroute/assignment endpoints unchanged.

### 3.14 Dashboard UX

#### Workflows page

For agent stages only, show:

```text
Execution
- Single agent
- Fixed team
- Adaptive team

Maximum workers: 2 / 3 / 4
```

For Fixed Team, allow 2..4 worker rows:

- worker label/focus;
- agent;
- model;
- effort;
- primary reviewer switch where relevant.

Built-in workflows remain read-only and show the resolved team configuration.

Do not turn the page into a node-graph editor.

#### Task page

Keep the existing Stage Timeline as the primary workflow view.

For a team stage, show a compact state such as:

```text
Implement
Team 2/3 running
```

Add a Stage Team panel in the Execution view:

```text
Frontend       Claude   RUNNING    03:12
Backend        Codex    SUCCESS    02:41
Shared types   Claude   SUCCESS    01:08
Integration    Waiting
```

Logs continue to use the existing execution/log pipeline; execution labels gain the work-unit title.

Show individual worker artifacts in the existing Artifacts view using clear names.

### 3.15 Built-in Architecture workflow after verification

Update future Architecture tasks only; existing task snapshots stay unchanged.

Recommended shape:

```text
Architecture assessment
  fixed read-only team:
    - Codex architecture assessment
    - Claude independent assessment
        |
        v
Consolidated plan
  single strong planner
  emits execution manifest when useful
        |
        v
Implement
  adaptive team, max 3
  single-agent fallback
        |
        v
Test
  deterministic commands
  parallel only where explicitly marked safe
        |
        v
Review
  fixed read-only team, max 2
  primary correctness/full-diff reviewer
  independent risk/architecture reviewer
        |
        +---- FAIL ---> Fix
        |
       PASS
        v
Complete
```

`Fix` may use adaptive team mode only when fresh failure decomposition finds two genuinely independent repair units; otherwise one fixer.

The current separate sequential `second-assessment` stage can be removed from the built-in Architecture happy path after the fixed two-worker assessment team is proven, which directly saves one serial agent-stage duration.

Roll the generic feature out conservatively:

- Architecture opts in first.
- Other built-ins remain behavior-compatible until real timing/quality evidence is recorded.
- Custom workflows can opt in immediately after feature verification.

---

## 4. Implementation steps

### Step 1 - Re-baseline the real repository before editing

Before implementation:

- pull/inspect current `main`;
- confirm no newer migration has taken the next version;
- inspect uncommitted work/shared worktrees;
- run the current project-prescribed baseline checks;
- back up the live `acc.db` with the same SQLite online-backup approach used by prior migrations;
- verify backup `integrity_check = ok`;
- record current task/event/execution/usage counts;
- do not touch another session's uncommitted files.

### Step 2 - Shared schemas and types

Update existing shared contracts:

- `StageDefinition.team`;
- fixed worker schema;
- adaptive manifest schema;
- `StageWorkUnit` types/statuses;
- `Execution.workUnitId`;
- usage event/attribution `workUnitKey`;
- `RepositoryCommand.parallelSafe`;
- realtime message type if required.

Update `validateWorkflow()` so invalid team configuration is rejected before save/start.

Add schema/validation tests first.

### Step 3 - Additive persistence

Append the next free migration.

Add:

- `stage_work_units`;
- `executions.work_unit_id`;
- `usage_events.work_unit_key`;
- indexes for task/stage/status lookup.

Extend `Store` with bounded work-unit CRUD/query methods.

Migration verification:

- fresh DB applies all migrations;
- copy of pre-migration DB upgrades once;
- row counts of existing tables remain unchanged;
- `integrity_check = ok`;
- second startup is idempotent.

### Step 4 - Git worker-isolation primitives

Reuse `createCheckpoint`, `addDetachedWorktree`, `removeWorktree`, private-index helpers and existing safe path handling.

Add the smallest missing helpers for:

- creating a child worktree from a checkpoint commit;
- capturing a worker result commit;
- listing changed paths base -> result;
- validating scope;
- atomically applying a worker result delta to the parent only when target paths still match the base;
- removing/quarantining child worktrees;
- cleaning `refs/acc/...` team refs.

Cover new files, deletions, binary files, renames, CRLF, untracked files and Windows paths in package-level Git tests.

### Step 5 - Work-unit prompt and manifest handling

Update Planner prompt/template:

- explain when parallel decomposition is useful;
- explicitly forbid artificial splitting;
- emit bounded execution manifest when useful.

Add a strict parser:

- extract only the designated manifest block;
- schema-validate;
- reject invalid/oversized data;
- hash the normalized manifest;
- fall back safely.

Add the adaptive fallback decomposer for stages that need fresh work partitioning, especially Fix.

All decomposition runs go through `AgentRegistry.launch()` and are attributed/metered.

### Step 6 - Stage Team runner

Implement a new internal Stage Team component under the orchestrator engine, then call it from `StageRunners.runAgent()`.

Required behavior:

- fixed teams;
- adaptive teams;
- bounded ready queue;
- dependency waves;
- global/stage worker cap;
- composite cancellation;
- read-only aggregation;
- write-worker child worktrees;
- result validation;
- deterministic integration;
- final integration pass;
- one `StageOutcome` returned to the existing engine.

Do not fork the workflow transition logic.

### Step 7 - Recovery and retry reuse

Add persisted recovery semantics:

- successful unit reuse only when base commit + manifest hash + unit definition match;
- failed/interrupted units rerun;
- no integration from partial work;
- cancelled workers remain cancelled;
- stale PIDs/processes are reconciled using the existing process/execution recovery path;
- restart does not duplicate agent executions.

Update Chairman evidence and tests, not Chairman's fundamental stage-level action model.

### Step 8 - Parallel-safe repository checks

Add `parallelSafe` to repository command editing/storage.

Refactor the current sequential `runCommands()` loop into:

- unchanged sequential path for current/default commands;
- bounded parallel batch for commands explicitly marked safe;
- composite cancellation;
- same `TestRun`, classification, reuse and failure semantics.

Do not parallelize staging/deploy/release actions.

### Step 9 - API, realtime and remote sync

Add read access to work units and realtime updates.

Update:

- local HTTP routes;
- API hooks;
- realtime invalidation;
- remote-node mirror/relay behavior where necessary;
- redaction/egress tests.

No raw child-worktree path should be exposed remotely unless the existing task path policy already permits the same data.

### Step 10 - Dashboard

Update:

- `WorkflowsPage.tsx` for team configuration;
- task timeline metadata for team progress;
- `ExecutionTab.tsx` with Stage Team panel;
- `LogsTab.tsx` execution labels to include work-unit name;
- artifacts presentation only as needed.

Maintain current responsive/accessibility patterns and `design.md`.

### Step 11 - Built-in Architecture profile

After framework tests are green:

- replace the serial two-stage architecture assessments with one fixed two-worker assessment team;
- keep one consolidated planner;
- enable adaptive Implement with max 3;
- enable fixed two-worker Review;
- enable adaptive Fix with conservative single-agent fallback;
- keep Test deterministic;
- bump built-in workflow version through the existing `WorkflowService.loadBuiltins()` behavior.

Do not alter historical task snapshots.

### Step 12 - Documentation and completion report

Update verified system docs:

- workflow engine;
- agents;
- usage;
- checkpoints/worktrees;
- Chairman/recovery;
- orchestrator/API;
- dashboard behavior.

Document:

- single-agent fallback;
- team eligibility;
- worker limits;
- write isolation;
- failure/restart semantics;
- usage attribution;
- known limitations.

---

## 5. Failure handling and recovery

| Failure | Required behavior |
|---|---|
| Manifest missing/invalid | Event explains why; use existing single-agent stage |
| Only one useful unit | Run single agent; no unnecessary team startup |
| Independent units overlap path scope | Do not parallelize those writers; serialize/fallback |
| Worker provider/auth/usage failure | Record on that unit; bounded retry/reroute policy; never hide failure |
| One worker fails in a write wave | Integrate nothing from that wave |
| Worker modifies paths outside its scope | Mark unit failed; preserve parent unchanged |
| Worker child worktree creation fails | Clean created children; fallback single if safe, otherwise normal stage error |
| Worker result capture fails | Do not integrate; fail/retry unit |
| Parent path changed before integration | Explicit integration conflict; never overwrite |
| Integration pass fails | Parent stage fails through existing recovery path |
| Test sibling fails in a parallel-safe batch | Cancel unfinished siblings where possible; classify failure normally |
| Pause/cancel | Stop every active child execution; no half-integrated wave |
| Orchestrator restart | Mark interrupted work; kill/reconcile surviving processes; reuse only validated completed results |
| Cleanup cannot remove child worktree | Preserve evidence/ref, mark cleanup warning, retry cleanup; never force-delete the user's workspace |
| Chairman/runtime limit reached mid-team | Stop starting new units and stop at the existing limit boundary |
| Database write failure | Do not start untracked worker work; stage stops with explicit internal error |
| Realtime/UI disconnect | Execution continues locally; DB remains authoritative; UI catches up from API |

Recovery must prefer reusing already-proven worker results over rerunning them, but only with exact base/manifest identity.

---

## 6. Security and data protection

1. Keep Claude/Codex native recursive Agent tools disabled.
2. Worker permission level cannot exceed the parent stage.
3. Level 5 / production stages never run as teams.
4. Write workers never receive the parent task worktree as their filesystem root.
5. Every write worker receives only its disposable child worktree through:
   - process cwd;
   - MCP scope cwd;
   - MCP roots.
6. Existing credential scoping remains repository-based.
7. Planner manifests contain no credentials, tokens or arbitrary commands.
8. Validate every persisted work-unit/path field with bounded schemas.
9. Result path scope is enforced by the orchestrator before integration; prompts are not considered a security boundary.
10. Never use force checkout/reset to merge worker output into the parent.
11. Existing pre-existing user changes remain protected.
12. Child worktree names/refs are generated by the system, not taken directly from model text.
13. All output/error/artifact content continues through existing redaction.
14. Usage ledger stores metadata/tokens/cost, never prompts or replies.
15. Remote/cloud egress must not leak credential values or new local path details.
16. Database migration is additive with backup + integrity verification.
17. Task completion/cancellation cleans disposable worktrees/refs only under Control Center-owned locations/ref prefixes.
18. No worker can create another worker or increase `maxWorkers`.

---

## 7. Testing and verification

### 7.1 Unit/schema tests

Verify:

- valid/invalid fixed team definitions;
- valid/invalid adaptive manifest;
- cycle detection;
- duplicate keys;
- worker count caps;
- permission restrictions;
- path-prefix validation;
- `parallelSafe` default false;
- old workflow JSON still parses unchanged.

### 7.2 Migration/store tests

Verify:

- v18/current -> next migration on a copied DB;
- fresh DB;
- rerun idempotency;
- all pre-existing rows/counts preserved;
- work-unit CRUD/order;
- execution/usage nullable linkage;
- task deletion cleanup.

### 7.3 Git isolation/integration tests

Use real temporary Git repositories.

Cases:

- parent has uncommitted tracked changes before team stage;
- parent has untracked files;
- two disjoint workers modify different files;
- new file;
- delete file;
- rename;
- binary file;
- CRLF on Windows behavior;
- one worker changes an out-of-scope file;
- two workers unexpectedly touch same file;
- parent changes after worker base;
- child worktree cleanup success/failure;
- no branch/index/status change in the operator's original checkout.

### 7.4 Stage Team scheduler tests

With simulated agents:

- two fixed read-only workers actually overlap in wall-clock time;
- max worker cap is respected;
- dependency chain does not start early;
- small adaptive manifest falls back to one run;
- invalid manifest falls back safely;
- writer workers receive distinct cwd values;
- no parent file changes before successful wave integration;
- one failed worker leaves parent untouched;
- successful results merge deterministically;
- integration pass sees all worker results;
- pause/cancel cancels every active execution;
- retry reuses valid success and reruns only invalid/failed work;
- changed base invalidates reuse;
- usage/Chairman run limits count all child runs.

### 7.5 Engine/recovery tests

Verify the real workflow loop:

- parent stage still creates one normal stage instance/outcome;
- `next`, `onFail` and fix cycles behave unchanged;
- verdict-team FAIL routes to Fix;
- restart during a worker wave does not duplicate a surviving process;
- restart after completed worker result but before integration safely reuses or revalidates;
- provider unavailable/reroute behavior remains truthful;
- task report contains team evidence;
- completion gate still requires real tests/review.

### 7.6 Test-stage parallelism tests

Verify:

- old commands run in the same serial order by default;
- only `parallelSafe` commands overlap;
- failure/cancel behavior;
- affected-test selection unchanged;
- baseline failure classification unchanged;
- test reuse unchanged;
- release tree proof unchanged.

### 7.7 API/realtime/remote tests

Verify:

- work-unit endpoint authorization/404 behavior;
- realtime state changes;
- redacted worker failures;
- remote task catches up after disconnect/reconnect;
- no child path/secret leakage;
- existing task APIs stay backward compatible.

### 7.8 Dashboard/Playwright

Test desktop and mobile:

- built-in read-only Stage Team summary;
- custom workflow team editor validation;
- running 1/3 -> 2/3 -> complete state;
- worker failure/retry state;
- logs can select each worker execution;
- Execution panel remains usable at mobile width;
- keyboard/focus/accessibility;
- no console errors or failed requests.

### 7.9 Real behavior verification

After automated tests:

1. Start a disposable real repository task with a task that naturally spans at least two independent areas.
2. Run Architecture workflow on the new build.
3. Prove from timestamps that at least two worker executions overlap.
4. Prove each write worker uses a distinct child worktree.
5. Prove the parent task result contains both changes and the original operator checkout is untouched.
6. Prove configured deterministic tests run after the integrated result.
7. Prove review sees the combined diff.
8. Record stage wall time, summed agent time and usage.
9. Compare with a single-agent run of the same controlled fixture or a deterministic simulated timing fixture.
10. Re-run after any discovered defect.

A deterministic timing fixture should demonstrate real concurrency: for two equal simulated workers, team-stage wall time must be materially below sequential time (target <= 70% of the sequential fixture, allowing orchestration overhead). Do not require a fixed speed percentage from live subscription providers because network/model latency is external.

---

## 8. Success criteria

The task is complete only when all of the following are verified:

1. Existing workflows with no `team` configuration behave exactly as before.
2. Architecture assessment runs Codex and Claude concurrently under one logical stage.
3. Adaptive implementation uses multiple workers only for validated independent units.
4. Small/cohesive work automatically stays single-agent.
5. Parallel writers never share the parent worktree.
6. A failed/out-of-scope/conflicting worker cannot partially overwrite the parent.
7. All worker runs are persisted, logged, cancellable and visible.
8. Every worker/decomposer/integration run goes through `AgentRegistry.launch()` and appears in usage accounting.
9. Chairman agent-run/runtime limits include team workers.
10. Stage retry/restart never creates duplicate concurrent workers.
11. Deterministic Test/App Check remains the source of truth for verification.
12. Existing test classification, affected-tests, reuse and release proof remain correct.
13. Current approvals/permission ceilings cannot be bypassed by a worker.
14. Native hidden Agent recursion remains unavailable.
15. Operator working folders and pre-existing changes remain protected.
16. Database migration preserves all existing data and passes integrity checks.
17. Workflow/API/realtime/cloud behavior remains backward compatible.
18. Dashboard shows clear stage-team progress and individual worker logs.
19. Automated unit/integration/Playwright suites pass with no new regressions.
20. A real disposable Architecture task proves parallel execution, safe integration, final testing and review end to end.
21. Final report records actual wall time, agent time, worker count and any remaining limitations without invented savings.

---

## 9. Found for Later

Do not expand the current implementation into these items:

1. **Multi-repository write teams** - current multi-repository workspace support is strong, but safe nested worker worktrees and integration across several repositories deserves its own design and test matrix.
2. **Specialty-aware automatic model routing** - use historical usage/success/latency to decide Claude vs Codex per frontend/backend/security unit.
3. **Per-work-unit manual reroute/retry controls** - useful after the core automatic retry/reuse behavior is stable.
4. **Distributed workers across remote Control Center nodes** - child work must remain local in this plan.
5. **Automatic detection of parallel-safe repository commands** - keep explicit opt-in first.
6. **Learning-loop optimization of team size** - later use observed lead time and failure rates to decide when 2 vs 3 workers is beneficial.
7. **Graph visualizer** - the current workflow UI should remain simple; a DAG view is not required to execute Stage Teams correctly.

---

## 10. Next Recommended Task

Create a focused **ADAPTIVE_WORKER_ROUTING_PLAN.md** after Stage Teams are proven in production-like runs.

That task should use the existing Usage & Costs ledger plus work-unit outcomes to choose the best available agent/model/effort for a worker specialty while respecting:

- subscription availability;
- user-configured role preferences;
- usage limits;
- measured latency;
- retry/failure history;
- no paid/API fallback when subscription-only policy is active.

Do not implement automatic routing before Stage Teams have trustworthy per-worker execution and outcome data.

---

## 11. Final execution prompt

`/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.`
