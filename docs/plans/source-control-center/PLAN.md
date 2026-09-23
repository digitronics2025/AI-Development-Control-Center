# Source Control Center — Production Implementation Plan

**Project:** `digitronics2025/AI-Development-Control-Center`
**Plan type:** Focused feature plan
**Verified against current repository:** 2026-09-23
**Status:** Implemented 2026-09-23 — see [Implementation status](#implementation-status) at the end and
[docs/systems/source-control.md](../../systems/source-control.md) for how it works.

> The root `PLAN.md` stays the product-level architecture. This file is the
> focused feature plan as approved, followed by its implementation record.

---

## Design reset: what should be built, and what should not

The useful part of the VS Code Source Control experience is not the exact panel layout. It is the immediate answer to four questions:

1. What changed?
2. What will be committed?
3. What happened in Git history?
4. Is my local repository safely synchronized with its remote?

The Control Center already has a strong foundation for this: native Git helpers, task baselines, task/pre-existing/mixed change attribution, bounded diffs, task branches, safe task-origin commits, a task Changes tab, Fastify APIs, SQLite state, WebSocket events, and shared dashboard/VS Code UI. The feature extends those capabilities rather than building a second Git subsystem.

### Weaknesses in the first idea that this plan corrects

- **Do not build a full VS Code/GitKraken clone.** Pull requests, interactive rebase, conflict editing, stash management, cherry-pick, multi-remote administration, commit signing UI, deployment dashboards and advanced graph operations are out.
- **Do not mix task change tracking with repository source control.** A task diff answers "what did this task change relative to its baseline?"; Git source control answers "what is staged, unstaged, untracked, conflicted, ahead, behind and committed right now?"
- **Do not make GitHub the source of truth.** Local native Git is authoritative.
- **Do not auto-stage, auto-push, auto-pull or auto-resolve divergence by default.**
- **Do not let UI actions race with an active coding agent.** Source-control mutations use the same repository coordination model as task execution.
- **Do not continuously scan every repository.** Cached Git state, explicit invalidation, a lightweight visible-page refresh and manual refresh.
- **Do not persist complete diffs or source files in SQLite.** Operation metadata and audit records only.
- **Do not invent a separate AI review system.** Reuse the reviewer role and workflow engine against a bounded, redacted staged diff.
- **Do not hide Git ambiguity.** Detached HEAD, no upstream, merge conflicts, diverged branches, failed hooks, remote rejection and external changes are first-class states.
- **Do not make "Sync" a dangerous magic button.** Fetch first; fast-forward only when safe; push only when ahead; stop on divergence or conflicts.

---

## 1. Goal

A first-class **Source Control** module that provides a reliable repository-level view of local Git state, safe everyday Git actions, commit history, and AI/task traceability while preserving the existing task-specific Git protections. It must let the user answer: which repository and branch; what is staged / unstaged / untracked / conflicted; which changes came from a task versus pre-existing work; what the next commit contains; the recent history; whether the branch is ahead / behind / diverged; whether commit / fetch / fast-forward / push succeeded; whether an active AI task makes Git mutations unsafe. It works in the standalone dashboard and the shared VS Code WebView without duplicated business logic.

## 2. Scope

**Included:** repository Source Control page (selector, branch/detached state, HEAD, upstream, ahead/behind/diverged, staged/unstaged/untracked/conflicts, inexpensive line counts, refresh, stale/offline/error states); lazy per-file diffs (staged/unstaged, attribution, binary/large handling, open in VS Code); safe staging (one/selected/all eligible, unstage one/selected/all, explicit handling of mixed task/user files); commit workflow (message, optional AI message from staged diff only, staged preview, revalidation, hooks enabled, exact new SHA, audit record); paginated history with lightweight graph, decorations, on-demand details and proven task attribution; safe fetch/sync/publish (no force, no automatic merge/rebase resolution); AI-aware integration (active task, attribution, read-only staged review via the reviewer workflow, repository mutation lock shared with task execution); reliability (idempotent requests, operation journal, restart reconciliation, structured errors, WebSocket invalidation, recovery guidance).

**Excluded:** PR management, Actions dashboard, issues, interactive rebase, cherry-pick UI, reflog browser, merge-conflict editor, automatic conflict resolution, arbitrary reset/clean, force push, stash manager, commit signing UI, multi-remote manager, submodules, LFS, deployments, worktree-based parallel tasks, hunk/line staging, remote/mobile Source Control.

## 3. Design principles (abridged from the approved plan)

- Layers: `packages/git` knows Git; the orchestrator knows policy, tasks, permissions, audit, locks and recovery; the UI knows presentation and intent.
- Two change models (Git state vs task attribution); attribution enriches, never replaces, Git state.
- A typed snapshot with a deterministic `version`; every mutation sends the version it acted on and a stale one returns `GIT_STATE_CHANGED`.
- One mutation coordinator per repository; reads concurrent; mutations serialized; no Git mutation while a writable task stage runs.
- Refresh: invalidate after known operations, WebSocket invalidation, short visible-page interval, manual refresh; diffs and history lazy.
- Sync state machine: fetch → recompute → synced / ahead→push / behind+clean→ff-only / behind+dirty→stop / diverged→stop / conflicts→stop / no upstream→explicit Publish.
- Staging with exact pathspecs; unstage compatible with unborn repositories; mixed files never auto-staged and Stage All never silently includes them.
- Commit only the index: lock, verify version, secret preflight, re-read staged paths, `git commit` with hooks, verify HEAD moved, re-read, journal.
- Sensitive-file and secret preflight before commit and push; AI receives redacted context without sensitive files.
- Operation journal (`git_operations`) with idempotency keys, bounded metadata, no diffs, no credentials.
- Restart reconciliation from repository reality; never repeat a commit or push blindly.
- Repository-centric typed API, strict path validation, no arbitrary Git endpoint.
- History: paginated, lanes for the loaded page, decorations, details on demand, attribution only with evidence.
- UX: first-class navigation destination, Changes and History only, precise status language, responsive drill-down.
- AI: message from staged diff only; staged review with the existing reviewer role, read-only; core Git works with no agent.

## 4. Phases

0 Inspect and freeze behaviour · 1 Git primitives · 2 Service and shared lock · 3 Migration and recovery · 4 Contracts and routes · 5 Read-only UI · 6 Staging and commit · 7 History graph · 8 Fetch/sync/publish · 9 AI message and staged review · 10 VS Code integration · 11 Documentation and hardening.

## 5. Failure handling

Git missing, not a repository, stale state, active task, index.lock, operation in progress, conflicts, hook failure/edits, lost commit response, remote auth failure, fetch failure, push rejected or uncertain, diverged, behind+dirty, no upstream, detached HEAD, unborn repository, binary, oversized diff, journal failures before/after Git, crash mid-operation — each with a truthful state and a safe next action. Principle: reconcile the database to the repository, never the repository to an assumption.

## 6. Security

Argv-only Git, bounded timeouts and output, no interactive prompts; registered repository + canonical relative paths + no traversal/symlink escape + NUL-safe parsing; no raw diffs or credentials persisted; redaction; sensitive-file/secret blocking; no force push / hard reset / destructive clean / automatic resolution; permission levels mapped; localhost + token + origin checks unchanged; data minimisation.

## 7. Testing

Unit tests on real temporary repositories and a local bare remote (clean, staged, unstaged, staged+unstaged, untracked, add/delete/rename, conflicts, spaces/Unicode/special names, detached, no upstream, ahead, behind, diverged, unborn, binary, truncation, exact stage/unstage, commit, hook rejection, fetch, fast-forward, push, rejection, publish); integration flows; task Git regressions; recovery (crash after commit, uncertain push, duplicate idempotent request); API security; Playwright matrix (viewports × Dark/Light, axe, keyboard, flows, WebView); performance behaviour; `pnpm typecheck / lint / test / build / e2e` and a manual real-repository check.

## 8. Success criteria

Listed with their verified status in [Implementation status](#implementation-status).

## 9. Found for later

| Item | Why it matters | Direction | Priority |
|---|---|---|---|
| Hunk/line-level staging | User + AI changes in one file | Patch-based staging with context validation | High |
| Git worktree isolation | Safe parallel tasks | One task per worktree, lifecycle cleanup | High |
| GitHub PR + CI layer | Remote review workflow | Separate provider integration | High |
| Conflict resolution UI | Sync/merge recovery | Explicit workflow, never silent AI resolution | Medium |
| Stash manager | Context switching | Typed stash list/apply/drop | Medium |
| Commit signing | Some repositories require it | Detect existing config first | Medium |
| Multi-remote UI | Forks/upstreams | Read-only list first | Medium |
| Revert/cherry-pick | History actions | Audited operations | Medium |
| Interactive rebase | Powerful, dangerous | Separate advanced mode | Low |
| Deployment linkage | Commit per environment | Deployment subsystem | Medium |
| Remote/mobile Source Control | Away from desktop | Needs remote-control architecture | Later |

## 10. Next recommended task

Worktree-based task isolation once Source Control is stable: one worktree per independent task, with lifecycle, branch cleanup, disk usage, recovery and merge-back policy designed in its own plan.

---

## Implementation status

Implemented on branch `source-control-center`, 2026-09-23. Design decisions
that go beyond the plan text:

- **Staleness by scope.** The version is global, but a mutation with an older
  version proceeds when the state *that action depends on* (the requested
  paths, the index, or the branch) is unchanged in one of the last 24
  snapshots. Editor saves elsewhere no longer reject a stage or commit.
- **`sync` is a journal kind** of its own, with `pushedSha` / `fastForwardTo`
  noted before the risky step so recovery can check the remote or HEAD.
- **Staged review is a task** on the new read-only `staged-review` workflow;
  read-only workflows neither wait for nor hold a repository, and a
  non-gating reviewer verdict is recorded as advisory.
- **Fetch is allowed while a task writes** (it only moves remote-tracking refs).
- **Conflicted paths** are shown but never staged; merges and rebases in
  progress block all mutations.

| Success criterion | Status | Evidence |
|---|---|---|
| First-class page; same page in the WebView | Verified | Playwright matrix + `webview.spec.ts` |
| Select a registered repository | Verified | `source-control.spec.ts` |
| Branch, HEAD, upstream, ahead/behind/diverged correct | Verified | git + API tests against a bare remote |
| Detached HEAD and no upstream explicit | Verified | API tests, banners |
| Staged/unstaged/untracked/conflicted, staged+modified file | Verified | `packages/git/test/source-control.test.ts` |
| Attribution where proven | Verified | coordination tests (`preexisting`, `both`) |
| Lazy staged/unstaged diffs; bounded; binary safe | Verified | git + API tests |
| Sensitive material not exposed to logs or AI | Verified | preflight tests, review artifact omits `.env` |
| Exact stage/unstage; Stage All refuses unconfirmed mixed files | Verified | API tests + e2e |
| Commit uses the index; hooks run; failure keeps staged state; verified SHA | Verified | API tests (hook rejection) + e2e |
| History paginated; graph; details on demand; evidence-only attribution | Verified | git/API tests, `layoutGraph` tests, e2e |
| Fetch leaves worktree; ahead pushes; behind fast-forwards only when clean; dirty stops; diverged stops; no force; explicit publish | Verified | API tests against a bare remote + e2e |
| Mutations cannot race a writable task; serialized; stale version detected; idempotent; reconciled after restart | Verified | coordination, idempotency and recovery tests |
| No arbitrary Git API; path escape impossible; no diffs/credentials in SQLite | Verified | API tests (traversal, unchanged paths), journal content test |
| Secret preflight blocks commit/push | Verified | API tests + e2e |
| Existing localhost/auth protections intact | Verified | API test (401 without token) + existing security suite |
| Existing task Changes tab, baselines, task commits | Verified | existing engine/git/API tests and e2e unchanged and passing |
| typecheck, lint, test, build, e2e | See the final report of the implementing session | |
