# Enhancement roadmap — stronger, smarter, more services

Status: proposed · Written 2026-09-27 against `c74a9ec` · All 57 initiatives in detail: [CATALOG.md](CATALOG.md) · Owners: every system in [docs/systems](../../systems/README.md)

## 1. Goal

Make the Control Center:

- **stronger**: it keeps its promises when an agent misbehaves, a process crashes, a limit runs out or a machine goes offline;
- **smarter**: it learns from its own history and gives agents complete evidence instead of making them guess;
- **able to reach more services**: more agents, CI, forges, alert channels, deploy targets and MCP servers.

It must do all of this without breaking the non-negotiables in [PLAN.md §2](../../../PLAN.md) and [AGENTS.md](../../../AGENTS.md). No initiative adds a paid-API path. None moves workflow state to the cloud. None lets a remote surface skip the node's own approvals, and none weakens a guard without a test.

## 2. How this list was made

1. Nine readers mapped the code and docs, one per area: engine, Chairman/Ask/learning, agents and usage, tools, delivery, security, surfaces, quality and operations, and the backlog. They proposed 90 ideas. They also confirmed about 180 backlog items (Found for Later sections, proposed plans, audit findings) that are still open in the code.
2. Four cross-cutting reviewers (smarter, stronger, more services, autonomy) proposed 37 more ideas. The services reviewer checked the 2026 agent-CLI landscape on the web.
3. The 127 ideas were merged into 49 initiatives, and a completeness pass added 8 for areas nobody had covered.
4. A skeptical reviewer checked every initiative against the code at `c74a9ec`. It asked whether the gap is real, whether the named files exist, and whether the change keeps the repository's rules. None was already built. 53 were narrowed ("partly built, this is what remains") or reframed to fit a rule, and their first steps were rewritten to name exact files.

Each entry in [CATALOG.md](CATALOG.md) has:

- the verified gap, with `path:line`;
- two or three PR-sized first steps;
- an observable "done when";
- what must still be confirmed against real third-party tools.

## 3. Fix first: a bypass of the F-02 self-reference guard

This is a vulnerability, not an enhancement. It was confirmed while writing this plan.

- **What.** An agent's tool call is refused when its input names the Control Center's own address: `referencesSelf` (`packages/security/src/commands.ts:185-213`), called at `apps/orchestrator/src/tools/service.ts:462`. The check matches literal spellings only, so `http://127.1:4317/`, `http://2130706433:4317/` and `http://0x7f000001:4317/` pass it. Node's URL parser then turns all three into `127.0.0.1`, and the Host check (`apps/orchestrator/src/http/security.ts:68-71`) accepts that.
- **Why it matters.** `http.request` GET is Level 1, so it is auto-approved. The dashboard page at `/` carries the access token in a `<meta name="acc-token">` tag (`apps/orchestrator/src/http/server.ts:110`). The reply is redacted before the model sees it (`tool-routes.ts:257`). But `expectText` answers yes or no on the raw body (`packages/tools/src/packs/http.ts:72`), so a prompt-injected agent could recover the token one character at a time. It needs a misbehaving agent, which is exactly what F-02 exists to contain.
- **Fix.** Normalise every URL with `new URL(u).href` before the self-reference check and on `guardedFetch`'s first hop, and match the loopback forms (127/8 shorthand, decimal, hex, octal, `::ffff:127.0.0.1`), with tests in both directions. This is step 1 of **SEC-1**.

Two related gaps were also confirmed in the code:

- Claude Code's own Read runs at every level with no path rule, and its own Bash is allowed from Level 2 (`packages/agent-claude/src/index.ts:88, 136-146`). Neither passes through the Control Center's classifier. This is the open part of F-02, and **SEC-3** addresses it.
- The Claude billing tripwire aborts only when the CLI reports an API-key source (`index.ts:480-483`). A missing field passes. The pre-run auth probe and the stripping of API variables still apply, so this is a defence-in-depth gap. **AGT-2** makes the tripwire fail closed once `verify:agents` shows that the real CLI always sends the field.

