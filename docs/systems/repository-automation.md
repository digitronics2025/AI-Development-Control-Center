---
system: repository-automation
sources:
  - apps/orchestrator/src/services/repository-automation.ts
  - apps/orchestrator/src/services/repositories.ts
  - apps/orchestrator/src/source-control/service.ts
  - packages/git/src/source-control.ts
  - packages/shared/src/schemas.ts
  - apps/dashboard/src/pages/RepositoriesPage.tsx
  - apps/dashboard/src/pages/SettingsPage.tsx
verified_at: dd8704f
---

# Repository automation

Keeps the repository list complete and up to date without manual steps:
**discovery** registers new Git repositories found on disk, and **background
sync** downloads new commits into every registered repository. Code:
[repository-automation.ts](../../apps/orchestrator/src/services/repository-automation.ts),
`backgroundSync` in [service.ts](../../apps/orchestrator/src/source-control/service.ts).

## Settings (`settings.repositoryAutomation`)

| Field | Default | Meaning |
|---|---|---|
| `discover` | `true` | Register new repositories found under `roots` |
| `roots` | `[]` | Absolute folders to search; empty = the user's home folder |
| `maxDepth` | `2` | Folder levels searched below each root (1–4) |
| `ignoredPaths` | `[]` | Never registered automatically (≤ 1000) |
| `sync` | `true` | Background sync; downloads only |
| `intervalMinutes` | `15` | Time between runs, measured from the end of the last (5–1440) |

## Schedule

`RepositoryAutomation.start()` runs from `main.ts` once restart recovery has
settled the Source Control journal: one run at startup, then one
`intervalMinutes` after each run finishes. A run does discovery first (so a
new repository is synced in the same run), then sync. Runs never overlap: a
second `run()` joins the one in progress. A `settings` change reschedules;
both switches off clears the timer. `ACC_REPOSITORY_AUTOMATION=0` keeps it
from starting at all; the demo (and so the e2e suite) sets it, and unit tests
never call `start()`.

## Discovery

Breadth-first walk of each root up to `maxDepth`, at most 20,000 folders.
A folder containing a `.git` **directory** is a repository. A `.git` **file**
(linked worktree, submodule) is skipped: it shares another repository's
history, and registering it twice would let two entries write the same Git
directory. Never entered: names starting with `.`, `node_modules`, `AppData`,
`Library`, `venv`, `__pycache__`, recycle-bin/system folders, symlinks and
junctions (so the walk cannot loop), and the orchestrator's data folder.
Registration goes through `RepositoryService.add` (same tool detection as a
manual add). Name = folder name, or `parent/name` if another repository
already has that name.

Paths compare through `pathKey` (resolved, trailing separator removed,
lowercased on Windows); `add` uses the same check, so a case variant is a
`DUPLICATE`.

**Ignore list.** Removing a repository appends its path to `ignoredPaths`;
adding it again by hand removes it. Settings → Repositories shows the list
with **Allow again**.

## Background sync

Per repository, four at a time:

1. Skip: folder missing, not Git, detached HEAD, no commits, no upstream.
2. `git fetch --no-write-fetch-head <upstream remote>` inside the
   coordinator's exclusive section (safe while a task writes). **Not
   journalled**: it moves only remote-tracking refs, and journalling every
   fetch every 15 minutes would bury the real entries.
3. Compare `HEAD...@{upstream}`:

| State | Result |
|---|---|
| equal | `up-to-date` |
| ahead and behind | `diverged`, nothing moves |
| ahead only | `ahead`, **nothing is pushed** |
| behind, tracked changes or conflicts | `behind-dirty`, nothing moves |
| behind, an unfinished task's branch | `skipped` |
| behind, clean | fast-forward → `fast-forwarded` |

"Unfinished task" = any task in the repository with status QUEUED, RUNNING,
PAUSED, WAITING_*, INTERRUPTED or FAILED whose `taskBranch ?? baselineBranch`
is the current branch. Its diff is measured against that branch, so moving
it would put upstream commits into the task's changes.

The fast-forward is a normal journalled Source Control mutation (kind
`fast_forward`, metadata `automatic: true`, `fastForwardTo` written before
moving). It re-checks everything under the repository lock and is refused
while a task stage writes. Restart recovery settles it from HEAD:
`HEAD == fastForwardTo` → succeeded, `HEAD == preHead` → failed, else
uncertain.

Uploads stay manual (Source Control → Sync). Background sync never pushes,
merges, rebases, stashes or touches uncommitted work.

## State and API

In memory only (rebuilt by the startup run): `lastRun` (trigger, times,
discovery report, per-outcome counts) and the latest result per repository.

| Method | Path | |
|---|---|---|
| GET | `/api/repository-automation` | `RepositoryAutomationStatus` |
| POST | `/api/repository-automation/run` | Starts a run as settings allow; answers 202 at once |

WebSocket: `repositoryAutomation` (full status) at run start and end and on
reschedule; each synced repository is re-read and pushed as `repository`.

`RepositoryStatus` gains `upstream`, `ahead`, `behind` from the same single
`git status --porcelain=v2 --branch` call that gives branch and changes
(counts are as of the last fetch).

## Dashboard

Repositories page: a **Remote** column (Up to date / N to download / N to
upload / Diverged / No upstream), a summary line with the last run, and
**Check now** (disabled when both switches are off). Settings →
Repositories edits every field above.

## Gotchas

- A repository whose remote needs interactive sign-in reports `failed`; no
  window ever opens. Background fetches (and restart recovery's) run with
  `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` (Git Credential Manager)
  and `SSH_ASKPASS_REQUIRE=never` (`UNATTENDED_REMOTE_ENV` in
  [source-control.ts](../../packages/git/src/source-control.ts)). Fetches the
  user starts from Source Control may still prompt.
- Fetch time is bounded per call (120 s), so one slow remote delays a run but
  cannot stall it.
- Results live in memory: after a restart the page shows nothing until the
  startup run finishes.

Last verified: 2026-09-23
