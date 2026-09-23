---
title: Chairman intelligence upgrade — evidence-driven, closed-loop recovery
source: conversation 2026-09-23 (CHAIRMAN_INTELLIGENCE_PLAN.md, attached to /implement-plan)
created: 2026-09-23
status: done
---

# Chairman intelligence upgrade — evidence-driven, closed-loop recovery

## Steps

<!-- Phase numbers follow CHAIRMAN_INTELLIGENCE_PLAN.md §4 (copied under Context). -->

- [x] 1. Phase 0 — baseline: record HEAD, highest migration, unrelated dirty work; run the Chairman unit/integration tests, `pnpm typecheck`, `pnpm build` and note any pre-existing failure — done when: the Ledger names the SHA, the migration number, the other session's files and each baseline result — check: `pnpm vitest run apps/orchestrator/test/chairman.test.ts apps/orchestrator/test/chairman-units.test.ts && pnpm typecheck && pnpm build`
- [x] 2. Phase 1 — shared contracts in `packages/shared/src/chairman.ts`: `ChairmanDiagnosis(+Confidence)`, `ChairmanStrategyRun`, `ChairmanStrategyOutcomeStatus`, `StrategyKind`, optional `strategy` on `ChairmanDecision`; no new action type — done when: the shared package and every consumer typecheck — check: `pnpm typecheck`
- [x] 3. Phase 2 — next free migration `chairman_strategy_runs` (decision_id unique FK → chairman_decisions ON DELETE CASCADE, index (task_id, started_at), structured fields only) with migration tests (fresh, upgrade from previous version, Chairman rows preserved, uniqueness, cascade, integrity_check) — done when: migration tests pass and earlier migrations are byte-identical — check: `pnpm vitest run apps/orchestrator/test/migrations.test.ts && git diff HEAD -- apps/orchestrator/src/db/migrations.ts | grep -c '^-[^-]'` (expect 0)
- [x] 4. Phase 3 — `ChairmanStore` strategy-run methods (insert, get, latestOpen, finish idempotently, list, failedStrategyFamilies) and `listDecisions` decorated with `strategy` — done when: unit tests cover insert/finish-twice/list/decorate — check: `pnpm vitest run apps/orchestrator/test/chairman-units.test.ts`
- [x] 5. Phase 4 — `ChairmanEvidenceService` (`evidence.ts`): `forRecovery`/`forChat`, per-section and total caps, redaction, fencing, reliability labels, deterministic order, digest, unavailable sections; wired from `app.ts` with the existing `ToolStore`; `Chairman.evidence()` and `ChairmanChat.evidence()` replaced — done when: unit tests prove determinism, caps, redaction before prompt, fencing, labels, test-log extraction, tool summaries only, no raw diff, missing-source tolerance — check: `pnpm vitest run apps/orchestrator/test/chairman-units.test.ts`
- [x] 6. Phase 5 — diagnosis in `reasoner.ts`: recovery schema gains `diagnosis {summary, confidence}`; category stays deterministic; deterministic diagnosis on outage/malformed output — done when: unit tests prove model diagnosis cannot change the category and malformed diagnosis falls back — check: `pnpm vitest run apps/orchestrator/test/chairman-units.test.ts`
- [x] 7. Phase 6 — `chairman.ts` records a `RUNNING` strategy run per recovery decision (contract version, cycle, trigger, kind, target stage/agent, category/hash, diagnosis, evidence digest, expected result, health before) before executing through the gateway; a gateway rejection finalizes it `SUPERSEDED`/`INCONCLUSIVE`, never `FAILED` — done when: integration tests show a strategy run per recovery decision and a stale rejection that is not an engineering failure — check: `pnpm vitest run apps/orchestrator/test/chairman.test.ts`
- [x] 8. Phase 7 — `outcomes.ts` deterministic evaluator (SUCCEEDED / IMPROVED / FAILED / REGRESSED / INCONCLUSIVE / SUPERSEDED) called from afterSuccess, onFailure (before the next decision), onError, beforeComplete, contract revision, onTerminal and onStartup; idempotent — done when: unit tests cover every status and idempotency; integration tests show success, partial progress, no improvement, regression, restart reconciliation and goal change — check: `pnpm vitest run apps/orchestrator/test/chairman-units.test.ts apps/orchestrator/test/chairman.test.ts`
- [x] 9. Phase 8 — outcome-aware ranking in `policy.ts`: FAILED/REGRESSED families for the same contract + category + target stage move behind other safe candidates; INCONCLUSIVE and older contracts never penalise; rollback-on-regression, replan-on-mismatch and provider reroute stay first — done when: unit tests prove each rule and the old ordering invariants still pass — check: `pnpm vitest run apps/orchestrator/test/chairman-units.test.ts`
- [x] 10. Phase 9 — snapshot gains compact `lastStrategy {kind, diagnosis, outcome}`; chat uses the shared evidence service; `/status` stays deterministic and mentions the last outcome; ask-vs-act unchanged — done when: chat tests still pass and a unit/integration assertion shows the new snapshot field — check: `pnpm vitest run apps/orchestrator/test/chairman.test.ts`
- [x] 11. Phase 10 — realtime/API: overview keys unchanged, decisions enriched, a finalized outcome republishes `chairman.decision` with the same id; dashboard upsert keeps one card — done when: API test asserts same keys + `strategy` present and the bus sees a republished decision id — check: `pnpm vitest run apps/orchestrator/test/chairman.test.ts`
- [x] 12. §6/§7 remote egress: a planted secret in failure evidence never appears in diagnosis, outcome summary, evidence metadata, or the scrubbed `chairman.decision` message; no absolute path leaks — done when: the egress test passes — check: `pnpm vitest run apps/orchestrator/test/remote-egress.test.ts`
- [x] 13. Phase 11 — `ChairmanDrawer.tsx` decision card shows diagnosis (category + confidence) and outcome (Resolved / Improved / No improvement / Regressed / Inconclusive / Superseded) with screen-reader labels; no raw evidence — done when: the Chairman Playwright spec asserts diagnosis, expected and outcome on the same card, one card per decision, phone width, both themes, axe clean — check: `pnpm build && pnpm --filter @acc/dashboard exec playwright test e2e/chairman.spec.ts`
- [x] 14. Phase 12 — docs: `docs/systems/chairman.md` (evidence sources and trust classes, diagnosis, strategy lifecycle, outcomes, restart, security, degraded mode, retention, API/realtime), `orchestrator.md` migration list; `design.md` only if the card contract changes — done when: docs guard passes and no doc describes decisions without outcome feedback — check: `pnpm docs:guard`
- [x] 15. §7 real behaviour: one simulated full-autopilot Chairman scenario against a real orchestrator process — decision, diagnosis, gateway action, test result, strategy outcome, next strategy, final report, persistence across restart — done when: the Ledger records what was observed through the HTTP API before and after a restart — check: `manual: Ledger line with the observed decision/outcome ids`
- [x] 16. §5 live database: back up the operator's live `acc.db` with the SQLite online backup API, verify the copy opens with `integrity_check = ok`, apply the new migration to a copy of that backup and confirm row counts unchanged — done when: the Ledger names the backup path, the before/after versions and counts — check: `manual: Ledger line with backup path and integrity result`

## Tail

