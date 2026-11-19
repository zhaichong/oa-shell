@echo off
cd /d "%~dp0"
if exist "%~dp0dist\win-unpacked\oa-shell.exe" (
  start "" "%~dp0dist\win-unpacked\oa-shell.exe"
  exit /b
)
call npm start
