---
system: source-control
sources:
  - packages/git/src/source-control.ts
  - apps/orchestrator/src/source-control/**
  - apps/orchestrator/src/services/repository-coordinator.ts
  - apps/orchestrator/src/store/git-operations.ts
  - apps/orchestrator/src/http/source-control-routes.ts
  - apps/dashboard/src/pages/source-control/**
  - apps/dashboard/src/api/source-control.ts
  - workflows/staged-review.yaml
verified_at: 2d516aa
---

# Source Control

Repository-level Git for one registered repository: what is staged, unstaged,
untracked or conflicted, the history, and whether the branch is in sync.
Native Git is authoritative; the database keeps only an operation journal.
Plan: [docs/plans/source-control-center/PLAN.md](../plans/source-control-center/PLAN.md).
UI standard: [design.md §7.9](../../design.md).

## Two models, kept apart

| Model | Answers | Source |
|---|---|---|
| Git state | staged / unstaged / untracked / conflicted, ahead / behind | `git status --porcelain=v2 -z --branch` |
| Task attribution | `task` / `preexisting` / `both` | the task baseline ([git.md](git.md)) |

A path shows attribution only when a baseline proves it: the unfinished task
holding the repository, else the latest finished task whose branch is checked
out. Read-only workflows never supply attribution.

## Layers

| Layer | Code |
|---|---|
| Git primitives (argv only, literal NUL pathspecs on stdin, no ext-diff/textconv) | [source-control.ts](../../packages/git/src/source-control.ts) |
| State, version, scopes | [state.ts](../../apps/orchestrator/src/source-control/state.ts) |
| Reads, mutations, journal | [service.ts](../../apps/orchestrator/src/source-control/service.ts) |
| Secret preflight | [preflight.ts](../../apps/orchestrator/src/source-control/preflight.ts) |
| Restart recovery | [reconcile.ts](../../apps/orchestrator/src/source-control/reconcile.ts) |
| Commit message + staged review | [assist.ts](../../apps/orchestrator/src/source-control/assist.ts) |
| Coordination with tasks | [repository-coordinator.ts](../../apps/orchestrator/src/services/repository-coordinator.ts) |
| Routes | [source-control-routes.ts](../../apps/orchestrator/src/http/source-control-routes.ts) |
| Page | [pages/source-control](../../apps/dashboard/src/pages/source-control) |

## API (`/api/repositories/:id/source-control`, bearer token)

| Method | Path | Notes |
|---|---|---|
| GET | `` | Snapshot (cached 1.5 s). Errors (not a repo, Git missing, folder gone) are a 200 snapshot with `error` set |
| POST | `refresh` | Fresh snapshot |
| GET | `diff?path&mode=staged\|unstaged` | Only paths Git reports as changed; 1 MB bound; redacted; `binary` flag |
| GET | `history?cursor&limit` | Topological order; cursor pins the tip SHAs so pages stay consistent |
| GET | `commits/:sha`, `commits/:sha/diff?path` | Files vs first parent; diff only for files in that commit |
| GET | `operations` | Last 30 journal entries |
| GET | `review` | Latest Staged Review task and its `review.md` |
| POST | `stage`, `unstage` | `{paths}` or `{all:true}`; stage-all takes `confirmMixed` |
| POST | `commit` | `{message}` — commits the index only; hooks run |
| POST | `fetch` | Upstream's remote, else `origin`, else the only remote |
| POST | `sync` | See below |
| POST | `publish` | `{remote}` — `push --set-upstream` of the current branch |
| POST | `suggest-message` | One read-only agent run, in memory, no task |
| POST | `review-staged` | 202 `{taskId}` |

Every mutation body carries `idempotencyKey` and (except fetch) the
`expectedVersion` the user acted on. Bodies are limited to 1 MB. There is no
endpoint that takes Git arguments.

Error codes and HTTP statuses: [errors.ts](../../apps/orchestrator/src/source-control/errors.ts).
Remote failures are 502/409, never 401 (the dashboard reserves 401 for its own token).

## Mutation protocol

1. Replay: a known `idempotencyKey` returns the stored outcome (or the stored
   error); one still `started` is `DUPLICATE_IN_FLIGHT`.
2. `coordinator.runMutation` — one mutation per repository at a time.
3. Refuse with `BLOCKED_BY_TASK` (423) while a task stage with permission level
   ≥ 2 runs there (fetch excepted). Writable stages in turn wait for a
   mutation in flight before they start.
4. Re-read Git; check `expectedVersion` **by scope**: when the version differs,
   the request still proceeds if the state it depends on is unchanged in a
   recent snapshot (24 kept per repository) — staging `a.ts` is not rejected
   because `b.ts` was saved. Unknown version → `GIT_STATE_CHANGED`.
5. A held `index.lock` is waited on for 2 s, never deleted.
6. Journal `started` (a DB failure here aborts before Git is touched), act,
   re-read, journal the outcome. A journal failure after Git acted leaves the
   entry `started`; startup reconciliation settles it.

The version is a sha256 of the porcelain v2 output (branch headers, entries
with index object ids) plus size and mtime of worktree-changed files.

## Safe Sync

Fetch the upstream remote, recompute ahead/behind against `@{upstream}`, then:

| State | Action |
|---|---|
| up to date | nothing |
| ahead only | secret preflight on outgoing commits, then `push --porcelain <remote> refs/heads/<b>:<merge ref>` (never forced) |
| behind only, tracked files clean | `merge --ff-only <upstream sha>` (untracked files allowed; Git refuses to overwrite them) |
| behind only, tracked changes | stop after fetch (`behind-dirty`) |
| diverged | stop (`diverged`) — never merge or rebase |
| no upstream / gone | `NO_UPSTREAM` / `UPSTREAM_GONE`; Publish is separate |

Background sync ([repository-automation.md](repository-automation.md)) is
the download half only: fetch, then fast-forward a clean, behind-only branch
as a journalled `fast_forward` (metadata `automatic: true`). It never pushes.

Detached HEAD blocks commit, sync and publish. A merge, rebase, cherry-pick,
revert or bisect in progress blocks every mutation; conflicts block staging
of the conflicted path, commit and sync.

## Secret preflight

Before a commit (staged diff, `-U0`, 20 MB bound) and before a push or publish
(`git log -p` of outgoing commits): files matching
[sensitive-files.ts](../../packages/security/src/sensitive-files.ts) and added
lines matching the high-confidence `blocking` rules of
[redact.ts](../../packages/security/src/redact.ts) block the action with
`SENSITIVE_CONTENT` (file + kind, never the value). Over the bound →
`PREFLIGHT_INCOMPLETE` (fails closed). Stage All skips sensitive files and
reports them; staging one explicitly is allowed but its commit is blocked.
AI context omits sensitive files entirely and redacts the rest.

## Journal (`git_operations`, migration 3)

Kinds `stage unstage commit fetch fast_forward push publish sync`; statuses
`started succeeded failed uncertain`. Holds SHAs, remote/ref names, error
code and a redacted summary (≤ 2 KB), and bounded metadata (message hash,
counts, sync outcome, `pushedSha`/`fastForwardTo` written *before* the risky
step). Never diffs, file contents, command lines or credentials. Commit
attribution in History reads it (`source-control`) and `tasks.git.commits`
(`task`).

## Restart recovery

After listen, in the background (60 s budget): `started` entries — and
`uncertain` ones with a `pushedSha` — are settled from reality. Commit: HEAD
moved to a child of `preHead` whose message hash matches → succeeded; HEAD
unmoved → failed; otherwise uncertain. Push/publish/sync: fetch, then the
remote ref contains `pushedSha` → succeeded, else failed; unreachable →
uncertain. Fast-forward: HEAD at `fastForwardTo` → succeeded, at `preHead` →
failed, else uncertain. Stage/unstage → uncertain ("current status shows the result").
Nothing is ever re-run.

## Refresh

No recursive watcher. The page polls the snapshot every 3 s while visible
(TanStack `refetchIntervalInBackground: false`); `RepositoryService.invalidate`
(after every stage) and every mutation publish `{type:'sourceControl'}` over
the WebSocket, which the client coalesces (300 ms). Diffs and history load
lazily and never ride on the status poll. Line counts and attribution are
recomputed only when the version changes.

Measured 2026-09-23 on Windows 11 (Git 2.52) with a generated fixture of 5,000
commits, 300 modified and 2,000 untracked files: fresh snapshot ≈ 100 ms,
cached read 6 ms, each 60-commit history page ≈ 45 ms, one file diff ≈ 50 ms.
Above 2,000 paths the list is capped (`changesTruncated`) and line counts and
attribution are skipped. No universal timing target is enforced.

## AI assistance

- **Suggest message**: the reviewer role's resolved agent gets the redacted,
  bounded (60 KB) staged diff at permission level 1, 180 s timeout; one run
  per repository at a time; output parsed to a subject (≤ 100) and body. The
  run's usage is recorded against the repository with step `commit-message`
  and no task ([usage.md](usage.md)).
- **Review staged**: creates a task on the built-in `staged-review` workflow
  (one Level 1 reviewer stage) with the diff saved as its `staged-diff`
  artifact; the context builder feeds that artifact to `{{diff}}` when a task
  has no baseline. Its verdict is advisory, so FAIL completes the task as
  *needs user action* instead of looping.

## Gotchas

- Read-only workflows (every stage Level 1 and `agent`) neither wait for nor
  hold a repository, so a review runs beside a paused writer.
- `git()` bounds stdout by characters and stops Git at the bound; `-z`
  outputs stay unsplit unless bounded.
- Git runs with `LC_ALL=C`; failure classification
  (`classifyGitOutput`) depends on English messages.
- Windows file names cannot contain `*`; tests use `[ab].txt` for the
  literal-pathspec check.

## Found for later

Hunk/line staging, worktree task isolation, PR/CI, conflict resolution UI,
stash, commit signing UI, multi-remote UI, revert/cherry-pick, interactive
rebase, deployment linkage, remote/mobile access.

Last verified: 2026-09-23