- [x] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat` reviewed hunk by hunk
- [x] T2. Similar-issue sweep — done when: other readers of `chairman_decisions`, `ChairmanDecision`, `fenceEvidence` and the `chairman.decision` message (VS Code WebView, remote egress, cloud mirror) were searched for breakage — check: `manual: list what was searched and what was found`
- [x] T3. Lint and tests green — done when: `pnpm check`, `pnpm build` and `pnpm e2e` exit 0, or any failure is shown identical to the recorded baseline — check: `pnpm check && pnpm build && pnpm e2e`
- [x] T4. Docs synced per the repo's rules — done when: the system doc reflects the change and `Last verified` is updated — check: `git diff --stat docs/`
- [x] T5. Committed path-scoped and pushed — done when: `git status` shows none of this work uncommitted and the push succeeded — check: `git log origin/main..HEAD --oneline`
- [x] T6. Confirmed live where the push deploys → no change needed: no deploy on push — done when: this step says "no deploy on push" for this repo (CI only; cloud deploys are manual `workflow_dispatch`) — check: `manual: .github/workflows triggers`
- [x] T7. A claim registered for this change → no change needed: no observable outcome beyond this run — the repo has no claims register — done when: the repo's claims register holds an entry, or this step says "no observable outcome" with the reason — check: `manual: name the claim and its deadline, or say why the change has no observable outcome`

## Context

The plan as attached, verbatim.

---

# Chairman Intelligence Upgrade Plan

**Plan file:** `CHAIRMAN_INTELLIGENCE_PLAN.md`  
**Verified repository:** `digitronics2025/AI-Development-Control-Center`  
**Investigation baseline:** `main` at `e8a5f712fc031548d602cf0ccfea2d8fe9ad7342` on 2026-09-23

## 1. Goal

Upgrade the existing task-scoped Chairman from a mostly reactive recovery selector into an **evidence-driven, closed-loop supervisor** that makes better recovery decisions, explains them clearly, observes whether they actually worked, and avoids repeating strategies that produced no useful result.

The upgrade must preserve the current safety model:

- `TaskEngine` remains the only workflow state authority.
- `ActionGateway` remains the only path for Chairman mutations.
- The Chairman reasoning agent remains read-only and cannot directly edit the repository, run arbitrary shell commands, bypass approvals, or create new action types.
- Existing deterministic behavior remains available when the Chairman reasoning model is unavailable.
- Existing Autopilot, Discuss First, chat, checkpoints, approvals, directives, task limits, restart recovery, remote control, and cloud synchronization must remain compatible.

### Verified current architecture

The current system already has a strong Chairman foundation:

- `apps/orchestrator/src/chairman/chairman.ts` implements one Chairman service with one persisted session per task.
- `apps/orchestrator/src/engine/supervision.ts` exposes the task-engine hooks used by the Chairman.
- `snapshot.ts` rebuilds fresh task state before decisions rather than trusting stale model memory.
- `signatures.ts` normalizes failures and creates stable hashes.
- `progress.ts` derives `PROGRESSING`, `STABLE`, `STALLED`, `REGRESSING`, or `UNKNOWN`.
- `policy.ts` creates a bounded set of safe recovery candidates.
- `reasoner.ts` runs the configured Chairman agent read-only at permission level 1 and only lets it choose a validated candidate id.
- `gateway.ts` performs schema validation, task-version checks, authorization, idempotency, locking, auditing, and the actual engine command.
- `gate.ts` prevents false completion without objective checks.
- `checkpoints.ts` protects write stages and rollback.
- `watchdog.ts` handles ghost, dead, timed-out, and silent workers.
- `chat.ts` keeps ask-vs-act separation and prevents questions from mutating the task.
- `chairman_decisions.expected_result` already exists and is displayed in `ChairmanDrawer.tsx`.
- Existing tests cover recovery cycles, regression rollback, plan mismatch, provider rerouting, hard blockers, model degradation, stale decisions, chat safety, restart recovery, prompt injection, checkpoints, completion gates, watchdog behavior, mobile UI, and accessibility.

### Root cause of the current Chairman limitation

The problem is **not lack of actions or lack of safety controls**. The problem is that decision quality is still based on a relatively narrow and short-lived view of the evidence.

Verified limitations in the current implementation:

1. Background recovery evidence in `Chairman.evidence()` is only the current failure detail plus the last few failure messages.
2. Chat has a separate evidence path in `ChairmanChat.evidence()` using review/verification/failure data, so evidence gathering is duplicated and inconsistent.
3. Recovery candidates are generated from a fixed trigger order. The reasoning model can choose among them, but it is not given a richer structured technical evidence packet.
4. `expectedResult` is persisted and shown to the user, but the system does not later evaluate whether that expected result was actually achieved.
5. `strategy_fingerprints` prevent an exact strategy/failure combination from repeating within a task, but the Chairman does not persist a structured result such as “this RCA strategy improved the task” or “this strategy regressed the task.”
6. Progress classification is objective but intentionally narrow: failure count and normalized failure hash. It does not connect a specific Chairman recovery decision to the result that followed it.
7. The current reasoner remains correctly isolated from the repository, but there is no dedicated bounded evidence service to safely give it the useful recorded facts that already exist elsewhere in the system.

The upgrade should fix those gaps without turning the Chairman into a second coding agent or a second workflow engine.

---

## 2. Scope

### Included

1. A single **Chairman Evidence Service** shared by background supervision and Chairman chat.
2. Structured, bounded, redacted evidence packets assembled from data the Control Center already records.
3. A lightweight **diagnosis layer** attached to recovery decisions.
4. A **strategy lifecycle/outcome record** that links each recovery decision to the objective result observed afterward.
5. Deterministic outcome evaluation using the existing test/review/verify/failure/progress signals.
6. Outcome-aware recovery ranking so an ineffective strategy family is deprioritized when another safe candidate exists.
7. Better Chairman state presented in the existing task Chairman drawer:
   - diagnosis
   - why the decision was made
   - expected result
   - observed outcome
8. Reuse of existing APIs and realtime transport wherever possible.
9. Additive database migration only if the verified current schema still requires one.
10. Full unit, integration, restart, security, API, realtime, dashboard, and Playwright verification.

### Explicitly excluded

- A global Chairman supervising multiple tasks/repositories.
- Cross-task machine learning or embeddings.
- Vector databases.
- Automatic model/effort selection based on historical statistics.
- A new workflow engine.
- New destructive Chairman actions.
- Direct repository-write access for the Chairman reasoning model.
- Direct PowerShell, shell, terminal, MCP, credential, or privileged-helper access for the Chairman reasoning model.
- Replacing `ActionGateway`.
- Replacing the existing failure-signature or completion-gate systems.
- Reworking the cloud-control project.
- Scheduler/concurrent-task changes.
- General UI redesign outside the Chairman surface.
- Fixing unrelated existing test/tooling issues unless they directly block this upgrade.

---

## 3. Enhanced design/architecture

### 3.1 Keep the existing authority boundaries

The desired flow is:

```text
TaskEngine / stage result
        |
        v
Chairman supervision hook
        |
        v
ChairmanEvidenceService
        |
        +----> deterministic failure signature / progress
        |
        v
Diagnosis + safe recovery candidates
        |
        v
Outcome-aware candidate ranking
        |
        +----> optional read-only Chairman Reasoner
        |          chooses only a validated candidate id
        v
ChairmanDecision
        |
        v
ActionGateway
        |
        v
TaskEngine
        |
        v
next objective observation
(test / review / verify / worker result / completion gate)
        |
        v
ChairmanOutcomeEvaluator
        |
        v
