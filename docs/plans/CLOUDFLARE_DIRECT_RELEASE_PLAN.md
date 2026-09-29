# CLOUDFLARE_DIRECT_RELEASE_PLAN — release a new app straight to Cloudflare Pages

Status: implemented 2026-09-29 · Extends [RELEASE_STAGE_PLAN.md](RELEASE_STAGE_PLAN.md) · Owners: [release.md](../systems/release.md), [tool-system.md](../systems/tool-system.md)

## 1. Goal

A brand-new app built by a Full Autopilot task (Simple Calc, TASK-0027) ended **ready** on a task branch with nowhere to go. The only release setting was **Push to a branch**, which needs a Pages project already connected to Git in the Cloudflare dashboard. Deploying it took an operator request, a new tool (`cloudflare.pages_project_create`, 1d51ff7) and two manual tool calls.

A third setting, **Deploy to Cloudflare**, makes the Release stage do that itself: the same one typed approval, and **Live** only when Cloudflare serves that exact commit.

## 2. Decisions

| Decision | Chosen | Why |
|---|---|---|
| Push as well as upload | Push the commit to the configured branch first, then upload | The branch and the live site never disagree; the next task starts from what is live, and the push path's checks (moved branch, foreign commits, manual paths, secret scan) apply unchanged. Upload first would leave a live version no branch holds. |
| Where the build runs | A detached worktree of the commit under `<dataDir>/releases`, dependencies from its lockfile | The artifact comes from exactly the tested commit, never from a folder with leftovers (the tests prove this: a build that passes only where the tests left a file behind is refused). |
| Build commands | The repository's `build` commands as detected in that checkout (`taskRepositoryView`), each classified; anything needing approval is refused | A release runs no command a person was not asked about. |
| Project creation | On the first release, after the push, with the configured branch as production | Nothing to set up in the dashboard; creating serves nothing until the upload. |
| Deploy mechanism | `cloudflare.pages_deploy` / `cloudflare.pages_project_create` through `ToolService.invoke` (origin `engine`, operator profile, `preApproved` by the release's typed approval), scope confined to the build folder | The repository's brokered `cloudflare` key; no Wrangler login, no token in a file or environment. |
| Proof | `cloudflare.pages_status`: the canonical deployment is the commit (`--commit-hash`) with deploy/success, and the live URL (the set one, else the project's `subdomain`) answers | The same proof as a Git-connected Pages release. |
| Replacing what is live | Refused when the live deployment's commit is unknown here or not an ancestor of the release commit | An upload replaces the whole site; it must never take down another task's release. |
| Workers | Added 2026-09-29 as `worker: { name?, environment? }` beside `pages` (exactly one) | Built in the clean copy, checked by Wrangler's dry run, deployed with `wrangler deploy --message "<task> <commit>"`; Live when the only live version (100%) names the commit. D1: a release refuses while a bound database has migrations not applied — it never applies one. Gradual rollouts are refused. Secrets stay with `secret-custody` (Wrangler refuses a deploy missing a `secrets.required` one, which shows as a failed deploy). An assets-only Worker (static site) is the same path. |

## 3. Irreversible effects

- The push to the release branch (as for **Push to a branch**).
- Creating the Pages project (it can be deleted in the dashboard; the name's `pages.dev` address is then free again).
- The upload replaces the live site; the previous deployment stays in the project and can be rolled back from the dashboard.

All three happen only after the Level 5 typed approval of that release.

## 4. Tests

`apps/orchestrator/test/release-cloudflare.test.ts` (stand-in Wrangler committed in the fixture's `node_modules/.bin`, stand-in Cloudflare API, both sharing one state file): first release creates, uploads the tested commit and proves Live; a commit that does not build from a clean copy sends nothing; a live version the commit lacks is never replaced; an upload refused after the push is `failed` and the Release button retries only the upload; Check setup creates nothing. `apps/dashboard/e2e/release.spec.ts` covers the panel in both themes and at phone width.
