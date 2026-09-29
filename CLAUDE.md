## Deploys — READ FIRST
- **Not connected to Workers Builds — deployed by hand.** Workers: `acc-cloud-control` (production) and `acc-cloud-control-staging`. Pushing to `main` does NOT deploy. After a manual deploy, check the live URL answers.
- GitHub Actions is OFF.
  Do not add deploy steps to Actions.
- Local direct release (only when asked or builds are broken): `pnpm cloud:deploy:staging`, then `pnpm cloud:deploy:production`.
  Rollback: `npx wrangler rollback`.
- Cloud sessions: never run `wrangler deploy`; ask the owner to deploy.
- Never print or commit secret values. Secrets live in Cloudflare.
