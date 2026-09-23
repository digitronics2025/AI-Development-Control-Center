---
system: checkpoints
sources:
  - apps/orchestrator/src/chairman/checkpoints.ts
  - packages/git/src/worktrees.ts
  - apps/orchestrator/src/engine/tooling.ts
verified_at: 351db1e
---

# Checkpoints and worktrees

## Checkpoints

One service, [checkpoints.ts](../../apps/orchestrator/src/chairman/checkpoints.ts),
for the Chairman, the tool layer and the API; one table, `task_checkpoints`.

| Type | What is kept | Restore |
|---|---|---|
| `git` | A commit of the whole working tree built in a private index under `refs/acc/checkpoints/<task>/<n>` ([git.md](git.md#checkpoints)) | Rewrites only task-owned paths; refuses across a new commit; takes a safety checkpoint first |
| `database` | A SQLite online backup of one file in the task, stored in `<data>/tasks/<task>/checkpoints/` | Copies the backup over that file (the current file is kept as `.before-restore`) |
| `deployment` | Metadata only | Refused: roll a deployment back with an approved deploy of that version |

Every git checkpoint records `metadata`: branch, head, dirty file count and the
first 200 dirty paths, SHA-256 prefixes of lockfiles, Node version and
platform (no file contents). Checkpoints are taken:

- before every write-capable agent stage of a supervised task (Chairman);
- by the tool layer before a Level ≥ 3 call or a database write in a task;
- on request: `POST /api/tasks/:id/checkpoints {label}`, the Execution tab,
  `checkpoint.create`, or the Chairman chat.

Restore: `POST /api/tasks/:id/restore {checkpointId?}`, the Execution tab's
**Roll back**, or `checkpoint.restore` (Level 3). The API routes go through
the Chairman's Action Gateway, which stops a running write stage first. All
checkpoints work on the task's working directory, which is its worktree when
isolated.

## Worktrees ([worktrees.ts](../../packages/git/src/worktrees.ts))

Repository Git mode **Isolated worktree** (or `worktree: true` on a task):

1. Before the first stage the engine runs `git worktree add -b ai/TASK-… <data>/worktrees/<repo>-<id>/<task> HEAD`.
   The baseline is that commit with no pre-existing changes — your
   uncommitted work stays in your working tree and is never seen.
2. When the project has a lockfile, dependencies are installed once with its
   package manager (`node.install`, locked). Without one nothing is installed
   up front — an install would write a new lockfile into the task's changes —
   and the test stage's repair installs when a check needs it
   ([recovery.md](recovery.md)).
3. Every stage, command, tool call, checkpoint and terminal of the task uses
   the worktree. Its stages do not take the repository's writer lock, so
   Source Control stays usable while it runs.
4. **Completed**: remaining task files are committed to the branch, the
   worktree is removed, the branch stays for you to merge.
   **Cancelled**: uncommitted work is kept in `refs/acc/worktree-backup/<task>`
   first, then the worktree is removed.
5. After removal the task's Changes and diff views read
   `baselineCommit..taskBranch`.

A repository with no commits cannot have a worktree; the task falls back to a
task branch and says so.

Last verified: 2026-09-23
