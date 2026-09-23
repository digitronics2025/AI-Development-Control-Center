---
system: recovery
sources:
  - packages/tools/src/recovery.ts
  - apps/orchestrator/src/engine/runners.ts
  - apps/orchestrator/src/engine/tooling.ts
verified_at: 351db1e
---

# Recovery

Two layers with separate jobs:

- **Tool level** (this doc): the environment broke, not the code — repair it
  and run the same check again, a bounded number of times.
- **Stage level** ([chairman.md](chairman.md)): the code or the plan is wrong
  — fix loops, strategy changes, re-plans, rollbacks.

## Classification ([recovery.ts](../../packages/tools/src/recovery.ts))

`classifyFailure(outputLines)` returns the first matching category and the
line that decided it:

| Category | Recognised by | Repair |
|---|---|---|
| `missing_browser` | Playwright "Executable doesn't exist" | `npx --yes playwright install chromium` |
| `port_conflict` | `EADDRINUSE …:port`, "port N is already in use" | stop **this task's own** process on that port; someone else's is left alone and named |
| `missing_dependency` | Cannot find module/package, ERR_MODULE_NOT_FOUND, Vite/webpack resolve errors, outdated lockfile, ModuleNotFoundError | locked install with the repo's package manager, then an unlocked one (may update the lockfile); `pip install -r requirements.txt` for Python |
| `missing_command` | "not recognized as an internal or external command", "command not found" | install, only when the binary belongs to a declared dependency or `node_modules` is missing |
| `transient_network` | ECONNRESET, EAI_AGAIN, ETIMEDOUT, socket hang up, registry 5xx | wait 2 s, then 4 s |
| `file_lock` | EBUSY, EPERM on rename/unlink, "used by another process" | same backoff |
| `rate_limit` | 429 / rate limit | wait 15 s once |
| `auth_failure`, `timeout`, `test_failure`, `build_failure`, `unknown` | — | none: these go to the fix loop / Chairman |

## In test stages ([runners.ts](../../apps/orchestrator/src/engine/runners.ts))

When a command fails, the engine classifies its last 80 lines and, with
Settings → Execution → *Repair environment problems* on, applies repairs up
to `maxRepairAttempts` (default 3) per command per stage run. A repair that
fails hands over to the next strategy (locked install → unlocked install);
only a successful repair re-runs the command. Each attempt is a
`recovery_attempts` row, a `RECOVERY_ATTEMPT` event and a `recovery`
realtime message; install repairs appear as their own log and test-run rows.
A command that passes after a repair says so in its summary
("… (after repair: Install the project's dependencies …)").

## Verified

Integration test: a repository whose test needs a `file:` dependency that is
not installed fails, `npm ci` fails for lack of a lockfile, `npm install`
succeeds, the test is re-run and passes, the task completes.

Last verified: 2026-09-23
