<#
.SYNOPSIS
  Stops the background orchestrator gracefully. Running stages are marked
  INTERRUPTED and can be resumed after the next start.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$dataDir = if ($env:ACC_DATA_DIR) { $env:ACC_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'AIDevControlCenter' }
$runtimeFile = Join-Path $dataDir 'runtime.json'
if (-not (Test-Path $runtimeFile)) { Write-Host 'The orchestrator is not running.'; return }

$runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json
$token = (Get-Content (Join-Path $dataDir 'auth-token') -Raw).Trim()
try {
  $null = Invoke-WebRequest -Uri "$($runtime.url)/api/service/shutdown" -Method Post -UseBasicParsing -TimeoutSec 5 `
    -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body '{}'
} catch {
  Write-Host "The orchestrator did not answer ($($_.Exception.Message))."
}

# After a crash runtime.json can outlive the orchestrator and its PID can be
# reused by any process. Only a Node process that started shortly before the
# recorded startedAt is ours (audit F-46).
function Get-Orchestrator {
  $process = Get-Process -Id $runtime.pid -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  if ($process.ProcessName -ne 'node') { return $null }
  if ($runtime.startedAt) {
    $started = [DateTimeOffset]::Parse($runtime.startedAt).UtcDateTime
    $gap = ($started - $process.StartTime.ToUniversalTime()).TotalSeconds
    if ($gap -lt -5 -or $gap -gt 600) { return $null }
  }
  return $process
}

for ($i = 0; $i -lt 30 -and (Get-Orchestrator); $i++) { Start-Sleep -Milliseconds 500 }
$process = Get-Orchestrator
if ($process) {
  Write-Host 'Graceful shutdown timed out; stopping the process.'
  Stop-Process -Id $process.Id -Force
  Remove-Item -Force $runtimeFile -ErrorAction SilentlyContinue
} elseif (Get-Process -Id $runtime.pid -ErrorAction SilentlyContinue) {
  Write-Host "Process $($runtime.pid) is no longer the orchestrator (its PID was reused); leaving it alone."
  Remove-Item -Force $runtimeFile -ErrorAction SilentlyContinue
}
Write-Host 'AI Development Control Center stopped.'
