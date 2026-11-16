---
system: codex-subscription-smoke
sources:
  - scripts/ai_review/**
  - .github/workflows/advisory-ai-review-reusable.yml
  - .github/workflows/codex-subscription-dispatch.yml
verified_at: 50ff7b27
---

# Codex subscription fallback smoke test

> Last verified: 2026-11-16 — document structure and tracked workflow contract reviewed; live subscription evidence remains as stated below.

This documentation-only PR tests whether a trusted GitHub workflow can request the connected Codex GitHub reviewer without an OpenAI API key. A posted request is not proof that a review started. All AI review remains advisory.

A separate controlled PR compares the connected GitHub user request with the unacknowledged workflow-bot request, without issuing two requests for the same PR head.

The final end-to-end test verifies Claude subscription failure, the pending marker, central dispatcher submission and native Codex completion on one fresh head.

The scheduled-credential activation test verifies that the stored GitHub user credential can submit the pending native review from GitHub Actions itself.
