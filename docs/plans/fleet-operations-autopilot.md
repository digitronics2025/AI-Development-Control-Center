---
title: Durable fleet operations and verified recovery for Dot
source: conversation 2026-10-09, approved fleet operations plan
created: 2026-10-09
status: in-progress
---

# Durable fleet operations and verified recovery for Dot

> Current acceptance, 2026-10-10: bounded monitor and owner Operations UI source
> are saved on main; full local checks and affected browser journeys passed.
> Messenger PR 47 merged, and its main build passed 3,210 tests before the new
> migration cost gate rejected unreviewed 0202/0203. No new production release
> is verified. Network-capable authorized Control Center release, actual billing/source
> bounds, connected execution node, authenticated new capabilities, native
> canary proof and elapsed 48-hour/seven-day windows remain required. See the
> current [fleet system map](../systems/fleet-operations.md#registration-and-release)
> and [Messenger release evidence](https://github.com/TenTen-maroc/whatsapp-inbox-saas/blob/main/docs/plans/fleet-supervision/release-evidence.md).

## Context

I would extend your existing AI Development Control Center to supervise your apps, with Dot as the assistant that explains what is happening and follows investigations. Messenger would supply notifications, each app would provide its recovery controls, and the Control Center would manage investigations, code fixes and verification.

I reviewed your app contracts, operational documentation, source code and recent fixes. The patterns below are documented problems and recent repairs; I haven’t measured their current frequency from fresh production logs. I made no changes.

One important discovery: the Control Center already has a Chairman supervisor. It manages task recovery, checkpoints, repeated failures and completion checks. We should build on that existing behavior.
Another matters for unattended operation: its cloud service currently relays work to a paired machine; it does not execute code repairs itself.

### 1. Create one reliable inventory of your apps.

Extend the Control Center’s app registry to record each app’s repository, production services, dependencies, notification bots, health checks, scheduled jobs, recovery actions and release method.
This must distinguish a website from its separate scheduler Workers. Accounting is a clear example: releasing its website does not prove that its schedulers were deployed or configured.
Record actual runtime schedules. Some older fleet documents still mention five-minute inventory synchronization, while the current Sales Analyzer code uses fifteen minutes. The supervisor must use the current configuration when deciding that a report is overdue.

### 2. Keep monitoring running independently of an open chat.

Add continuous operations monitoring to the Control Center’s cloud service, using durable storage for incidents, evidence and pending actions.
Apps should publish operational events through a durable delivery mechanism. Messenger receives the readable notification; the operations service receives the information needed to investigate it.
Dot can then explain and coordinate the work through supported tools. Monitoring and incident records continue even when your phone is closed.

### 3. Detect both reported failures and missing activity.

Use immediate operational events for failures, supplemented by a lightweight five-minute check of due deadlines, unresolved incidents and critical service availability.
Preserve each app’s existing job cadence. Monitoring should inspect activity without repeatedly rerunning jobs or scanning entire databases.
This addresses a real weakness documented in Accounting: a scheduler missing its credential can fail before contacting the app, leaving no application error log. Only deployment checks and missing heartbeats reveal it.
If evidence cannot be read, report “monitoring unavailable”. An empty log does not establish health.

### 4. Classify the problem before acting.

Separate technical failures, expected pauses, policy holds and business warnings.
For example:
An unanswered, bot-owned customer question can require recovery.
A conversation handed to staff requires staff attention.
An uncertain message-send outcome requires delivery investigation.
A message-budget hold requires a policy decision.
A cheque-coverage warning requires financial verification.
The accounting alert about money needed for cheques belongs in your business-attention report. It should not trigger an automatic attempt to alter balances or payment records.

### 5. Create one investigation for each underlying problem.

Group alerts by app, affected resource, operation and failure signature. Repeated notifications update the existing incident’s occurrence count and evidence.
Correlate failures across dependencies. If Accounting becomes unavailable and both Sales Analyzer and the website report synchronization failures, investigate the shared dependency together.
Use a clear lifecycle:
Detected → Investigating → Recovering → Verifying → Resolved
Include explicit Waiting for execution machine and Needs owner decision states.
My default recurrence rule would be: a problem returning three times within seven days triggers a prevention investigation, even if routine recovery keeps succeeding.

### 6. Create investigation tasks in your existing Control Center.

Each actionable incident gets a linked task containing the original alert, current evidence, affected apps, investigation history, repair attempts and resolution.
Its task conversation becomes the place where the investigation lives. Dot gives you the summary and a link.
This delivers the separate investigation you requested using task creation that already exists in your Control Center. Creating a separate native Dot chat remains an additional capability to verify.
Investigations should check current logs, job history, deployment changes, configuration readiness and downstream effects before proposing a repair. Notification text supplies evidence; it does not authorize commands.

### 7. Use app-specific recovery procedures.

Each procedure must have preconditions, a scoped action, an attempt limit and a verification step.
Your apps already implement several of these mechanisms. The supervisor should invoke them through scoped operations.
Long-running backup work must execute through a suitable background job. Your documentation records approximately thirty-second limits on HTTP background work, so a “Run now” request alone cannot establish that a large backup completed.

### 8. Send recurring bugs through a complete code-repair workflow.

When routine recovery is insufficient, the Control Center starts a source-code investigation:
Reproduce → Diagnose → Implement → Review → Test → Release → Verify production
Use isolated working folders and the existing repository locks. Cross-app changes must include both sides of the contract and the required release order.
Follow each repository’s actual release process. Some use Cloudflare Workers Builds, Accounting uses Pages plus separate Workers, and some projects require a supported manual release path.
Preserve the existing permission and release gates. Configure standing authorization through supported controls so routine approved work can proceed automatically.
Bound repair attempts. After two unsuccessful repair strategies, record what was tried and escalate with evidence.

### 9. Require proof before reporting “fixed.”

A successful retry is recovery. A demonstrated cause and a tested change are stronger evidence that recurrence has been prevented.

### 10. Give you concise reports at useful moments.

Notify you when an important problem is confirmed, when meaningful recovery occurs, when work is blocked and when resolution is verified.
A report should answer:
What happened? Which app was affected? What did we check? What changed? What proves recovery? What still needs attention?
The existing daily review should combine business updates, open incidents, completed repairs and recurring problems. It should refresh all available bot chats every run.
Keep notification delivery reliable too. Monitor Messenger and the supervisor independently, and provide a configured owner email or phone-notification fallback for critical outages. Existing deliberately disabled customer-notification channels should retain their settings.

### 11. Make future apps join automatically.

Existing new bot chats already become available to the reader automatically.
Full operational supervision needs more information. Add an app-registration contract to the app-creation workflow containing its identity, health checks, job schedules, notification source, dependencies and permitted recovery procedures.
I found that Messenger’s current notification ingestion uses a fixed list of source applications. Future implementation should replace that limitation with a validated registry, while preserving existing integrations and per-app authentication.
Newly registered apps start with automatic discovery, monitoring and investigation. Automatic repairs become available through verified recovery procedures. New reporting groups retain their separate consent requirement.

### 12. Provide dependable execution and control costs.

Cloud monitoring and supported app recovery jobs can continue without your personal PC.
For code investigations, use the existing Control Center on a dedicated execution machine that stays available. When it is offline, incidents remain visible and tasks remain queued; stale actions must be revalidated before execution resumes.
Use deterministic checks first and invoke AI for investigations that need reasoning. Respect existing app budgets, limit concurrency and record investigation costs. Increased checking should not recreate the database congestion already documented in your website.

### 13. Roll it out in a deliberate order.

Start by auditing the deployed services, credentials’ readiness, current schedules and existing monitors. Preserve the customer-reply monitor already documented in Messenger.
Then implement:
- registry/incidents/event delivery/read-only evidence
- automatic investigations for Messenger, AI and backups
- verified recovery procedures
- accounting/sales integration recovery
- code-repair execution/production verification
- registration/monitoring of remaining apps

Product Hunter, Rihla, Applybridge and your other projects join according to verified deployment status and available operational interfaces. Desktop and phone apps need device-health reporting; expected offline behavior must be respected.
Before enabling repairs broadly, prove the workflow with controlled failures: a missing heartbeat, duplicate alert, unavailable AI provider, uncertain message outcome, failed backup mirror, offline execution machine and unsuccessful release.

The resulting system would give you automatic detection, a persistent investigation, controlled recovery and an evidence-based report. This is the implementation plan; the new supervision and repair workflow has not yet been built.

## Steps

- [x] 1. Register apps and runtime contracts — done when: validated identities, dependencies, release methods and real schedules are stored — check: `pnpm cloud:test -- operations`
- [x] 2. Durable monitoring and delivery — done when: incidents and retryable deliveries survive restart — check: `pnpm cloud:test -- operations`
- [x] 3. Missing activity and service monitoring — done when: indexed bounded due checks distinguish unknown from healthy — check: `pnpm cloud:test -- operations`
- [x] 4. Classify failures and business attention — done when: financial, staff, budget and uncertain-send alerts never authorize repair — check: `pnpm cloud:test -- operations`
- [x] 5. Deduplicate and correlate investigations — done when: repeats update one incident and recurrences escalate — check: `pnpm cloud:test -- operations`
- [x] 6. Link existing task investigations — done when: typed commands preserve leases and offline safety — check: `pnpm cloud:test -- operations`
- [x] 7. Scoped app recovery — done when: bounded procedures check native preconditions and verify effects — check: `manual: app adapter contract and recovery tests`
- [ ] 8. Code-repair workflow — done when: tasks enforce stages, attempt limits and existing release gates — check: `manual: task integration tests and production node readiness`
- [x] 9. Evidence before resolution — done when: untrusted or old evidence cannot resolve incidents — check: `pnpm cloud:test -- operations`
- [ ] 10. Owner reporting and fallback — done when: incident changes reach owner and daily review includes all bots — check: `manual: real owner report and scheduled review configuration`
- [x] 11. Future apps and bots — done when: validated registration includes new sources without weakening group consent — check: `manual: source registration and authorization tests`
- [x] 12. Bounded costs and offline execution — done when: limits, indexed plans, concurrency and stale-action guards are tested — check: `pnpm cloud:test -- operations`
- [ ] 13. Controlled rollout — done when: failure scenarios pass and intended production versions and outcomes are observed — check: `manual: deployed version, downstream probes and failure matrix`

## Tail

- [x] T1. Adversarial review — done when: findings fixed or recorded — check: `git diff --stat` reviewed hunk by hunk
- [x] T2. Similar-issue sweep — done when: related auth, outboxes and query paths checked — check: `manual: Ledger sweep results`
- [x] T3. Full applicable checks — done when: repository check passes — check: `pnpm check`
- [x] T4. Documentation — done when: owning system docs and follow-ups reflect behavior — check: `pnpm docs:guard`
- [x] T5. Scoped commit and push — done when: exact source revision is saved remotely — check: `git log origin/main..HEAD --oneline`
- [ ] T6. Live verification — done when: supported releases and downstream results verified — check: `manual: release receipts and runtime evidence`
- [x] T7. Downstream claims — done when: probe and deadline registered — check: `manual: docs claims entry`

## Ledger

- 2026-10-09 — Approved full autopilot with cost efficiency. No paid infrastructure or quota increases authorized. Preserve customer budgets and release gates. Repository main equals origin/main on entry.
- 2026-10-09 — Production node is offline (last seen October 3); Desktop Commander is also offline. Finish cloud and independent work; code execution proof must remain explicitly blocked until a real node runs it. No simulated node is production proof.
- 2026-10-09 — Production Control Center is manually released, not Workers Builds. User explicitly authorized implementation, migration and release; preserve supported staged release sequence and authentication gates. Do not create GitHub Actions.
- 2026-10-09 — Available conversation context retained above; detailed recovery matrix and resolution criteria are expanded in the owning system documentation during implementation.

- 2026-10-09 — Steps 1, 2, 4, 5: actual Workers/D1 tests passed concurrent dedupe, restart persistence, source isolation, nontechnical decision-only handling and cost-budget rejection. Nine validated seed manifests; unsupported job receipts are not invented. Other steps remain open until their tests and runtime evidence exist.

- 2026-10-09 — Final local gates: Control Center full check 2,335 tests; Messenger full suite 3,102 tests plus affected-source, owner-scope and native recovery checks. Browser verification covered 83 journeys: 81 passed initially; two stale WebSocket test patterns were corrected and all four send-control journeys passed. No product UI behavior was changed to satisfy those mocks.
- 2026-10-09 — Added a per-tick 48-D1-statement ceiling (each batch statement counted), single-batch registry bootstrap, metadata-only unconnected jobs and permission inheritance. Actual local Workers tests prove pending investigations resume on later ticks without exceeding D1 Free; remote tasks inherit the machine's current ceiling rather than trying to raise it.
- 2026-10-09 — Accounting runtime inventory: 25 named Workers deployed, one print-agent Worker config absent. Actual schedules were read through Cloudflare; dispatcher/stocktake/Google Sheets/DR schedules differ from source. Registry records actual live cron metadata without changing those production schedules or the existing cost monitor's held baseline.
- 2026-10-09 — Unavoidable release verification blocker: runtime egress policy allows Cloudflare/GitHub APIs but not the control/relay/Messenger public domains. CONNECT 403 comes from the workspace proxy, not an app response. User authorized all available actions, but no runtime tool can edit the policy. Do not convert this into a successful smoke check or bypass the proxy.

- 2026-10-09 — Final suites: Messenger 3,103 passed, one existing skip, 274 files; latest affected tests 34 passed and OAuth protocol seven passed after replacing a hardcoded test-only secret with runtime randomness. Typecheck/lint/build/local migrations/DB wiring and clean-tree hygiene passed. Control Center full rerun passed 2,331 tests but one existing four-test upload suite timed out starting its fixture; targeted upload + operations rerun passed all 15 tests. Latest typecheck/lint/docs guard passed. The earlier complete full check passed 2,335 tests. Browser evidence is 81 full-run passes plus all four corrected send-control journeys, not an invented single green run.
- 2026-10-09 — Source failure matrix verified: concurrent retries/identity conflicts, native downstream delivery versus API acceptance, stale backup/ARK receipts, financial/budget/staff/uncertain-send classification, recurring prevention incident, dependency cycles, offline waiting, current test-node typed task, inherited permission ceilings, real local Worker restart, indexed candidate queries, bounded owner registry and future-bot dynamic reader discovery. A real production execution/release failure remains unprovable while the paired node is offline.
- 2026-10-09 — Installed purpose-specific bridge/reader/registration/health/recovery/owner-notification credentials in Control Center production and Messenger, plus health and an independent read-only summary credential in staging. Values generated in memory and stored only in Cloudflare. No legacy sender/session key rotated. Saved pre-change deployment versions: Control Center 570631aa-118a-442b-bb09-a918aaeedbdd; staging dd2d1507-2224-4a36-81a6-23a1b3e73e61; Messenger 6df8566e-58ef-425c-b82c-9301eb7a4b6f. Secret bindings alone are not a source release or a successful handshake.
- 2026-10-09 — Owner onboarding supports the existing Access broker so clients need not retain the cross-service master key. Future producers receive only their individual credentials. CLI verifies producer secret names and fails if an earlier lost response left credentials missing; it never silently rotates them. Existing legacy bots are reused by the trusted owner provisioner without new impersonating sender keys.
- 2026-10-09 — Global app-creation/fleet registration workflow updated and secret-scanned. Fixed non-executable hook/scanner metadata so Linux checkouts actually run the blocking secret gate. The offline PC has not received a synchronization receipt; repository publication is not PC synchronization.

- 2026-10-09 — Supported staging deployment applied migration 0002 and served version 05257faf-3ebc-4d95-b5f9-2312a061f4b2. All ten public smoke checks failed to reach their hosts due to runtime network enforcement. This is a blocked release gate, not successful staging certification; production remains unchanged apart from separately installed secret bindings. Newly added cron propagation is still awaiting its first actual receipt.
- 2026-10-09 — Concurrent Messenger main changes were preserved by rebasing onto 6095b03. Our independent migration was renumbered to 0202 after another change used 0201. That main release's own runbook records repeated production D1 import failures 7009/7429 for migration 0184 and verified rollback to schema 0183. No blind retry, schema-history bypass or broad table replacement is attempted by this rollout. The Messenger change is held as a draft branch until both the callee release gate and existing database blocker are cleared.
- 2026-10-09 — Fresh execution readiness checks still show the paired node last seen 2026-10-03 and Desktop Commander offline 166 hours. Real code investigation/production repair remains blocked; test nodes are not production evidence. Native DigiTronics tools are not callable in this root session, so no daily automation was created from an unverified connector. Private plugin archive 1.1.0 is prepared but publication waits for its actual server capability.

- 2026-10-09 — Rebased Messenger revision 009d113 on main 6095b03 passes typecheck/lint, 3,121 tests (one existing skip), build, fresh migrations through 0202, D1 smoke, tenant-isolation wiring, and all 85 desktop/mobile browser journeys. Generated screenshots were moved out before clean-tree hygiene. Prior local D1 state was preserved before fresh migration verification. Code is saved remotely in draft PR https://github.com/TenTen-maroc/whatsapp-inbox-saas/pull/47; no production merge or deploy occurred.
- 2026-10-09 — Hardened enabled job contracts to require their downstream proof kind. Fresh same-job native evidence atomically advances the deadline and resolves its missing-activity incident; arbitrary healthy prose, a generic liveness receipt or missing job identity cannot mask a failed backup. All 12 real Workers/D1 operations tests and latest typecheck/lint passed.
- 2026-10-09 — Updated monitor-only staging version 8501c4bb-d161-4302-b6ad-9fec005bf7e9 still cannot pass public smoke due to the network policy. First actual cron completion remains pending; source/configuration alone is not an operational monitoring receipt. Production code release, Messenger migration/deployment, private plugin publication, authenticated daily schedule, independent email fallback, real execution-node repair, and non-Messenger native receipts remain open.

- 2026-10-09 — Latest staged source version 4d9ce7cc-4f78-4c92-bdf3-ecce9f269672 includes required native job proof and tested missing-activity resolution. Supported release still returns failure at its ten public smoke checks; production is held. Cloudflare settings confirm the correct staging D1 binding and configured five-minute cron, but a current completed tick has not yet been observed. No assertion of operational monitoring is made from settings alone.

- 2026-10-09 18:00 UTC — After cron propagation, actual staging cycles completed at 17:55:23 and 18:00:31 on version 4d9ce7cc-4f78-4c92-bdf3-ecce9f269672. First bootstrap registered nine app contracts and one probe in 34 statements; the next cycle checked two probes in 27 statements. Both remained below the hard 48-statement ceiling and performed no repair actions or owner deliveries. Messenger's unreleased native health endpoint correctly produced unknown monitoring rather than a healthy claim.
- 2026-10-09 — Environment restart preserved files and credentials but did not change restricted egress. All ten supported staging smoke checks still fail at transport. Required public domains are acc-staging.dr-badawi-abdalsalam.com, acc-relay-staging.dr-badawi-abdalsalam.com, acc.dr-badawi-abdalsalam.com, acc-relay.dr-badawi-abdalsalam.com and messenger.digitronics.app. Authorization is already granted; there is no available tool to edit that environment policy. Production code remains held behind the real release gate.
- 2026-10-09 — Native Messenger tools became callable after the runtime restart. Verified contact@tenten.ma, all seven approved channels and complete 24-page history: 2,388 messages, no attachments, checkpoint 2026-10-09T17:52:36.000Z. Rechecked unchanged unread counts, including Accounting's four. Actual patterns include correlated Sales/ARK missing-device checks and stale offline restore drill, Accounting's reported missing Stocktake Anomaly Digest, AI helper/volume alerts, historical guarded-budget send failures and decision-only funding reports. Reports are evidence of reported conditions, not independently reconciled current health or finances.
- 2026-10-09 — Saved and read back one daily Review Messenger notifications task (6ac92b39c2d48191954c293597494a64): enabled, 09:00 Asia/Shanghai beginning October 10, dynamic all-page bot discovery and new-bot backfill, unchanged group consent, incremental review and explicit unavailable-state fallback. The service returned no next-run timestamp and no run has occurred, so only the saved schedule/enabled state are verified.
- 2026-10-09 — Published and read back private instruction-only plugin 1.0.2, release pluginrel_6ac92bc81e488191b1047acb3cd69bff. Exact App binding, workspace, private audience, presentation and manifest fields except version were preserved. Optional operations guidance labels the still-unreleased capability as pending. This intentionally releases useful reader instructions independently; the prepared server/plugin 1.1.0 package still waits for the actual server release.
- 2026-10-09 — Saved and read back independent hourly Check app availability fallback, beginning 18:30 UTC October 9. Prerequisite real checks succeeded: native reader profile, current runtime readiness, production OPS_ENABLED=false, and actual Messenger KV scheduler stamp 18:00:46 UTC. Future checks use at most two bounded D1 reads and direct Cloudflare evidence, without relying on either notification bot. Phone push receipt and email routing remain unverified. A temporary prompt overlay on the existing customer-reply monitor was removed after inspecting its intentional 24-run duration; its exact original prompt, schedule and enabled state were verified restored. The permanent fallback is a separate small task, avoiding indefinite expensive customer-history audits.
- 2026-10-09 — Messenger main advanced to 1b01140 with a reviewed bounded staged-migration runner replacing the repeatedly failed atomic import. Preserve that separate remediation and do not launch overlapping production releases. Integrate its source into the draft fleet branch and verify affected contracts. Actual database upgrade and final healthy artifact remain prerequisites; historical 7009/7429 failures alone do not establish the new procedure's result.
- 2026-10-09 — Integrated main's three migration-maintenance commits into the draft branch without force-pushing (merge 5c4edb3, pushed). Runtime app/UI/migration files are unchanged from the fully checked 009d113 revision. All 47 affected migration, fleet, native recovery, reader and OAuth integration tests passed; latest typecheck/lint, Node/Bash syntax, staged secret scan and diff checks passed. Previous 3,121-test/full-build/fresh-local-migration and 85-browser results apply to the unchanged runtime artifact; the new maintenance procedure has its own affected tests. PR 47 still waits for the actual callee and production migration gates.
- 2026-10-09 18:10 UTC — Third observed monitor-only staging completion used 28 statements for two probes, with no repairs or deliveries. Messenger's latest deployment remains the 17:15:20 secret-binding change serving the old artifact; no native server or fleet source release is inferred. Independent hourly fallback ID: 6ac92cc4f5e481918a0cb10654a669a0. Both new tasks' exact saved prompts, schedules and enabled states were read back successfully. Production owner-notice delivery, phone push receipt, real code execution and downstream repair proof remain open.
