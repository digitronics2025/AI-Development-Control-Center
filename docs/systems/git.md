---
system: git
sources:
  - packages/git/**
verified_at: 8b64752
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
left uncommitted. Nothing is ever pushed automatically.

## Limitations

- Tasks in the same repository run one at a time; a finished task leaves its
  branch checked out, so the next task's baseline records those files as
  pre-existing (reported as such), and a committed task's branch becomes the
  next task's starting point. When the baseline branch is another task's
  (`taskIdFromBranch`), a `GIT_BRANCH` event and the report's Git section say
  so and ask for that task to be merged first. Worktrees are Found-for-Later.

Last verified: 2026-09-23
