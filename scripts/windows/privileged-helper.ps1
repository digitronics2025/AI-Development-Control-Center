<#
.SYNOPSIS
  The Control Center's privileged helper (docs/plans/tool-layer-v2, V2 plan §35).

.DESCRIPTION
  Runs ONE allowlisted administrator operation, then exits. It is started by
  the orchestrator through Windows UAC (the person at the keyboard approves
  each run), so the orchestrator itself never runs as Administrator and there
  is no elevated shell to send arbitrary commands to.

  Every request is a JSON file signed with HMAC-SHA256 using a key only this
  Windows user can read (<data>\privileged-key). A request is refused unless
  its signature matches, it is younger than five minutes, it has not been
  used before, its operation is on the allowlist and every parameter passes
  strict validation. Each run is appended to <data>\privileged-audit.log.

  -ValidateOnly checks a request without executing it (used by tests and to
  preview what a request would do).
#>
param(
  [Parameter(Mandatory = $true)][string]$RequestFile,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Allowed = @{
  install_package      = @{ ids = @('Microsoft.PowerShell', 'Git.Git', 'GitHub.cli', 'OpenJS.NodeJS.LTS', 'Python.Python.3.12', 'Google.AndroidStudio') }
  firewall_allow_port  = @{}
  firewall_remove_rule = @{}
  service_start        = @{ names = @('com.docker.service', 'ssh-agent') }
  service_stop         = @{ names = @('com.docker.service', 'ssh-agent') }
  service_restart      = @{ names = @('com.docker.service', 'ssh-agent') }
}

$dataDir = if ($env:ACC_DATA_DIR) { $env:ACC_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'AIDevControlCenter' }
$resultFile = "$RequestFile.result.json"
$auditFile = Join-Path $dataDir 'privileged-audit.log'

function Write-Result([bool]$ok, [string]$message) {
  [pscustomobject]@{ ok = $ok; message = $message; finishedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultFile -Encoding UTF8
  $line = '{0} {1} {2} {3}' -f (Get-Date).ToUniversalTime().ToString('o'), ($(if ($ok) { 'OK' } else { 'REFUSED/FAILED' })), $script:operation, $message
  Add-Content -LiteralPath $auditFile -Value $line -Encoding UTF8
  if ($ok) { exit 0 } else { exit 1 }
}

$script:operation = 'unknown'
try {
  $keyPath = Join-Path $dataDir 'privileged-key'
  if (-not (Test-Path -LiteralPath $keyPath)) { Write-Result $false 'No privileged key: the helper can only be used by the Control Center' }
  $key = [Convert]::FromBase64String((Get-Content -LiteralPath $keyPath -Raw).Trim())
  $request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
  $script:operation = [string]$request.operation

  # Signature over the exact payload text the orchestrator signed.
  $hmac = New-Object System.Security.Cryptography.HMACSHA256 (, $key)
  $expected = [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$request.payload)))
  if (-not [string]::Equals($expected, [string]$request.signature, [StringComparison]::Ordinal)) { Write-Result $false 'Bad signature' }
  $payload = [string]$request.payload | ConvertFrom-Json
  $script:operation = [string]$payload.operation

  $issued = [DateTime]::Parse([string]$payload.issuedAt).ToUniversalTime()
  if (((Get-Date).ToUniversalTime() - $issued).TotalMinutes -gt 5) { Write-Result $false 'Request expired' }
  $usedFile = Join-Path $dataDir 'privileged-used.txt'
  if ((Test-Path -LiteralPath $usedFile) -and ((Get-Content -LiteralPath $usedFile) -contains [string]$payload.id)) { Write-Result $false 'Request already used' }
  if (-not $Allowed.ContainsKey($script:operation)) { Write-Result $false "Operation not allowed: $($script:operation)" }

  $p = $payload.params
  switch ($script:operation) {
    'install_package' {
      $id = [string]$p.id
      if ($Allowed.install_package.ids -notcontains $id) { Write-Result $false "Package not on the allowlist: $id" }
      $plan = "winget install --id $id --exact"
    }
    'firewall_allow_port' {
      $port = [int]$p.port
      $name = [string]$p.name
      if ($port -lt 1024 -or $port -gt 65535) { Write-Result $false 'Port must be 1024-65535' }
      if ($name -notmatch '^[A-Za-z0-9_-]{1,40}$') { Write-Result $false 'Rule name: letters, digits, dash, underscore' }
      $plan = "allow inbound TCP $port on private networks as ACC-$name"
    }
    'firewall_remove_rule' {
      $name = [string]$p.name
      if ($name -notmatch '^[A-Za-z0-9_-]{1,40}$') { Write-Result $false 'Rule name: letters, digits, dash, underscore' }
      $plan = "remove firewall rule ACC-$name"
    }
    default {
      $svc = [string]$p.name
      if ($Allowed[$script:operation].names -notcontains $svc) { Write-Result $false "Service not on the allowlist: $svc" }
      $plan = "$($script:operation -replace 'service_', '') service $svc"
    }
  }

  if ($ValidateOnly) {
    [pscustomobject]@{ ok = $true; message = "Valid: $plan"; finishedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultFile -Encoding UTF8
    exit 0
  }

  Add-Content -LiteralPath $usedFile -Value ([string]$payload.id) -Encoding UTF8
  switch ($script:operation) {
    'install_package' {
      & winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Result $false "winget exited with $LASTEXITCODE" }
    }
    'firewall_allow_port' { New-NetFirewallRule -DisplayName "ACC-$name" -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private | Out-Null }
    'firewall_remove_rule' { Remove-NetFirewallRule -DisplayName "ACC-$name" }
    'service_start' { Start-Service -Name $svc }
    'service_stop' { Stop-Service -Name $svc }
    'service_restart' { Restart-Service -Name $svc }
  }
  Write-Result $true "Done: $plan"
} catch {
  Write-Result $false ("Failed: " + $_.Exception.Message)
}
