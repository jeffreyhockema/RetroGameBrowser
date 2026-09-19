@echo off
:: Start menu: "Run the service as a Windows account". Asks for administrator rights and keeps the
:: window open so what happened can be read. With /local, goes back to NT AUTHORITY\LocalService.

set "EXTRA="
if /i "%~1"=="/local" set "EXTRA=,'-LocalService'"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File','%~dp0service-account.ps1'%EXTRA%"
