#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Chooses the Windows account the Retro Game Browser service runs as.

.DESCRIPTION
  The service starts out as NT AUTHORITY\LocalService, which can't read a LaunchBox inside
  someone's user folder (C:\Users\<name>\LaunchBox, where LaunchBox installs itself) or on a
  network share. Run as a Windows account that can, it reads what that account reads.

  Asks for the account and its password (for a Microsoft account, the name of the account on
  this PC, such as .\alex, with the Microsoft account's password), gives the account the right
  to run services, lets it write the data folder, and restarts the service. A wrong password is
  caught and the service goes back to the account it had.

  Mapped drive letters (X:) belong to a signed-in session and a service never sees them: give the
  setup page the network path (\\server\share\LaunchBox) instead.

  Start menu: Retro Game Browser > Run the service as a Windows account.

.PARAMETER LocalService
  Goes back to NT AUTHORITY\LocalService.
#>
[CmdletBinding()]
param(
  [switch]$LocalService,
  [string]$DataDir
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$ServiceId = $Global:RgbServiceId
if (-not $DataDir) { $DataDir = $Global:RgbDataDir }

if (-not (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue)) { throw "The service $ServiceId isn't installed." }
$before = Get-RgbServiceAccount
Write-Host "The service runs as $before now."

# Grants "Log on as a service" (what services.msc does when an account is chosen there; sc.exe
# doesn't), through the Local Security Authority.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class RgbLsa {
  [StructLayout(LayoutKind.Sequential)] struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LSA_OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public int Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LSA_OBJECT_ATTRIBUTES attrs, int access, out IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr handle, byte[] sid, LSA_UNICODE_STRING[] rights, int count);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  public static void Grant(string account, string right) {
    var sid = (SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier));
    var bytes = new byte[sid.BinaryLength];
    sid.GetBinaryForm(bytes, 0);
    var attrs = new LSA_OBJECT_ATTRIBUTES();
    IntPtr policy;
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attrs, 0x00000800 | 0x00000010, out policy);
    if (status != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(status));
    try {
      var name = new LSA_UNICODE_STRING();
      name.Buffer = Marshal.StringToHGlobalUni(right);
      name.Length = (ushort)(right.Length * 2);
      name.MaximumLength = (ushort)(name.Length + 2);
      try {
        status = LsaAddAccountRights(policy, bytes, new[] { name }, 1);
        if (status != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(status));
      } finally { Marshal.FreeHGlobal(name.Buffer); }
    } finally { LsaClose(policy); }
  }
}
'@

function Set-Account([string]$User, [string]$Password) {
  Stop-Service -Name $ServiceId -Force -ErrorAction SilentlyContinue
  # Windows PowerShell drops an empty argument, and sc.exe needs one for an account with no password.
  if (-not $Password) { $Password = '""' }
  $out = & sc.exe config $ServiceId obj= $User password= $Password
  if ($LASTEXITCODE -ne 0) { throw "sc.exe couldn't change the account: $out" }
}

if ($LocalService) {
  $user = 'NT AUTHORITY\LocalService'
  Write-Step "Switching to $user"
  Set-Account $user ''
} else {
  $default = "$env:USERDOMAIN\$env:USERNAME"
  $cred = Get-Credential -UserName $default -Message "The Windows account Retro Game Browser runs as: one that can read your LaunchBox folder. For a Microsoft account, use this PC's name for it (such as .\$env:USERNAME) and the Microsoft account's password."
  if (-not $cred) { Write-Note 'Nothing changed.'; return }
  $user = $cred.UserName
  if ($user -notmatch '\\|@') { $user = ".\$user" }
  # NTAccount wants the PC's name, not "."
  $lookup = $user -replace '^\.\\', "$env:COMPUTERNAME\"
  Write-Step "Letting $user run services"
  [RgbLsa]::Grant($lookup, 'SeServiceLogonRight')
  Write-Step "Switching the service to $user"
  Set-Account $user $cred.GetNetworkCredential().Password
}

Write-Step 'Letting it write the data folder'
Set-RgbDataAcl -DataDir $DataDir -Account $user

Write-Step 'Starting the service'
try {
  Start-Service -Name $ServiceId
} catch {
  Write-Note "It wouldn't start as ${user}: $($_.Exception.Message)"
  Write-Note 'Usually a wrong password. Going back to the account it had.'
  if ($before -match 'LocalService') { Set-Account 'NT AUTHORITY\LocalService' '' } else { Write-Note "Set $before again in services.msc: its password isn't known here." }
  Set-RgbDataAcl -DataDir $DataDir -Account $before
  Start-Service -Name $ServiceId -ErrorAction SilentlyContinue
  exit 1
}
$port = Get-RgbPort $DataDir
if (Wait-RgbServer -Port $port -Seconds 30) {
  Write-Host ''
  Write-Host "The service now runs as $user." -ForegroundColor Green
  Write-Host "Back in the browser, check your LaunchBox folder again: http://localhost:$port"
} else {
  Write-Note "The service started as $user but nothing answered at http://localhost:$port yet. Its log is in $DataDir\logs."
}
