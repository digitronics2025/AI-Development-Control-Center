<#
.SYNOPSIS
  Removes the shortcuts created by install.ps1. Task history and settings in
  %LOCALAPPDATA%\AIDevControlCenter are kept.
#>
[CmdletBinding()]
param()

$programs = [Environment]::GetFolderPath('Programs')
$startup = [Environment]::GetFolderPath('Startup')
foreach ($path in @(
    (Join-Path $programs 'AI Control Center.lnk'),
    (Join-Path $programs 'Stop AI Control Center.lnk'),
    (Join-Path $startup 'AI Control Center (background).lnk'))) {
  if (Test-Path $path) { Remove-Item -Force $path; Write-Host "Removed $path" }
}
