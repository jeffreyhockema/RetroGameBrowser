#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs Retro Game Browser as a Windows service, or updates the one installed.

.DESCRIPTION
  Makes the data folder (config, accounts, cache and logs; C:\ProgramData\RetroGameBrowser),
  writes the service descriptor next to RetroGameBrowser.exe, registers the service the first
  time (as NT AUTHORITY\LocalService), lets it through Windows Firewall on private networks, and
  starts it. Run again over an installed copy (an update), it keeps the service as it is,
  including the Windows account it was set to run as, and only restarts it.

  The installer runs this hidden; its output goes to the data folder's logs\install-*.log.
  Run by hand from an elevated PowerShell:
      PS> & 'C:\Program Files\RetroGameBrowser\service\install-service.ps1'

.PARAMETER InstallDir
  The folder the service runs from. Defaults to the one above this script's.

.PARAMETER DataDir
  The folder the service writes to. Defaults to C:\ProgramData\RetroGameBrowser.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$DataDir
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$ServiceId = $Global:RgbServiceId
if (-not $DataDir) { $DataDir = $Global:RgbDataDir }

# ---- The data folder first, so the transcript can go in it ----
foreach ($sub in @('', 'logs', 'logs\service', 'userdata', 'cache')) {
  $p = if ($sub) { Join-Path $DataDir $sub } else { $DataDir }
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}
$LogFile = Join-Path $DataDir ("logs\install-{0:yyyy-MM-dd-HHmmss}.log" -f (Get-Date))
try { Start-Transcript -Path $LogFile -Force | Out-Null } catch { }
Write-Host "Install log: $LogFile"
Write-Host "InstallDir:  $InstallDir"
Write-Host "DataDir:     $DataDir"

# Anything that goes wrong ends here: said plainly, in the transcript, with exit code 1. The
# installer runs this hidden, so this is the only record.
trap {
  Write-Host ''
  Write-Host "[FATAL] $($_.Exception.Message)" -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor Red }
  Write-Host "Full log: $LogFile" -ForegroundColor Yellow
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}

# ---- What it needs ----
Write-Step 'Checking the install'
$nodeExe = Join-Path $InstallDir 'node\node.exe'
if (-not (Test-Path $nodeExe)) { throw "No Node.js at ${nodeExe}: the install is incomplete. Run the installer again." }
if (-not (Test-Path (Join-Path $InstallDir 'server\start.js'))) { throw "No server\start.js in ${InstallDir}: the install is incomplete." }
$winswExe = Join-Path $InstallDir "$ServiceId.exe"
if (-not (Test-Path $winswExe)) { throw "No $ServiceId.exe (WinSW) in ${InstallDir}: the install is incomplete." }
Write-Ok "Node $(& $nodeExe --version)"

# ---- Service descriptor ----
Write-Step 'Writing the service descriptor'
$template = Join-Path $InstallDir 'service\RetroGameBrowser.xml'
$winswXml = Join-Path $InstallDir "$ServiceId.xml"
# XML-escaped, in case the folder's name has an ampersand in it.
$dataDirXml = [System.Security.SecurityElement]::Escape($DataDir)
(Get-Content $template -Raw).Replace('@DATA_DIR@', $dataDirXml) | Set-Content -Path $winswXml -Encoding UTF8
Write-Ok $winswXml

# ---- Register, or keep the one there ----
$existing = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($existing) {
  Write-Step 'Service already installed: stopping it for the update'
  if ($existing.Status -ne 'Stopped') { Stop-Service -Name $ServiceId -Force }
  Write-Ok "Keeping it as it is (runs as $(Get-RgbServiceAccount))"
} else {
  Write-Step "Registering the service $ServiceId"
  & $winswExe install $winswXml --no-elevate
  if ($LASTEXITCODE -ne 0) { throw "WinSW couldn't register the service (exit $LASTEXITCODE)." }
  Write-Ok 'Registered, running as NT AUTHORITY\LocalService'
}

# ---- Data folder permissions (after the service exists, whose account they name) ----
Write-Step 'Setting the data folder''s permissions'
$account = Get-RgbServiceAccount
Set-RgbDataAcl -DataDir $DataDir -Account $account
Write-Ok "Administrators and $account"

# ---- Firewall ----
$port = Get-RgbPort $DataDir
Write-Step "Letting other devices on private networks reach port $port"
Get-NetFirewallRule -DisplayName $Global:RgbFirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $Global:RgbFirewallRule -Description 'Retro Game Browser, for phones, TVs and other computers on your home network.' `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Program $nodeExe -Profile Private,Domain | Out-Null
Write-Ok 'Firewall rule added (private and domain networks only)'

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  $owner = (Get-Process -Id $listening[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
  Write-Note "Port $port is already taken (by $owner): the service can't start until it's free."
}

# ---- Start ----
Write-Step 'Starting the service'
Start-Service -Name $ServiceId
if (Wait-RgbServer -Port $port -Seconds 30) {
  Write-Ok "Answering at http://localhost:$port"
  Write-Host ''
  Write-Host 'Install complete.' -ForegroundColor Green
  Write-Host "  Open:      http://localhost:$port"
  Write-Host "  Data:      $DataDir"
  Write-Host "  Logs:      $DataDir\logs"
  try { Stop-Transcript | Out-Null } catch { }
} else {
  Write-Note "The service started but nothing answered at http://localhost:$port within 30 seconds."
  Write-Note "Its log is in $DataDir\logs (and what it printed last in $DataDir\logs\service)."
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}
