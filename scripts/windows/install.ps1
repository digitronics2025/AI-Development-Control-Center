<#
.SYNOPSIS
  Adds per-user shortcuts for the AI Development Control Center (no admin
  rights needed):
    - Start menu: "AI Control Center" (starts the orchestrator, opens the dashboard)
    - Start menu: "Stop AI Control Center"
    - with -AutoStart: a Startup-folder shortcut that starts the orchestrator
      at sign-in without opening a browser.

  Remove them with uninstall.ps1.
#>
[CmdletBinding()]
param([switch]$AutoStart)

$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$start = Join-Path $PSScriptRoot 'start-control-center.ps1'
$stop = Join-Path $PSScriptRoot 'stop-control-center.ps1'
$programs = [Environment]::GetFolderPath('Programs')
$startup = [Environment]::GetFolderPath('Startup')

function New-Shortcut([string]$path, [string]$script, [string]$extraArgs, [string]$description) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $powershell
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" $extraArgs".Trim()
  $link.WorkingDirectory = $PSScriptRoot
  $link.Description = $description
  $link.WindowStyle = 7 # minimized
  $link.Save()
  Write-Host "Created $path"
}

New-Shortcut (Join-Path $programs 'AI Control Center.lnk') $start '' 'Start the AI Development Control Center and open the dashboard'
New-Shortcut (Join-Path $programs 'Stop AI Control Center.lnk') $stop '' 'Stop the AI Development Control Center orchestrator'
if ($AutoStart) {
  New-Shortcut (Join-Path $startup 'AI Control Center (background).lnk') $start '-NoBrowser' 'Start the AI Development Control Center orchestrator at sign-in'
}
