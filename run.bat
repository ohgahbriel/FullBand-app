@echo off
REM Start FullBand (double-click me). Opens the mixer in your browser.
title FullBand
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"
