@echo off
:: Start menu: "Repair the service". Runs install-service.ps1 again with administrator rights, in
:: a window that stays open, for when the installer's hidden run didn't get the service going.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File','%~dp0install-service.ps1'"
