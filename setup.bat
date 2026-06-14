@echo off
REM One-command FullBand setup (double-click me).
title FullBand setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
pause
