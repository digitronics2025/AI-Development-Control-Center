---
system: release
sources:
  - apps/orchestrator/src/release/**
  - packages/tools/src/packs/cloudflare-api.ts
  - apps/dashboard/src/pages/ReleasePanel.tsx
  - apps/dashboard/src/pages/task/ReleaseCard.tsx
verified_at: 2eaba2f
---

# Releases

Sends a task's tested commit live after **one typed Level 5 approval**, and
says **Live** only when the hosting provider (or a version URL) shows that exact
commit. Plan: [RELEASE_STAGE_PLAN.md](../plans/RELEASE_STAGE_PLAN.md).
Code: [release/service.ts](../../apps/orchestrator/src/release/service.ts),
the stage runner `runRelease` in
[runners.ts](../../apps/orchestrator/src/engine/runners.ts).

## Setting (per repository)

`repositories.release` (migration 17, JSON, default `{"method":"none"}`),
validated by `releaseConfigSchema` in
[schemas.ts](../../packages/shared/src/schemas.ts). A stored value that no
longer validates reads as `none`.

| Field | Meaning |
|---|---|
| `method` | `none` (never releases) or `push` |
| `remote`, `branch` | plain Git names, default `origin` / `main`; no leading `-`, no `..` |
| `liveUrl` | `https://` only; must answer (status < 500) before anything is sent |
| `proof.cloudflarePages.project` | Live when the project's canonical (production) deployment is the pushed commit with `latest_stage` `deploy` / `success` |
| `proof.versionUrl` | `https://`; Live when the body names the commit (full id or a 7+ character prefix) |
| `manualPaths` | globs (Chairman `matchesAny` semantics); a release changing one is refused |
| `timeoutSec` | 60–3600, default 900: how long the proof is polled (every 15 s) |

At least one proof is required. Repository detection never turns release on.

## Flow

1. **Resolve** — the commit is the last of `task.git.commits` (primary
   repository). A task that is not yet COMPLETED is refused when its folder
   holds uncommitted changes beyond the operator's pre-existing ones.
2. **Tested** — `git rev-parse <sha>^{tree}` must be one of `testedTrees()`:
   for each SUCCESS `tests` stage, the `tree_id` of its last-finished check,
   when every check passed, failed only as on the baseline, or was flaky
   (its failing files passed when run again on the same files); repair,
   re-run and superseded rows excluded (a run of affected tests replaced by the
   whole suite, [workflow-engine.md](workflow-engine.md#affected-tests-only)).
   No tree recorded → "No record of which version passed the checks". When the
   last passing Test stage ran only the unit tests affected by the change
   (`affectedOnly()`), the approval's reason ends "Unit tests on this commit
   covered only the tests affected by the change."
3. **Safe to publish** (under the repository writer lock) — the remote exists;
   `fetchBranch` updates only `refs/remotes/<remote>/<branch>`; that ref must be
   an ancestor of the commit ("`<branch>` has moved…"); every outgoing commit
   must be one of the task's (never the operator's unpushed commits); no path
   matches `manualPaths`; `scanOutgoing` (Source Control's push preflight) finds
   no secret material; the live URL answers; the Pages "before" deployment is
   recorded.
4. **Publish** — `pushRef(repo.path, { sha, remoteRef: refs/heads/<branch> })`:
   no force option exists; a non-fast-forward is rejected by the remote. Runs
   from the repository folder (worktrees share its object store), so it works
   after the worktree is gone and never switches a branch or touches files. The
   writer lock is released after the push; Source Control's background sync
   later fast-forwards the operator's local branch.
5. **Prove** — polls every configured proof plus the up check. A Pages build of
   the commit that reports `failure`/`canceled` ends `failed`; a provider that
   cannot be read at all (no key, several accounts) ends `published_unconfirmed`
   at once when it is the only proof; otherwise polling runs to `timeoutSec`.
6. **Outcome** — saved in `tasks.git.release` (`TaskRelease`, no new column),
   written to the `release.md` artifact and to one event.

| State | Meaning | Event |
|---|---|---|
| `publishing` / `proving` | in progress | `RELEASE_APPROVED`, `RELEASE_PUBLISHED` |
| `live` | every proof passed; `liveConfirmedAt` set | `RELEASE_LIVE` |
| `published_unconfirmed` | sent, not proved in time or provider unreadable | `RELEASE_UNCONFIRMED` |
| `failed` | push rejected, or the provider reported a failed build | `RELEASE_FAILED` |
| `refused` | a check in 1–3 stopped it; nothing sent | `RELEASE_REFUSED` |

`RELEASE_REQUESTED` marks the approval request, `RELEASE_DECLINED` a denial.

## Two entry points

- **Release stage** (`kind: release`, Full Autopilot after Smoke). Skipped
  before any approval when `skipReason()` says so: no release set up, a task
  across repositories, nothing committed. Otherwise the stage gate asks a
  `stage_permission` approval, Level 5, typed task id, one attempt; its card is
  `describe()` ("Push `abc1234` to origin/main …"). Declining → stage SKIPPED
  "Release declined", the task completes. Live → SUCCESS; anything else → stage
  FAILED and `optional_failed` with the summary as the report limitation
  (NEEDS_USER_ACTION) — never a fix cycle, retry or Chairman recovery. The loop
  takes no writer lock for this stage; the service takes it for steps 1–4 only.
  A stop before the push re-runs the stage (and asks again) on resume; after the
  push it ends `published_unconfirmed`.
- **Release button** on a COMPLETED task: `POST /api/tasks/:id/release` runs
  the read-only pre-checks (tested tree, remote, branch moved) and either
  answers `409 RELEASE_REFUSED` with the reason (saved as `refused`) or creates
  an approval of kind `release` with `requestDetached` (the task keeps its
  status). Approving it runs the same service in the background against a
  synthetic `release` stage record.

**Update from the target branch** (plan §9). When the stage's release is
refused only because the target branch moved (`refusal: 'moved'`), and the
task still has its isolated worktree, `updateFromTarget` merges
`<remote>/<branch>` into the task branch there (`--no-ff`, under the writer
lock, never in the operator's folder), appends the merge commit to
`task.git.commits`, moves the task's baseline (commit and snapshot) to the
target so reviews and baseline checks see only the task's own changes, and
the stage returns `goto` to the workflow's tests stage: the checks, reviews
and verification run again, and the Release stage asks again. A conflict
aborts the merge and fails the stage naming the files; more than
`MAX_UPDATES_FROM_TARGET` (3) updates, uncommitted changes or no worktree
leave it refused. The Release button (a completed task, worktree gone) still
refuses a moved branch.

`POST /api/tasks/:id/release/check` (**Check again**) re-runs step 5 only, in
the background, for a release whose commit was sent. `POST
/api/repositories/:id/release/check` (**Check setup**) checks the saved setting
or a `release` in the body: remote, `ls-remote` of the branch, the live URL, the
Pages project, the version URL. None of these send anything.

## Authority

Only the local API token reaches these routes. There is no Chairman action,
chat intent, agent tool or cloud operation for a release: the gateway rejects
`RETURN_TO_STAGE`/`RETRY_STAGE` to a `release` stage, recovery never offers
`retry_stage` for one, and `policyCeiling` caps automatic approval at Level 4.
The push uses the operator's own Git credential helper, as Source Control's
pushes do; no token is injected. Live checks are GETs without cookies or
tokens, redirects not followed. Pages reads go through `ToolService.invoke`
(`cloudflare.pages_status`, Level 1, read-only, the repository's `cloudflare`
key; see [tool-system.md](tool-system.md)).

## Restart

`recover()` (startup, in the background) resolves a release left `publishing`
or `proving` from the remote with `ls-remote`: contains the commit →
`published_unconfirmed`; does not → `failed` ("nothing was sent"); cannot tell
→ `published_unconfirmed`. It never pushes. Shutdown stops background proofs
and waits for them to save (`close()`).

## Gotchas

- Test runs record `committableTree` — the tree a commit of those files would
  have, with the repository's line-ending settings — not the byte-exact
  checkpoint tree. With `core.autocrlf=true` the two differ, and only the first
  equals the commit's tree ([git.md](git.md)).
- A check that changes tracked files (a build writing a committed `dist/`)
  records no tree; a Test stage ending on such a check proves nothing, and the
  release is refused until the checks run again.
- A second task started from a stale local branch meets a moved target once
  the first was released; the stage updates itself, the button refuses —
  background sync (or a pull) before starting avoids both.

Last verified: 2026-09-26
