# Shared by the Retro Game Browser service scripts. Dot-source from each:
#   . (Join-Path $PSScriptRoot '_common.ps1')
#
# Keep in step with installer\RetroGameBrowser.xml (<id>) and installer\RetroGameBrowser.iss
# (ServiceId, AppPort).

$Global:RgbServiceId = 'RetroGameBrowser'
$Global:RgbDisplayName = 'Retro Game Browser'
$Global:RgbDataDir = Join-Path $env:ProgramData 'RetroGameBrowser'
$Global:RgbDefaultPort = 6502
$Global:RgbFirewallRule = 'Retro Game Browser'
# Built-in accounts by SID, which reads the same in every Windows language.
$Global:RgbLocalServiceSid = 'S-1-5-19'

function Write-Step($msg) { Write-Host ">> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   $msg" -ForegroundColor Green }
function Write-Note($msg) { Write-Host "   $msg" -ForegroundColor Yellow }

# The port the server listens on: config.local.json's, or the default.
function Get-RgbPort([string]$DataDir) {
  $config = Join-Path $DataDir 'config.local.json'
  if (Test-Path $config) {
    try {
      $port = (Get-Content $config -Raw | ConvertFrom-Json).port
      if ($port) { return [int]$port }
    } catch { }
  }
  return $Global:RgbDefaultPort
}

# The account the service runs as, as Windows has it ("NT AUTHORITY\LocalService", ".\alex").
function Get-RgbServiceAccount {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$($Global:RgbServiceId)'" -ErrorAction SilentlyContinue
  if ($svc) { return $svc.StartName }
  return $null
}

# The data folder is the service's and the administrators' alone: it holds the accounts'
# password hashes and sessions. Inheritance from ProgramData (where every user may read) is cut,
# and the service's account may change what's in it.
function Set-RgbDataAcl([string]$DataDir, [string]$Account) {
  $grants = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
  if (-not $Account -or $Account -match '^NT AUTHORITY\\LocalService$') {
    $grants += "*$($Global:RgbLocalServiceSid):(OI)(CI)M"
  } else {
    $grants += "$($Account -replace '^\.\\', "$env:COMPUTERNAME\"):(OI)(CI)M"
  }
  & icacls.exe $DataDir /inheritance:r /grant:r @grants /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls couldn't set the data folder's permissions (exit $LASTEXITCODE)." }
}

# Waits for the server to answer on its port; $true once it does.
function Wait-RgbServer([int]$Port, [int]$Seconds = 30) {
  for ($i = 0; $i -lt $Seconds * 2; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $null = Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 2
      return $true
    } catch {
      # An answer with an error status still means it's up.
      if ($_.Exception.Response) { return $true }
    }
  }
  return $false
}
