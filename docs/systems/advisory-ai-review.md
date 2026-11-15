# Advisory AI review

The independent review workflow never gates merging, releases, or deployment.
Claude is primary. Codex runs once on Claude error, timeout, quota, authentication
failure, or an incomplete response. A PR labelled `ai-second-opinion` **before its
head is reviewed**, or a manual dispatch with `second_opinion=true`, also runs
Codex when Claude reports findings. Findings are ordinary comments, never
`REQUEST_CHANGES` reviews. Existing human approvals, builds, tests and security
controls remain mandatory.

## Distribution and onboarding

The public reusable workflow is callable from both public and private repositories.
Callers and the trusted runner are pinned to immutable commits. The fleet keeps
the existing caller filename `.github/workflows/claude-fallback-review.yml` so no
second legacy trigger remains. Do not add AI jobs to required status checks,
required workflows, deployment `needs`, release conditions, or merge scripts.
Passing a job with `continue-on-error` is insufficient if a merge script still
waits for its completion: remove that dependency too.

The scheduled `advisory-ai-onboarding.yml` reconciles every six hours. It reads
`scripts/ai_review/workflow-version.txt` for the released workflow SHA, so updating
the hub's own caller does not cause a pin-update loop. It uses only
`AI_REVIEW_ADMIN_TOKEN`, never provider credentials. It scopes user tokens to
repositories with admin or maintain permission, including organizations. Set
`AI_REVIEW_OWNERS` to a JSON array to narrow this scope. For an installation token,
set `AI_REVIEW_AUTH_MODE=installation`; the selected installation repositories are
the authorized scope. A GitHub App must be installed on **all repositories** to
include future repositories. An external token broker must refresh installation
tokens before scheduled runs; a static installation token expires in about an
hour. Alternatively use a fine-grained PAT scoped to the managed owners with
Contents and Workflows write, Pull requests write, and metadata read. Organization
SSO or owner approval may restrict installation and repository access.

If no administration token is configured, the scheduled job reports that onboarding
is unavailable. A missing token does **not** mean future repositories are covered.
Run `python3 scripts/ai_review/onboard.py --workflow-sha SHA` for a dry run; add
`--apply` to update callers. Protected defaults receive ordinary PRs, preserving
required CI and human approvals. The scheduled reconciler distributes callers;
it does not silently remove pre-existing merge gates or change repository policies.

## Credentials

Set only explicit provider secrets on each personal repository or eligible
organization repositories: `ANTHROPIC_API_KEY` (preferred) or existing
`CLAUDE_CODE_OAUTH_TOKEN`, and `OPENAI_API_KEY` for the Codex fallback. Missing
secrets are permitted at workflow startup and recorded as unavailable. Subscription
Codex bot settings and ChatGPT login tokens are not OpenAI API credentials.
Never copy a short-lived session token into an automation secret. Credential
creation and custody follow the owner's existing vault policy.

Optional repository variables `CLAUDE_REVIEW_MODEL` and `CODEX_REVIEW_MODEL`
override the defaults (`claude-sonnet-4-5` for the API, `sonnet` for the Claude
subscription CLI, `gpt-5.2-codex` for Codex). Verify availability for the account.
No provider success or live failover is established by simulated tests.

## Isolation, cost and availability

`pull_request_target` uses the trusted base workflow. **Never check out PR code**
in this workflow. Only the immutable public reviewer is checked out, with checkout
credentials disabled. Same-repository PR diffs are API data; fork and Dependabot
PRs are skipped. No repository scripts, instructions, packages, MCP servers, or
hooks run. The Claude CLI gets a private temporary home, no tools, no hooks, no
MCP servers and no GitHub token or secondary provider key. API models have no tools.

One active review job per repository bounds concurrent provider use. GitHub may
coalesce pending reviews; skipped reviews remain advisory. Across repositories,
GitHub's account runner and provider quotas still apply; there is no account-wide
distributed semaphore. AI and production workflows never share a concurrency group
or deployment environment. Hosted runner capacity remains a shared GitHub account
resource, so absolute zero scheduling contention requires separate runner capacity.

A bot-authored claim is persisted per PR head **before** provider execution. Reruns
and cancellation never repeat requests for that head. An interrupted claim can
leave no result; it never blocks merging. An owner can delete the claim explicitly
to authorize another paid attempt. Each provider is invoked at most once by the
runner; there are no application retries. Claude CLI's internal transport behavior
is also bounded by its process deadline. Provider HTTP calls have 75-second limits;
the CLI gets 45 seconds for installation and 90 for review. The review process has
a 300-second deadline, a six-minute step limit, and a seven-minute job limit.
Only a partial diff (48,000 characters maximum) is reviewed, with bounded output.
This reduces cost but cannot prove the absence of bugs elsewhere in the code.

## Verification

`python3 -m unittest discover -s scripts/ai_review -p 'test_*.py' -v` tests provider
selection and errors, timeouts, unavailable credentials, deduplication, untrusted
PR isolation, advisory negative findings, and protected onboarding without bypass.
The manual `advisory-ai-review-verify.yml` runs these tests in GitHub Actions.
Repository verification must separately inspect actual protection settings, all
merge scripts and deployment workflows; unit tests do not prove a live deployment.