## 4. The short list

If only a handful get built, build these.

| | Code | What | Why |
|---|---|---|---|
| Stronger | SEC-1 | Close loopback-alias and exfiltration gaps; scan and gate `git.push` | The bypass above. Also, uploads such as `curl -F file=@.env` and download-then-run across two commands are classified Level 2 today, and `git.push` sends commits without a secret scan |
| Stronger | SEC-3 | Guard Claude's native tools and choose the agent OS boundary | The largest remaining hole in F-02 |
| Stronger | SEC-2 | Repository trust scan and fenced external content | A cloned repository can ship agent hooks. Web pages and issue text reach agents unfenced |
| Stronger | AGT-1 | Respect usage limits: refuse launches on an exhausted agent, auto-resume after the reset | Tasks wait for a manual Resume, and background work drains the same window first |
| Stronger | AGT-2 | Adapter conformance kit and fail-closed billing checks | Needed before any third agent can be added safely |
| Smarter | VER-2 | Complete failure and review evidence for the fix loop | Fixers see 80 lines of one failed command. Give them every failing test with its message and first project frame |
| Smarter | DEC-1 | Environment-aware recovery | A stopped database is treated as a code bug and burns fix cycles |
| Smarter | MEM-3 | Repository memory: related past tasks, files that change together, known fixes, a prompt budget | Every task starts from zero today |
| Smarter | DEC-3 + DEC-4 | Routing advisor, fed by what really happened to the task's commits | Turns the ledger the product already keeps into better defaults, measured against reverts and re-fixes rather than "the reviewer said PASS" |
| Smarter | VER-5 | Plan contract: declared proofs the orchestrator runs itself, plan coverage, plan-caused rerouting | The planner names proofs that nothing runs |
| More services | DLV-3 | GitHub CI feedback into the fix loop, and a pull-request release method | Repositories with a protected `main` cannot be released at all |
| More services | NTF-1 | Cloud Web Push, a node-offline watchdog, pluggable alert channels (ntfy, Slack/Discord/Telegram webhooks) | If the desk PC dies mid-task, nothing reaches the phone |
| More services | INT-1 | Start later, priorities, task recipes, capped automations | Recurring maintenance is retyped by hand |
| More services | AGT-4 | Third agents: a guarded local model first, then Antigravity and Copilot CLI | With Codex out of credits, everything rides on one Claude plan |
| More services | INT-2 | MCP tools agents can actually use: real input schemas, images, a vetted server catalog | Registered MCP tools reach agents with a generic input, so they guess |
| More services | REL-3 | Always-on Linux execution node | Tasks sent from the phone need the Windows PC switched on |

## 5. Tiers

**Now** closes verified holes and fixes the feedback loop. Every item's first step is small.
**Next** makes the loop smarter and adds the main services.
**Later** holds the larger bets and the items that depend on Next.

Within **Next**, the smarter work and the services work touch different code and can run side by side.

### Now (12)

Stronger:

- **SEC-1** Close loopback-alias and exfiltration gaps; scan and gate `git.push` (M, impact 5)
- **SEC-3** Guard Claude's native tools. Steps 1-2 now: move worktrees out of the data folder, deny the secret files and the API port, and add a fail-closed Bash precheck hook. The OS-boundary decision follows (XL, impact 5)
- **SEC-2** Repository trust scan and fenced external content for agents (L, impact 5)
- **SEC-4** Host-bound credentials and outbound secret checks on the tool door (L, impact 4)
- **VER-1** Secret scan at every task commit, plus a security scanning pack (M, impact 4)
- **AGT-1** Respect usage limits: admission, auto-resume at reset, Codex parity (L, impact 5)
- **AGT-2** Adapter safety kit and fail-closed billing checks (L, impact 4)
- **OPS-1** Operations safety net. Step 1 now: a daily online backup with an integrity check, plus a restore script (L, impact 4)

Smarter:

