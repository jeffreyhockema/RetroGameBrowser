<#
.SYNOPSIS
  Builds the Retro Game Browser installer: dist\installer\RetroGameBrowser-Setup-<version>.exe.

.DESCRIPTION
  Stages the app into installer\stage (its code, public pages, the browser emulators in vendor\
  and its production node_modules), adds a Node.js of its own and WinSW (which runs it as a
  Windows service), and compiles installer\RetroGameBrowser.iss with Inno Setup.

  Needs, on the building PC:
    - the emulators fetched: npm run fetch-scummvm, npm run fetch-emulators, npm run fetch-mame
    - Inno Setup 6 (winget install JRSoftware.InnoSetup; -AutoInstallInnoSetup does it)
    - the internet the first time, for Node.js and WinSW (kept in installer\.cache after)

      PS> npm run package
      PS> .\installer\package.ps1 -Version 1.0

.PARAMETER Version
  The installer's version (its file name, and Add/Remove Programs). Defaults to package.json's,
  shown as the app shows it ("0.9" for 0.9.0).

.PARAMETER NodeMajor
  The Node.js LTS line to bundle; the newest release in it is used unless NodeVersion pins one.

.PARAMETER NodeVersion
  An exact Node.js version to bundle, such as 22.16.0.

.PARAMETER NoBuild
  Stages only, without compiling the installer.
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$NodeMajor = '22',
  [string]$NodeVersion = '',
  [string]$WinSwUrl = 'https://github.com/winsw/winsw/releases/download/v3.0.0-alpha.11/WinSW-net461.exe',
  # The SHA-256 of that file. The release lists no checksum of its own, so this is pinned; a new
  # WinSwUrl needs its own.
  [string]$WinSwSha256 = '91bce26b4fa3a7534e7967c1804d7417737b7169014435e5b3b31924bf19f3ee',
  [switch]$NoBuild,
  [switch]$AutoInstallInnoSetup
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service\_common.ps1')

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$StageDir = Join-Path $PSScriptRoot 'stage'
$CacheDir = Join-Path $PSScriptRoot '.cache'
$IssFile  = Join-Path $PSScriptRoot 'RetroGameBrowser.iss'
$OutDir   = Join-Path $RepoRoot 'dist\installer'

function Assert-Sha256([string]$File, [string]$Expected) {
  $actual = (Get-FileHash -Path $File -Algorithm SHA256).Hash
  if ($actual -ne $Expected) {
    Remove-Item -Force $File
    throw "$(Split-Path $File -Leaf) doesn't match its SHA-256 (expected $Expected, got $actual); it was deleted."
  }
}

