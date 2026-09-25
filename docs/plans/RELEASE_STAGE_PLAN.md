# RELEASE_STAGE_PLAN — send tested work live, with proof

Status: proposed (v2, rewritten after a fresh code investigation) · Written 2026-09-25 against `b9ce60f` · Pairs with [AUTOPILOT_GATES_PLAN.md](AUTOPILOT_GATES_PLAN.md) · Owners: [workflow-engine.md](../systems/workflow-engine.md), [git.md](../systems/git.md), [source-control.md](../systems/source-control.md), [tool-system.md](../systems/tool-system.md)

## 1. Goal

When a task's work has passed its checks, the Control Center sends it live after **one typed approval** from the operator. It says **Live** only once the hosting provider confirms that the live site is serving **that exact commit**.

**What happened in TASK-0007.** The finished work was a commit on a local branch. Releasing it took five manual steps:

1. check that `origin/main` had not moved;
2. fast-forward;
3. push;
4. watch Cloudflare Pages;
5. confirm the live site.

The obvious shortcuts were misleading:

- `wrangler pages deployment list` said "Active" for the new build several minutes before it served traffic.
- Comparing the page's asset bundle only works when the front end changes. A change to server functions alone leaves the HTML identical, and the accounting app doesn't expose its commit publicly (`/api/health` requires sign-in).

**Root cause in the code:**

- The git stage commits only on the task branch (`engine/runners.ts:775-834`; `workflows/full-autopilot.yaml:75`, "never pushes").
- `finalizeWorktree` tells the operator to merge it themselves (`engine/tooling.ts:424-455`).
- Source Control can push only the branch that is checked out, and the engine can't call it (`app.ts:145-147`).
- Nothing records which tree passed the checks.
- Nothing asks the provider which commit is live.

## 2. Scope

**In**

1. **A per-repository release setting.** Method `push`: fast-forward a remote branch to the task's commit. That is the release for Git-connected hosts, which covers the accounting app (Cloudflare Pages Git integration) and the Control Center's own cloud control plane (its deploy workflow runs from `main`). The default is `none`.
2. **Proof of live**, from one or both of these sources:
   - **Cloudflare Pages:** the project's current production deployment is for the pushed commit, and its deploy stage succeeded.
   - **Version URL:** a URL whose response contains the pushed commit, for apps that report their build.

   Plus an **up check**: the live URL answers.
3. **A `release` stage at Level 5.** It always needs a typed approval. It runs after Smoke in `full-autopilot`, and it is SKIPPED when the repository has no release configured.
4. **A Release button for completed tasks.** Same service, same checks, same approval.
5. **"Tested tree" recording**, so only a commit whose exact files passed Test can be released.
6. **One read-only tool,** `cloudflare.pages_status`. One additive migration. Tests, docs, and a real release on `tenten-accounting-in`.

**Out** (see §9)

- Direct-upload releases, such as `wrangler deploy` or `pages deploy` from a built folder, and any free-form release command. These would need broker credentials injected into a command, which `sanitizeEnv` rightly prevents today.
- Releasing without approval.
- Rollback.
- Remote database migrations.
- Updating from `main` when it has moved.
- Pull-request flows.
- Multi-repository releases.

## 3. Enhanced design and architecture

### 3.1 Why this shape

| Choice | Chosen | Rejected, and why |
|---|---|---|
| How to publish | `git push <remote> <sha>:refs/heads/<branch>`, run from the repository folder, never forced | Checking out or merging in the operator's folder, which touches their work. `merge --ff-only` in a worktree, which is an extra step that gives the same result. |
| Proof of live | The provider's **live deployment identity** (commit plus successful deploy stage), or a version URL showing the commit | The CLI status "Active" (seen to be early). An HTML asset fingerprint (blind to server-only changes). |
| Release methods | `push` only | Free-form commands with injected credentials: a new secret-exposure surface for a second-priority need. |
| Where the logic lives | A `ReleaseService` in the orchestrator, called by the stage and by the route; provider reads go through `ToolService.invoke` | Reusing `SourceControlService.mutate`, which refuses while a task holds the writer lock (`BLOCKED_BY_TASK`), so it can't serve the task's own release. |

### 3.2 Repository release setting

The `repositories` table gets a new JSON column, `release`. It is validated by a `releaseConfigSchema` in `packages/shared/src/schemas.ts`, used inside `updateRepositorySchema`:

