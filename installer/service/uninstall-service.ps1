#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Removes the Retro Game Browser service and its firewall rule.

.DESCRIPTION
  Stops and unregisters the service. The data folder (config, accounts, favorites, cache, logs)
  is kept unless -RemoveData is given, so installing again picks up where it left off. The
  uninstaller asks whether to delete it.

.PARAMETER InstallDir
  The folder the service runs from. Defaults to the one above this script's.

.PARAMETER DataDir
  The data folder. Defaults to C:\ProgramData\RetroGameBrowser.

.PARAMETER RemoveData
  Deletes the data folder too.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$DataDir,
  [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$ServiceId = $Global:RgbServiceId
if (-not $DataDir) { $DataDir = $Global:RgbDataDir }
$winswExe = Join-Path $InstallDir "$ServiceId.exe"
$winswXml = Join-Path $InstallDir "$ServiceId.xml"

if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
  Write-Step 'Stopping the service'
  Stop-Service -Name $ServiceId -Force -ErrorAction SilentlyContinue
  Write-Step 'Unregistering the service'
  if ((Test-Path $winswExe) -and (Test-Path $winswXml)) {
    & $winswExe uninstall $winswXml --no-elevate | Out-Null
  } else {
    & sc.exe delete $ServiceId | Out-Null
  }
  Write-Ok 'Service removed'
} else {
  Write-Note "The service $ServiceId isn't installed."
}

Get-NetFirewallRule -DisplayName $Global:RgbFirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Ok 'Firewall rule removed'

if ($RemoveData) {
  if (Test-Path $DataDir) {
    Write-Step "Deleting $DataDir"
    Remove-Item -Path $DataDir -Recurse -Force
    Write-Ok 'Data folder deleted'
  }
} elseif (Test-Path $DataDir) {
  Write-Note "Data folder kept: $DataDir"
}