- **VER-2** Complete failure and review evidence for the fix loop (L, impact 4)
- **DEC-1** Environment-aware recovery: stop fixing code when the environment is broken (L, impact 4)
- **DEC-2** Chairman "try harder" step: raise effort or model before re-planning. This matters most while only one agent works (M, impact 3)
- **UX-1** Enforced directives from every surface, in French too (M, impact 4)

### Next (26)

Smarter:

- **MEM-3** Repository memory: past tasks, co-change, known fixes, prompt budget (XL, impact 4)
- **MEM-1** Learning that targets the right stage and measures honestly (M, impact 4)
- **MEM-2** House rules: operator constraints that persist across tasks (M, impact 4)
- **DEC-3** Routing advisor, in recommendation mode first (L, impact 4)
- **DEC-4** Outcome labels after completion, and cross-task recovery priors (L, impact 4)
- **VER-5** Plan contract (XL, impact 4)
- **REL-1** `checks.run` for agents, pnpm/yarn/Jest narrowing, an early commit-hook probe (L, impact 4)
- **VER-3** Test adequacy: do the new tests fail without the change? (L, impact 4)
- **VER-4** Repository test health: readiness check, main-branch sentinel, flaky ledger (L, impact 4)
- **INT-3** Follow-up backlog from agents' Found for Later notes (M, impact 3)

Stronger:

- **SEC-5** Assume-breach security regression suite, as a ratchet (M, impact 4)
- **SEC-6** New-dependency check: age, install scripts, advisories, look-alike names (M, impact 4)
- **AGT-3** Stop runaway runs, and budgets that ask instead of stopping (L, impact 4)
- **REL-2** Run isolated tasks side by side safely, with a dynamic App check port (L, impact 4)
- **VER-6** Live smoke tests for the tool packs that were never run against real services (M, impact 3)
- **OPS-2** Discard drafts, archive tasks, show what storage holds (M, impact 3)

More services and reach:

- **DLV-3** GitHub CI feedback and pull-request releases (XL, impact 4)
- **DLV-1** Release safety net: check before asking, smoke after, one-step rollback (L, impact 4)
- **DLV-2** Landing task work: merge-back, fresh bases, early "target moved" warnings (L, impact 4)
- **NTF-1** Cloud Web Push, node-offline watchdog, pluggable alert channels (L, impact 4)
- **NTF-2** One-tap answers for "needs your decision" blockers (M, impact 3)
- **UX-2** Gate preview, up-front approvals, remembered consent (L, impact 5)
- **INT-1** Start later, priorities, recipes, capped automations (L, impact 4)
- **INT-2** Usable MCP tools and a vetted server catalog (L, impact 4)
- **AGT-4** Third agents: local model first, then Antigravity and Copilot CLI (XL, impact 4)
- **REL-3** Always-on Linux execution node (L, impact 4)

### Later (19)

- Smarter:
  - **DEC-5** evaluation and replay;
  - **DEC-6** New Task advisor;
  - **DEC-7** Goals (one request becomes linked, ordered tasks);
  - **AGT-5** curated skill sets per role;
  - **UX-4** smarter Chairman chat, more Ask analytics, Ask from the phone.
- Stronger:
  - **VER-7** an App check that really runs more app types and signed-in pages;
  - **SEC-7** a security audit trail with who acted from the cloud;
  - **SEC-8** a security posture page and credential lifecycle;
  - **REL-4** tool failures that explain themselves;
  - **REL-5** crash-safe resume for calls whose outcome is unknown;
  - **NTF-3** cloud mirror anti-entropy and capacity-aware node choice.
- More services:
  - **DLV-4** more ways to go live (Worker direct deploy, registries, stores), with the publish side door closed;
  - **DLV-5** releases for multi-repository tasks;
  - **VER-8** disposable test databases per task;
  - **INT-4** design and document links as frozen context (Figma, Notion);
  - **INT-5** issue-linked tasks, GitHub first behind a neutral `tracker.*` seam;
  - **INT-6** GitHub intake of labelled issues and red main-branch runs;
  - **UX-3** line comments on a task's changes, and follow-up tasks;
  - **UX-5** start and approve tasks from VS Code, a terminal and the phone share sheet.