```ts
type ReleaseConfig =
  | { method: 'none' }
  | {
      method: 'push';
      remote: string;                  // default 'origin'; must exist in `git remote`
      branch: string;                  // default 'main'
      liveUrl: string;                 // https URL of the live app; must answer (any status < 500)
      proof: {
        cloudflarePages?: { project: string };        // e.g. tenten-accounting-in-saas-new
        versionUrl?: string;                          // https URL whose body contains the commit sha
      };                               // at least one proof source required
      manualPaths: string[];           // globs that must never ship this way, e.g. ['db/migrations/**']
      timeoutSec: number;              // default 900, max 3600
    };
```

- **Validation.** The URLs must use `https`. At least one proof source is required, so there is no configuration that can never prove Live. The branch and remote are plain names (`^[\w./-]+$`).
- **UI.** The `RepositoryDetailPage` (panels at `:145/:156/:210/:245`) gets a **Release** panel with:
  - the method, remote and branch, live URL, proof sources and manual paths;
  - a **Check setup** button that runs only the read-only parts: `git remote` and `ls-remote` for the branch, the live URL answering, and a read of the provider project. It sends nothing;
  - the wording *"Releasing sends work to your live site. It always asks you first."*
- **Detection** never turns release on by itself.

### 3.3 Recording the tested tree

The `test_runs` table gets a new `tree_id` column, unless AUTOPILOT_GATES_PLAN §E has already added it, in which case it is reused.

- At the start of a `tests` stage, `runCommands` computes `workingTreeTree(workdir)` once per repository. The helper already exists at `packages/git/src/index.ts:398-403`: a private index plus `write-tree`, which leaves the real index untouched. The value is stored on each run.
- **Tested tree** = the `tree_id` of a Test stage whose runs for that repository all passed. With AUTOPILOT_GATES_PLAN, runs that are entirely `preexisting` also count; a `new` or `unknown` failure never does.

### 3.4 ReleaseService (`apps/orchestrator/src/release/service.ts`)

It is called by the stage runner and by the route. It holds the repository writer lock (`coordinator.acquireWriter`, as at `engine.ts:820`) for steps 1–4, and records every step as a task event and in `task.git.release`.

1. **Resolve.** The commit is the last entry in `task.git.commits` for the primary repository.
   - The engine's own git checkpoint makes that commit, so the task's changes are all in it.
   - If the task's working folder still exists and has uncommitted task files, refuse: *"Some changes were never committed or tested."*
2. **Tested.**
   - `git rev-parse <sha>^{tree}` must equal a tested tree of this task, or the refusal is *"This commit is not the version that passed the checks."*
   - A task created before this feature has no `tree_id`, so it is refused with *"No record of which version passed the checks — run the checks again."*
3. **Safe to publish.**
   - `git fetch <remote> <branch>` updates remote-tracking refs only.
   - `git merge-base --is-ancestor <remote>/<branch> <sha>` must succeed. Otherwise: *"`<branch>` has moved since this task started. Update the task and re-test first."*
   - The changed paths from `<remote>/<branch>` to `<sha>` must not match `manualPaths`. Otherwise the refusal lists them: *"these need a manual step (for example a database migration)."*
   - The secret scan over the outgoing range uses the same check Source Control runs before pushing (`source-control/service.ts:927-936`). It is extracted to a shared helper, `scanOutgoing(repoPath, fromRef, toRef)`, which Source Control keeps using unchanged.
   - Up check: `liveUrl` answers with a status below 500 through `http.request` (Level 1, GET, no credentials). Otherwise: *"The live site isn't answering; nothing was sent."*
   - **Before snapshot.** For Pages, read the project's current live deployment id and commit.
4. **Publish.**
   - `pushRef` (`packages/git/src/source-control.ts:400-404`) is extended to accept `<sha>:refs/heads/<branch>`. It still has no force path.
   - The push runs from `repo.path`. Worktrees share its object store, so this works during the task and after the worktree has been removed. It only reads objects and changes the remote; it never switches a branch, never merges and never writes into the operator's working tree.
   - Git rejects anything that isn't a fast-forward, so a lost race fails safely.
   - Afterwards, Source Control's existing background fast-forward brings the operator's local branch up to date (`source-control/service.ts:735-909`).
   - The writer lock is released after the push.
