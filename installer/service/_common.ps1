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

# The message at the bottom of an exception's chain, with the Windows error code when it has one.
# Start-Service's own message ("Cannot start service X on computer '.'") says nothing; the reason
# ("The service did not start due to a logon failure", say) is two exceptions down.
function Get-RgbInnermostMessage($Exception) {
  $ex = $Exception
  while ($ex.InnerException) { $ex = $ex.InnerException }
  $msg = $ex.Message.Trim()
  if ($ex -is [System.ComponentModel.Win32Exception]) { $msg += " (Windows error $($ex.NativeErrorCode))" }
  return $msg
}

# What Windows, WinSW and the server had to say about a service that didn't start: for the
# install log, which is all the installer's hidden run leaves behind.
function Write-RgbServiceDiagnostics([string]$DataDir, [datetime]$Since) {
  $id = $Global:RgbServiceId
  Write-Host ''
  Write-Host '---- Why the service didn''t start ----' -ForegroundColor Cyan

  # The program the service points at: antivirus quarantines an unsigned service program now
  # and then, and the service can't start without it.
  $svc = Get-CimInstance Win32_Service -Filter "Name='$id'" -ErrorAction SilentlyContinue
  if ($svc) {
    Write-Host "Service:      $($svc.PathName)"
    Write-Host "Runs as:      $($svc.StartName)  (state: $($svc.State))"
    $exe = if ($svc.PathName -match '^"([^"]+)"') { $Matches[1] } else { ($svc.PathName -split ' ')[0] }
    if ($exe -and -not (Test-Path $exe)) {
      Write-Note "$exe is missing. Check Windows Security > Protection history: an antivirus may have quarantined it. Restore it, then run the installer again."
    }
  } else {
    Write-Note "Windows has no service named $id."
  }

  # What Windows logged: the Service Control Manager (System log) and the service itself
  # (WinSW writes to the Application log under the service's name).
  foreach ($log in @(@{ LogName = 'System'; ProviderName = 'Service Control Manager' }, @{ LogName = 'Application'; ProviderName = $id })) {
    $events = @()
    try { $events = @(Get-WinEvent -FilterHashtable ($log + @{ StartTime = $Since.AddSeconds(-5) }) -MaxEvents 20 -ErrorAction Stop) } catch { }
    if ($log.LogName -eq 'System') { $events = @($events | Where-Object { $_.Message -match [regex]::Escape($id) -or $_.Message -match [regex]::Escape($Global:RgbDisplayName) }) }
    Write-Host "$($log.LogName) log ($($log.ProviderName)): $(if ($events.Count) { "$($events.Count) entries" } else { 'nothing' })"
    foreach ($e in ($events | Sort-Object TimeCreated)) {
      Write-Host ("  {0:HH:mm:ss}  [{1}] {2}" -f $e.TimeCreated, $e.Id, (($e.Message -replace '\s+', ' ').Trim()))
    }
  }

  # What WinSW and the server printed last.
  $files = @()
  $serviceLogs = Join-Path $DataDir 'logs\service'
  if (Test-Path $serviceLogs) { $files += Get-ChildItem $serviceLogs -Filter '*.log' -ErrorAction SilentlyContinue }
  $files += Get-ChildItem (Join-Path $DataDir 'logs') -Filter 'server-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  foreach ($f in $files) {
    if (-not $f) { continue }
    $tail = @(Get-Content $f.FullName -Tail 25 -ErrorAction SilentlyContinue)
    Write-Host "$($f.FullName) ($(if ($tail.Count) { "last $($tail.Count) lines" } else { 'empty' })):"
    foreach ($line in $tail) { Write-Host "  $line" }
  }
  if (-not (Test-Path $serviceLogs) -or -not (Get-ChildItem $serviceLogs -Filter '*.log' -ErrorAction SilentlyContinue)) {
    Write-Note "WinSW wrote nothing in $serviceLogs, so the program didn't get as far as running."
  }
  Write-Host '----'
}

# Waits for the server to answer on its port; $true once it does. Asked by name and by IPv4
# address both: a copy that hasn't been set up yet listens on 127.0.0.1 only, and "localhost"
# may go to ::1 first.
function Wait-RgbServer([int]$Port, [int]$Seconds = 30) {
  for ($i = 0; $i -lt $Seconds * 2; $i++) {
    Start-Sleep -Milliseconds 500
    foreach ($hostName in @('localhost', '127.0.0.1')) {
      try {
        $null = Invoke-WebRequest -Uri "http://${hostName}:$Port/" -UseBasicParsing -TimeoutSec 2
        return $true
      } catch {
        # An answer with an error status still means it's up.
        if ($_.Exception.Response) { return $true }
      }
    }
  }
  return $false
}
