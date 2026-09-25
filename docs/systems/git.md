---
system: git
sources:
  - packages/git/**
verified_at: b9ce60f
---

# Git integration

[packages/git](../../packages/git/src/index.ts) wraps the native `git` CLI
(argv only, `GIT_TERMINAL_PROMPT=0`).

## Baseline and task branch

Before the first stage with permission level ≥ 2 the engine records a snapshot:
branch, HEAD, and every dirty file with its content hash
(`git hash-object`). In `task-branch` mode it then runs `git switch -c
ai/TASK-NNNN-<slug>` — this never touches the working tree, so uncommitted user
work comes along untouched. Repositories with no commits are handled (unborn
branch renamed, diffs against the empty tree).

## Change attribution (`changesSince`)

| Origin | Meaning |
|---|---|
| `task` | not dirty at baseline — created by the task |
| `preexisting` | dirty at baseline, unchanged since |
| `both` | dirty at baseline and modified again by the task |

Diffs are against the baseline commit and include untracked files; they are
loaded per file in the UI and bounded (1 MB API, 150 KB in prompts).

## Commits

The `git` stage kind (Full Autopilot's "Git checkpoint") commits only
`task`-origin files, with hooks running normally, and reports `both` files it
left uncommitted. Nothing is ever pushed automatically. When the repository's
pre-commit hook rejects the commit and the stage has `onFail` (Full Autopilot
routes it to `fix`), the rejection counts as a fix cycle: the fixer sees the
hook's message under its test results, and the checkpoint runs again after
test, review and verify. Git's line-ending notices are dropped from failure
text (`failureText`) so the hook's own words are what the fixer reads.

## Releases

A release ([release.md](release.md)) is the one path that sends a task's
commit to a remote, and only after a typed approval. The helpers it uses:
`pushRef(cwd, { sha, remote, remoteRef })` pushes one exact commit (full id
only; `refs/heads/<plain name>` only; a remote name cannot start with `-`; no
force option anywhere); `fetchBranch` updates only
`refs/remotes/<remote>/<branch>`; `remoteBranchHead` reads a branch with
`ls-remote` unattended; `treeOfCommit`, `changedPaths(from, to)` (renames count
as both paths), `commitsInRange(from, to)`, and the existing `isAncestor`.

`committableTree(cwd)` is the tree `git add -A && git commit` would record,
built in a private index with the repository's own line-ending and filter
settings. Test runs store it as `tree_id`; `workingTreeTree` (byte-exact,
`core.autocrlf=false`) stays for checkpoints. With `core.autocrlf=true` the two
differ for a CRLF file — only `committableTree` equals the commit's tree.

## Checkpoints

`createCheckpoint` builds a commit of the whole working tree (tracked and
untracked, `.gitignore` respected) in a **private index** (a copy of the real
one, `GIT_INDEX_FILE`) with `core.autocrlf=false`, and keeps it alive under
`refs/acc/checkpoints/<task>/<n>` — HEAD, branches, the user's index and files
are untouched. `restoreCheckpoint` diffs that tree against the current one and
rewrites only paths the caller allows (the Chairman excludes every file dirty
at the baseline); files added since are deleted. `deleteRefs` only accepts
`refs/acc/`. The Chairman refuses a rollback when HEAD moved since the
checkpoint. Used by [chairman.md](chairman.md#checkpoints).

## Diff packing ([diff-pack.ts](../../packages/git/src/diff-pack.ts))

`packDiff(raw, changedFiles, budget)` splits a unified diff per file (the new
path from `+++`, else `---`, `rename to` or the header), orders files source →
tests → config → docs → generated/lockfiles/binaries (`classifyDiffPath`) and
packs whole files up to the budget; the first file alone over budget is cut at
a hunk boundary and marked `partial`. `omitted` names every changed file not
shown in full, including ones that never reached the collected diff
(`withoutPartialTail` drops a chunk cut short when the raw diff hit its bound).
`diffSince` now bounds git's output while it is read (`maxOutputBytes`).

## Worktrees

[worktrees.ts](../../packages/git/src/worktrees.ts): `addWorktree`,
`addDetachedWorktree` (no branch: a bisect step, a baseline check),
`removeWorktree` (prunes; clears a locked folder on force), `changesInRange` /
`diffInRange` (task changes after its worktree is gone) and
`checkpointMetadata`. How tasks use them: [checkpoints.md](checkpoints.md#worktrees).

## Limitations

- Tasks in the same repository run one at a time; a finished task leaves its
  branch checked out, so the next task's baseline records those files as
  pre-existing (reported as such), and a committed task's branch becomes the
  next task's starting point. When the baseline branch is another task's
  (`taskIdFromBranch`), a `GIT_BRANCH` event and the report's Git section say
  so and ask for that task to be merged first. Repositories in Git mode *Isolated worktree* avoid this: each task has its own checkout ([checkpoints.md](checkpoints.md#worktrees)).
- `deleteBranchIfAt(repo, branch, commit)` deletes a branch only while it still
  points at `commit` (`update-ref -d`, compare-and-delete); `diffSince` takes a
  `prefix` so one patch can cover several repositories
  ([multi-repository-tasks.md](multi-repository-tasks.md)).

## Repository Source Control

Repository-level primitives (porcelain v2 status, per-side diffs, literal
pathspec staging, commit, history, fetch, fast-forward-only, push without
force) live in [source-control.ts](../../packages/git/src/source-control.ts)
and are documented in [source-control.md](source-control.md). `git()` takes
`maxOutputBytes` (stops Git at the bound, sets `truncated`) and keeps at most
64 KB of stderr. `fetchRemote(…, { unattended: true })` adds
`UNATTENDED_REMOTE_ENV` (`GCM_INTERACTIVE=never`, `SSH_ASKPASS_REQUIRE=never`)
so background fetches fail instead of opening a credential window.

Last verified: 2026-09-25
