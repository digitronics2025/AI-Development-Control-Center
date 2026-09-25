<#
.SYNOPSIS
  Stops the background orchestrator.

.DESCRIPTION
  With no switch it refuses while a task has a stage running: it lists the
  running tasks and exits with code 2, and nothing is interrupted.

  -Drain  stops every task at its next stage boundary (nothing is cut off
          mid-stage), then shuts down. Supervised tasks resume by themselves
          after the next start. Use this to restart after a new build.
  -Force  interrupts running stages now (they are marked INTERRUPTED and can
          be resumed), and stops the process if it has not exited in 15 s.
#>
[CmdletBinding()]
param(
  [switch]$Drain,
  [switch]$Force,
  # How long -Drain waits for the running stages to reach their boundary.
  [int]$DrainTimeoutMinutes = 180
)

$ErrorActionPreference = 'Stop'
if ($Drain -and $Force) { throw 'Use -Drain or -Force, not both.' }
$dataDir = if ($env:ACC_DATA_DIR) { $env:ACC_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'AIDevControlCenter' }
$runtimeFile = Join-Path $dataDir 'runtime.json'
if (-not (Test-Path $runtimeFile)) { Write-Host 'The orchestrator is not running.'; return }

$runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json
$token = (Get-Content (Join-Path $dataDir 'auth-token') -Raw).Trim()
$mode = if ($Force) { 'force' } elseif ($Drain) { 'drain' } else { 'refuse' }

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

$answered = $false
try {
  $response = Invoke-WebRequest -Uri "$($runtime.url)/api/service/shutdown" -Method Post -UseBasicParsing -TimeoutSec 10 `
    -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body (@{ mode = $mode } | ConvertTo-Json -Compress)
  $answered = $true
  $body = $response.Content | ConvertFrom-Json
  if ($body.draining) {
    $names = ($body.waitingFor | ForEach-Object { if ($_.stage) { "$($_.taskId) ($($_.stage))" } else { $_.taskId } }) -join ', '
    Write-Host "Draining: waiting for $names to reach the end of the current stage."
  }
} catch {
  $status = $null
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  if ($status -eq 409) {
    $text = $null
    try {
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $text = ($reader.ReadToEnd() | ConvertFrom-Json).error.message
    } catch { }
    if (-not $text -and $_.ErrorDetails.Message) { $text = ($_.ErrorDetails.Message | ConvertFrom-Json).error.message }
    Write-Host ($(if ($text) { $text } else { 'Not stopping: tasks are running.' }))
    Write-Host 'Run again with -Drain to stop at the next stage boundary (tasks resume after the restart), or -Force to interrupt them now.'
    exit 2
  }
  Write-Host "The orchestrator did not answer ($($_.Exception.Message))."
}

# A drain lasts as long as the running stages; a force or an idle stop takes seconds.
$deadline = if ($Drain -and $answered) { (Get-Date).AddMinutes($DrainTimeoutMinutes) } else { (Get-Date).AddSeconds(15) }
$lastNote = Get-Date
while ((Get-Orchestrator) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if ($Drain -and ((Get-Date) - $lastNote).TotalSeconds -ge 60) {
    Write-Host 'Still waiting for running stages to finish...'
    $lastNote = Get-Date
  }
}
$process = Get-Orchestrator
if ($process) {
  if ($Drain -and $answered) {
    Write-Host "The drain did not finish within $DrainTimeoutMinutes minutes; the orchestrator is still running. Use -Force to interrupt the remaining stages."
    exit 3
  }
  if (-not $Force) {
    Write-Host $(if ($answered) { 'The orchestrator accepted the stop but has not exited yet; run again with -Force to stop the process.' } else { 'The orchestrator is not answering; run again with -Force to stop the process.' })
    exit 3
  }
  Write-Host 'Graceful shutdown timed out; stopping the process.'
  Stop-Process -Id $process.Id -Force
  Remove-Item -Force $runtimeFile -ErrorAction SilentlyContinue
} elseif (Get-Process -Id $runtime.pid -ErrorAction SilentlyContinue) {
  Write-Host "Process $($runtime.pid) is no longer the orchestrator (its PID was reused); leaving it alone."
  Remove-Item -Force $runtimeFile -ErrorAction SilentlyContinue
}
Write-Host 'AI Development Control Center stopped.'
