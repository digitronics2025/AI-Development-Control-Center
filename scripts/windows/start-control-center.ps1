<#
.SYNOPSIS
  Starts the AI Development Control Center orchestrator in the background (if it
  is not already running) and opens the dashboard.

.DESCRIPTION
  Runs `node apps/orchestrator/dist/main.js` hidden, with its log in the data
  folder. Safe to run repeatedly: an already-running orchestrator is reused.
  Binds to 127.0.0.1 only.

.PARAMETER NoBrowser
  Start (or reuse) the orchestrator without opening the dashboard. Used by the
  login shortcut.
#>
[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$main = Join-Path $repo 'apps\orchestrator\dist\main.js'
$dataDir = if ($env:ACC_DATA_DIR) { $env:ACC_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'AIDevControlCenter' }
$runtimeFile = Join-Path $dataDir 'runtime.json'
$logFile = Join-Path $dataDir 'orchestrator.log'

function Get-RunningUrl {
  if (-not (Test-Path $runtimeFile)) { return $null }
  try {
    $url = (Get-Content $runtimeFile -Raw | ConvertFrom-Json).url
    $null = Invoke-WebRequest -Uri "$url/healthz" -UseBasicParsing -TimeoutSec 3
    return $url
  } catch { return $null }
}

$url = Get-RunningUrl
if (-not $url) {
  if (-not (Test-Path $main)) {
    Write-Error "The orchestrator is not built. Run 'pnpm install' and 'pnpm build' in $repo first."
  }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Error 'Node.js 22 or newer is required (node was not found on PATH).' }

  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  # Keep one previous log; start fresh when the current one grows past 10 MB.
  if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 10MB)) {
    Move-Item -Force $logFile "$logFile.1"
  }
  Start-Process -FilePath $node -ArgumentList "`"$main`"" -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" | Out-Null

  for ($i = 0; $i -lt 40 -and -not $url; $i++) {
    Start-Sleep -Milliseconds 500
    $url = Get-RunningUrl
  }
  if (-not $url) { Write-Error "The orchestrator did not start. See $logFile and $logFile.err." }
  Write-Host "AI Development Control Center started at $url"
} else {
  Write-Host "AI Development Control Center is already running at $url"
}

if (-not $NoBrowser) { Start-Process $url }