5. **Prove.** The service polls every 15 s until `timeoutSec`. **Live** needs every configured proof:
   - **Pages:** the new read tool `cloudflare.pages_status` returns the project's live production deployment, taken from the project's canonical deployment (the same `cfApi` project read that `pagesProductionBranch` already does, `packs/cloudflare.ts:111-117`, `:143-152`). The proof holds when its commit hash starts with the pushed sha and its deploy stage status is `success`.
     - A deployment for the sha that **failed** ends as `failed`, with a link to the build.
     - A deployment still building keeps polling.
     - A different commit being live keeps polling until the timeout.
   - **Version URL:** a GET response (no credentials) contains the pushed sha, full or 7+ characters.
   - **Up:** `liveUrl` answers with a status below 500.
6. **Outcome.**

   | State | Meaning |
   |---|---|
   | `live` | Every proof passed. Records `liveConfirmedAt` and the evidence (deployment id and URL, the response excerpt). |
   | `published_unconfirmed` | Pushed, but no proof within the timeout, or the provider couldn't be read (for example no Cloudflare credential for this repository). The evidence gathered so far is kept. |
   | `failed` | The provider reported a failed deploy, or the push was rejected. |
   | `refused` | A check in steps 1–3 stopped the release. Nothing was sent. |

### 3.5 Stage, approval and task state

- **Stage kind.** `STAGE_KINDS` (`constants.ts:60`) gains `release`. `full-autopilot.yaml` becomes `smoke.next: release`, with this new stage:

  ```yaml
    - key: release
      name: Release
      role: deployer
      kind: release
      permissionLevel: 5
      requiresApproval: true
      optional: true
      next: complete
  ```

  The builtin loader saves the new workflow version for new tasks (`services/workflows.ts:57-58`). Existing tasks keep their snapshot.
- **Skipping.** `skipsForLackOfCommands` (`runners.ts:144-148`) treats `kind: release` with method `none` as a skip. Such a stage is SKIPPED ("No release set up for this repository") **before** the approval gate, so no approval is ever asked for.
- **Approval.** The stage uses the existing Level 5 stage-permission approval:
  - It needs the typed task id (`engine/approvals.ts:50-80`) and is one attempt only (`engine.ts:865-870`). `policyCeiling` caps automatic approval at Level 4 (`packages/tools/src/policy.ts:41-45`), so it can never be auto-approved.
  - The card states the action: *"Push `779bbcb` to `origin/main`. Cloudflare Pages `tenten-accounting-in-saas-new` builds it. Live when the project serves `779bbcb`."*
  - **Declining** marks the stage SKIPPED ("Release declined"), and the task completes. The operator can release later with the button. If the current reject path does something else, change it for `release` stages only.
- **Outcome routing.**
  - `live` → `success`.
  - `refused`, `failed` and `published_unconfirmed` → the stage is FAILED with a limitation, and the task moves on to `complete`. Use AUTOPILOT_GATES_PLAN's `optional_failed` if it has shipped; otherwise add that outcome here, as that plan describes in §D.
  - The Chairman's policy excludes `retry_stage` for `release` stages, and a release **never** starts a recovery cycle. Retrying a release is an operator decision.
- **Task state.** `TaskGitInfo` (`packages/shared/src/types.ts:55-69`) gains `release?: { state, commit, tree, target, requestedAt, approvedBy?, publishedAt?, liveConfirmedAt?, proof: {...}, reason? }`. It is stored in the existing `tasks.git` JSON column, so it needs no new column.
- **Report.** In `engine/report.ts:12`, `deployed` gains `'production'`, set only for `live`. The report shows `Live on {liveUrl} since {time} — commit {sha}`. `published_unconfirmed`, `failed` and `refused` add a plain limitation, so the task becomes NEEDS_USER_ACTION. `FinalStatus` is unchanged.
- **Dashboard.**
  - The task header and the task list get a badge: **Live**, **Sent — not confirmed**, **Release failed** or **Not released**.
  - The Overview gets a Release card with the steps and their evidence.
  - A **Check again** button re-runs only step 5, reading and never writing.

### 3.6 Release button for completed tasks

