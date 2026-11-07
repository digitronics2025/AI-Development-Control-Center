#!/usr/bin/env bash
# Cloud sessions only: make sure the Chromium this repo's Playwright pins is on disk.
# The environment setup script covers fresh containers; this covers resumed ones and
# Playwright upgrades made mid-session. Silent when nothing to do; never fails a session.
# One overall budget (290 s) keeps every download inside the hook's 320 s timeout, so
# the hook is never killed silently: what does not fit is said, and retried next start.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}" 2>/dev/null || exit 0
deadline=$((SECONDS + ${ENSURE_TEST_BROWSER_BUDGET:-290}))
find . -maxdepth 5 -path '*/node_modules/.bin/playwright' \
  -not -path '*/node_modules/*/node_modules/*' 2>/dev/null |
while read -r pw; do
  left=$((deadline - SECONDS))
  if [ "$left" -lt 5 ]; then echo "ensure-test-browser: out of time before $pw; retried next session start"; continue; fi
  out=$(timeout "$left" "$pw" install chromium 2>&1) || { echo "ensure-test-browser: download failed or timed out for $pw"; continue; }
  case "$out" in *downloaded*) echo "ensure-test-browser: installed the pinned Chromium for $pw";; esac
done
exit 0
