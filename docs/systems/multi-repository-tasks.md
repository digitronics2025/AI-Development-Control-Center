---
system: multi-repository-tasks
sources:
  - apps/orchestrator/src/engine/task-repositories.ts
  - apps/orchestrator/src/engine/engine.ts
  - apps/orchestrator/src/engine/runners.ts
  - apps/orchestrator/src/engine/context.ts
  - apps/orchestrator/src/tools/service.ts
  - apps/orchestrator/src/chairman/checkpoints.ts
verified_at: f6bc77e
---

# Tasks across repositories

A task works in its **primary** repository (`tasks.repository_id`, Git state in
`tasks.git`) and up to **7 linked** ones (`MAX_LINKED_REPOSITORIES`,
[schemas.ts](../../packages/shared/src/schemas.ts)). Plan and decisions:
[MULTI_REPO_TASKS_PLAN.md](../plans/MULTI_REPO_TASKS_PLAN.md).

## Workspace

Every repository of such a task is an isolated worktree, side by side:

```text
<ACC_DATA_DIR>/workspaces/TASK-0142/
  api/   ← primary, on ai/TASK-0142-…
  web/   ← linked, on ai/TASK-0142-…
```

- Agents, tool sessions, terminals and environment discovery work in the
  workspace (`agentWorkdir`). Engine-run work (checks, App check, commits,
  finalize, diffs) runs per repository in its folder.
- Isolation is mandatory: `worktree: false` with `linkedRepositoryIds` is
  refused, and so is a repository that is not Git or has no commit — checked
  at create, before anything is written. Your working trees, indexes and
  current branches are never touched.
- Folder = repository name slug (≤ 30 chars, `-2`… when repeated, Windows
  reserved names get `-repo`), fixed at create.
- The task takes the **most restrictive** auto-approve level and policy mode
  of its repositories (`strictestPolicy`), unless set on the task.

## Data (migration 13)

| Where | What |
|---|---|
| `task_linked_repositories(task_id, repository_id, position, folder, git)` | Linked repositories; `git` is the same `TaskGitRecord` shape as `tasks.git`. `repository_id` has no cascade, so a repository in use cannot be removed (409) |
| `tasks.git.workspacePath`, `tasks.git.folder` | The workspace (null once removed) and the primary's folder |
| `test_runs.repository_id` | Set on every run of a multi-repository task; null for single-repository tasks |
| `task_checkpoints.parts` | One `{repositoryId, folder, ref, commit, head}` per repository |

Single-repository tasks have no rows in the new table and read exactly as
before. [task-repositories.ts](../../apps/orchestrator/src/engine/task-repositories.ts)
is the one accessor (`taskRepositories`, `taskRepository`,
`isMultiRepository`, `agentWorkdir`); `Publisher.updateRepositoryGit` is the
one write path for a repository's Git record.

## Lifecycle

| Step | Behaviour |
|---|---|
| Baseline | Every repository gets its worktree and baseline before the first stage (`ensureWorkspace`). A repository already baselined is kept, so it resumes. On a failure the worktrees and still-empty branches of this attempt are removed (`deleteBranchIfAt`, an atomic `update-ref -d <branch> <head>`) and the task waits: "Could not prepare X for this task…" |
| Scheduling | A task waits for any unfinished writer task sharing one of its repositories; the message names the repository when either task spans several |
| Checks | Each repository's own commands in its folder, named `web · unit tests`; `skip_tests` only when no repository has checks |
| App check | Each repository with a runtime, one after another, each stopped before the next; one `browser-verification.md` |
| Git checkpoint | Commits task files in each repository; a hook rejection names the repository |
| Complete | One `git-diff.patch` with folder prefixes (`a/web/src/x.ts`); per-repository Files and Git sections in the report; every worktree finalized, then the empty workspace removed |
| Cancel | Uncommitted work of each repository kept in its own `refs/acc/worktree-backup/<task>` |
| Checkpoints | One ref per repository under the same name; restore is refused if any repository has new commits, takes a safety checkpoint of all, and if one fails puts every repository back — or names the safety checkpoint to restore when that fails too |
| Resume | A worktree removed outside the Control Center parks the task with its name instead of running in a missing folder |
| Stray files | Anything written at the workspace root is on no branch: the report lists it and is never READY |

## Tool calls

A call in a multi-repository scope runs in **one** repository
(`narrowToRepository`, [service.ts](../../apps/orchestrator/src/tools/service.ts)):
the one containing its `cwd` (else `directory`, else the scope cwd). Its
roots shrink to that repository's folder and it gets that repository's
credentials only. At the workspace root it keeps the workspace as its root,
only credentials not limited to any repository are usable, and Git capabilities
are refused (any Git process there also gets `GIT_CEILING_DIRECTORIES`, so it
never finds a repository above the data folder);
`credential.generate` is refused there (it takes `cwd`). A folder outside the
roots is refused (`OUTSIDE_ROOT`). Git tools and `terminal.start` accept a
confined `cwd`.

## Prompts

The workspace layout, each folder's facts, Git status and changed files, and
all diffs packed together by priority into one 150 KB budget (folder-prefixed; every file
not shown is named in `{{diff_coverage}}`, [workflow-engine.md](workflow-engine.md#gates-that-tell-the-truth)) replace the
single-repository variables; the prompt tells agents to read each folder's
`AGENTS.md`/`CLAUDE.md`.

## API and clients

- `POST /api/tasks {linkedRepositoryIds}`; `TaskSummary.repositories` (primary
  first, length 1 for a single repository).
- `GET /api/tasks?repositoryId=` and task history match linked repositories
  (on this machine; the cloud's offline copy filters by the primary only).
- `GET /api/tasks/:id/changes` keeps the primary's flat fields and adds
  `repositories[]`; `GET /api/tasks/:id/diff?repositoryId=` (404 for a
  repository the task does not work in).
- Source Control reads a task's record for that repository (`gitIn`):
  attribution, active task, commit attribution, branch protection.
- New Task: **Also work in** (local only), Tasks list "api + 1", header and
  Overview list every repository, Changes groups files by repository;
  `openDiff` carries `repositoryId`.
- Additive for every task: test runs carry `repositoryId` (null for a single
  repository) and checkpoints `parts` (null for a single repository).
- Cloud: a `task.create` with `linkedRepositoryIds` is refused on the node;
  `workspacePath` is stripped from egress.

## Gotchas

- A Git `cwd` may only name a repository folder, never a folder inside it
  (it could hold a nested repository).
- Codex runs with `-C <workspace> --sandbox workspace-write`, so it can write
  every folder; it was not exercised in the real run (Claude Code was).
- Each repository's `.claude/settings.json` hooks do not load: the agent's
  cwd is the workspace.
- Usage and budgets attribute the whole task to the primary repository.

Last verified: 2026-09-25
