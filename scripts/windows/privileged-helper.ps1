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
  agent_account_create = @{}
  agent_account_remove = @{}
}

$dataDir = if ($env:ACC_DATA_DIR) { $env:ACC_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'AIDevControlCenter' }
$resultFile = "$RequestFile.result.json"
$auditFile = Join-Path $dataDir 'privileged-audit.log'

# ----- the agent account (SEC-3, docs/systems/security.md "Agent OS boundary") ----------------
# A standard local account agent stages run as. Only an account carrying this description is ever
# changed or removed, so an account the operator made for anything else is never touched.
$AgentAccountDescription = 'AI Development Control Center agent runs'
$agentRecordFile = Join-Path $dataDir 'agent-account.json'
$agentPluginsDir = Join-Path $dataDir 'learning\plugins'
$hiddenAccountsKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'

function Test-Inside([string]$child, [string]$parent) {
  ($child.TrimEnd('\') + '\').StartsWith($parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

# Why a folder may not be given to the agent account, or $null. Folders only the operator could
# mean: absolute, normalised, not a drive, system, program or profile root, not the data folder,
# inside it or above it, and not a credential folder.
function Get-FolderRefusal([string]$folder, [switch]$MustExist) {
  if (-not $folder -or $folder.Length -gt 200) { return 'a full folder path of at most 200 characters is needed' }
  if ($folder -notmatch '^[A-Za-z]:\\[^\\]') { return "$folder is not a full local folder path" }
  $full = [IO.Path]::GetFullPath($folder).TrimEnd('\')
  if ($full -ne $folder.TrimEnd('\')) { return "$folder is not written in its plain form" }
  if (($full -split '\\').Count -lt 3) { return "$folder is too close to the root of its drive" }
  foreach ($system in @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData)) {
    if ($system -and (Test-Inside $full $system)) { return "$folder is a system or program folder" }
  }
  $profiles = @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' | ForEach-Object { [Environment]::ExpandEnvironmentVariables([string](Get-ItemProperty -LiteralPath $_.PSPath).ProfileImagePath) } | Where-Object { $_ })
  foreach ($root in @($profiles) + @($profiles | ForEach-Object { Split-Path $_ -Parent })) {
    if ($root -and [string]::Equals($full, $root.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { return "$folder is a user folder root" }
  }
  if ((Test-Inside $full $dataDir) -or (Test-Inside $dataDir $full)) { return "$folder is, holds or is inside the Control Center's data folder" }
  foreach ($part in ($full -split '\\')) {
    if (@('.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.claude', '.codex', '.config', 'Microsoft') -contains $part) { return "$folder is or is inside a folder that holds credentials" }
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $full -PathType Container)) { return "$folder does not exist" }
  return $null
}

function Invoke-Icacls([string]$path, [string[]]$arguments) {
  $output = & icacls.exe $path @arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "icacls $path $($arguments -join ' '): $output" }
}

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
    { $_ -in 'agent_account_create', 'agent_account_remove' } {
      $account = [string]$p.account
      if ($account -cnotmatch '^[A-Za-z][A-Za-z0-9_-]{2,19}$') { Write-Result $false 'Account name: 3-20 letters, digits, dash or underscore, starting with a letter' }
      $workDir = [string]$p.workDir
      $why = Get-FolderRefusal $workDir
      if ($why) { Write-Result $false "Work folder: $why" }
      $existing = Get-LocalUser -Name $account -ErrorAction SilentlyContinue
      if ($existing -and $existing.Description -ne $AgentAccountDescription) { Write-Result $false "The Windows account $account exists and was not made by the Control Center: it is left alone" }
      $record = if (Test-Path -LiteralPath $agentRecordFile) { Get-Content -LiteralPath $agentRecordFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
      if ($record -and [string]$record.account -ne $account) { Write-Result $false "The agent account set up here is $($record.account), not $account" }
      if ($script:operation -eq 'agent_account_create') {
        $readFolders = @()
        foreach ($key in 'read1', 'read2', 'read3', 'read4', 'read5', 'read6') {
          if (-not $p.$key) { continue }
          $why = Get-FolderRefusal ([string]$p.$key) -MustExist
          if ($why) { Write-Result $false "Folder to read: $why" }
          $readFolders += [IO.Path]::GetFullPath([string]$p.$key).TrimEnd('\')
        }
        $plan = "$(if ($existing) { 'give the Windows account' } else { 'create the standard Windows account' }) $account a new password for agent runs; refuse it $dataDir (except the learned plugins, read only); let it change $workDir$(if ($readFolders.Count) { "; let it read $($readFolders -join ', ')" })"
      } else {
        if (-not $existing -and -not $record) { Write-Result $false "There is no agent account $account to remove" }
        $plan = "remove the Windows account $account, its user folder and its access to $dataDir and $workDir$(if ($record) { ' and every folder it was given' })"
      }
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
    'agent_account_create' {
      # A random password nobody types: saved for this Windows user only (DPAPI), never shown or logged.
      $bytes = New-Object byte[] 32
      [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $password = ConvertTo-SecureString -String ([Convert]::ToBase64String($bytes) + '-aZ9') -AsPlainText -Force
      if ($existing) {
        Set-LocalUser -Name $account -Password $password -PasswordNeverExpires $true -AccountNeverExpires
        Enable-LocalUser -Name $account
      } else {
        New-LocalUser -Name $account -Password $password -Description $AgentAccountDescription -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword | Out-Null
      }
      $sid = (Get-LocalUser -Name $account).SID.Value
      # A standard user (the Users group lets it sign in), hidden from the sign-in screen.
      try { Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $sid -ErrorAction Stop } catch { if ($_.FullyQualifiedErrorId -notlike 'MemberExists*') { throw } }
      New-Item -Path $hiddenAccountsKey -Force | Out-Null
      New-ItemProperty -Path $hiddenAccountsKey -Name $account -Value 0 -PropertyType DWord -Force | Out-Null
      New-Item -ItemType Directory -Force -Path $agentPluginsDir, $workDir | Out-Null
      $grants = @(
        [pscustomobject]@{ path = $dataDir; access = 'deny' },
        [pscustomobject]@{ path = $agentPluginsDir; access = 'read' },
        [pscustomobject]@{ path = $workDir; access = 'modify' }
      ) + @($readFolders | ForEach-Object { [pscustomobject]@{ path = $_; access = 'read' } })
      # The record first, so a remove finds every folder even if a grant below fails.
      # DPAPI (this user, this machine): only the operator's own processes can unseal it.
      $sealed = ConvertFrom-SecureString -SecureString $password
      [pscustomobject]@{ account = $account; sid = $sid; protectedSecret = $sealed; grants = $grants; createdAt = (Get-Date).ToUniversalTime().ToString('o') } |
        ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath $agentRecordFile -Encoding UTF8
      $password = $null
      # An explicit allow on the plugins folder comes before the deny it inherits from the data folder.
      Invoke-Icacls $dataDir @('/deny', "*${sid}:(OI)(CI)F")
      Invoke-Icacls $agentPluginsDir @('/grant', "*${sid}:(OI)(CI)RX")
      Invoke-Icacls $workDir @('/grant', "*${sid}:(OI)(CI)M")
      foreach ($folder in $readFolders) { Invoke-Icacls $folder @('/grant', "*${sid}:(OI)(CI)RX") }
    }
    'agent_account_remove' {
      $sid = if ($existing) { $existing.SID.Value } else { [string]$record.sid }
      if ($sid -notmatch '^S-1-5-21-[0-9-]+$') { Write-Result $false "The agent account's identity is not a local account's" }
      $folders = @($dataDir, $agentPluginsDir, $workDir) + @($record.grants | ForEach-Object { [string]$_.path })
      foreach ($folder in ($folders | Where-Object { $_ } | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $folder) { Invoke-Icacls $folder @('/remove', "*$sid") }
      }
      if ($existing) {
        Get-CimInstance -ClassName Win32_UserProfile | Where-Object { $_.SID -eq $sid } | Remove-CimInstance
        Remove-LocalUser -SID $sid
      }
      Remove-ItemProperty -Path $hiddenAccountsKey -Name $account -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $agentRecordFile -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Result $true "Done: $plan"
} catch {
  Write-Result $false ("Failed: " + $_.Exception.Message)
}
