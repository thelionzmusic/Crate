@echo off
rem Double-click to build Crate.exe. Takes a few minutes the first time.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
echo.
pause
