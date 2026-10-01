# Cloudflare cost cut round 2 claims

Last verified: 2026-10-01. Production savings remain unmeasured; manual Worker release is pending. No deployment or production configuration change is authorized from this container.

| Item | Plan baseline | Proof the morning after deployment | State |
| --- | --- | --- | --- |
| C1 | D1 acc-control-production 50–85K writes/day; node_repositories replacement ~80%; expected −1.5–2M/month | D1 query analytics: unchanged snapshot upserts/deletes have rowsWritten=0; new/changed/gone rows still write. SELECT node_id,local_id,name,fingerprint,updated_at FROM node_repositories ORDER BY node_id,local_id LIMIT 100 preserves the complete current inventory. Workers Logs confirm valid snapshots still synchronize. | Prepared; manual release pending |

The repository's production wrangler config enables traces (0.1 sampling). “Workers traces off” is not confirmed; no settings were flipped. The production setting is not read through a configuration API because this task permits only GraphQL, Workers Logs and SELECT with LIMIT.