- **Route:** `POST /api/tasks/:id/release`, through `command(...)` in `http/routes.ts:169-182`.
- **When it's allowed:** the task is COMPLETED, the repository's method is `push`, the task has a commit, and its release state is not `live` or `publishing`.
- **What it does:** it creates the same Level 5 approval. Once approved, it runs `ReleaseService` and records events against a synthetic `release` stage record so the Timeline shows them.
- **Stale work:** a task whose target branch has moved, or which has no tested tree, is refused with the reason and nothing is sent.
- **UI:** a **Release** button next to Details when the action is allowed.

### 3.7 Tool

`cloudflare.pages_status`, in `packages/tools/src/packs/cloudflare.ts`:

- It is **read-only** at Level 1 and needs the `cloudflare` credential.
- Input: `{ project }`.
- It returns `{ productionBranch, live: { id, commit, stage, status, url, createdAt } | null }`.
- It is registered in the tool policy like the other read tools.
- The engine calls it through `ToolService.invoke({ origin: 'engine', preApproved: true })`, the same pattern as `verify.web` (`runners.ts:729-738`).
- If no Cloudflare credential is available for the repository, it returns a clear `UNAVAILABLE` result. The release is then `published_unconfirmed` (when that was the only proof) and never `live`.

### 3.8 Data model: migration (next free version)

```sql
ALTER TABLE repositories ADD COLUMN release TEXT NOT NULL DEFAULT '{"method":"none"}';
ALTER TABLE test_runs ADD COLUMN tree_id TEXT;   -- skip if AUTOPILOT_GATES_PLAN already added it
```

The change is additive. Existing repositories default to `none`, which behaves exactly as today, and existing test runs have a NULL `tree_id`.

## 4. Implementation steps

Each step is one tested update, and `pnpm check` stays green after each.

1. **Types and schema.** Add `ReleaseConfig` and its schema, the `release` stage kind, and `TaskGitInfo.release`. Add the migration and the store mapping for `repositories.release`.
2. **Tested tree.** Compute `tree_id` in `runCommands` and store it. Add a helper, `testedTrees(store, taskId, repoId)`.
3. **Git helpers.**
   - Extend `pushRef` to take `<sha>:refs/heads/<branch>`, with no force path.
   - Add `isAncestor`, `treeOf`, `changedPaths(from, to)` and `remoteExists` to `packages/git`.
   - Extract `scanOutgoing`, and switch Source Control over to it.
4. **Tool.** Add `cloudflare.pages_status`, its policy entry and fake-API tests.
5. **`ReleaseService`.** Implement steps 1–6 of §3.4 with events and state, and unit-test every outcome.
6. **Stage.**
   - Add `runRelease` in `runners.ts` and the skip rule.
   - Update the workflow YAML.
   - Add the approval card text and the decline behaviour.
   - Add outcome routing, and exclude `release` from the Chairman's retries.
7. **Route and button.** Add `POST /api/tasks/:id/release`, the synthetic stage record and the Timeline events.
8. **Report and UI.**
   - Update `report.ts`.
   - Add the badges, the Release card and **Check again**.
   - Add the repository Release panel with **Check setup**.
   - Run the Playwright matrix in both themes.
9. **Docs.** Update `workflow-engine.md`, `git.md`, `source-control.md`, `tool-system.md`, `dashboard.md` and `operations.md` (how to set up a release), and each `Last verified:` date.
10. **Real release** (§7).

## 5. Failure handling and recovery

| Situation | Result | Sent? |
|---|---|---|
| Uncommitted task files; commit tree ≠ tested tree; no tested tree | `refused` | No |
| Target branch moved (not a fast-forward) | `refused`, with the update-and-re-test instruction | No |
| `manualPaths` matched | `refused`, listing the paths | No |
| Secret found in the outgoing range | `refused`, with the finding redacted | No |
| Live URL not answering before the release | `refused` | No |
| Remote rejects the push (race, branch protection, auth) | `failed`, with the git message redacted | No |
| Provider reports a failed deploy for the sha | `failed`, with a link to the build; the previous version stays live, because Pages promotes only successful builds | Commit on remote |
| No proof within the timeout, or the provider unreadable | `published_unconfirmed` with the evidence so far; **Check again** is available | Commit on remote |
| Orchestrator restarts while `publishing` or `proving` | On startup the state becomes `published_unconfirmed` if the remote branch now contains the sha, otherwise `failed`. Nothing is ever re-pushed automatically. **Check again** runs step 5 only. | As it was |
| Operator declines the approval | Stage SKIPPED ("Release declined"), and the task completes | No |