function Copy-Tree([string]$From, [string]$To, [string[]]$ExcludeFiles = @(), [string[]]$ExcludeDirs = @()) {
  $robocopyArgs = @($From, $To, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($ExcludeFiles.Count) { $robocopyArgs += '/XF'; $robocopyArgs += $ExcludeFiles }
  if ($ExcludeDirs.Count) { $robocopyArgs += '/XD'; $robocopyArgs += $ExcludeDirs }
  & robocopy @robocopyArgs | Out-Null
  # robocopy: 0-7 is success of one kind or another, 8 and up a failure.
  if ($LASTEXITCODE -ge 8) { throw "robocopy $From failed (exit $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}

# ---- Version ----
# package.json's, without a patch number of 0 ("0.9" for 0.9.0), as the app shows it (see server/lib/build.js).
if (-not $Version) { $Version = (Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version -replace '^(\d+\.\d+)\.0$', '$1' }
Write-Step "Building the installer for version $Version"

# ---- The emulators must be there: they're fetched, not in git ----
$vendor = @{ 'scummvm-web' = 'npm run fetch-scummvm'; 'emulatorjs' = 'npm run fetch-emulators'; 'mame' = 'npm run fetch-mame' }
foreach ($name in $vendor.Keys) {
  if (-not (Test-Path (Join-Path $RepoRoot "vendor\$name"))) { throw "vendor\$name is missing: run $($vendor[$name]) first." }
}

# ---- Stage ----
if (Test-Path $StageDir) { Remove-Item -Path $StageDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $StageDir, $CacheDir, $OutDir | Out-Null

Write-Step 'Staging the app'
foreach ($f in @('package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md')) { Copy-Item (Join-Path $RepoRoot $f) -Destination $StageDir }
# The installed copy's README is the one for people who install it (installer\README.md, also the
# text of an installer release), not the project's.
Copy-Item (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $StageDir 'README.md')
Copy-Tree (Join-Path $RepoRoot 'server') (Join-Path $StageDir 'server') -ExcludeFiles '*.test.js'
Copy-Tree (Join-Path $RepoRoot 'public') (Join-Path $StageDir 'public')
Copy-Tree (Join-Path $RepoRoot 'docs') (Join-Path $StageDir 'docs')
# ScummVM's gui-icons (pictures for its own game list, which never shows here) stay out, from a
# copy fetched before scripts/fetch-scummvm-web.mjs left them out.
foreach ($name in $vendor.Keys) { Copy-Tree (Join-Path $RepoRoot "vendor\$name") (Join-Path $StageDir "vendor\$name") -ExcludeDirs 'gui-icons' }
# Only the lock-out helper from scripts\: the rest fetch and build things, for development.
New-Item -ItemType Directory -Force -Path (Join-Path $StageDir 'scripts') | Out-Null
Copy-Item (Join-Path $RepoRoot 'scripts\local-account.mjs') -Destination (Join-Path $StageDir 'scripts')
Write-Ok 'server, public, vendor and scripts\local-account.mjs'

# Which build this is (see server/lib/build.js): an installed copy has no git to ask.
Push-Location $RepoRoot
try {
  $commit = (& git rev-parse --short HEAD 2>$null)
  $dirty = [bool](& git --no-optional-locks status --porcelain --untracked-files=no 2>$null)
} finally { Pop-Location }
@{ commit = $commit; dirty = $dirty; version = $Version; packaged = (Get-Date).ToString('o') } | ConvertTo-Json |
  Set-Content -Path (Join-Path $StageDir 'build-info.json') -Encoding ASCII
Write-Ok "Build $commit$(if ($dirty) { ' (with changes not committed)' })"

Write-Step 'Installing production dependencies into the stage'
Push-Location $StageDir
try {
  & npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }
Write-Ok 'node_modules'

# ---- Service files ----
Write-Step 'Staging the service scripts'
$serviceDest = Join-Path $StageDir 'service'
New-Item -ItemType Directory -Force -Path $serviceDest | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'service\*') -Destination $serviceDest
Copy-Item (Join-Path $PSScriptRoot 'RetroGameBrowser.xml') -Destination $serviceDest
Copy-Item (Join-Path $PSScriptRoot 'WinSW-LICENSE.txt') -Destination $serviceDest

# ---- Node.js ----
if (-not $NodeVersion) {
  Write-Step "Finding the newest Node.js $NodeMajor LTS"
  try {
    $index = Invoke-WebRequest -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 15 | ForEach-Object Content | ConvertFrom-Json
    $lts = @($index | Where-Object { $_.lts -and $_.version -like "v$NodeMajor.*" })
    if (-not $lts.Count) { throw "no LTS release in Node $NodeMajor" }
    $NodeVersion = $lts[0].version.TrimStart('v')
  } catch {
    # Offline: the newest one already downloaded.
    $cached = Get-ChildItem $CacheDir -Filter "node-v$NodeMajor.*-win-x64.zip" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $cached) { throw "Couldn't reach nodejs.org ($($_.Exception.Message)) and no Node.js is cached." }
    $NodeVersion = $cached.Name -replace '^node-v(.+)-win-x64\.zip$', '$1'
    Write-Note "Offline: using the cached Node.js $NodeVersion"
  }
}
$nodeName = "node-v$NodeVersion-win-x64.zip"
$nodeZip = Join-Path $CacheDir $nodeName
# The zip's SHA-256 from nodejs.org's SHASUMS256.txt, kept beside the cached zip so an offline
# build still checks it.
$nodeSum = "$nodeZip.sha256"
if (-not (Test-Path $nodeSum)) {
  $sums = Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -UseBasicParsing | ForEach-Object Content
  $line = ($sums -split "`n") | Where-Object { $_ -match "^([0-9a-f]{64})\s+$([regex]::Escape($nodeName))\s*$" } | Select-Object -First 1
  if (-not $line -or $line -notmatch '^([0-9a-f]{64})') { throw "nodejs.org's SHASUMS256.txt for $NodeVersion doesn't list $nodeName." }
  Set-Content -Path $nodeSum -Value $Matches[1] -Encoding ASCII
}
$nodeExpected = (Get-Content $nodeSum -Raw).Trim()
if (-not (Test-Path $nodeZip)) {
  Write-Step "Downloading Node.js $NodeVersion"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/$nodeName" -OutFile $nodeZip -UseBasicParsing
}
Assert-Sha256 $nodeZip $nodeExpected
$extract = Join-Path $CacheDir 'node-extract'
if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
Expand-Archive -Path $nodeZip -DestinationPath $extract -Force
$inner = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
# node.exe is all the service runs; npm and the rest stay out.
New-Item -ItemType Directory -Force -Path (Join-Path $StageDir 'node') | Out-Null
Copy-Item (Join-Path $inner.FullName 'node.exe'), (Join-Path $inner.FullName 'LICENSE') -Destination (Join-Path $StageDir 'node')
Remove-Item -Recurse -Force $extract
Write-Ok "Node.js $NodeVersion"

# ---- WinSW ----
$winswCached = Join-Path $CacheDir 'WinSW.exe'
if (-not (Test-Path $winswCached)) {
  Write-Step 'Downloading WinSW'
  Invoke-WebRequest -Uri $WinSwUrl -OutFile $winswCached -UseBasicParsing
}
Assert-Sha256 $winswCached $WinSwSha256
Copy-Item $winswCached -Destination (Join-Path $StageDir "$($Global:RgbServiceId).exe")
Write-Ok "WinSW as $($Global:RgbServiceId).exe"

# ---- Icon ----
& node (Join-Path $PSScriptRoot 'make-icon.mjs') (Join-Path $StageDir 'app.ico')
if ($LASTEXITCODE -ne 0) { throw "Couldn't make the icon (exit $LASTEXITCODE)" }

$stageBytes = (Get-ChildItem $StageDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Ok ("Stage: {0:N0} MB" -f ($stageBytes / 1MB))
if ($NoBuild) {
  Write-Ok "Staged only: $StageDir"
  return
}

# ---- Inno Setup ----
function Find-Iscc {
  $candidates = @(
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $onPath = Get-Command iscc -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1',
                     'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1',
                     'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1')) {
    $loc = (Get-ItemProperty -Path $key -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
    if ($loc -and (Test-Path (Join-Path $loc 'ISCC.exe'))) { return (Join-Path $loc 'ISCC.exe') }
  }
  return $null
}

$iscc = Find-Iscc
if (-not $iscc -and $AutoInstallInnoSetup) {
  Write-Step 'Installing Inno Setup with winget'
  & winget install --id JRSoftware.InnoSetup --silent --accept-package-agreements --accept-source-agreements
  $iscc = Find-Iscc
}
if (-not $iscc) { throw 'Inno Setup 6 is needed: winget install JRSoftware.InnoSetup (or run this with -AutoInstallInnoSetup).' }

Write-Step "Compiling the installer (this takes several minutes: the emulators are over a gigabyte)"
$env:RGB_VERSION = $Version
& $iscc /Q $IssFile
if ($LASTEXITCODE -ne 0) { throw "ISCC failed (exit $LASTEXITCODE)" }

$output = Get-Item (Join-Path $OutDir "RetroGameBrowser-Setup-$Version.exe")
Write-Host ''
Write-Host 'Build complete.' -ForegroundColor Green
Write-Host "  $($output.FullName)"
Write-Host ("  {0:N0} MB" -f ($output.Length / 1MB))
