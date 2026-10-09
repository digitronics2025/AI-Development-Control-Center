---
title: Durable fleet operations and verified recovery for Dot
source: conversation 2026-10-09, approved fleet operations plan
created: 2026-10-09
status: in-progress
---

# Durable fleet operations and verified recovery for Dot

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

- [ ] 1. Register apps and runtime contracts — done when: validated identities, dependencies, release methods and real schedules are stored — check: `pnpm cloud:test -- operations`
- [ ] 2. Durable monitoring and delivery — done when: incidents and retryable deliveries survive restart — check: `pnpm cloud:test -- operations`
- [ ] 3. Missing activity and service monitoring — done when: indexed bounded due checks distinguish unknown from healthy — check: `pnpm cloud:test -- operations`
- [ ] 4. Classify failures and business attention — done when: financial, staff, budget and uncertain-send alerts never authorize repair — check: `pnpm cloud:test -- operations`
- [ ] 5. Deduplicate and correlate investigations — done when: repeats update one incident and recurrences escalate — check: `pnpm cloud:test -- operations`
- [ ] 6. Link existing task investigations — done when: typed commands preserve leases and offline safety — check: `pnpm cloud:test -- operations`
- [ ] 7. Scoped app recovery — done when: bounded procedures check native preconditions and verify effects — check: `manual: app adapter contract and recovery tests`
- [ ] 8. Code-repair workflow — done when: tasks enforce stages, attempt limits and existing release gates — check: `manual: task integration tests and production node readiness`
- [ ] 9. Evidence before resolution — done when: untrusted or old evidence cannot resolve incidents — check: `pnpm cloud:test -- operations`
- [ ] 10. Owner reporting and fallback — done when: incident changes reach owner and daily review includes all bots — check: `manual: real owner report and scheduled review configuration`
- [ ] 11. Future apps and bots — done when: validated registration includes new sources without weakening group consent — check: `manual: source registration and authorization tests`
- [ ] 12. Bounded costs and offline execution — done when: limits, indexed plans, concurrency and stale-action guards are tested — check: `pnpm cloud:test -- operations`
- [ ] 13. Controlled rollout — done when: failure scenarios pass and intended production versions and outcomes are observed — check: `manual: deployed version, downstream probes and failure matrix`

## Tail

- [ ] T1. Adversarial review — done when: findings fixed or recorded — check: `git diff --stat` reviewed hunk by hunk
- [ ] T2. Similar-issue sweep — done when: related auth, outboxes and query paths checked — check: `manual: Ledger sweep results`
- [ ] T3. Full applicable checks — done when: repository check passes — check: `pnpm check`
- [ ] T4. Documentation — done when: owning system docs and follow-ups reflect behavior — check: `pnpm docs:guard`
- [ ] T5. Scoped commit and push — done when: exact source revision is saved remotely — check: `git log origin/main..HEAD --oneline`
- [ ] T6. Live verification — done when: supported releases and downstream results verified — check: `manual: release receipts and runtime evidence`
- [ ] T7. Downstream claims — done when: probe and deadline registered — check: `manual: docs claims entry`

## Ledger

- 2026-10-09 — Approved full autopilot with cost efficiency. No paid infrastructure or quota increases authorized. Preserve customer budgets and release gates. Repository main equals origin/main on entry.
- 2026-10-09 — Production node is offline (last seen October 3); Desktop Commander is also offline. Finish cloud and independent work; code execution proof must remain explicitly blocked until a real node runs it. No simulated node is production proof.
- 2026-10-09 — Production Control Center is manually released, not Workers Builds. User explicitly authorized implementation, migration and release; preserve supported staged release sequence and authentication gates. Do not create GitHub Actions.
- 2026-10-09 — Available conversation context retained above; detailed recovery matrix and resolution criteria are expanded in the owning system documentation during implementation.
