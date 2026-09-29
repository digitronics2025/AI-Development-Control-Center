## Deploys — READ FIRST
- **Not connected to Workers Builds — deployed by hand.** Workers: `acc-cloud-control` (production) and `acc-cloud-control-staging`. Pushing to `main` does NOT deploy. After a manual deploy, check the live URL answers.
- GitHub Actions is OFF.
  Do not add deploy steps to Actions.
- Local direct release (only when asked or builds are broken): `pnpm cloud:deploy:staging`, then `pnpm cloud:deploy:production`.
  Rollback: `npx wrangler rollback`.
- Cloud sessions: never run `wrangler deploy`; ask the owner to deploy.
- Never print or commit secret values. Secrets live in Cloudflare.

<!-- BEGIN operator-conventions: regenerated from digitronics2025/claude-config -->
## Reply contract — every task-closing reply

End every task-closing reply with these three, in order, nothing after:

1. **Plain recap**, 3 sentences, no paths/hashes/jargon ("saved" not "commit",
   "sent live" not "deploy"); shipped work may use the five-part form
   (changed / was wrong / before→after / gain / next), ~180 words.
2. **Grandma summary**, 2-4 plain sentences, no tool, file or product names —
   what it means for the shop. Unverified stays unverified.
3. **What you need to do** — numbered steps naming the exact button and what
   they should see, or exactly `Nothing — you're all set.` Never empty, never
   "just". Anything the user must do goes ONLY here.

"skip recap" silences 1 and 2; 3 stays. Not for technical answers, code, plans or
commit messages.

Prefer **maintainable > scalable > secure > production-ready > sustainable**.
Never report unverified work as done: checked, not verified, or could not check.
Update the doc owning a behaviour in the same commit. Never commit a secret.
Only this repo's tracked files and account-level skills reach a session off the
operator's PC — never point at `~/.claude/...` or `C:\Users\...` unmarked.

**Merge your own PR once it is green — without asking.** Operator's standing
order (2026-09-29), every repo and session. Merge a PR you opened or were asked to
drive as soon as the repo's own gate passes (lint, tests, any guard script), no
real check is red or pending (Actions checks that can never run do not count), it
merges cleanly, and no bot review is still running or blocking finding open.
Otherwise fix it or report. Never merge a red, untested or conflicted PR, one that
needs a manual step first (remote migration, secret, Worker deploy), or one you
only watch. Where a merge deploys to production, say so in the reply.

Conditional rules (branch model, approval, autopilot, machine-bound skills):
[digitronics2025/claude-config](https://github.com/digitronics2025/claude-config)
<!-- END operator-conventions sha256:cb67eddf5ab0 -->
