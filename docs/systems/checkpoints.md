---
system: checkpoints
sources:
  - apps/orchestrator/src/chairman/checkpoints.ts
  - packages/git/src/worktrees.ts
  - apps/orchestrator/src/engine/tooling.ts
verified_at: 57af61a
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
**Roll back**, or `checkpoint.restore` (Level 3). Without a `checkpointId` it
restores the last automatic checkpoint taken before the latest write-class
stage (implementer, fixer, designer; `lastChangeTarget`). The API routes go
through the Chairman's Action Gateway, which stops a running write stage first. All
checkpoints work on the task's working directory, which is its worktree when
isolated.

## Worktrees ([worktrees.ts](../../packages/git/src/worktrees.ts))

Repository Git mode **Isolated worktree** (or `worktree: true` on a task). It
is the default for every repository added since 2026-09-25; one added before
keeps its mode, and its page shows **Tasks run in your working folder** with a
**Use isolated worktrees** button. The task header shows the folder a task
works in:

1. Before the first stage the engine runs `git worktree add -b ai/TASK-… <work>/worktrees/<repo>-<id>/<task> HEAD`
   in the work root, outside the data folder so an agent may name its paths
   ([orchestrator.md](orchestrator.md#work-root-acc_work_dir); worktrees made
   in `<data>/worktrees` before it existed are moved there once, at start).
   The baseline is that commit with no pre-existing changes — your
   uncommitted work stays in your working tree and is never seen.
2. When the project has a lockfile, dependencies are installed with its
   package manager (`node.install`, locked) **in the background**
   (`EngineTooling.startInstall`): read-only agent stages (Level 1 — Claude
   Code has no shell there, Codex a read-only sandbox) start at once, and
   anything else — a Level ≥ 2 agent stage, tests, commands, verify, Git,
   release, completion — waits for it first. While it runs a Level 1 prompt
   gets `## Dependencies` (node_modules may be incomplete; run no project
   scripts). An install never outlives the loop that started it: pause,
   redirect, drain and cancel wait for it (cancel waits rather than kills: a
   stopped tool call answers before the killed process tree has exited, and a
   worktree is never removed under a running install); a shutdown stops it.
   A task that parks meanwhile (an approval, a question) reads as not running
   at once, and runs again only after the install ends. A failed install is
   logged and the task goes on. Done means
   `node_modules/.acc-install-complete`, written only after a successful
   install — or, for npm, npm's own `node_modules/.package-lock.json`, which
   `npm ci` deletes first and writes last, so a test stage's repair `npm ci`
   (which empties node_modules, the marker with it) or an agent's still
   counts. A worktree with neither (an install a restart or shutdown cut
   short, or one made before this marker existed) is installed again the next
   time the task runs. A task across repositories installs each repository in
   turn, the same way. Without a lockfile nothing is installed up front — an
   install would write a new lockfile into the task's changes — and the test
   stage's repair installs when a check needs it ([recovery.md](recovery.md)).
   A tool looked for in the worktree while the install runs (a Level 1
   Wrangler read on a machine without a global Wrangler) can be found missing;
   when the install ends, what the tool layer remembered about that folder is
   forgotten (`ToolService.forgetFolder`), so later stages find it
   ([tool-system.md](tool-system.md)).
3. Every stage, command, tool call, checkpoint and terminal of the task uses
   the worktree. Its stages do not take the repository's writer lock, so
   Source Control stays usable while it runs.
4. **Completed**: remaining task files are committed to the branch, the
   branch stays for you to merge. **Cancelled**: uncommitted work is kept in
   `refs/acc/worktree-backup/<task>` first. Then the worktree folder is
   renamed into `<work>/trash/<parent>-<folder>-<random>` (same drive: a
   rename, not a copy), `git worktree prune` drops Git's record of it,
   `worktreePath` is cleared, COMPLETED (or CANCELLED) is published, and the
   folder — node_modules included, ~11 s on a large repository — is deleted
   in the background ([orchestrator.md](orchestrator.md#work-root-acc_work_dir)). A folder
   that cannot be renamed (a locked file, a process still inside on Windows),
   or that still has changes when nothing was committed, is removed in place
   as before (`git worktree remove`).
5. After removal the task's Changes and diff views read
   `baselineCommit..taskBranch`; `git-diff.patch` is written after the final
   commit and read from the task branch, never from the moved folder.

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
`<work>/workspaces/<task>/<folder>`, all created before its first stage (their
installs follow in the background, as in step 2); a failure removes what that
attempt made and parks the task. Its checkpoints
hold one ref per repository (`task_checkpoints.parts`) and restore all or
nothing ([multi-repository-tasks.md](multi-repository-tasks.md)).


A rollback holds the writer lock of every repository it rewrites (like a
stage), unless the task already holds it or works in its own worktree, so a
Source Control commit can never land on a half-restored tree.

## Stage Team checkouts

Write workers of a Stage Team run in detached child checkouts of a hidden
checkpoint of the task worktree (`refs/acc/team/<task>/…`, folders under
`<work>/team-worktrees/`); results are captured as hidden commits and
written back only while the task still equals the base. Swept at start,
deleted at completion and cancel ([stage-teams.md](stage-teams.md)).

Last verified: 2026-09-27