- **Nothing irreversible happens before step 4.** Step 4 is the only write, and it is a fast-forward, never forced.
- **No automatic rollback.** A rollback is its own production change (§9).
- **Rolling back this feature's code** leaves the new columns unused. Repositories behave as `none`, and older tasks are unaffected.

## 6. Security and data protection

- **The approval is always required.** Level 5 needs a typed approval every time. There is no auto-release setting, and neither `policyCeiling` nor `autoApproveUpToLevel` can bypass it.
- **Only the operator can release.** Agents, the Chairman gateway and chat intents can't call the release route or `ReleaseService`, and tests prove this. The remote and branch come only from the saved repository setting.
- **Exact-tree rule.** Only a commit whose tree passed Test is released. This is checked again, under the writer lock, straight after the approval.
- **The operator's folder is untouched.** The push reads objects and writes only to the remote. The operator's local branch moves only through Source Control's existing, refusal-guarded fast-forward.
- **Secrets.** The outgoing range is scanned with Source Control's own check. The push uses the operator's own git credential helper, exactly as Source Control's pushes do today. No token is injected, and `sanitizeEnv` is unchanged. Provider reads use the broker's repository-scoped `cloudflare` credential through the tool system, at Level 1, read-only. Output passes through `redact()`.
- **Live checks carry no credentials.** They are GET requests only, with no cookies or tokens sent to the app.
- **Audit.** Every step writes a task event (`RELEASE_REQUESTED`, `APPROVED`, `DECLINED`, `REFUSED`, `PUBLISHED`, `LIVE`, `UNCONFIRMED`, `FAILED`). Each event carries the commit, the target, who approved it and the evidence.
- **No new dependencies, and no guard listed in AGENTS.md is weakened.** Every changed guard path has a test that proves the new behaviour.

## 7. Testing and verification

**Unit**

- **`packages/git`:**
  - `pushRef` of `<sha>:refs/heads/main` to a local bare remote, including when the worktree has been deleted;
  - a push that isn't a fast-forward is rejected;
  - there is no force option;
  - `isAncestor`, `treeOf`, `changedPaths` and `scanOutgoing`, with Source Control's own tests still passing.
- **Tool:** `cloudflare.pages_status` against a fake Cloudflare API, covering a live commit that matches, one that is still building, a failed build, a different live commit, a missing credential (`UNAVAILABLE`), and its policy level.
- **`ReleaseService`** (`apps/orchestrator/test/release.test.ts`): every row of §5, using a bare remote, a stub HTTP server and the fake provider. It asserts:
  - the state, the events and the report limitation;
  - nothing is pushed in any refusal;
  - the operator folder's branch, `HEAD` and `git status` are identical before and after.
- **Engine:**
  - method `none` means the stage is SKIPPED with no approval;
  - a configured release waits for a Level 5 approval, and the typed id is required;
  - declining gives SKIPPED and the task completes;
  - after approval the release runs once;
  - a non-live outcome gives FAILED plus a limitation, and the task still completes;
  - the Chairman never retries a release;
  - `tree_id` is recorded on test runs.
- **Routes:**
  - `POST /api/tasks/:id/release` in each allowed and refused state;
  - it is refused from agent and gateway origins;
  - an approval is always required.
- **Restart:** a task left in `publishing` or `proving` is resolved on startup without re-pushing. **Check again** only reads.

**End-to-end and visual**

`pnpm build && pnpm e2e`, in both themes:

- the Release panel with **Check setup**;
- the approval card text;
- the badges (Live, Sent — not confirmed, Release failed, Not released);
- the Release card;
- the Release button on a completed task.

Then an eye check in the operator's browser at desktop and phone width.

