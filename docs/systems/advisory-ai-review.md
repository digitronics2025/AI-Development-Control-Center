# Subscription-only advisory AI review

Claude is primary, using the owner's Claude subscription. Codex fallback uses
native GitHub code review on the owner's ChatGPT subscription. The runner has no
paid Anthropic or OpenAI model API path, even if API keys are accidentally set.
Plan limits still apply; there is no guarantee of unlimited reviews.

All AI findings, outages, timeouts, missing responses and queued reviews are
advisory. Merging and deployment never wait for them. Mandatory build/test checks,
security controls, human approvals and human/security review threads stay binding.

## Activate the subscription fallback

One **GitHub user credential** belongs in this public control repository only:
`CODEX_REVIEW_GITHUB_TOKEN`. This is not an OpenAI API key and does not buy API
credits. Do not copy ChatGPT cookies or Codex session/refresh tokens into Actions.

1. Use the GitHub account connected to the intended ChatGPT subscription.
2. Create a fine-grained personal access token at
   <https://github.com/settings/personal-access-tokens/new>.
3. Select the owner `digitronics2025` and **All repositories** to cover future
   personal repositories. Grant **Pull requests: Read and write**. Metadata read
   is included. The dispatcher does not need Contents write, Actions write,
   Secrets, Administration, deployment or repository deletion permission.
4. Save the credential in MyVault under the existing secret-custody policy, then
   save it as the control repository's Actions secret `CODEX_REVIEW_GITHUB_TOKEN`:
   <https://github.com/digitronics2025/AI-Development-Control-Center/settings/secrets/actions>.
   Never send the token in chat, commit it, or include it in a report.
5. Run **ChatGPT subscription review fallback** from the Actions tab to verify.
   Keep native Codex Automatic review and Auto security review off to avoid
   duplicate automatic reviews; manual `@codex review` must remain available.

A fine-grained GitHub token is scoped to one resource owner. Organization coverage
requires a suitable user credential and any organization/SSO approvals; do not
claim a personal-owner token covers private organization repositories. Expired,
revoked or restricted tokens stop the dispatcher, never merges or deployment.

The secret API was inaccessible to the setup session (HTTP 403), so the owner
must save this one secret. Until configured, the scheduled dispatcher explicitly
reports **inactive**. Posting a request is not proof that a review completed.

## Request flow and cost controls

The trusted runner reviews API diff text with Claude Code, no tools, hooks, MCP
servers, PR checkout or PR execution. Its private temporary home has only the
Claude subscription token; GitHub and other credentials are excluded. Forks,
Dependabot and drafts are skipped. CLI install is pinned, has a 45-second limit,
and runs no package lifecycle scripts; the native CLI review has a 90-second
process deadline. The overall process/step/job deadlines are 300 seconds, six
minutes and seven minutes. Diffs and output are bounded.

A bot-authored claim is saved per PR head before Claude runs. Reruns never repeat
Claude on that head. A successful pass triggers no Codex request. On Claude error,
auth failure, service failure, quota, invalid response or timeout, the result
gets a pending marker for the central dispatcher. Add `ai-second-opinion` before
the head is first reviewed, or use manual dispatch with `second_opinion=true`,
to queue Codex when Claude reports findings. Negative findings remain advisory.

The dispatcher runs on a five-minute schedule, best effort, or manual dispatch.
GitHub may delay scheduled jobs. It reads open PRs and comments in repositories
the token can manage, accepts only trusted bot markers for the current head, and
posts `@codex review` as the connected GitHub user. No private code or diff is sent
in the trigger comment; the existing Codex GitHub integration performs its review.
A seven-minute runner that dies without updating its claim is recoverable after
eight minutes. This covers lost responses and hard job timeouts without starting
Codex in parallel with a healthy Claude job.

One dispatcher run is active at a time. It rechecks the head and open state before
posting; the native request comment is the durable per-head claim. Existing native
running/completed/failed state prevents duplicate requests. There are no automatic
per-head retries after a native request, including quota failure. A user may
explicitly request another native review after their allowance resets.

The dispatcher does not wait for Codex. Its logs and public summaries contain
only counts, not private repository names, PR URLs, code or credential values.
Provider account allowances and shared hosted-runner capacity still apply. The
review and dispatcher own no production concurrency group or deployment environment.

## Distribution and repository policy

All consumers call the public reusable workflow at an immutable commit. The
reviewer source is separately pinned. The released workflow SHA is stored in
`scripts/ai_review/workflow-version.txt`. Callers keep the legacy filename
`.github/workflows/claude-fallback-review.yml`, avoiding duplicate legacy triggers.

Personal Manager prohibits PR-triggered secrets. Its default-branch config
`.github/advisory-ai-review.json` is
`{"trigger":"workflow_run","workflows":["CI"]}`. Its review starts independently
after trusted CI completion and reads no CI artifact or PR code. The reconciler
preserves this choice. Neither CI nor deployment waits for its review.

Six-hour onboarding is separate from review dispatch. It needs a scoped
`AI_REVIEW_ADMIN_TOKEN`, or `AI_REVIEW_APP_ID` plus `AI_REVIEW_APP_PRIVATE_KEY`.
The latter mints fresh short-lived installation tokens. An App installed on all
managed owners' repositories covers future selected repositories. Protected
branches receive normal PRs, without policy bypass. The dispatcher credential
alone cannot onboard or edit workflows, and no such permission should be added
solely for code review. Unknown pre-existing AI gates still need an audit.

## Verification and observed limitations

On 2026-11-15, a native request from `github-actions[bot]` received no response
in the test window. A separate request from connected user `digitronics2025`
was acknowledged, completed on the exact tested head and posted a review receipt
in control-repository PR #20. This verifies the native subscription review route,
not the unconfigured scheduled credential. No paid model API was used.

The end-to-end test in control-repository PR #21 then exercised the released
Claude runner returning UsageLimit, its trusted pending marker, the actual broker
requesting a native review as the connected GitHub user, and Codex completing
that exact head. A second broker run posted zero requests. The broker used the
setup session’s existing GitHub user authorization for this one test; scheduled
operation still requires CODEX_REVIEW_GITHUB_TOKEN in the hub. The 39 focused
tests passed in GitHub Actions run 43753670043.

Persistent automation was then activated with the owner-saved GitHub user
credential. Actions run 43755495844 scanned all 42 repositories with zero access
errors, submitted one pending request, and native Codex completed PR #22 on the
exact tested head. Only one dispatcher request exists for that head. The
five-minute dispatcher is active; no OpenAI or Anthropic API key is used.
This verifies the stored credential in Actions, not only the setup session.

Focused tests cover primary success, errors, quota, timeout, pending fallback,
second-opinion opt-in, no paid API calls, fork isolation, lost-job recovery,
spoofed-marker rejection, stale heads, native deduplication, GitHub user identity,
and absence of an automation credential. Run:

    python3 -m unittest discover -s scripts/ai_review -p 'test_*.py' -v

The manual verification workflow runs these tests in GitHub Actions. Independent
normal builds and security checks remain mandatory; their failures must not be
suppressed to make this review configuration appear green.
