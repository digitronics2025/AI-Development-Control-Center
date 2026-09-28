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
verified_at: 57af61a
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
| `githubAccounts` | `[]` | GitHub users/organisations whose missing repositories are downloaded (needs `discover`; empty = off) |
| `githubMaxSizeMb` | `500` | Larger GitHub repositories are skipped, not downloaded |
| `ignoredRemotes` | `[]` | `host/owner/name` never downloaded (≤ 1000) |

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
junctions (so the walk cannot loop), and the orchestrator's data folder and
work root (its task worktrees).
Registration goes through `RepositoryService.add` (same tool detection as a
manual add). Detection also runs per task: checks a task adds in its worktree
are merged in memory (`taskRepositoryView`, [workflow-engine.md](workflow-engine.md)),
so an empty repository needs no Re-detect once a task adds its checks. Name = folder name, or `parent/name` if another repository
already has that name.

Paths compare through `pathKey` (resolved, trailing separator removed,
lowercased on Windows); `add` uses the same check, so a case variant is a
`DUPLICATE`.

The disk walk only sees disk; repositories that exist only on GitHub come
from *GitHub downloads* below (or by hand: *Download from GitHub*).

## GitHub downloads

`RepositoryAutomation.downloadFromGitHub`, in the same run right after the
disk walk (so a copy already on disk is registered, not downloaded again),
when `discover` is on and `githubAccounts` is not empty:

1. Each account is listed through `github.repo_list` (`ToolService.invoke`,
   origin `engine`, Level 1): `gh repo list <owner> --json …`, under the
   account `gh` is signed in to. An account that fails is reported in
   `errors`; the others still run.
2. "Already here" = some registered repository has a remote whose
   `host/owner/name` (`normalizeRemote`) equals `github.com/<nameWithOwner>`,
   so a renamed folder still counts. Remote URLs are read as configured
   (`git config --get-regexp`), not after `insteadOf` rewriting.
3. Skipped with a `kind` and a full `reason`: `archived`, `fork`,
   `too-large` (over `githubMaxSizeMb`, from `diskUsage`), or
   `folder-taken` — the destination folder exists; the reason names the
   remote it holds. Seen live 2026-09-27: a repository moved from the
   personal account to an organisation (local copy still on the old,
   redirecting address), and two same-named repositories on two accounts.
   Nothing is overwritten in either case.
   Silently skipped: `ignoredRemotes`, and a destination in `ignoredPaths`.
4. The rest are cloned with `RepositoryService.clone(…, { unattended: true })`
   into `defaultCloneParent()` (first discovery root, else home) —
   `UNATTENDED_REMOTE_ENV`, so a private repository without a saved sign-in
   fails instead of opening a window — and registered.

**Removed stays removed:** `RepositoryService.remove` records the removed
repository's remote identities in `ignoredRemotes` (and its path in
`ignoredPaths`); adding it again by hand clears both. Settings →
Repositories lists them with **Allow again**.

The run's `downloads` report (`RepositoryDownloadReport`: accounts,
downloaded, skipped, errors) feeds the Repositories summary line, which
names what was downloaded and what was not, with the reason.

**Ignore list.** Removing a repository appends its path to `ignoredPaths`;
adding it again by hand removes it. Settings → Repositories shows the list
with **Allow again**.

## Download from GitHub (clone)

`RepositoryService.clone` in
[repositories.ts](../../apps/orchestrator/src/services/repositories.ts)
clones into a **new** folder and then registers it through `add`. The
Add repository dialog's **Download from GitHub** option calls it.

- Address: `parseCloneUrl` ([schemas.ts](../../packages/shared/src/schemas.ts))
  accepts `owner/name` (becomes `https://github.com/owner/name.git`),
  `https://`, `ssh://`, `git@host:path` and `file://`. It refuses any other
  transport (`ext::` runs commands, `http://`/`git://` are unencrypted) and a
  username or password in an `https` address, which Git would keep in plain
  text in the clone's config. `cloneRepository`
  ([source-control.ts](../../packages/git/src/source-control.ts)) also sets
  `protocol.allow=never` with only those transports allowed, and passes `--`.
- Folder: `parentFolder`, else the first discovery root, else the home folder
  (`GET /api/repositories/clone-defaults`); name = `folderName` or the
  repository name, a single plain segment. An existing destination is
  `DUPLICATE` (409) — nothing is ever cloned into an existing folder.
- Failure: `CLONE_FAILED` (502) with Git's last lines; the destination is
  removed (it did not exist before). 10-minute limit.
- Sign-in: started by the operator, so like a Source Control fetch it may
  use Git Credential Manager's cached sign-in; it is not run unattended.
- An empty repository clones fine and shows **No upstream** until its first
  push.

| Method | Path | |
|---|---|---|
| POST | `/api/repositories/clone` | `{ url, parentFolder?, folderName?, name? }` → 201 `Repository` |
| GET | `/api/repositories/clone-defaults` | `{ parentFolder }` |

Not a remote operation (like adding a folder, it names paths on this PC).

## Create new

`POST /api/repositories/new` `{ name, parentFolder?, github?, visibility?, description? }`
→ 201 `NewRepositoryResult { repository, github }`. The dialog's **Create new**
option calls it.

1. **Always local** (`RepositoryService.createNew`): a new folder `name` in
   `parentFolder` (default as for a clone), `git init -b main`, a README
   (`# name` + description) and a commit "Initial commit" using the
   operator's Git identity, then `add`. An existing folder is `DUPLICATE`;
   any failure removes the folder (`CREATE_FAILED`, 500 — a missing Git
   name/email says how to set it).
2. **GitHub, if asked**: the route calls `github.repo_create` through
   `ToolService.invoke` (origin `operator`, `preApproved` — the click is the
   decision; recorded like any tool call). Private is Level 3; **public is
   Level 5**, so an agent can never publish a repository without typed
   approval. It runs
   `gh repo create <name> --private|--public --source . --remote origin --push`
   in the new folder, under the account `gh` is signed in to.
3. A GitHub failure never undoes step 1: the answer has
   `github: { ok: false, message }`, the repository shows **No upstream**, and
   the dialog says it was created on this computer only. `github: null` when
   not asked.

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
| fetch fails | `failed` |
| fetch says "repository not found" **and** another repository with the same `host/owner` fetched in this run | `remote-gone` |

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

**Deleted remotes.** Hosts answer "repository not found" both for a deleted
repository and for a private one the caller cannot see, so an expired sign-in
would look like every repository being deleted. `confirmGoneRemotes` (in
[repository-automation.ts](../../apps/orchestrator/src/services/repository-automation.ts))
therefore upgrades `failed` to `remote-gone` only when a repository of the
same account (`remoteOwnerKey`: `host/owner`, never the URL or credentials)
fetched in the same run. Nothing is removed automatically: the repository
stays listed as **Remote deleted**, and its local copy is never touched.

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
upload / Diverged / No upstream, or from the last run Unreachable / Remote
deleted with the reason on hover), a summary line with the last run, and
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

Last verified: 2026-09-26