**Real release** (on the operator's PC, the proof)

1. Configure `tenten-accounting-in`:
   - `push` to `origin/main`;
   - `liveUrl` `https://accounting.digitronics.app/`;
   - proof `cloudflarePages: { project: 'tenten-accounting-in-saas-new' }`;
   - `manualPaths: ['db/migrations/**']`.

   **Check setup** must pass and send nothing.
2. Run a small, low-risk, real task (a copy or docs change the operator agrees to) through Full Autopilot. Approve Release, then record:
   - the push;
   - the Pages live deployment switching to the sha;
   - the **Live** state and how long it took.
3. Prove the button path by releasing a second small completed task with **Release**.
4. Prove a refusal on a scratch branch that touches `db/migrations/`: it is refused with the paths listed, and nothing is sent.

**Commands:** `pnpm check` · `pnpm build && pnpm e2e` · the real release.

## 8. Success criteria

- A repository with no release set up behaves exactly as today: the stage is SKIPPED and no approval is requested.
- A repository with release set up asks for **one** typed Level 5 approval that states what will be sent, where, and how Live will be proved. Nothing is sent before it.
- Only a commit whose tree passed Test can be released. Each refusal case in §5 stops before anything is sent and gives a plain reason.
- The push never forces, never changes the operator's folder, and works after the task's worktree has been removed.
- **Live** is shown only when the provider confirms the project serves the pushed commit with a successful deploy, or the version URL shows the commit, **and** the live URL answers. A CLI "Active" status or a changed page alone is never enough.
- An unconfirmed push is shown as **Sent — not confirmed**, with evidence and **Check again**, and the task is NEEDS_USER_ACTION. It is never shown as Live.
- A restart never re-pushes. **Check again** only reads.
- Agents and the Chairman can't trigger a release, and the tests prove it.
- The real release on `tenten-accounting-in` reaches **Live**, confirmed by the Pages live deployment for the pushed commit. The button path also works, and a migration-touching change is refused with nothing sent.
- `pnpm check` and the e2e matrix are green in both themes. The touched system docs are updated with new `Last verified:` dates.

## 9. Found for later

- **Update from `main` and re-test.** When the target branch has moved, merge it into the task branch in a worktree, re-run Test, Review and Verify, then offer Release again. This is the most common refusal on busy repositories. **Priority: high.**
- **Direct-upload releases.** `cloudflare.deploy` (Workers) and `cloudflare.pages_deploy` (a built folder) as release methods. They go through the existing Level 5 tools rather than a free-form command, and the proof comes from the returned `versionId` or deployment id. **Priority: high,** for Worker-based apps.
- **Remote database migrations before release,** for example `npm run db:migrate:all:remote` for the accounting app. This would be a separate, approval-gated pre-release step for changes that touch `manualPaths`. **Priority: high.**
- **Exposing the commit in the accounting app.** A public, secret-free `/api/version` returning `CF_PAGES_COMMIT_SHA` (the app already reads it at `functions/api/_middleware.ts:622`) would give a second, provider-independent proof. This is work in that repository. **Priority: medium.**
- **One-click rollback,** re-pointing production to the previous deployment, behind its own approval. **Priority: medium.**
- **Pull-request release flows** and **multi-repository ordered releases.** **Priority: medium.**
- **Release notifications,** "waiting for your release approval" and "Live", sent as PWA pushes. **Priority: medium.**
- **Signed-in post-release smoke checks.** This needs the App check work in AUTOPILOT_GATES_PLAN §9. **Priority: medium.**

## 10. Next recommended task

**APP_CHECK_PLAN**: make the App check stage run for real:

- detect the actual start command (Playwright `webServer`, `dev:full`);
- sign in through the repository's `.agent/browser-auth.json` contract, and confirm `expectedWorkspace`;
- add per-repository verification fixtures so screens with numbers can be checked on seeded data.

In TASK-0007 the Funding Plan screen was never checked by the workflow. The same capability later gives releases a signed-in check after going live.

## 11. Final execution prompt

Implement `docs/plans/RELEASE_STAGE_PLAN.md` in `AI-Development-Control-Center`.

- Read `AGENTS.md`, `PLAN.md`, `design.md` and the system docs named in the header first. Investigate the code paths cited in §1 and §3 before changing them.
- If AUTOPILOT_GATES_PLAN has shipped, reuse its `tree_id` column and its `optional_failed` outcome. If not, add them here exactly as that plan describes.
- Follow §4 in order. Each step is a tested update that keeps `pnpm check` green.
- Keep every guard AGENTS.md protects. Release is Level 5 and always needs a typed approval. Never add a force path, an auto-release setting or credential injection into commands.
- The only schema change is one additive migration at the next free version.
- Update the owning `docs/systems/*.md` in the same step as the behaviour.
- Finish with the real release in §7 on `tenten-accounting-in`, using only a small, low-risk change the operator has agreed to, and verify every item in §8.
- Report what was checked, what was not, and why.

/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.
