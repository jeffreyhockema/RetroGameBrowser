; ========================================================================
;  Retro Game Browser: Inno Setup script
; ========================================================================
;
; Makes one Setup.exe that installs the app into C:\Program Files\RetroGameBrowser, with a
; Node.js of its own and WinSW, registers and starts the Windows service (service\install-
; service.ps1), and opens the setup page, where the owner points it at their LaunchBox and
; chooses how people sign in.
;
; Built by installer\package.ps1 (npm run package), which fills installer\stage first:
;     stage\
;       server\, public\, docs\, vendor\, node_modules\, scripts\local-account.mjs
;       package.json, package-lock.json, README.md, LICENSE, THIRD_PARTY_NOTICES.md
;       build-info.json, app.ico
;       node\node.exe, node\LICENSE a Node.js of its own
;       RetroGameBrowser.exe        WinSW, renamed
;       service\                    the service scripts, WinSW's descriptor template and licence
;
; What the server writes goes in C:\ProgramData\RetroGameBrowser (config, accounts, cache,
; logs), which an update keeps, and uninstalling offers to delete.
; ========================================================================

#define AppName "Retro Game Browser"
#define ServiceId "RetroGameBrowser"
#define AppPort "6502"
#define AppURL "http://localhost:" + AppPort
#define AppVersion GetEnv("RGB_VERSION")
#if AppVersion == ""
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{C11DEE03-355D-4A91-8211-8136CC215332}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppName}
AppPublisherURL={#AppURL}
DefaultDirName={autopf}\{#ServiceId}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputBaseFilename={#ServiceId}-Setup-{#AppVersion}
OutputDir=..\dist\installer
; The emulators are over a gigabyte, mostly WebAssembly, which LZMA2 packs well.
Compression=lzma2
SolidCompression=yes
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=4
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
SetupIconFile=stage\app.ico
UninstallDisplayIcon={app}\app.ico
UninstallDisplayName={#AppName}
; The service is stopped in PrepareToInstall, so nothing is left holding the files.
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[InstallDelete]
; An update replaces the app's own folders whole, so a file the new version no longer has
; doesn't linger.
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\public"
Type: filesandordirs; Name: "{app}\docs"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\vendor"

[Files]
Source: "stage\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; The service is always running: the site's address is the way in.
Name: "{group}\{#AppName}"; Filename: "{#AppURL}"; IconFilename: "{app}\app.ico"
; For a LaunchBox in a user folder or on a network share, which the service's own account can't read.
Name: "{group}\Run the service as a Windows account"; Filename: "{app}\service\service-account.cmd"; IconFilename: "{app}\app.ico"
; For when the installer's hidden run didn't get the service going: runs it again, visibly.
Name: "{group}\Repair the service"; Filename: "{app}\service\reinstall-service.cmd"; IconFilename: "{app}\app.ico"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{commondesktop}\{#AppName}"; Filename: "{#AppURL}"; IconFilename: "{app}\app.ico"; Tasks: desktopicon

[Run]
; The setup page, the first time (or the site, after an update).
Filename: "{#AppURL}"; Description: "Open {#AppName} to finish setting it up"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service\uninstall-service.ps1"" -InstallDir ""{app}"""; \
  Flags: runhidden waituntilterminated; RunOnceId: "RemoveRetroGameBrowserService"

[UninstallDelete]
; What the install script made next to the program: WinSW's descriptor, filled in.
Type: files; Name: "{app}\{#ServiceId}.xml"

[Code]
// The service is stopped before its files are replaced (an update). Stop-Service waits for it.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  Exec('powershell.exe', '-NoProfile -Command "Stop-Service -Name {#ServiceId} -Force -ErrorAction SilentlyContinue"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// Registers and starts the service once the files are in. Its output goes to the data folder's
// logs\install-*.log; a failure says where, and how to try again with the window showing.
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  WizardForm.StatusLabel.Caption := 'Starting the Retro Game Browser service...';
  if not Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\service\install-service.ps1') + '" -InstallDir "' + ExpandConstant('{app}') + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
  begin
    if not WizardSilent then
      MsgBox('The Retro Game Browser service didn''t start properly.' + #13#10#13#10 +
        'What happened is in ' + ExpandConstant('{commonappdata}') + '\RetroGameBrowser\logs (install-*.log, and the server''s own log).' + #13#10#13#10 +
        'To try again with the details showing, open Start > Retro Game Browser > Repair the service.',
        mbError, MB_OK);
  end;
end;

// Uninstalling keeps the owner's settings, accounts and favorites unless they say otherwise.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  DataDir := ExpandConstant('{commonappdata}\RetroGameBrowser');
  if not DirExists(DataDir) or UninstallSilent then Exit;
  if MsgBox('Also delete Retro Game Browser''s settings, accounts, favorites, play history, cache and logs?' + #13#10#13#10 +
      DataDir + #13#10#13#10 + 'Keep them to pick up where you left off if you install it again. Your LaunchBox folder isn''t touched either way.',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    DelTree(DataDir, True, True, True);
end;