## 6. Order and dependencies

- **AGT-2 before AGT-4.** A third agent must pass the shared conformance kit.
- **REL-1 → VER-3 → DEC-5.** Test adequacy reuses `checks.run`. The eval harness uses fail-to-pass as its oracle.
- **DEC-4 feeds DEC-3, VER-2's reviewer calibration and DEC-5.** Outcome labels are the ground truth the other "smarter" work is measured against.
- **DLV-2 before DEC-7, UX-3 and DLV-5.** Goals, follow-up tasks and multi-repository releases need merge-back and fresh bases.
- **DLV-1 before DLV-5.** Rollback and prechecks come first.
- **VER-6 before DLV-4, DLV-1's rollback and VER-8.** Those build on pack operations that have only been tested against stand-ins.
- **OPS-2 before INT-1, INT-3, INT-6 and DEC-7.** They create drafts in bulk, and today a draft cannot be discarded.
- **AGT-1 before INT-1.** Automations must skip firing while an agent is capacity-blocked.
- **SEC-3 before the rest of SEC-4.** Host-bound credentials cover the tool door. Claude's native shell stays out of reach until SEC-3.
- **SEC-4 → INT-5 → INT-6.** Issue and CI data are untrusted input and must go to the right host with the right token.

## 7. Decisions for the operator

1. **Agent OS boundary (SEC-3).** The options are a separate low-privilege Windows account for agent runs, Claude Code's native sandbox, or making Codex's sandbox the only runner at Level 2 and above. Until one is chosen, the permission rules and the Bash precheck hook are the guard.
2. **Which third agent (AGT-4).** A local model on `127.0.0.1` is the only option with no billing risk, and it covers light roles only (reports, commit messages, learning reviews). The services review cited two changes: Google moved personal logins from Gemini CLI to Antigravity CLI on 2026-06-18, and GitHub Copilot moved to usage-based credits on 2026-06-01. Confirm both before building. Copilot counts as subscription-only only when a $0 additional-spend budget can be proven.
3. **Alert channels (NTF-1).** Choose which of ntfy, Telegram, Slack and Discord to support. Also decide whether cloud Web Push is wanted, given that iOS supports it only for installed PWAs.
4. **How much background work may spend (AGT-1, INT-1).** Automations, goals, learning reviews and the Chairman share the 5-hour and weekly windows. Choose a cap per window.
5. **Parallel tasks (REL-2).** The per-repository limit stays at 1 unless raised.
6. **Always-on node (REL-3).** Decide where it runs (a small server or a home box). It needs its own signed-in CLIs on subscription billing.

## 8. Smaller gaps the completeness pass reported

These came from the completeness pass. They have not been checked one by one, so verify each before planning it:

- Test reports in JUnit, TRX, `go test -json` or cargo JSON are never read, and pytest, go and cargo runs are never narrowed.
- Source Control has no discard or restore, hunk staging, stash, revert, cherry-pick, or branch create, switch and delete. Merge-back (DLV-2) is the only one planned.
- Other Git hosts (GitLab, Bitbucket, Azure DevOps) and deploy targets (Vercel, Netlify, Fly.io) are missing, and the clone shorthand assumes github.com.
- Nothing adds up delivery metrics across tasks: lead time, first-pass READY rate, fix cycles and time spent waiting for approval.
- Nothing paces use of the weekly allowance. AGT-1 only reacts once a window is exhausted.
- The Codex adapter keeps only its last `agent_message`, and the verifier's "Remaining limitations" never reach the final report.
- Task titles come from the first sentence of the description, which gives poor branch names.
- Stage Teams follow-ups are still open: rerouting or retrying one work unit, and team size tuned by the learning loop.
- Chairman prompts are code constants, not versioned templates like the role prompts.
- Cloud artifacts are not end-to-end encrypted. `user_shared` has no "Share to cloud" action, and there is no published API contract for integrators.
- This repository's own CI attaches dashboard screenshots without comparing them against a baseline.
