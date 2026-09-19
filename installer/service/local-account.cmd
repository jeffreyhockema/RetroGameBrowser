@echo off
:: A way back in when the owner's local account password is forgotten (see scripts/local-account.mjs):
::   local-account list
::   local-account password <username>
::   local-account off
:: Run from a command prompt opened as administrator: the data folder is administrators' only. The
:: service is stopped meanwhile, since a running server keeps its own copy of the accounts.

setlocal
set "RGB_DATA_DIR=%ProgramData%\RetroGameBrowser"
set "APP=%~dp0.."
if /i not "%~1"=="list" net stop RetroGameBrowser >nul 2>&1
"%APP%\node\node.exe" "%APP%\scripts\local-account.mjs" %*
if /i not "%~1"=="list" net start RetroGameBrowser >nul 2>&1
endlocal
