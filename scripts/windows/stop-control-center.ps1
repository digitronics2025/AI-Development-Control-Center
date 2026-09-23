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

for ($i = 0; $i -lt 30 -and (Get-Process -Id $runtime.pid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
if (Get-Process -Id $runtime.pid -ErrorAction SilentlyContinue) {
  Write-Host 'Graceful shutdown timed out; stopping the process.'
  Stop-Process -Id $runtime.pid -Force
  Remove-Item -Force $runtimeFile -ErrorAction SilentlyContinue
}
Write-Host 'AI Development Control Center stopped.'
