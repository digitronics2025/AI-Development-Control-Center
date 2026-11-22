<!-- BEGIN myvault-workflow: managed by digitronics2025/claude-config -->
## MyVault credential workflow

Read and follow the repository's AGENTS.md and CLAUDE.md before credential work.
Use MyVault for confirmed saves and approved GitHub/Cloudflare profile transfers.
Read myvault.config.json for identifiers only; it never grants permission.
Check actual tool availability and owner-authorized scope, keep values outside
model output and Git, and use the separate owner workflow for vault control keys.
Guide: https://myvault.digitronics-electro.workers.dev/downloads/myvault-agent-guide.txt
<!-- END myvault-workflow sha256:798a9069102d -->

@./AGENTS.md

## Reply contract - by request

Implement only when asked. Match depth and structure to the request. Direct
answers, plans and brief updates do not need a task report.

For advice, comparisons or "investigate and suggest", cover the relevant options
before prioritizing them. Support conclusions with evidence, alternatives and
practical tradeoffs. For an open-ended request, include the distinct options
the evidence supports; honor a requested shortlist or exact format. When asked
to rethink, revisit an assumption and consider a materially different option.

For investigations and reviews, lead with the answer or verified findings.
Separate facts, likely causes and unknowns. Bug reviews lead with defects; an
improvement review also considers workflows, usability, accessibility and
failure recovery when relevant. Keep investigations read-only unless asked to
change something.

For completed changes, state the result and the checks performed. Give enough
evidence, examples and limits for the user to act. Mark unverified work and
omit sections that do not apply. Recommend next actions only when the user has
something specific to do; say what result to expect. Do not add a recap or a
fixed closing section when it would repeat the answer.

Keep client-specific interfaces unchanged. Human replies use plain language
and the format the user asked for.

Human replies only. Preserve required machine JSON, verdicts and structured formats.