strategy outcome persisted + Chairman UI updated
```

No new path may bypass `ActionGateway` or mutate task state directly.

### 3.2 New `ChairmanEvidenceService`

Add a focused service, proposed file:

`apps/orchestrator/src/chairman/evidence.ts`

It should replace the duplicated ad-hoc evidence methods currently in `chairman.ts` and `chat.ts`.

The service should build an ephemeral `ChairmanEvidencePacket`. It must be regenerated from authoritative persisted state whenever a decision or answer is needed.

Suggested shape:

```ts
interface ChairmanEvidencePacket {
  purpose: 'recovery' | 'chat';
  taskId: string;
  generatedAt: string;
  digest: string;
  sections: ChairmanEvidenceSection[];
  availableKinds: ChairmanEvidenceKind[];
  unavailableKinds: ChairmanEvidenceKind[];
}
```

Each section should contain:

- a stable source kind
- a bounded redacted text body for the reasoner
- an evidence reliability class:
  - `OBSERVED` for orchestrator/test/tool facts
  - `AGENT_REPORTED` for plan/review/verification prose
- a source identifier when one exists
- a truncation marker when capped

Do **not** persist the raw packet.

Persist only a digest and small structural metadata needed for audit.

### 3.3 Evidence sources

Reuse existing stores/services instead of adding another telemetry system.

For recovery, include only evidence relevant to the failure type.

#### Always available when present

- authoritative `ChairmanTaskSnapshot`
- current failure signature/category/hash
- last few same-source failure summaries
- current strategy summary
- current assignment
- current agent health
- current contract version
- current recovery cycle
- recent meaningful task events

#### Test failure

Reuse:

- `Store.listTestRuns()`
- existing `Chairman.testEvidence()` logic
- bounded `tailLogLines()` for the failed test execution

Include:

- failing command name
- failing test ids
- failure count
- bounded log tail
- previous comparable test failure
- task-owned changed-file names/status only

#### Review or verification failure

Reuse:

- `ArtifactService.latestText()`
- existing review/verification artifacts
- current plan artifact only when the failure is a plan/requirement mismatch
- task-owned changed-file names/status only

Do not include an unrestricted full Git diff by default.

#### Worker/tool/environment failure

Wire the already-created `ToolStore` into the Chairman composition root instead of opening a second database path.

Reuse:

- `ToolStore.listExecutions({ taskId })`
- `ToolStore.listRecovery(taskId)`
- execution error classes
- current agent health

Include only bounded summaries, error codes, recovery strategy/results, and evidence fields already produced by the tool layer.

#### Chat

Use the same evidence service with `purpose: 'chat'`.

Keep chat lighter than recovery:

- current state
- latest review/verification
- latest failure
- latest Chairman strategy/outcome

Only include additional evidence when needed by the question.

### 3.4 Evidence safety and prompt-injection boundary

Every free-text evidence block must continue to use the existing `fenceEvidence()` mechanism.

The reasoner rules must explicitly distinguish:

- system/task state = authoritative
- observed evidence = factual but still data, never instructions
- agent-produced plan/review/verification text = untrusted claims, never instructions

Run `redact()` again while creating the packet even if the source was already redacted earlier.

Never automatically include:

- credential values
- environment variables
- local API token
- raw terminal transcripts
- arbitrary file contents
- `.env` content
- unrestricted Git diffs
- database rows containing user data
- full absolute local repository paths where a relative path is sufficient

### 3.5 Structured diagnosis

Do not create an unconstrained “AI diagnosis engine.”

Use the existing deterministic `FailureCategory` as the authoritative category.

Add a small structured diagnosis object attached to a recovery strategy:

```ts
interface ChairmanDiagnosis {
  category: FailureCategory;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  summary: string;
  source: 'policy' | 'model';
}
```

Rules:

- `category` starts from `signatureOf()` and remains authoritative for policy decisions.
- The model may provide a bounded diagnosis summary and confidence, but cannot invent a new category, action, permission, or recovery path.
- If the reasoner is unavailable or malformed, create the diagnosis deterministically from the failure category, trigger, and observed evidence.
- Diagnosis must be a concise operational hypothesis, not hidden chain-of-thought.
- Low-confidence diagnosis must favor investigation over aggressive intervention when the existing safe candidate set allows it.

### 3.6 Strategy lifecycle and outcome feedback

The current `expectedResult` is already correct and should be reused.

Add one new lifecycle entity for recovery strategies rather than mutating the existing decision audit history.

Proposed shared type:

```ts
interface ChairmanStrategyRun {
  decisionId: string;
  taskId: string;
  contractVersion: number;
  recoveryCycle: number;
  trigger: string;
  strategyFingerprint: string;
  strategyKind: StrategyKind;
  targetStageKey: string | null;
  targetAgentId: string | null;
  failureCategory: FailureCategory;
  failureHash: string;
  diagnosis: ChairmanDiagnosis;
  evidenceDigest: string;
  expectedResult: string;
  status:
    | 'RUNNING'
    | 'SUCCEEDED'
    | 'IMPROVED'
    | 'FAILED'
    | 'REGRESSED'
    | 'INCONCLUSIVE'
    | 'SUPERSEDED';
  outcomeSummary: string | null;
  healthBefore: ChairmanHealth;
  healthAfter: ChairmanHealth | null;
  startedAt: string;
  evaluatedAt: string | null;
}
```

The implementation may adjust exact field names, but keep the semantics.

### 3.7 Database design

At the verified baseline, local migrations end at version 6.

However, `docs/plans/myvault-credential-bridge.md` already describes another future migration as “migration 7.” Therefore:

**Do not hard-code migration number 7 from this plan.**

At implementation time:

1. inspect the latest `apps/orchestrator/src/db/migrations.ts`
2. determine the actual highest migration
3. append the next free version
4. never renumber or edit an already-applied migration

Preferred new table:

`chairman_strategy_runs`

Requirements:

- one row per recovery decision/strategy
- `decision_id` unique and foreign-keyed to `chairman_decisions`
- indexed by `(task_id, started_at)`
- structured fields only
- no raw logs, prompts, model replies, file contents, diffs, credentials, or secrets
- outcome finalization must be idempotent

Keep existing:

- `chairman_decisions`
- `chairman_actions`
- `failure_signatures`
- `chairman_sessions.strategy_fingerprints`

Do not remove or repurpose current fields in this task.

### 3.8 Outcome evaluator

Add a focused service, proposed file:

`apps/orchestrator/src/chairman/outcomes.ts`

It should evaluate the latest open strategy when new comparable evidence arrives.

Evaluation must be deterministic.

Suggested rules:

- same failure source resolves successfully -> `SUCCEEDED`
- `classifyProgress()` becomes `PROGRESSING` -> `IMPROVED`
- `classifyProgress()` becomes `REGRESSING` -> `REGRESSED`
- the same normalized failure remains stalled after the strategy -> `FAILED`
- a different unrelated failure replaces the old one with no clear comparable improvement -> `INCONCLUSIVE`
- task goal/contract changes before evaluation -> `SUPERSEDED`
- user cancellation -> `SUPERSEDED`
- task reaches objective completion gate -> latest compatible open strategy -> `SUCCEEDED`
- ambiguous evidence -> `INCONCLUSIVE`, never force a negative result

Do not parse the free-text `expectedResult` as executable logic.

`expectedResult` remains the human-readable prediction; actual outcome comes from objective system evidence.

### 3.9 Where outcome evaluation runs

Integrate with existing Chairman hooks instead of creating a polling loop.

Call outcome reconciliation from the natural observation points:

- `afterSuccess()`
- `onFailure()`
- `onError()`
- `beforeComplete()`
- contract revision / goal change
- terminal/cancel handling
- `onStartup()` reconciliation

The evaluator must be idempotent so restart or duplicate hook execution cannot create a second outcome.

### 3.10 Restart safety

On startup:

1. keep the current `engine.recover()` -> `chairman.onStartup()` order
2. reconcile any `RUNNING` strategy-run rows against already-recorded stage/test/failure evidence
3. finalize only when the evidence is sufficient
4. otherwise leave them open until the next comparable observation
5. never replay the Chairman action just to reconstruct an outcome

### 3.11 Outcome-aware recovery selection

Keep `recoveryCandidates()` as the safe candidate generator.

Add a small deterministic ranking pass after candidate generation.

Do not let historical outcomes create new actions.

Rules:

- exact fingerprints already tried remain excluded as today
- for the current contract version, a strategy family that produced `FAILED` or `REGRESSED` for the same failure category + target stage should be deprioritized behind other safe candidates
- `INCONCLUSIVE` must not penalize a strategy
- history from an older task contract must not poison the new goal
- regression must still prefer rollback when a valid checkpoint exists
- plan mismatch must still prefer re-plan
- provider/auth blockage must still prefer a healthy alternative agent when one exists
- if outcome-aware ranking leaves no better choice, retain the existing safe fallback order rather than hard-blocking prematurely

The reasoner may still choose any candidate in the final safe list.

If the reasoner is unavailable, the improved deterministic ordering chooses the first candidate.

### 3.12 Do not add automatic model/effort optimization yet

The code already supports `CHANGE_AGENT`, `CHANGE_MODEL`, and `CHANGE_EFFORT`.

Do not introduce statistical automatic routing in this plan.

This upgrade should first create reliable strategy outcomes. Those records become the trustworthy dataset for a later adaptive-routing feature.

### 3.13 Public types/API compatibility

Prefer additive types.

Extend `ChairmanDecision` with an optional strategy view rather than changing the top-level Chairman overview contract:

```ts
strategy?: ChairmanStrategyRun | null;
```

Keep the existing `ChairmanOverview` top-level keys:

- `state`
- `contract`
- `messages`
- `decisions`
- `actions`
- `checkpoints`

This avoids unnecessary API/client breakage and preserves the existing API test that asserts those keys.

`ChairmanStore.listDecisions()` can join or decorate each decision with its strategy run.

### 3.14 Realtime behavior

Reuse the existing `chairman.decision` realtime message.

When a strategy outcome is finalized:

1. reload the enriched decision
2. publish the same `chairman.decision` event with the same decision id
3. the dashboard query cache upserts it

Do not create a new WebSocket message type unless the existing path proves insufficient.

This keeps dashboard, VS Code WebView, and remote/cloud relay compatibility simpler.

### 3.15 Chairman drawer UX

Modify only:

`apps/dashboard/src/pages/task/ChairmanDrawer.tsx`

For a recovery decision card, show compactly:

- trigger
- `Model` or `Rules`
- diagnosis: category + confidence
- existing `Why`
- existing `Expected`
- outcome once known:
  - Resolved
  - Improved
  - No improvement
  - Regressed
  - Inconclusive
  - Superseded

Do not expose raw evidence contents in the drawer.

Keep technical evidence in existing Logs, Tests, Activity, Changes, and Artifacts surfaces.

At mobile width, the card remains single-column and readable.

### 3.16 Snapshot/chat enhancement

Extend `ChairmanTaskSnapshot` only with compact decision feedback:

- latest diagnosis summary
- latest strategy outcome
- latest strategy kind

This gives `/status`, questions, and future recovery decisions the result of the previous Chairman intervention without adding full history to every prompt.

---

## 4. Implementation steps

### Phase 0 - Re-verify the live project before edits

1. Pull/inspect current `main`.
2. Record current commit SHA.
3. Inspect:
   - `apps/orchestrator/src/chairman/**`
   - `apps/orchestrator/src/engine/supervision.ts`
   - `apps/orchestrator/src/engine/context.ts`
   - `apps/orchestrator/src/app.ts`
   - `apps/orchestrator/src/tools/store.ts`
   - `packages/shared/src/chairman.ts`
   - `packages/shared/src/constants.ts`
   - `apps/orchestrator/src/db/migrations.ts`
   - Chairman HTTP/realtime/dashboard code
   - current Chairman/unit/e2e tests
4. Re-check the highest local migration number. Do not assume it is still 6.
5. Record any unrelated dirty/uncommitted work and do not overwrite it.
6. Run a baseline:
   - targeted Chairman unit/integration tests
   - `pnpm typecheck`
   - `pnpm build`
   - relevant e2e if practical
7. Note pre-existing failures separately.

There is a repository-recorded pre-existing PTY interactive-shell timeout on the operator PC in the cloud-control plan. Recheck it; do not expand this Chairman task merely to fix it unless it blocks Chairman verification.

### Phase 1 - Add shared contracts

Update `packages/shared/src/chairman.ts`.

Add:

- `ChairmanDiagnosis`
- `ChairmanDiagnosisConfidence`
- `ChairmanStrategyRun`
- `ChairmanStrategyOutcomeStatus`
- optional `strategy` field on `ChairmanDecision`

Keep current action schemas unchanged.

Do not add a new Chairman action type.

If an additional event type is necessary for internal Activity logging, prefer one bounded event such as `CHAIRMAN_OUTCOME`; otherwise reuse `CHAIRMAN_DECISION` plus the existing realtime entity update.

### Phase 2 - Add the strategy-run migration

Update `apps/orchestrator/src/db/migrations.ts` using the next free migration version discovered at implementation time.

Create `chairman_strategy_runs`.

Add migration tests covering:

- fresh database
- upgrade from the previous schema version
- existing Chairman rows preserved
- existing tasks/events/directives/credentials untouched
- `PRAGMA integrity_check = ok`
- foreign-key and uniqueness behavior
- repeated migration startup is harmless through the existing migration runner

Before applying to the operator's live database, use the project's existing safe backup pattern and verify the backup opens.

### Phase 3 - Extend `ChairmanStore`

Update:

`apps/orchestrator/src/chairman/store.ts`

Add methods such as:

- `insertStrategyRun()`
- `strategyRun(decisionId)`
- `latestOpenStrategy(taskId)`
- `finishStrategyRun()`
- `listStrategyRuns(taskId, limit)`
- `failedStrategyFamilies(...)`

Requirements:

- bounded queries
- indexed lookups
- idempotent finalization
- no raw evidence persistence
- all returned text already redacted/bounded

Decorate `ChairmanDecision` with its optional strategy run when returned by `listDecisions()` / decision lookup.

### Phase 4 - Build `ChairmanEvidenceService`

Create:

`apps/orchestrator/src/chairman/evidence.ts`

Wire dependencies from the existing composition root in `apps/orchestrator/src/app.ts`:

- `Store`
- `ChairmanStore`
- `ArtifactService`
- `RepositoryService`
- `ToolStore`
- `AgentRegistry`
- `TaskViews`

Do not instantiate duplicate stores.

Implement:

- `forRecovery(...)`
- `forChat(...)`
- canonical digest generation
- per-section caps
- total cap
- redaction
- untrusted evidence fencing
- source reliability labels
- deterministic ordering

Refactor:

- remove/replace `Chairman.evidence()`
- remove/replace `ChairmanChat.evidence()`

Do not change behavior unrelated to evidence.

### Phase 5 - Add structured diagnosis to recovery reasoning

Update `apps/orchestrator/src/chairman/reasoner.ts`.

Extend the recovery response schema with:

- diagnosis summary
- diagnosis confidence

The existing candidate id remains mandatory.

Keep:

- one repair attempt on malformed JSON
- Zod validation
- validated candidate-id membership
- bounded summary/guidance/expected-result lengths
- no step-by-step hidden reasoning request
- permission level 1
- artifact-folder cwd
- current timeout behavior

If the reasoner fails, generate a deterministic diagnosis from current category/trigger and continue using policy.

### Phase 6 - Record strategy start

Update `apps/orchestrator/src/chairman/chairman.ts`.

When a recovery candidate is selected and the Chairman decision is persisted:

1. persist the decision as today
2. create a `ChairmanStrategyRun` linked to the decision
3. store:
   - current contract version
   - recovery cycle
   - trigger
   - candidate kind
   - target stage/agent
   - failure category/hash
   - diagnosis
   - evidence digest
   - expected result
   - health before
4. then execute the existing actions through `ActionGateway`

If action execution is rejected because the task changed/stale version, finalize the strategy run as `SUPERSEDED` or `INCONCLUSIVE` as appropriate; do not mark the recovery as an engineering failure.

### Phase 7 - Add deterministic outcome evaluation

Create:

`apps/orchestrator/src/chairman/outcomes.ts`

Implement the objective rules in Section 3.8.

Integrate at the existing Chairman hooks.

Important ordering:

- observe/persist the new test/review/verify/failure state first
- evaluate the prior strategy against that evidence
- then calculate the next recovery decision

This ensures the next strategy sees the result of the previous one.

### Phase 8 - Make candidate ranking outcome-aware

Update:

`apps/orchestrator/src/chairman/policy.ts`

Preserve `recoveryCandidates()` safety semantics.

Add a small ranking function using:

- trigger
- deterministic category
- exact tried fingerprints
- current contract version
- prior strategy outcomes in the same task

Do not introduce probabilistic scoring or opaque numeric “AI confidence” scores.

Use explicit ordering rules that can be unit-tested.

### Phase 9 - Improve snapshot and chat

Update:

- `apps/orchestrator/src/chairman/snapshot.ts`
- `apps/orchestrator/src/chairman/chat.ts`

Add compact last-strategy/diagnosis/outcome context.

Use the shared evidence service for model-backed questions.

Preserve:

- questions never act
- `/status` stays deterministic
- user directives remain the only source of directives
- user text remains pinned when the model interprets a directive
- cancel is still not performed from ambiguous chat
- terminal tasks remain immutable

### Phase 10 - Update realtime/API without unnecessary endpoints

Keep existing routes in `apps/orchestrator/src/http/routes.ts`.

`GET /api/tasks/:id/chairman` should continue returning the same top-level object shape.

Return enriched decisions.

When an outcome is finalized, republish the enriched `chairman.decision`.

Update dashboard sync logic only if needed to ensure same-id upsert refreshes the decision card.

Do not add a new endpoint unless a concrete implementation blocker proves it necessary.

### Phase 11 - Upgrade Chairman drawer

Update:

`apps/dashboard/src/pages/task/ChairmanDrawer.tsx`

Add compact diagnosis/outcome rendering to the existing decision card.

Requirements:

- no new modal hierarchy
- no raw log/evidence dump
- keyboard accessible
- screen-reader labels for outcome/status
- dark/light themes
- phone-width support
- no layout overflow
- existing chat flow unchanged

### Phase 12 - Documentation

Update the current system documentation rather than creating duplicate architecture documents:

- `docs/systems/chairman.md`
- `docs/systems/orchestrator.md` only if schema/data-flow description changes
- `design.md` only if the Chairman decision-card contract changes enough to require it

Document:

- evidence sources and trust classes
- diagnosis rules
- strategy lifecycle
- outcome semantics
- restart reconciliation
- security boundary
- degraded mode
- data retention
- API/realtime compatibility

Do not leave docs describing the old “decision with no outcome feedback” behavior.

---

## 5. Failure handling and recovery

### Evidence source unavailable

If one evidence source cannot be read:

- mark that section unavailable
- continue with remaining evidence
- do not fail or pause the task solely because Chairman enrichment failed
- include the missing source in the reasoner's structured context

### Evidence service throws unexpectedly

Catch at the Chairman boundary.

Fallback to:

- current snapshot
- current failure detail
- existing deterministic policy

Record a bounded system/Chairman event.

Do not convert the task itself to `FAILED`.

### Reasoning model unavailable

Keep current degraded behavior:

- `ChairmanState.status = degraded`
- deterministic policy still supervises
- evidence still improves the deterministic context and stored audit
- no automatic paid API fallback

### Malformed reasoner output

Keep the current one repair attempt.

If still malformed:

- use deterministic diagnosis
- choose the first safe outcome-aware candidate
- record `reasoner: policy`

### Stale task version

Keep the existing `ActionGateway` rejection.

A stale recovery decision must never force an old action onto the new task state.

Mark its strategy run `SUPERSEDED`/`INCONCLUSIVE`; rebuild evidence and reevaluate from current state.

### No safe recovery candidate

Preserve the current hard-blocker behavior.

Do not invent new actions.

### Outcome cannot be determined

Use `INCONCLUSIVE`.

Never treat absence of evidence as failure.

### Goal or constraint changes

A new task contract version supersedes still-open recovery strategies from the old contract.

Do not use their negative result to rank strategies for the new contract.

### Restart/crash

On restart:

- do not replay completed Chairman actions
- reconcile strategy-run state from persisted observations
- preserve idempotency
- only resume the task through the existing gateway/recovery path

### Database migration failure

Before modifying the live database:

- create a verified backup using the repository's existing backup approach
- use additive migration only
- stop on migration error
- never partially rewrite prior migrations
- confirm `integrity_check`
- preserve old data

### UI/realtime disconnect

The database remains authoritative.

A reconnect/refetch must reconstruct the full diagnosis/decision/outcome state without relying on missed WebSocket messages.

---

## 6. Security and data protection

1. The Chairman reasoning agent remains permission level 1.
2. Keep its cwd outside the repository in the task artifact directory.
3. Do not give it generic shell, terminal, privileged-helper, credential, or arbitrary tool authority.
4. Every mutating recommendation still becomes a typed Chairman action and passes through `ActionGateway`.
5. Model output can never create an action outside `CHAIRMAN_ACTION_TYPES`.
6. Recovery reasoning can select only candidate ids generated by deterministic code.
7. User-only directive permissions remain unchanged.
8. No raw evidence packet is persisted.
9. Persist only structured strategy metadata, bounded diagnosis/outcome summaries, and an evidence digest.
10. Run `redact()` on all evidence before sending it to the reasoner and on all model summaries before persistence.
11. Keep untrusted evidence fencing.
12. Never automatically include raw `.env`, credentials, API tokens, full terminal streams, arbitrary database data, or unrestricted diffs.
13. Relative file names/status are acceptable; avoid absolute machine paths in model context.
14. New diagnosis/outcome fields that may flow through remote/cloud synchronization must contain only the same privacy-safe redacted metadata allowed today.
15. Extend remote-egress tests with a planted secret and assert it does not appear in:
    - diagnosis
    - outcome summary
    - evidence metadata
    - realtime Chairman messages
    - cloud-synced task/Chairman payloads
16. Do not weaken approval levels, repository coordinator locks, worktree isolation, checkpoint protections, or Source Control secret preflight.

---

## 7. Testing and verification

### Unit tests

Extend `apps/orchestrator/test/chairman-units.test.ts`.

Cover:

1. evidence sections are deterministic
2. evidence total/section limits
3. redaction occurs before prompt creation
4. malicious evidence remains fenced
5. reliability labels are correct
6. test failure evidence extracts failed tests and log tail
7. review/verification evidence stays untrusted
8. tool/recovery evidence contains summaries only
9. no raw Git diff is included by default
10. diagnosis category remains deterministic
11. malformed diagnosis output falls back safely
12. outcome:
    - `SUCCEEDED`
    - `IMPROVED`
    - `FAILED`
    - `REGRESSED`
    - `INCONCLUSIVE`
    - `SUPERSEDED`
13. outcome finalization is idempotent
14. failed/regressed strategy families are deprioritized
15. `INCONCLUSIVE` does not penalize a strategy
16. old contract history does not affect a new contract
17. existing recovery ordering invariants still hold

### Migration tests

Extend `apps/orchestrator/test/migrations.test.ts`.

Test:

- fresh database -> current schema
- prior schema -> new schema
- old Chairman records unchanged
- new table/indexes exist
- duplicate `decision_id` rejected
- delete cascade behaves as intended
- integrity check passes

### Chairman integration tests

Extend `apps/orchestrator/test/chairman.test.ts`.

Required scenarios:

1. **Recovery succeeds**
   - decision created
   - strategy run `RUNNING`
   - next passing test finalizes `SUCCEEDED`

2. **Partial progress**
   - failing test count decreases
   - outcome becomes `IMPROVED`
   - Chairman does not treat it as a stalled strategy

3. **No improvement**
   - same normalized failure repeats
   - prior strategy becomes `FAILED`
   - next recovery prefers a different safe strategy family

4. **Regression**
   - failure count increases
   - outcome becomes `REGRESSED`
   - checkpoint rollback remains preferred

5. **Plan mismatch**
   - verification says request was missed
   - diagnosis remains `REQUIREMENT_OR_PLAN`
   - re-plan remains preferred

6. **Provider block**
   - no false code diagnosis
   - healthy alternative agent behavior remains intact

7. **Reasoner outage**
   - deterministic diagnosis/ranking still works
   - task continues under existing degraded semantics

8. **Bad JSON**
   - one repair attempt
   - fallback after second invalid result

9. **Stale decision**
   - gateway rejects old action
   - strategy run does not report engineering failure

10. **Restart**
    - open strategy run reconciles once
    - completed actions are not replayed
    - no duplicate outcomes

11. **Goal change**
    - old strategy becomes superseded
    - old negative outcome does not poison new contract

12. **Prompt injection**
    - malicious test/review/tool evidence cannot create an arbitrary action
    - candidate-id validation still wins

13. **Hard blocker**
    - after safe strategies are exhausted, behavior remains `WAITING_FOR_USER`, not terminal failure

14. **Completion gate**
    - objective completion can finalize the last compatible strategy as succeeded
    - protected-path/required-check behavior remains intact

### API/realtime tests

Verify:

- same Chairman overview top-level keys remain
- existing clients can ignore new optional fields
- enriched decision is returned
- finalized outcome republishes the same decision id
- reconnect/refetch reconstructs outcome correctly
- bearer-token/local security unchanged

### Remote/cloud egress tests

Extend existing remote egress tests only where necessary.

Verify:

- no seeded secret appears in enriched Chairman decision data
- outcome updates are safe to relay
- no local absolute path is leaked
- offline mirrored task data remains readable if the current cloud implementation mirrors Chairman entities

Do not expand into unfinished cloud-control features.

### Dashboard/Playwright tests

Extend:

`apps/dashboard/e2e/chairman.spec.ts`

Verify:

- diagnosis visible on recovery decision
- expected result still visible
- outcome updates on the same card after the next test/review
- model/rules badge remains correct
- chat remains functional
- no duplicate card when the same decision is republished with outcome
- keyboard operation
- phone width
- light theme
- dark theme
- no horizontal overflow
- accessibility checks remain green

### Full verification

After targeted tests:

```bash
pnpm typecheck
pnpm lint
pnpm docs:guard
pnpm test
pnpm build
pnpm e2e
```

Prefer the existing `pnpm check` where appropriate.

If the known unrelated PTY timeout still reproduces exactly as at baseline, record it as pre-existing and verify there are no new failures. Do not silently claim the full suite is green.

### Real behavior verification

Do not stop at compilation.

Run at least one real simulated full-autopilot Chairman scenario end-to-end and inspect:

- decision
- diagnosis
- Action Gateway action
- actual test/review result
- strategy outcome
- next strategy behavior if it fails
- final completion report
- restart/reload persistence

---

## 8. Success criteria

The Chairman upgrade is complete only when all applicable criteria below are verified.

1. Recovery and chat use one shared evidence service.
2. Background recovery no longer relies only on the current failure plus a few historical messages.
3. Evidence is bounded, redacted, source-labelled, and prompt-injection fenced.
4. The Chairman reasoning model still cannot directly mutate the repository or task.
5. All mutations still pass through `ActionGateway`.
6. Every model-selected recovery action is still limited to deterministic safe candidate ids.
7. Every recovery strategy records structured diagnosis and an evidence digest.
8. Existing `expectedResult` is preserved and reused.
9. The next comparable objective observation evaluates the strategy as one of:
   - succeeded
   - improved
   - failed
   - regressed
   - inconclusive
   - superseded
10. Outcome evaluation is deterministic and idempotent.
11. Restart cannot duplicate an outcome or replay an already-completed Chairman action.
12. A failed/regressed strategy family is deprioritized when another safe candidate exists for the same contract/category/stage.
13. A goal/contract change prevents old recovery history from incorrectly steering the new goal.
14. Existing rollback, completion gate, directives, limits, provider rerouting, and hard-blocker behavior still pass.
15. The Chairman drawer shows diagnosis, why, expected result, and observed outcome without exposing raw logs or sensitive data.
16. Existing Chairman API top-level shape remains backward compatible.
17. Local dashboard and VS Code WebView continue to function.
18. Remote/cloud egress tests prove the new Chairman metadata does not leak secrets.
19. Migration upgrades real pre-upgrade schema data without loss and passes integrity checking.
20. Targeted Chairman tests are fully green.
21. Build succeeds.
22. Full verification has no new failures compared with the recorded baseline.
23. Documentation matches the implemented behavior.
24. No unrelated architectural rewrite or dependency was added.

---

## 9. Found for Later

These are valuable but should **not** be implemented in this task.

### Global Chairman console

A system-level Chairman across tasks, repositories, agents, nodes, budgets, and approvals is valuable, but it is a separate coordination problem. Build it after task-level decision/outcome semantics are trustworthy.

**Priority:** High  
**Affects current task:** No

### Cross-task strategy learning

Once `chairman_strategy_runs` has enough real outcomes, aggregate by repository/task type/failure category/stage/strategy and build recommendation mode.

Do not make routing decisions from tiny datasets.

**Priority:** High  
**Affects current task:** No

### Adaptive agent/model/effort routing

Use strategy outcomes plus the existing usage/capacity ledger to recommend the agent/model/effort with the best observed success/latency/retry profile.

Start with recommendations before automatic routing.

**Priority:** High  
**Affects current task:** No

### Global resource-aware task scheduling

Worktree isolation exists, but multi-task same-repository scheduling is a separate engine/resource-governor feature.

**Priority:** Medium  
**Affects current task:** No

### Rich semantic failure clustering

Embeddings/vector search may eventually identify semantically similar failures across differently-worded logs, but normalized deterministic signatures are safer and sufficient for this upgrade.

**Priority:** Low/Medium  
**Affects current task:** No

### Worker heartbeat/progress protocol

The current watchdog uses pid, timeout, and log silence. A structured worker heartbeat could distinguish legitimate silent work from a stall more accurately, but it touches agent/executor lifecycle and is not required for evidence-driven recovery.

**Priority:** Medium  
**Affects current task:** No

### Existing PTY stream-redaction finding

The Tool Layer plan records that terminal output is redacted per chunk, so a secret split across two chunks could theoretically evade pattern matching. Fix with a rolling redaction tail in a dedicated security task, especially before broad remote-terminal use.

**Priority:** High  
**Affects current task:** No

### Parallel migration numbering

The MyVault credential-bridge plan references a future migration 7. This is not a Chairman bug, but it means every implementation must allocate migration numbers from the live `migrations.ts`, never from plan text.

**Priority:** High operational discipline  
**Affects current task:** Yes only as a migration-number safety check

---

## 10. Next Recommended Task

Create `CHAIRMAN_ADAPTIVE_ROUTING_PLAN.md`.

Use the real `chairman_strategy_runs` outcome history together with the existing usage/cost/capacity ledger to build **recommendation-only** routing for agent/model/effort by workflow role and task/failure type.

Do not enable automatic routing until:

- enough real outcomes exist
- confidence thresholds are defined
- fallback behavior is proven
- operator-visible reasoning is available
- recommendation quality is measured against the current static assignments

After adaptive routing is proven, the next larger Chairman project should be the Global Chairman console.

---

## 11. Final execution prompt

`/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.`

## Ledger

- 2026-09-23 — created from the attached CHAIRMAN_INTELLIGENCE_PLAN.md (conversation 2026-09-23)
- 2026-09-23 21:25 — step 1 — baseline at b07294c (plan commit on top of eca4518). Highest migration is **7** (`myvault credential bridge`, committed in eaba6cf), so this work uses **8**. Unrelated uncommitted work from another session (MyVault vault bridge) is in the tree: modified `app.ts`, `routes.ts`, `server.ts`, `tools/{credentials,service,store}.ts`, dashboard Tools pages, `packages/tools/**`, `packages/shared/src/tools.ts`, several `docs/systems/*.md`, plus untracked `vault-bridge*` files — none will be staged by this plan; `app.ts` hunks of this plan are staged via a patch of only its own lines. Baseline (with that work present): chairman, chairman-units, migrations, remote-egress tests 49/49 pass (175 s); `pnpm typecheck` exit 0; `pnpm build` exit 0. A live orchestrator is listening on 127.0.0.1:4317 (pid 39056).
- 2026-09-23 21:40 — step 2 — besides the plan's fields, `ChairmanStrategyRun` carries `failureSource`, `failureStageKey` and `failureCount` (the triggering failure's baseline) so the evaluator can compare the next observation against it without re-reading logs; added `STRATEGY_OUTCOME_LABEL` / `FAILURE_CATEGORY_LABEL` for the drawer; `policy.StrategyKind` is now an alias of the shared `ChairmanStrategyKind`.
- 2026-09-23 21:48 — step 3 — migration **8** `chairman strategy outcomes`; `decision_id` is the primary key (unique by construction) with FK → chairman_decisions ON DELETE CASCADE, plus an `(task_id, status)` index for open-run lookups. The committed v6→v7 test called `migrate(db)` (all migrations) and expected `[7]`; it now migrates to ≤7 explicitly so it keeps testing what it was written for. 4/4 migration tests pass; earlier migrations byte-identical (0 removed lines).
- 2026-09-23 21:55 — step 4 — store gained `decision(id)`, `openStrategyRuns`, `tasksWithOpenStrategies` (restart reconciliation) beyond the plan's list; `finishStrategyRun` is an `UPDATE … WHERE status = 'RUNNING'` returning null on the second call. 19/19 unit tests pass.
- 2026-09-23 22:10 — step 5 — `evidence.ts` takes `Store`, `ChairmanStore`, `ArtifactService`, `AgentRegistry` and the tool layer's `ToolStore` (passed from `app.ts` as `toolStore`); `RepositoryService`/`TaskViews` from the plan's list were not needed (repository path comes from `Store.getRepository`). Chairman's `testEvidence` moved into the service as `testFailure` (same 80-line tail). Absolute repository/worktree paths become `<repo>` inside evidence. Reasoner RULES gained one line distinguishing OBSERVED from AGENT_REPORTED evidence. The total cap (22 000 chars) is a safety net: per-source section caps sum below it. 26/26 unit tests pass.
- 2026-09-23 22:20 — step 6 — the model's diagnosis is parsed separately from its choice (`parseRecoveryChoice`): a malformed diagnosis falls back to the rules' diagnosis without spending the repair attempt; a malformed choice still gets the one repair. The rules' diagnosis (`policyDiagnosis`) lives in `policy.ts` and is also shown to the model as a fixed category. The simulated Chairman now returns a diagnosis (`packages/agent-sdk/src/simulated.ts`, test-only adapter). 28/28 unit tests pass.
- 2026-09-23 22:45 — step 7 — the strategy run is inserted inside `decide()` (same transaction of intent as the decision) and the published `chairman.decision` already carries it. Strategy runs are recorded for all three kinds of strategy decision: recovery cycles, the provider-block reroute (`recoveryCycle` unchanged) and completion-gate remedies (source `gate`, digest of the gate message only). Evidence is now gathered even when the model is unavailable, so every run has a digest. `StrategyCandidate` gained `targetStageKey`/`targetAgentId`. Integration: 25/25 (two new tests: run per recovery decision with model diagnosis; stale gateway rejection → SUPERSEDED, idempotent).
- 2026-09-23 23:05 — step 8 — the evaluator is DB-driven: `reconcile(taskId)` rebuilds observations from stage results created at/after the strategy's start plus failure signatures keyed by stage id, so hooks and restart share one idempotent path. A new recovery-cycle strategy closes a still-open one as INCONCLUSIVE (a provider-block reroute does not); a finished task closes leftovers (cancel → SUPERSEDED, complete → INCONCLUSIVE after a last reconcile). Outcome notes reuse the `CHAIRMAN_DECISION` event type with `data.outcome` — no new event type. First try asserted a gate strategy in the e2e-directive test; that task never needed one (the tests stage ran e2e directly), so the gate→SUCCEEDED case got its own test. Units 31/31; integration 27 + 3 (completion gate group) pass, including restart reconciliation without replay, goal change → SUPERSEDED, C → FAILED then replan, provider block → AUTH_OR_EXTERNAL + SUCCEEDED, hard blocker strategies → FAILED.
- 2026-09-23 23:20 — step 9 — `rankCandidates` is a stable partition (not-failed families first, failed ones last — never dropped), with rollback/replan/change_agent pinned for regression/plan_mismatch/provider_blocked and a LOW-confidence rule that puts root-cause analysis first. Units 32/32; the new integration test shows RCA → REGRESSED (2 → 5 failing) and the next cycle choosing Re-plan although RCA was offered first by the fixed order. Another session is concurrently editing `remote/guards.ts` and `remote-commands.test.ts` (uncommitted; a type error there is theirs) and committed 953e754, 6090c3d, 010ac0f, d940bab on top of the plan commit — not touched here.
- 2026-09-23 23:35 — step 10 — `ChairmanTaskSnapshot.lastStrategy` {kind, targetStageKey, diagnosis, confidence, outcome, outcomeSummary}; `/status` adds 'Last strategy: <kind> at <stage> — <outcome>: <summary>.'; shared `STRATEGY_KIND_LABEL` added. Chat already used the shared evidence service since step 5. Integration 30/30 (the resolved-strategy test also asserts the snapshot field, the /status line, and that /status takes no action).
- 2026-09-23 23:50 — step 11 — no route or dashboard sync change needed: `GET /api/tasks/:id/chairman` returns decisions from `listDecisions` (now decorated), and the dashboard's `chairman.decision` handler already upserts by id, so the republished decision replaces the same card. New API test: the bus sees the same decision id twice (RUNNING, then IMPROVED), a duplicate finish publishes nothing, the refetched overview keeps its six keys and equals the last published strategy. Test helper `openStrategy` replaced three hand-built strategy starts. Integration 31/31.
- 2026-09-23 23:59 — step 12 — egress needed no code change: `chairman.decision` was already a live-only type passing the deep scrub. New test drives a real recovery on a paired node with an echoing Chairman model that repeats a registered secret and the repository path into its summary, guidance, expected result and diagnosis: the stored decision/strategy holds `[REDACTED]` instead of the secret, the relay saw the decision twice (RUNNING, SUCCEEDED) with the diagnosis text, and no frame (live, mirrored or the `chairman.overview` RPC) contains the secret or any spelling of the repository path. 8/8 egress tests pass. The model's absolute path remains in the local row (redaction is for secrets; paths are removed at the egress boundary).
- 2026-09-24 00:15 — step 13 — besides `ChairmanDrawer.tsx`, the outcome chip's visual lives with the other status visuals in `packages/ui/src/tokens/status.ts` (`STRATEGY_OUTCOME_VISUAL`, semantic tones only). Card: outcome chip (screen-reader prefix 'Outcome:'), 'Diagnosis: <category> · <confidence> confidence — <summary>', Why, Expected, 'Result: <outcome summary>'; each card carries `data-decision-id` for the one-card-per-decision check. `pnpm build` then the Chairman spec: 3/3 pass (keyboard open, diagnosis/expected/outcome on the same card, no duplicate card after republish, Activity outcome line, reload at 390 px, no overflow, axe clean in dark and light).
- 2026-09-24 00:30 — step 14 — `chairman.md` gained Evidence, Diagnosis and Strategy outcomes sections plus ranking, restart, tables (migration 8), API/realtime/drawer and gotchas; `verified_at` → 953e754. `design.md` §7.3.1 decision-card line extended (outcome chip, diagnosis, Result, in-place update). `orchestrator.md` table list names migration 8 — its pre-existing drift warning (verified_at 2d516aa, 15 commits, several from other sessions, and the vault-bridge session has uncommitted edits in the same file) was left for a dedicated doc pass rather than bumping `verified_at` unverified. `pnpm docs:guard`: 0 failures, chairman.md not flagged.
- 2026-09-24 00:55 — step 15 — real orchestrator process (built `dist/main.js`, simulated agents, own data folder, port 4398; the operator's live 4317 instance untouched). `scripts/demo.mjs` wipes its data on every start, so persistence was checked with a small launcher on a fixed folder; the first attempt under the scratchpad failed on the Windows path-length limit for git's branch lock file (environment, not product), so the folder moved to `%TEMP%\acc-cr`. HTTP API only: TASK-0001 stalled on 2 failing tests → decision `repeated_failure`, model diagnosis MEDIUM, action RETURN_TO_STAGE completed → next tests 5 failing → strategy **REGRESSED** "Failing tests went from 2 to 5" → stalled again → ranking put **Re-plan** first (RCA family regressed), REPLAN completed → tests passed → **SUCCEEDED**; task COMPLETED/READY, final report "Chairman recovery cycles: 2", `/status` "Last strategy: Re-plan at plan — Resolved". After killing and restarting the process on the same data: both decisions, strategies and actions byte-identical in the API, exactly 2 outcome events (no duplicates, no replayed actions). Playwright MCP (real Chrome, persistent profile) on the restarted instance: cards show Regressed/Resolved chips, diagnosis, Why, Expected, Result; readable at 390 px; 0 console errors; screenshots in `~/.claude/browser/playwright-mcp/chairman-card-*.png`. VS Code Simple Browser preview did **not** open (receipt still shows a 2026-09-15 URL) — the visible preview is unverified.
- 2026-09-24 00:55 — step 15 (deviation) — the real run showed "/status: Health: Stalled" on a completed task: a strategy that resolves a failure leaves no new failure to classify, so session health never moved. `finishStrategy` now sets the session health to the outcome's `healthAfter` (when not null) and publishes state; the decision logic is unchanged (it uses the per-cycle classification). Re-run showed "Health: Progressing"; the resolved-strategy integration test now asserts it.
- 2026-09-24 01:05 — step 16 — live `acc.db` (schema v7, 5 tasks, 281 events, 3 Chairman decisions) backed up with the SQLite online backup API to `%LOCALAPPDATA%\AIDevControlCenter\backups\acc-before-chairman-outcomes-20260924.db`; the backup reports `integrity_check = ok`. A copy of it migrated v7 → v8 (`[8]`), counts of tasks/events/directives/decisions/actions/sessions/failures/credentials/usage identical, `integrity_check = ok`, a second run applies nothing. The live file itself was **not** migrated or restarted by this work: it upgrades when the operator's orchestrator next starts from a build containing migration 8 (another session restarted 4317 during this run; its database is still v7). Pre-existing decisions simply show no strategy (`strategy: null`).
- 2026-09-24 01:15 — T1 — reviewed every hunk of chairman.ts, store.ts, evidence.ts, outcomes.ts, policy.ts, reasoner.ts, snapshot.ts, chat.ts, the shared/UI types, drawer, migration and tests. No defect found; confirmed: mutations only via ActionGateway, the model still only picks offered ids (diagnosis cannot change category or actions), finishing is idempotent, evaluation precedes the next decision, evidence is redacted/fenced and never persisted. Known, accepted: a strategy is judged by its first comparable result (documented gotcha); `listDecisions` decorates from the newest 200 runs (decisions list is capped at 50). ESLint clean on all changed files. Trial migration copy deleted; the backup stays (its empty -wal/-shm sidecars come from opening it read-only).
- 2026-09-24 01:20 — T2 — searched apps/ and packages/ for `ChairmanDecision`, `chairman.decision`, `chairman_decisions`, `fenceEvidence`, `StrategyCandidate`, `recoveryCandidates`: only the dashboard sync (upsert by id — works unchanged), the drawer, remote egress (live-only type, deep-scrubbed — covered by the new egress test), shared ws types and the Chairman's own files/tests reference them. `apps/cloud-control` and `apps/vscode-extension` have no Chairman code (the WebView embeds the dashboard build, rebuilt in step 13). No other caller constructs `Chairman`.
- 2026-09-24 02:10 — T3 — `pnpm check`: typecheck, lint, docs guard pass; vitest 567 passed / 6 failed. Each failure checked: ConPTY shell (`pty.test`), PowerShell routing and real-Chromium page check (`packs.test`), engine real-browser verification (`tools.test`) all **pass when run alone** (16/16, 13/13, 3/3) — timeouts under a fully loaded machine (the known PTY timeout among them). The two cloud-control failures (`commands.test` lease/mirror, `objects.test`) **reproduce on a clean worktree of HEAD without any of this work** and belong to the cloud-control session, which committed "Fix two Worker tests" (c66a1fc) meanwhile. `pnpm build` exit 0. `pnpm e2e`: 73 passed, 6 failed — all six in `vault-bridge.spec.ts`, the other session's untracked, parked MyVault spec; all Chairman e2e tests pass in the same run. No failure is new relative to code this plan touched.
- 2026-09-24 02:10 — T4 — chairman.md now also states that a finished outcome sets session health (the step 15 fix); design.md, orchestrator.md and the plan are the rest of the doc diff. Docs guard 0 failures.
- 2026-09-24 02:20 — T5 — committed path-scoped with only this plan's files. `app.ts` and `docs/systems/orchestrator.md` also carry the MyVault session's uncommitted edits, so each was staged as HEAD's version plus this plan's single line (index blob), leaving their work unstaged in the tree. Pushed to `origin/main` (autopilot, direct-push repo).
- 2026-09-24 02:20 — T6 — no deploy on push: `ci.yml` runs on push to main (checks only); `deploy-cloud.yml` / `rollback-cloud.yml` are `workflow_dispatch`. The change reaches the operator's live orchestrator when it next restarts from a build of this commit — that start applies migration 8 (proven on a backup copy in step 16).
- 2026-09-24 02:20 — T7 — the repository keeps no claims register (`docs/` holds only `plans/` and `systems/`); nothing to register.
