---
system: pty
sources:
  - packages/pty/**
  - apps/orchestrator/src/tools/terminals.ts
  - apps/dashboard/src/components/terminal.tsx
verified_at: 0d4eaf8
---

# Interactive terminals

[`@acc/pty`](../../packages/pty/src/index.ts) wraps `node-pty` 1.1 (ConPTY
through its bundled `conpty.dll`/OpenConsole on Windows; prebuilds ship in the
package, `allowBuilds` only runs its prebuild check).

## Sessions

- Output is redacted before it is kept or sent, whole lines at a time: the
  line in progress (at most 8 KB of it) is held back until the chunk that
  completes it arrives, or 40 ms after it started (a prompt, an echoed key),
  so a secret the pseudo-terminal splits across two chunks is redacted whole;
  a private key block stays hidden across chunks up to its END line
  (`streamRedactor`, [security.md](security.md#redaction-redactts)). A secret
  whose second half arrives after that wait is judged in halves. Output is
  kept in a bounded buffer (256 KB) with a monotonic **cursor**: `read(since)` returns what came after a cursor and
  says when older output was dropped. The realtime socket skips chunks for a
  viewer that falls more than 8 MB behind; the dashboard terminal sees the gap
  between its cursor and the next chunk and reads the missing part with
  `?since=`.
- Close on idle (30 min), lifetime cap (8 h), explicit close, task end and
  shutdown. `kill()` lets ConPTY end its console session, then runs
  `taskkill /T /F` on the shell as a fallback, then waits up to 2 s for exit.
- At most 12 open sessions. Operator terminals load the user's shell
  profile; agent terminals start clean (`-NoProfile`, `--norc`).

## Orchestrator ([terminals.ts](../../apps/orchestrator/src/tools/terminals.ts))

- Refused while terminals are off (Settings → Execution) or while the
  orchestrator listens on anything but loopback (`ACC_ALLOW_REMOTE`): this is
  never a remote shell.
- The working folder is always a registered repository or a task's working
  directory (its worktree when isolated).
- Operator keystrokes arrive over the WebSocket (`terminal.input`) and are
  accepted only for a terminal that client subscribed to; resize likewise.
  Output (`terminal.output`) goes only to subscribed clients and is never
  stored. `pty_sessions` keeps status rows only; rows left running by a crash
  are marked exited at startup.
- Agent input (`terminal.send`) is typed as it arrives and each line is
  classified when Enter arrives — assembled from however many sends it took
  ([terminals.ts](../../apps/orchestrator/src/tools/terminals.ts)), with the
  release gate (`judgeLine`: a push to the task's release branch or a
  production-named one, one whose destination cannot be read, or a
  pull-request merge is Level 5 production, judged after the lines that
  terminal ran before, so `git switch main` then `git push` counts, and `cd
  web` then `git push` reads `web`'s branch). Those lines are the last 50 and
  every older one that changed folder, aliased Git or gave a variable a value
  naming Git (`x="git push origin main"`, which a later `$x` runs;
  `shellHistory`). An earlier push itself does not make a later line's
  variables a push: `node server.js --port $PORT` after `git push origin
  feature/x` is judged on its own. A line
  ending while the shell still reads a command begun on earlier lines — an
  open quote, a trailing `\`, backtick or `^`, a trailing pipe or `&&`, a
  heredoc (`lineContinues`) — is judged alone and as part of that command, so
  `git push \` then `origin main` counts; a command over 20,000 characters is
  refused. In bash a line that history expansion would rewrite (`!^`, `!!`,
  `^old^new`: `expandsHistory`) is Level 5: what runs would not be the line
  judged. A line that is dangerous, Level 5, production or above the stage
  level is cancelled with Ctrl+C (which drops the command's earlier lines
  too) and the call fails `DENIED`. Tab and escape sequences are dropped, as for the cloud's terminals.

## API

`GET /api/terminals`, `POST /api/terminals {repositoryId | taskId, shell, cols, rows}`,
`GET /api/terminals/:id/output?since=`, `POST /api/terminals/:id/resize`,
`DELETE /api/terminals/:id`. WebSocket client messages: `subscribeTerminal`,
`unsubscribeTerminal`, `terminal.input`, `terminal.resize`.

## Dashboard

[terminal.tsx](../../apps/dashboard/src/components/terminal.tsx): xterm.js
themed from the design tokens, catch-up read then live stream, fit on resize.
Closing the drawer closes the terminal (also when it closes before the
terminal finished starting).

## Remote terminals

A terminal opened from the cloud dashboard runs here like any other, but only
with the node's remote-terminal permission, and every line is classified when
Enter arrives; refused lines are cancelled and escape sequences and Tab are
dropped. In cloud mode the terminal drawer first asks for confirmation (naming
the node, the limits and that nothing typed is stored in the cloud), and
viewer-only notices from the node are written to the screen without being sent
to the shell. See [remote-node.md](remote-node.md#terminals).

## Gotchas

- Killing with `taskkill` before ConPTY's own kill made node-pty's console
  list agent print "AttachConsole failed"; the bundled-DLL mode avoids the
  agent entirely.

Last verified: 2026-09-24
