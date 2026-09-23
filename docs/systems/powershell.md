---
system: powershell
sources:
  - packages/executor/src/shells.ts
  - packages/tools/src/packs/shell.ts
  - packages/tools/src/packs/windows.ts
verified_at: 351db1e
---

# Shells: PowerShell, CMD, Bash, WSL

[shells.ts](../../packages/executor/src/shells.ts) runs scripts in every shell
the Control Center drives; [shell.ts](../../packages/tools/src/packs/shell.ts)
exposes them as capabilities.

## Resolution (`resolveShell`)

| Kind | Order |
|---|---|
| `powershell` | `pwsh` (7+) on PATH → Windows PowerShell 5.1 (`powershell` on PATH, then `System32\WindowsPowerShell\v1.0`) |
| `cmd` | `%ComSpec%` |
| `bash` | Git Bash next to `git.exe` (`..\bin\bash.exe`), then Program Files, then `bash` on PATH — never `System32\bash.exe`, which is the WSL launcher |
| `wsl` | `wsl.exe`; detected as installed only when `wsl -e sh -c "uname -r"` works |

## Running (`runScript`)

The script goes to a private temporary file (removed when the process ends),
never through argv:

- PowerShell: UTF-8 **with BOM** (5.1 reads BOM-less files as ANSI), a
  prologue that silences progress output and sets UTF-8 console encoding,
  `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <tmp>` (the
  policy flag is process scope only; nothing on the machine changes).
- CMD: `@echo off` + CRLF, `cmd /d /c <tmp>`.
- Bash: LF, `bash --noprofile --norc <tmp with forward slashes>`.
- WSL: the script on stdin to `wsl -e bash --noprofile --norc -s`.

Streaming lines, stdin, timeout, cancellation and tree kill come from
`runProcess` ([agents.md](agents.md)). `powershellJson()` runs a script ending
in `ConvertTo-Json -Compress` with `$ErrorActionPreference = 'Stop'` and parses
the result; the Windows pack (processes, services, ports, system information,
scheduled tasks, tool locations, network configuration) is built on it.

## Capabilities

`shell.run` (router picks PowerShell on Windows unless `shell` names another),
`shell.powershell`, `shell.cmd`, `shell.bash`, `shell.wsl`, `process.exec`
(one executable + argv, no shell). Every script is classified first
([security.md](security.md#command-classification)); a read-only script is
Level 1, so Analyze stages may run it.

`windows.kill_process` is Level 2 for processes the task started (or their
children) and Level 4 otherwise; it refuses the Control Center's own pid.

## Verified on the operator's machine (2026-09-23)

Windows PowerShell 5.1.26100 (no PowerShell 7 installed), CMD, Git Bash and
WSL (Ubuntu) all ran real scripts in tests: multi-line JSON, stdin, UTF-8,
arguments, exit codes, timeout tree-kill and cancel.

Last verified: 2026-09-23
