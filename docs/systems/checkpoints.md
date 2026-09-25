---
system: checkpoints
sources:
  - apps/orchestrator/src/chairman/checkpoints.ts
  - packages/git/src/worktrees.ts
  - apps/orchestrator/src/engine/tooling.ts
verified_at: b9ce60f
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

Repository Git mode **Isolated worktree** (or `worktree: true` on a task). It
is the default for every repository added since 2026-09-25; one added before
keeps its mode, and its page shows **Tasks run in your working folder** with a
**Use isolated worktrees** button. The task header shows the folder a task
works in:

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

When the worktree cannot be created (a repository with no commits, a locked
or occupied folder) the task stops before anything is touched, with the hard
blocker *Couldn't create an isolated worktree: <reason>. Your working folder
was not touched.* — it never falls back to your checkout. **Resume** tries
again; a folder a previous attempt left behind is cleared first. A folder that
is not a Git repository has no branch to switch and still runs in place.

Baseline checks ([workflow-engine.md](workflow-engine.md#gates-that-tell-the-truth))
use a third kind: a detached worktree of the task's baseline commit under
`<data>/baselines/`, removed after the one command, swept at start.

A task across repositories has one worktree per repository inside
`<data>/workspaces/<task>/<folder>`, all created before its first stage; a
failure removes what that attempt made and parks the task. Its checkpoints
hold one ref per repository (`task_checkpoints.parts`) and restore all or
nothing ([multi-repository-tasks.md](multi-repository-tasks.md)).


A rollback holds the writer lock of every repository it rewrites (like a
stage), unless the task already holds it or works in its own worktree, so a
Source Control commit can never land on a half-restored tree.

Last verified: 2026-09-25
