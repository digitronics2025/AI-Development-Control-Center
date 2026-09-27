---
system: git
sources:
  - packages/git/**
verified_at: 57af61a
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
one, `GIT_INDEX_FILE`, so only changed files are re-hashed) with
`core.autocrlf=false`, and keeps it alive under
`refs/acc/checkpoints/<task>/<n>` — HEAD, branches, the user's index and files
are untouched. `restoreCheckpoint` diffs that tree against the current one and
rewrites only paths the caller allows (the Chairman excludes every file dirty
at the baseline); files added since are deleted. `deleteRefs` only accepts
`refs/acc/`. The Chairman refuses a rollback when HEAD moved since the
checkpoint. Used by [chairman.md](chairman.md#checkpoints).

The copy's modification time is set to the whole second before the real
index's (`withPrivateIndex`). Git trusts a cached stat unless the file is as
new as the index file (racy git), and with `core.checkstat=minimal` it
compares only whole seconds and the size; a copy dated when it is made would
look newer, so a same-size change written in the index's own second would be
missed a second later and the checkpoint, the Stage Team wave base and
`committableTree` would record the old blob. Dating it earlier only re-hashes
more files.

## Diff packing ([diff-pack.ts](../../packages/git/src/diff-pack.ts))

`packDiff(raw, changedFiles, budget)` splits a unified diff per file (the new
path from `+++`, else `---`, `rename to` or the header), orders files source →
tests → config → docs → generated/lockfiles/binaries (`classifyDiffPath`) and
packs whole files up to the budget; the first file alone over budget is cut at
a hunk boundary and marked `partial`. `omitted` names every changed file not
shown in full, including ones that never reached the collected diff
(`withoutPartialTail` drops a chunk cut short when the raw diff hit its bound).
`diffSince` now bounds git's output while it is read (`maxOutputBytes`).

## Applicable patches

`diffSince` is text for prompts and the dashboard: `git()` reads output line
by line, which drops each `\r` before `\n`. [patch.ts](../../packages/git/src/patch.ts)
builds the task's `git-diff.patch` ([workflow-engine.md](workflow-engine.md)),
a patch `git apply` takes back, with nothing unredacted written to disk:

- `patchSince(cwd, baseline, { prefix?, maxBytes, redactText? })` diffs a
  working tree against the baseline: tracked changes, then each untracked file
  (`--no-index` against `NUL`/`/dev/null`; exit 1 means "differs"; a path Git
  cannot diff, such as a nested repository, is named in `dropped`).
  `patchBetween(cwd, from, to, …)` diffs two commit ids (an isolated task's
  baseline and its branch tip) and refuses anything else.
- Git's stdout is read as bytes by a spawned `git`, never through the line
  reader, so a change to a CRLF-committed file keeps its `\r`. The read is
  bounded at 4 × `maxBytes`; stopping it (the bound or a timeout) kills the
  whole process tree, since on Windows the `git` on PATH is a launcher.
- The user's diff settings are pinned: `--no-color --no-ext-diff
  --no-textconv --full-index -U3 --submodule=short --ignore-submodules=dirty`,
  explicit `a/`/`b/` prefixes (or `a/<folder>/` with `--no-renames`, since Git
  writes rename lines without the folder), `GIT_DIFF_OPTS` and
  `GIT_EXTERNAL_DIFF` emptied.
- A section that is not plain UTF-8 text (a NUL, or invalid UTF-8) — a binary
  file, one a repository's `diff` attribute prints as text, a non-UTF-8 text
  file — keeps its header and full `index` ids and says only "Binary files …
  differ", like Git's own binary sections. No binary byte is carried; `git
  apply` takes the content from the repository. `patchSince` stores exactly
  those files (regular files only — never a link's target — up to 100 MB) with
  `git hash-object -w` (no ref, index or file change), then checks every id
  resolves (`cat-file --batch-check`); a file whose content the repository
  still cannot supply is moved to `dropped`, so it cannot break the rest.
- With `redactText` (the artifact mode) a section is withheld — replaced by one
  `[withheld from git-diff.patch: <path> held secret-shaped content]` line —
  when its text would be redacted, when it shows a `PRIVATE KEY-----` marker
  (context lines of a key too), when `sensitiveFileReason` marks its path
  (`.env`, `*.pem`, `id_rsa`, …), or when a binary/stubbed file's content, read
  as UTF-8, Latin-1, UTF-16 LE/BE and with NULs removed, holds something the
  redactor would change. The rest still applies, and no object id of a
  withheld file remains (so a guessed secret cannot be confirmed against it).
  Every name in a note or in `dropped` is redacted too.
- Bounded by `maxBytes`, whole sections only (notes always kept): later files
  are named in `dropped`, never cut; after an overflow every changed path the
  read never reached is named as well.

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

## Stage Team helpers

[team.ts](../../packages/git/src/team.ts): `createWaveBase` (a normalised commit of the task's files — what `git add -A` would record, parent = task HEAD — plus the byte-exact tree, under `refs/acc/team/`), `addChildWorktree` (detached, the repository's own line-ending settings, so a child's `git status` starts clean), `captureResult` (the worker's result, normalised the same way), `changedPathsBetween` (renames as D+A), `combineResults` (private index, refuses two units on one path, refs only under `refs/acc/team/`), `applyIfUnchanged` (compares byte-exact with byte-exact, then writes only the changed paths with line-ending conversion on; deletions delete, binary files byte-exact), `treeOf`. Used by [stage-teams.md](stage-teams.md).

Last verified: 2026-09-27
