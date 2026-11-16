@echo off
chcp 65001 >nul
cd /d "%~dp0"
title UNKNOWN CHAT CONTROL
if not exist "data\config.json" (
  echo Erst-Einrichtung wird gestartet...
  call npm run setup
)
call npm start
pause
