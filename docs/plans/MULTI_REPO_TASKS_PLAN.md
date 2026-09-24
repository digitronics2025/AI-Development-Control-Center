---
title: One task can work across several repositories, each in its own isolated worktree inside one task workspace
source: conversation 2026-09-24 (operator request; plan written after a read-only investigation of the codebase)
created: 2026-09-24
status: in-progress
---

# Multi-repository tasks

## Context

The plan below is copied as written; only its heading levels were lowered to sit
under this section. Where it says "migration 10", read **migration 12** (see Ledger).

Status: proposed · 2026-09-24 · next schema version: **10**

### 1. Goal

Let one task change several registered repositories together. Examples: an API
and the client that calls it, or a shared package and its two consumers. The
agents should see and edit all of them in one run. Tests, review, commits and the
final report should cover every repository. The user's own working folders must
never be touched.

Today this is impossible. It is not one missing field: the codebase assumes a
single repository at every layer.

| Layer | The single-repository assumption | Where |
|---|---|---|
| API contract | `createTaskSchema.repositoryId: string` | [schemas.ts:148](../../packages/shared/src/schemas.ts#L148) |
| Database | `tasks.repository_id NOT NULL`, one `tasks.git` JSON record, `git_snapshots` with no repository column | [migrations.ts:93-123, 240-250](../../apps/orchestrator/src/db/migrations.ts#L93) |
| Working directory | `taskWorkdir(task, repo)` returns one path, and every stage, tool, checkpoint and terminal uses it | [workdir.ts:7](../../apps/orchestrator/src/engine/workdir.ts#L7) |
| Engine | one baseline, one worktree, one test command set, one commit list, one report | [engine.ts:753-928, 1090-1136](../../apps/orchestrator/src/engine/engine.ts#L753) |
| Scheduling | `repositoryHolder` looks at `task.repositoryId` only | [engine.ts:688-693](../../apps/orchestrator/src/engine/engine.ts#L688) |
| Tool scope | `roots: [cwd]`, one `repositoryId` for credential resolution, a git pack that runs in `ctx.cwd` | [tooling.ts:99-115](../../apps/orchestrator/src/engine/tooling.ts#L99), [service.ts:410, 483-491](../../apps/orchestrator/src/tools/service.ts#L410) |
| UI | one Repository combobox, one Changes list, `openDiff {taskId, path}` | [NewTaskPage.tsx:230-246](../../apps/dashboard/src/pages/NewTaskPage.tsx#L230), [ChangesTab.tsx](../../apps/dashboard/src/pages/task/ChangesTab.tsx) |

### 2. Scope

**In scope**

- A task has **one primary repository and up to 7 linked repositories**, so at
  most 8 in total.
- A multi-repository task always runs **isolated**. Each repository gets its own
  Git worktree and task branch, all placed side by side in one task workspace
  folder.
- For every repository: baseline, tests (that repository's own commands), App
  check, the Git checkpoint commit, finalize or cancel, changes and diff,
  checkpoints and restore.
- Scheduling and Source Control understand which repositories a task belongs to.
  This covers the holder rule, task history, commit attribution, and branch
  protection.
- The tool layer:
  - Git tools and `terminal.start` gain an optional `cwd`, confined to the task's
    roots.
  - Credentials are resolved for the repository the call runs in.
- The New Task page gets an "Also work in" field. The task list, header and
  Changes tab show every repository.
- Documentation updates for every subsystem touched.

**Out of scope, recorded in §9**

- Creating a multi-repository task from the cloud control plane. The node
  refuses it.
- Starting several apps together for one App check.
- Splitting usage and budgets across repositories.
- Changing the linked repositories after a task has been created.
- The existing rule that isolated single-repository tasks still hold their
  repository.

**Unchanged:** single-repository tasks. They take the same code paths, produce
the same text and use the same data, and the migration writes no rows for them.

### 3. Enhanced design / architecture

#### 3.1 Key decision: a task workspace folder of sibling worktrees

```text
<ACC_DATA_DIR>/workspaces/TASK-0142/
  api/     ← git worktree of "api"  on ai/TASK-0142-…  (primary)
  web/     ← git worktree of "web"  on ai/TASK-0142-…
  shared/  ← git worktree of "shared" on ai/TASK-0142-…
```

For a multi-repository task, **the agent's working directory is the workspace
folder**. Each repository is a subfolder of it.

Why this layout rather than "primary folder as cwd, plus extra directories":

- **Confinement stays a single root.** `roots: [workspace]` is already how
  `resolveInside` works ([paths.ts:51-57](../../packages/tools/src/paths.ts#L51)).
  The folder holds only this task's worktrees, so it grants nothing new.
- **Agent CLIs need no new flags.**
  - Codex runs `exec -C <cwd> --sandbox workspace-write --skip-git-repo-check`
    ([agent-codex/index.ts:169-171](../../packages/agent-codex/src/index.ts#L169)).
    Write access therefore covers every subfolder, and a workspace that is not
    itself a Git repository is already accepted.
  - Claude Code works from the same cwd.
  - Without the shared folder, Codex could not write to a second repository.
- **Your working trees are never touched**, because isolation is mandatory.
  That removes three problems for linked repositories:
  - pre-existing-change protection, since the baseline is clean;
  - the Source Control writer lock, since isolated stages don't take it
    ([engine.ts:760](../../apps/orchestrator/src/engine/engine.ts#L760));
  - mixed-file limitations.
- **Paths are unambiguous.** An agent writes `web/src/api.ts`. Tools and the
  prompt name repositories by their folder.

Folder name = repository name slug (`[a-z0-9-]`, 30 characters at most),
de-duplicated with `-2`, `-3`, and so on. It is computed once at creation and
stored.

#### 3.2 Data model (migration 10, additive only)

```sql
CREATE TABLE task_linked_repositories (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id),   -- no cascade: a used repository can't be removed
  position      INTEGER NOT NULL,                             -- 1..7, display and run order
  folder        TEXT NOT NULL,
  git           TEXT NOT NULL,                                -- TaskGitRecord JSON, same shape as tasks.git
  PRIMARY KEY (task_id, repository_id),
  UNIQUE (task_id, folder)
);
CREATE INDEX idx_task_linked_repository ON task_linked_repositories(repository_id);
ALTER TABLE test_runs        ADD COLUMN repository_id TEXT;   -- null = the primary / single repository
ALTER TABLE task_checkpoints ADD COLUMN parts TEXT;           -- null = single repository (today's columns)
```

- **The primary repository is not repeated in the new table.**
  - It stays in `tasks.repository_id`, and its Git state stays in `tasks.git`.
  - That keeps a single source of truth for the primary.
  - Every existing single-repository task is valid as-is, with no backfill.
  - Readers that only need "the task's repository" (usage `projectId`, the
    staged review assist, the cloud mirror) keep working.
- `tasks.git` (JSON) gains two optional fields:
  - `workspacePath` — set only for multi-repository tasks;
  - `folder` — the primary's folder name.
- The same `TaskGitRecord` shape (baseline snapshot id, baseline commit/branch,
  task branch, worktree path, commits) is stored per linked repository.
- `git_snapshots` needs no new column. Each repository's record points at its own
  snapshot id.
- `task_checkpoints.parts` is a JSON array
  `[{repositoryId, folder, ref, commit, head}]`, one entry per repository. The
  existing columns hold the primary's part, so older readers still see a valid
  row.

#### 3.3 One accessor instead of scattered lookups

`apps/orchestrator/src/engine/task-repositories.ts` (new):

```ts
interface TaskRepository { repo: RepositoryRecord; folder: string | null; git: TaskGitRecord; primary: boolean; workdir: string }
taskRepositories(task): TaskRepository[]        // primary first, then linked by position
taskRepository(task, repositoryId): TaskRepository
isMultiRepository(task): boolean
agentWorkdir(task, repo): string                 // workspacePath ?? taskWorkdir(task, repo)
updateTaskRepositoryGit(taskId, repositoryId, patch)  // primary → tasks.git, linked → the row
```

- For a single-repository task, `taskRepositories` returns one entry whose
  `workdir` equals today's `taskWorkdir`.
- Every per-repository consumer becomes a loop over this list, and for a single
  repository the loop output is byte-identical to today.
- The display rule is: **prefix names with the folder only when there is more
  than one repository.**

| Consumer | Uses |
|---|---|
| Agents, tool scope, terminals, environment discovery, prompt header | `agentWorkdir` (workspace) |
| Baseline, test/command runs, App check, Git stage, finalize/cancel, changes/diff, checkpoints, Chairman evidence and completion gate | loop over `taskRepositories` |
| Usage attribution, policy defaults already resolved on the task | primary |

#### 3.4 Lifecycle changes

1. **Create** ([engine.ts:140](../../apps/orchestrator/src/engine/engine.ts#L140))
   - Validate `linkedRepositoryIds`:
     - distinct, not the primary, at most 7;
     - each one registered, a Git repository, and with at least one commit.
   - Explicit `worktree: false` combined with linked repositories → `INVALID_INPUT`.
   - Force `isolated = true`.
   - `autoApproveUpToLevel` and `policyMode` default to the **most restrictive**
     among all the repositories (the minimum level; `safe` < `autopilot` < `full`).
     They are stored on the task, so the gates downstream stay unchanged.
   - Insert the linked rows, set `lastTaskId` on every repository, and name them
     all in the `TASK_CREATED` event.
2. **Baseline** (`ensureBaseline`) — for multi-repository tasks, **every
   repository is baselined before the first stage runs**:
   - Create the workspace folder.
   - For each repository in order: `addWorktree(repo.path, <workspace>/<folder>, branch)`.
     This is the existing [worktrees.ts](../../packages/git/src/worktrees.ts),
     with the directory passed in.
   - Record its snapshot and git record, then `prepareWorktree`.
   - A repository whose record already has a baseline is skipped, so the step is
     resumable.
3. **Scheduling**: `repositoryHolder` returns the first active, non-read-only
   task whose repository set **intersects** this task's set. The message names
   the shared repository.
4. **Tests / command stage**
   - `stageCommands` runs per repository, using that repository's own
     `commands`, in its folder.
   - Each `test_runs` row carries `repository_id`, and its name is prefixed
     `web · test`.
   - A repository with no configured checks is recorded as "not checked" in
     Verification coverage.
   - The `skip_tests` approval is asked only when **no** repository has checks.
   - One failure in any repository fails the stage, and the fixer sees which
     folder failed.
5. **App check**
   - Runs, one after another, for each repository with a `runtime.devUrl`.
   - Each app is stopped before the next one starts.
   - It is skipped when no repository has a runtime.
6. **Git stage**
   - `commitPaths` runs in each repository.
   - A hook rejection in any repository is `tests_failed`, naming the folder.
   - Commits append to that repository's record.
7. **Complete**
   - For each repository: changes and diff, then finalize (commit what remains,
     remove the worktree).
   - `git-diff.patch` is one file built with `--src-prefix=a/<folder>/ --dst-prefix=b/<folder>/`,
     so it applies from a workspace-shaped folder.
   - `final-report.md` gets a Repositories section and per-repository Files and
     Git sections.
   - The workspace folder is removed only once it is empty.
8. **Cancel**
   - Each repository's pending work goes to `refs/acc/worktree-backup/<task>` in
     that repository, then the worktree is removed.

#### 3.5 Tool layer

- **Scope** ([tooling.ts:99](../../apps/orchestrator/src/engine/tooling.ts#L99))
  - `cwd = roots[0] = workspace`, and `protectedPaths = []`.
  - New field `repositories: [{id, root}]`.
  - `profile` = the union of the repositories' detected tooling. The profile
    only says which capabilities exist; permission still comes from level and
    policy.
- **Git pack and `terminal.start`**
  - Add an optional `cwd` input.
  - It is resolved with `resolveInside(ctx.roots, ctx.cwd, input.cwd)`.
    Outside the roots, the call is refused with `OUTSIDE_ROOT`.
  - At the workspace root, Git tools return a clear "choose a repository
    folder" failure instead of a raw Git error.
- **Credentials** ([service.ts:410, 483-491](../../apps/orchestrator/src/tools/service.ts#L410))
  - The effective `repositoryId` of a call is the repository whose root contains
    the call's resolved cwd. At the workspace root it is **null**, so only
    credentials scoped to all repositories are usable there.
  - `credential.generate` with a null repository is refused.
  - A credential for repository A can never be used from repository B.
- **MCP session and prompt**
  - The prompt's tool section lists each folder → repository.
  - `context.ts` gives each repository its own facts block (branch, commands,
    `git status`), and bounds the diffs to 150 KB in total.
  - The prompt says: "each folder may carry its own `AGENTS.md`/`CLAUDE.md`;
    read the one for a folder before changing it".
- **Environment discovery**: one `environment.md`, with one section per
  repository.

#### 3.6 Checkpoints and the Chairman

- **Checkpoints** ([checkpoints.ts](../../apps/orchestrator/src/chairman/checkpoints.ts))
  - Create: one ref per repository, `refs/acc/checkpoints/<task>/<n>`, all
    recorded in `parts`.
  - Restore is all or nothing:
    - first check that **every** repository's HEAD is unchanged, and refuse if
      any moved;
    - take a before-rollback checkpoint of all the repositories;
    - restore each one;
    - if a later repository fails, restore the ones already done from the
      before-rollback checkpoint and report it.
  - Prune runs in every repository.
- **Chairman**
  - Evidence and the completion gate loop over the repositories, with changed
    files prefixed by folder.
  - `scrubRoots` labels each root `<repo:folder>` instead of one `<repo>`.
  - `configuredKinds` = the union across repositories.
  - The contract's `scope.repository` = the names joined by ", ". The type does
    not change.

#### 3.7 API, views and clients

- **Create and list**
  - `createTaskSchema` gains `linkedRepositoryIds?: string[]` (max 7).
    `repositoryId` stays the primary, so demo, e2e, staged review and the cloud
    callers are unchanged.
  - `TaskSummary` gains `repositories: {id, name, folder, primary}[]`, with a
    length of 1 for single-repository tasks.
  - `repositoryName` stays the primary's name.
  - `listTasks({repositoryId})` and `countTasksForRepository` match the primary
    **or** a linked row. Task history, the Tasks filter and "can't remove a
    repository with task history" then cover linked repositories.
- **Changes and diff**
  - `GET tasks/:id/changes` keeps today's flat fields (for the primary) and adds
    `repositories: TaskChanges[]`, where each entry carries
    `repositoryId, name, folder`.
  - `GET tasks/:id/diff?path=&repositoryId=` defaults to the primary.
  - `ChangedFile.path` stays relative to its repository.
- **Source Control** ([service.ts:256-296, 405-414, 863-868](../../apps/orchestrator/src/source-control/service.ts#L256))
  - Attribution, commit attribution and `branchBlocker` read the git record
    through `taskRepository(task, repositoryId)`.
  - A linked repository's task branch is then protected exactly like a primary's.
- **WebSocket**
  - The engine calls `repositories.invalidate` for every repository of the task
    ([engine.ts:708, 791](../../apps/orchestrator/src/engine/engine.ts#L708)).
- **Dashboard**
  - **New Task**
    - The Repository combobox stays as it is, so the existing e2e steps keep
      working.
    - Below it: "Also work in (optional)". This reuses the same single-value
      `Combobox` to add one repository at a time, shows each choice as a chip
      with a remove button, and excludes repositories already chosen.
    - When any are chosen, the Worktree switch is forced on and disabled, with
      the help text "Tasks across repositories always run in their own copies;
      your folders are not touched."
    - Semantic tokens and shared `packages/ui` components only.
  - Tasks list: shows "api + 2".
  - Task header and Overview: list every repository.
  - Changes tab:
    - one section per repository;
    - list keys are `repositoryId + path`;
    - the diff hook passes `repositoryId`;
    - "Open file" uses that repository's path.
- **Host message**: `openDiff` gains an optional `repositoryId`, in both the
  dashboard and extension copies ([runtime.tsx:12-20](../../apps/dashboard/src/app/runtime.tsx#L12), [webview.ts:7-14, 64-68](../../apps/vscode-extension/src/webview.ts#L7)).
- **Remote node**
  - `remote/guards.ts` refuses a cloud `task.create` carrying
    `linkedRepositoryIds` with `MULTI_REPOSITORY_LOCAL_ONLY`.
  - `egress.ts` also strips `workspacePath`.
  - The cloud continues to show the primary repository.

### 4. Implementation steps

Each step keeps `pnpm check` green before moving to the next.

1. **Shared contract**
   - Add `linkedRepositoryIds` to `createTaskSchema`, with refinements: distinct,
     max 7, and it cannot be combined with `worktree: false`.
   - Add `TaskSummary.repositories`, the per-repository fields of
     `TaskChanges`, `ChangedFile.repositoryId?`, and the optional
     `workspacePath` and `folder` on `TaskGitInfo`.
   - Unit tests for the schema.
2. **Migration 10 and store**
   - Append a new migration as described in §3.2. Shipped migrations are never
     edited.
   - Store functions: `insertLinkedRepositories`, `listLinkedRepositories`,
     `updateLinkedRepositoryGit`.
   - Change `listTasks({repositoryId})` and `countTasksForRepository` to match
     the primary **or** a linked row (`EXISTS`).
   - Add `repository_id` to test runs and `parts` to checkpoints.
   - Migration test: a v9 database with tasks upgrades to v10, and every
     existing task reads back unchanged.
3. **`task-repositories.ts` accessor** (§3.3), with unit tests. Refactor
   `workdir.ts` callers to `agentWorkdir` / `taskRepositories` without changing
   behaviour. The full existing suite must pass unmodified before step 4.
4. **Engine: create and baseline**
   - Validation and restrictive defaults.
   - Folder naming.
   - Workspace creation.
   - Baseline for every repository, with rollback on failure (§5).
   - `tooling.createWorktree` accepts a target directory.
   - Add a guarded `deleteBranchIfAt(repo, branch, head)` to
     [packages/git](../../packages/git/src/index.ts). It refuses unless the
     branch tip equals the given commit.
5. **Engine: scheduling**: repository-set intersection in `repositoryHolder`,
   and invalidate every repository.
6. **Stages**
   - Per-repository `runCommands`, `runVerify` and `runGit`.
   - Per-repository `stageCommands`, `skipsForLackOfCommands` and
     `verificationCoverage`.
   - `test_runs.repository_id`.
7. **Completion and cancel**
   - Per-repository finalize and backup refs.
   - Combined `git-diff.patch`.
   - `report.ts`: Repositories, Files and Git sections.
   - Workspace removal.
8. **Context and prompts**: per-repository facts and diffs, the workspace
   layout, and the nested `AGENTS.md` instruction. `RUN_CONTEXT` is unchanged.
9. **Tool layer**
   - The scope's `repositories`.
   - Git pack and `terminal.start` `cwd`.
   - Credential resolution by folder.
   - The `credential.generate` refusal.
   - Profile union.
   - Tests for each, including refusal outside the roots and credential
     isolation between two repositories.
10. **Checkpoints and Chairman**: `parts`, the all-or-nothing restore,
    per-repository prune, evidence and scrub labels, gate kinds.
11. **HTTP**
    - Changes and diff per repository.
    - Source Control attribution and branch blocker via the accessor.
    - Refuse deleting a repository used as a linked repository.
    - Remote guard and egress `workspacePath`.
12. **Dashboard and extension**
    - New Task "Also work in".
    - Tasks list, header and Overview.
    - Changes tab sections.
    - `openDiff.repositoryId` in both copies.
    - Read [design.md](../../design.md) §7.2 and §8.3 first.
13. **Demo and e2e**
    - Append one multi-repository demo task after the existing seeds, so that
      TASK-0001 and TASK-0004 keep their numbers.
    - e2e: create a multi-repository task through the UI, check the Changes
      sections, and run the matrix in both themes and at both widths.
14. **Docs** (same change set)
    - [workflow-engine.md](../systems/workflow-engine.md),
      [checkpoints.md](../systems/checkpoints.md), [git.md](../systems/git.md),
      [tool-system.md](../systems/tool-system.md),
      [credential-broker.md](../systems/credential-broker.md),
      [chairman.md](../systems/chairman.md),
      [dashboard.md](../systems/dashboard.md),
      [orchestrator.md](../systems/orchestrator.md) (tables, API),
      [remote-node.md](../systems/remote-node.md).
    - [PLAN.md](../../PLAN.md) §15 Task Model and §26 Worktrees.
    - Update the `Last verified` dates.
15. **Release**
    - Run `pnpm check`, `pnpm build && pnpm e2e`, and the real agent run in §7.
    - Save with explicit paths only, because other sessions share this tree.
    - Push to `main`.
    - Back up `acc.db`, then restart the orchestrator so migration 10 applies.

#### Irreversible steps

- **Migration 10 applied to the live database.** It only adds a table and
  columns, and older binaries ignore them. It cannot be removed without a manual
  schema edit. A copy of `acc.db` is taken first.
- **Push to `main`.** The branch model is direct push; it is not rewritten
  afterwards.
- No production deploy. Cloud Control code is not changed, so there is no
  Cloudflare release.

### 5. Failure handling and recovery

| Failure | Handling |
|---|---|
| A linked repository is not Git, has no commits, or is unknown | Refused at create with the repository named (`INVALID_INPUT`). Nothing is written. |
| Creating worktree *k* of *n* fails (locked folder, disk, Git error) | Roll back this attempt's worktrees 1..k-1: `removeWorktree` force, then `deleteBranchIfAt(branch, head)`, which only deletes an empty branch. Clear their records. The task goes to `WAITING_FOR_USER` with "Could not prepare `<repo>`: `<reason>`". Resume retries from a clean state. |
| Crash between `addWorktree` and saving its record | On retry the folder exists with no record. No agent ever ran in it, because every repository is baselined before stage 1, so it is removed with force and recreated. A branch name collision gets `-2` (existing `addWorktree`). |
| Restart mid-run | Records are in the database. `ensureBaseline` skips baselined repositories. The existing INTERRUPTED/resume and Chairman restart paths apply unchanged. |
| Tests fail in one repository | The stage fails and the fixer sees the folder. It counts as a normal fix cycle, or goes to Chairman recovery. |
| Hook rejects a commit in one repository | `tests_failed` names the folder. Commits already made in other repositories stay, and the next cycle commits only new task files. |
| Finalize fails for one repository | Keep going with the others. That worktree is kept and the report says where (existing message). The task still completes, as `NEEDS_USER_ACTION`. |
| Checkpoint restore fails part-way | Restore the finished repositories from the before-rollback checkpoint, and report which one failed. Never leave a mixed state silently. |
| A linked repository is removed or moved on disk mid-task | The stage fails with a path error, and the existing retry leads to `WAITING_FOR_USER`. Removal through the API is refused while a task references it. |
| Two tasks share one repository | The second waits: "Waiting for TASK-x in the same repository (web)". |

### 6. Security and data protection

- **Confinement never widens.** Roots = `[workspace]`, and that folder contains
  only this task's worktrees. The new `cwd` inputs go through `resolveInside`,
  and a test proves `../` and absolute paths outside are refused. The tool
  policy, command classifier, subscription guard and Host/Origin/token checks
  are unchanged.
- **Credential isolation.** Resolution follows the folder the call runs in, and
  fails closed to "global only" at the workspace root. A test proves
  repository A's credential is not injected for a call in repository B's
  folder.
- **User work is protected.** Isolation is mandatory, so no linked repository's
  working tree, index or current branch is touched. Branch deletion is only
  allowed for an untouched branch created in the same attempt
  (`deleteBranchIfAt`).
- **The least-privilege default** is the most restrictive auto-approve level and
  policy among the task's repositories.
- **Egress.** `workspacePath` joins the stripped fields, so no local path leaves
  the machine. Multi-repository creation from the cloud is refused.
- **No new secrets or literals.** Test credentials are assembled at runtime.
  Redaction runs before every row write, as today.
- **Commits stay explicit.** Only task-origin files are committed, hooks run
  normally, and nothing is ever pushed automatically.

### 7. Testing and verification

**Unit and integration** (vitest, `apps/orchestrator/test`, simulated agents).
Extend `createTask(t, repositoryId, …, extra)` with
`extra.linkedRepositoryIds`, so the ~13 test files using the helper don't change.

1. Schema: duplicates, the primary listed again, 8 linked, and
   `worktree:false` + linked are all refused.
2. Migration 9→10 keeps every existing task byte-identical when read back.
3. Full Autopilot across two `makeRepo` repositories, each with an uncommitted
   user file:
   - both worktrees are created under one workspace;
   - tests run per repository, and `test_runs.repository_id` is set;
   - there are commits on both task branches;
   - the report lists both;
   - the worktrees and workspace are removed;
   - **both user files and current branches are unchanged**.
4. Cancel: backup refs exist in both repositories.
5. Scheduling: a single-repository task in B waits while an A+B task runs, and
   starts after it.
6. Worktree failure on repository 2 → repository 1's worktree and empty branch
   are gone, the task is `WAITING_FOR_USER`, and resume succeeds.
7. Checkpoints: create and restore across 2 repositories. Restore is refused
   when one HEAD moved. A simulated failure part-way restores the first
   repository.
8. Tool layer: the git pack and `terminal.start` `cwd` are refused outside the
   roots; credential A is not visible from folder B; `credential.generate` is
   refused at the root.
9. API:
   - `/changes` and `/diff?repositoryId=` return per-repository results;
   - the list filter by a linked repository finds the task;
   - `DELETE repository` on a linked repository returns 409;
   - Source Control refuses deleting a linked task branch.
10. Remote: the guard refuses cloud multi-repository create, and egress strips
    `workspacePath`.
11. Regression: the whole existing suite passes, and single-repository output
    (reports, events, test names) is unchanged.

**End-to-end** (`pnpm build && pnpm e2e`):
- the New Task "Also work in" flow;
- the Changes tab sections;
- the task list label;
- the full visual matrix in both themes, desktop and phone, with no axe
  violations and no horizontal overflow.

**Real behaviour**
- One real Claude Code task across two scratch repositories. For example:
  "rename function X in lib and update its call in app".
  - Check that the agent edited both folders and the checks ran in each.
  - Check that both branches carry the commit and the user's folders are
    untouched.
- Verify the dashboard visibly with browser-autopilot on the operator's PC.
- Codex is reported **unverified** if its CLI or credits still block it.

### 8. Success criteria

1. A task created with a primary and linked repositories runs Full Autopilot
   end to end with a real agent. It commits the task's changes on one task
   branch per repository, and each repository's checks were observed by the
   orchestrator.
2. No file, index entry or current branch in any user working tree changes
   during or after the task.
3. Single-repository tasks behave exactly as before, and the existing test
   suite passes unmodified.
4. Each of these is proven by a test:
   - a tool call can't reach outside the workspace;
   - a credential for one repository is never usable from another;
   - a cloud request can't create a multi-repository task.
5. Failure paths leave no orphan worktrees, no empty stray branches and no mixed
   restore:
   - worktree creation failing part-way;
   - restart;
   - cancel;
   - a checkpoint restore failing part-way.
6. Dashboard:
   - New Task can add and remove linked repositories;
   - Tasks, header and Changes show every repository;
   - the Playwright matrix is green in both themes.
7. The docs listed in step 14 describe the shipped behaviour and have current
   `Last verified` dates.

### 9. Found for Later

- **Isolated single-repository tasks still hold their repository.**
  `repositoryHolder` ([engine.ts:688-693](../../apps/orchestrator/src/engine/engine.ts#L688))
  never checks `git.isolated`, so worktree tasks in the same repository run one
  at a time, and [git.md](../systems/git.md#limitations) reads as if they don't.
  Decide whether to allow parallel isolated tasks, then fix the code or the doc.
- **MCP server credentials are never repository-scoped.**
  [mcp.ts:106, 134](../../apps/orchestrator/src/tools/mcp.ts#L106) call
  `config()` without a `repositoryId`, so a per-repository MCP credential is
  never resolved.
- **Out-of-root paths are refused, not escalated**
  ([paths.ts:51-57](../../packages/tools/src/paths.ts#L51)).
  [tool-system.md](../systems/tool-system.md) line 65 implies escalation. Align
  the doc with the code.
- Cloud-created multi-repository tasks. This needs:
  - D1 `cloud_task_repositories`;
  - leases on every fingerprint, taken atomically;
  - routing to a node that holds all the repositories.
- An App check that starts several apps together (a client plus its API).
- Usage and budgets split per repository. Today the primary carries the whole
  run.
- Each repository's `.claude/settings.json` hooks don't load, because the agent
  cwd is the workspace. Only the primary's `AGENTS.md` is found automatically by
  Codex; the prompt compensates for the rest.
- Adding or removing linked repositories on a draft task (`updateTaskSchema`).

### 10. Next Recommended Task

**Merge assistant for multi-repository tasks.** Source Control shows each
repository's task branch separately, so merging a cross-repository change means
several manual merges in the right order. Add "Merge all task branches" on the
task page. It would:

- fast-forward only, in the task's repository order;
- refuse the whole merge if any repository can't fast-forward;
- run through the existing Source Control journal and writer lock.

### 11. Final execution prompt

> Implement [docs/plans/MULTI_REPO_TASKS_PLAN.md](MULTI_REPO_TASKS_PLAN.md) in
> `AI-Development-Control-Center`.
>
> First, re-read the files the plan cites and confirm the line references still
> hold. Also read [AGENTS.md](../../AGENTS.md), [design.md](../../design.md)
> §7.2/§8.3 and the `docs/systems/` files named in step 14.
>
> Work through §4 steps 1-15 in order, keeping `pnpm check` green after each
> step. Hard constraints:
> - Single-repository tasks must behave exactly as before, and the existing test
>   suite must pass unmodified.
> - Migration 10 is additive and appended. Never edit a shipped migration.
> - Never weaken path confinement, the tool policy, the command classifier,
>   credential scoping or egress redaction without a test proving the new
>   behaviour.
> - Multi-repository tasks are always isolated. No user working tree is ever
>   written.
> - Semantic tokens and `packages/ui` components only in the dashboard.
>
> Run every test in §7, including one real Claude Code task across two scratch
> repositories and the Playwright matrix in both themes. Update the docs in the
> same change set.
>
> Many sessions share this working tree: stage explicit paths only, and check
> for other sessions' migrations before restarting. Back up `acc.db`, push to
> `main`, restart the orchestrator, and confirm migration 10 applied.
>
> Report each §8 success criterion as checked, not verified, or couldn't check.

/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.

## Steps

- [x] 1. Shared contract: `linkedRepositoryIds` on `createTaskSchema` (distinct, max 7, not with `worktree:false`), `TaskSummary.repositories`, per-repository `TaskChanges`, `ChangedFile.repositoryId?`, `TaskGitInfo.workspacePath?/folder?` — done when: the schema refuses duplicates, the primary repeated, 8 linked and worktree:false+linked, and accepts a valid list — check: `pnpm vitest run packages/shared`
- [x] 2. Migration 12 and store: `task_linked_repositories`, `test_runs.repository_id`, `task_checkpoints.parts`; store read/write helpers; `listTasks({repositoryId})` and `countTasksForRepository` match linked rows — done when: a v11 database with tasks upgrades to v12 and every existing task reads back unchanged, and a task linked to a repository is found by that repository's filter — check: `pnpm vitest run apps/orchestrator/test/migrations.test.ts apps/orchestrator/test/multi-repo.test.ts`
- [x] 3. `task-repositories.ts` accessor (`taskRepositories`, `taskRepository`, `isMultiRepository`, `agentWorkdir`, `updateTaskRepositoryGit`) and callers of `taskWorkdir` moved onto it without behaviour change — done when: the whole existing suite passes unmodified — check: `pnpm test`
- [x] 4. Engine create and baseline: validation, most-restrictive defaults, folder naming, workspace, baseline of every repository before stage 1, rollback on failure, `createWorktree` with a target directory, guarded `deleteBranchIfAt` — done when: a two-repository task gets both worktrees under one workspace with both user trees untouched, and a failure on repository 2 leaves no worktree or empty branch behind and parks the task — check: `pnpm vitest run apps/orchestrator/test/multi-repo.test.ts`
- [x] 5. Scheduling: repository-set intersection in `repositoryHolder`, invalidate every repository — done when: a single-repository task in B waits while an A+B task runs and starts after it — check: `pnpm vitest run apps/orchestrator/test/multi-repo.test.ts`
- [x] 6. Stages per repository: tests/commands with `test_runs.repository_id`, App check per runtime, Git stage commits per repository, coverage and skip rules — done when: Full Autopilot across two repositories records test runs for each and commits on both task branches — check: `pnpm vitest run apps/orchestrator/test/multi-repo.test.ts`
- [x] 7. Completion and cancel: per-repository finalize and backup refs, combined `git-diff.patch` with folder prefixes, report Repositories/Files/Git sections, workspace removal — done when: completion removes every worktree and the workspace and the report names both repositories; cancel leaves a backup ref in both — check: `pnpm vitest run apps/orchestrator/test/multi-repo.test.ts`
- [x] 8. Context and prompts: per-repository facts and bounded diffs, workspace layout, nested AGENTS.md instruction — done when: an agent prompt for a multi-repository task lists every folder with its repository and commands — check: `pnpm vitest run apps/orchestrator/test/multi-repo.test.ts`
- [x] 9. Tool layer: scope `repositories`, git pack and `terminal.start` `cwd` confined to roots, credential resolution by folder, `credential.generate` refused at the workspace root, profile union — done when: tests prove a cwd outside the roots is refused, credential A is not injected for a call in folder B, and generate is refused at the root — check: `pnpm vitest run apps/orchestrator/test/tools.test.ts apps/orchestrator/test/multi-repo.test.ts`
- [x] 10. Checkpoints and Chairman: `parts`, all-or-nothing restore, per-repository prune, evidence and scrub labels, union of check kinds — done when: create/restore across two repositories works, restore is refused when one HEAD moved, and a failure part-way restores the first repository — check: `pnpm vitest run apps/orchestrator/test/multi-repo.test.ts apps/orchestrator/test/chairman.test.ts`
- [x] 11. HTTP, Source Control and remote: per-repository `/changes` and `/diff?repositoryId=`, attribution and branch blocker via the accessor, repository delete refused when linked, remote guard refuses cloud multi-repository create, egress strips `workspacePath` — done when: each of those is asserted by a test — check: `pnpm vitest run apps/orchestrator/test/api.test.ts apps/orchestrator/test/source-control.test.ts apps/orchestrator/test/remote-egress.test.ts apps/orchestrator/test/remote-commands.test.ts apps/orchestrator/test/multi-repo.test.ts`
- [x] 12. Dashboard and extension: New Task "Also work in", Tasks list label, header/Overview repositories, Changes tab sections, `openDiff.repositoryId` in both host-message copies — done when: the dashboard and extension typecheck and the new UI renders from real API data — check: `pnpm typecheck && pnpm lint`
- [ ] 13. Demo seed and e2e: one multi-repository demo task appended after the existing seeds; e2e for the New Task flow and Changes sections; full matrix in both themes — done when: the Playwright suite passes — check: `pnpm build && pnpm e2e`
- [ ] 14. Real agent run: one real Claude Code task across two scratch repositories — done when: the agent edited both folders, checks ran in each, both task branches carry a commit and the user folders are untouched — check: `manual: task id, branches and commits recorded in the Ledger`
- [ ] 15. Docs: workflow-engine, checkpoints, git, tool-system, credential-broker, chairman, dashboard, orchestrator, remote-node system docs and PLAN.md §15/§26 describe the shipped behaviour with current Last verified dates — done when: docs guard passes and each file names the multi-repository behaviour — check: `pnpm docs:guard && git diff --stat docs/ PLAN.md`

## Tail

- [ ] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat` reviewed hunk by hunk
- [ ] T2. Similar-issue sweep — done when: every remaining reader of `task.repositoryId`, `task.git` and `taskWorkdir` was searched and each is either multi-repository aware or deliberately primary-only — check: `manual: list what was searched and what was found`
- [ ] T3. Gates green — done when: `pnpm check` and `pnpm build && pnpm e2e` pass on the full suite, or a failure is shown to be another session's — check: `pnpm check && pnpm build && pnpm e2e`
- [ ] T4. Docs synced per the repo's rules — done when: step 15's files reflect the shipped code — check: `git diff --stat docs/`
- [ ] T5. Committed path-scoped and pushed — done when: `git status` shows none of this work uncommitted and the push succeeded — check: `git log origin/main..HEAD --oneline`
- [ ] T6. Live on this machine — done when: `acc.db` is backed up, the orchestrator restarted, the live database reports schema version 12 and the dashboard shows the "Also work in" field (no deploy on push for this repo) — check: `manual: schema version and dashboard observation recorded in the Ledger`
- [ ] T7. A claim registered for this change — done when: the repo's claims register holds an entry, or this step says why there is none — check: `manual: name the claim, or the reason`

## Ledger

- 2026-09-24 — created from the conversation plan, kept under the operator's requested file name rather than a kebab-case slug
- 2026-09-24 — migrations 10 and 11 were shipped by other sessions after the investigation (22 commits since 741cbe5); this plan's migration is **12**. Line references in Context predate those commits and are re-checked per step.
- 2026-09-24 — docs/plans/ROLE_PROMPTS_PLAN.md is another session's untracked file; not touched, not staged.
- 2026-09-24 — step 1 — other sessions are editing context.ts, runners.ts, routes.ts and shared/index.ts in the shared tree at the same time; this work moved to its own worktree (C:/Users/abuye/acc-multi-repo, branch multi-repo-tasks), to be rebased onto main and fast-forward pushed at T5 — prevents interleaved hunks in path-scoped commits
- 2026-09-24 — step 1 — views.summary returns repositories (primary only) and the extension test fixture gained the field, so the whole repo typechecks after the contract change
- 2026-09-24 — step 2 — updateLinkedRepositoryGit bumps tasks.version so clients refetch, matching a tasks.git change; the linked row has no version of its own
- 2026-09-24 — step 3 — full suite: 705 passed, 1 failed (pty ConPTY interactive-shell timeout) which passes 3/3 alone; an earlier run showed 37 failures while other sessions ran suites concurrently — load, not this change. updateTaskRepositoryGit lives in the engine (it must publish), so the accessor module is read-only; only the agent/tool/terminal callers moved to agentWorkdir here, per-repository callers change in steps 6-11
- 2026-09-24 — step 3 — another session has claimed migration 12 (connected apps) in the shared tree; this branch renumbers to the next free version when it is rebased at T5
- 2026-09-24 — step 4 — the simulated agent (packages/agent-sdk) now edits sim-output.md in every repository folder when its cwd is a workspace with no Git at the root; single-repository behaviour unchanged. Needed so tests exercise real edits in both repositories
- 2026-09-24 — step 4 — a failed workspace preparation parks the task WAITING_FOR_USER with blocker kind error (no new blocker kind); rollback uses git update-ref -d <branch> <head>, an atomic compare-and-delete, rather than branch -D
- 2026-09-24 — step 4 — Publisher.updateRepositoryGit is the single write path for a repository Git record (primary → tasks.git, linked → its row), so every change is published
- 2026-09-24 — step 4 — workspace folder names avoid Windows reserved names (con, nul, aux, prn, comN, lptN)
- 2026-09-24 — step 5 — the queued message keeps its exact single-repository text and appends (repository name) only when either task works in several repositories
- 2026-09-24 — step 6 — test_runs.repository_id is set for every run of a multi-repository task (primary included) and stays null for single-repository tasks; run names are "<folder> · <command>" only in multi-repository tasks. skipsForLackOfCommands takes every repository of the task. browser-verification.md is written once per App check stage (artifacts.write makes a new -N copy per call)
- 2026-09-24 — step 7 — diffSince gained an optional folder prefix (--src-prefix/--dst-prefix) for the combined git-diff.patch; verification coverage across repositories reports each repository on its own and adds "<folder>: no checks configured" to Not verified (which, like any missing check, is reported, not a limitation). finalizeWorktree takes the repository Git record and a label; single-repository messages are unchanged
- 2026-09-24 — step 8 — the workspace layout, per-folder facts, Git status, changed files and diffs (one shared 150 KB bound, folder-prefixed) replace the single-repository variables only for multi-repository tasks; role templates are unchanged
- 2026-09-24 — step 9 — narrowing (ToolService narrowToRepository) goes further than the plan: a call naming a repository folder (cwd, else directory, else the scope cwd) runs with its roots shrunk to that repository, not just its credentials, so e.g. cwd=api with directory=web is refused rather than deploying web with api credentials. It runs before routing so project-local tools are detected in that repository. credential.generate gained an optional cwd so a secret can be made for one repository of a workspace
- 2026-09-24 — step 9 — git cwd with protected user work (single-repository, non-isolated) is allowed only at the repository root: protected paths are root-relative, so a subfolder cwd could otherwise let a protected file be committed or restored
- 2026-09-24 — step 10 — a checkpoint across repositories is all or nothing at creation too (refs already made are deleted if one repository fails). Database checkpoints of a multi-repository task are rooted at the workspace. Chairman evidence switches to per-folder labels only while the task has a workspace, so the existing evidence unit test (a partial Store stub) runs unmodified. The part-way-failure test lives in its own file (multi-repo-restore.test.ts) because it mocks @acc/git for that file only
- 2026-09-24 — step 11 — Source Control reads a task Git record per repository through one private gitIn(task, repositoryId) (attribution, active task, commit attribution, branch blocker); the tests assert the linked repository shows the task as active, and the store test of step 2 covers the 409 on removing a linked repository. /changes keeps the flat primary fields and adds repositories[]; /diff takes repositoryId (404 when the task does not work in it)
- 2026-09-24 — step 12 — "Also work in" reuses the single-value Combobox (one pick adds one repository) plus a list with remove buttons like Attachments; it is hidden in cloud mode (the node refuses it there) and when only one repository is registered. Advanced defaults show the most restrictive auto-approve level and policy across the chosen repositories, matching the orchestrator. Overview gains a Repositories row; its Branch row stays the primary branch (every repository branch is on the Changes tab)
