#!/usr/bin/env bash
# Cloud sessions only: make sure the Chromium this repo's Playwright pins is on disk.
# The environment setup script covers fresh containers; this covers resumed ones and
# Playwright upgrades made mid-session. Silent when nothing to do; never fails a session.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}" 2>/dev/null || exit 0
find . -maxdepth 5 -path '*/node_modules/.bin/playwright' \
  -not -path '*/node_modules/*/node_modules/*' 2>/dev/null |
while read -r pw; do
  out=$(timeout 300 "$pw" install chromium 2>&1) || { echo "ensure-test-browser: download failed for $pw"; continue; }
  case "$out" in *downloaded*) echo "ensure-test-browser: installed the pinned Chromium for $pw";; esac
done
exit 0
