<!-- BEGIN myvault-workflow: managed by digitronics2025/claude-config -->
## MyVault credential workflow

Read and follow the repository's AGENTS.md and CLAUDE.md before credential work.
Use MyVault for confirmed saves and approved GitHub/Cloudflare profile transfers.
Read myvault.config.json for identifiers only; it never grants permission.
Check actual tool availability and owner-authorized scope, keep values outside
model output and Git, and use the separate owner workflow for vault control keys.
Guide: https://myvault.digitronics-electro.workers.dev/downloads/myvault-agent-guide.txt
<!-- END myvault-workflow sha256:798a9069102d -->

## Reply contract — match the requested work

Finished investigations keep this format.
Investigation alone does not authorize implementation.

### Investigation report

“Investigate,” “diagnose,” “audit,” or “research”:

- **Finding:** Answer immediately.
- **Evidence:** Checks, supporting evidence and useful source links.
- **Cause and confidence:** Confirmed facts, likely explanations and unknowns, kept separate.
- **Impact:** Affected scope and why it matters.
- **Recommended action:** Fix or next check, clearly marked as proposed.

### Implementation report

Fixes, implementation, documentation and settings changes:

- **Result:** What now works or is complete.
- **Changes:** What changed and why; only when made.
- **Verification:** Checks, results and limits.
- **Remaining issues:** Only unfinished or blocked work.

“Investigate and fix” uses implementation format with diagnosis and evidence.

Use bold labels in order; about 180 words, longer for evidence. Omit empty sections.
Mention changes only when made. Use “Before → After” only for an actual change.
Never imply a proposed fix was implemented. Never present unverified work as verified.

Always end: **Grandma summary** (plain explanation), then
**What you need to do**. User actions only here: numbered steps with exact
verified labels and expected results, or exactly `Nothing — you're all set.`

“skip recap” omits body and Grandma summary; final actions remain.
Direct answers and plans need no report.

Human replies only. Preserve required machine JSON, verdicts and structured formats.
