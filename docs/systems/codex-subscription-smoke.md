# Codex subscription fallback smoke test

This documentation-only PR tests whether a trusted GitHub workflow can request the connected Codex GitHub reviewer without an OpenAI API key. A posted request is not proof that a review started. All AI review remains advisory.

A separate controlled PR compares the connected GitHub user request with the unacknowledged workflow-bot request, without issuing two requests for the same PR head.

The final end-to-end test verifies Claude subscription failure, the pending marker, central dispatcher submission and native Codex completion on one fresh head.
