---
system: claude-subscription-smoke
sources:
  - scripts/ai_review/**
  - .github/workflows/advisory-ai-review-reusable.yml
  - .github/workflows/codex-subscription-dispatch.yml
verified_at: 50ff7b27
---

# Claude subscription review smoke test

> Last verified: 2026-11-16 — document structure and tracked workflow contract reviewed; live subscription evidence remains as stated below.

This documentation-only change tests the Claude subscription credential. Provider API keys are not passed to the review workflow. The review remains advisory and never gates merging or deployment.

A fresh documentation revision verifies the updated subscription credential without reusing a previously claimed PR head.
