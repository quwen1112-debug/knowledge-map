@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Knowledge Map - local gateway

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found.
  echo   Install Node.js 18+ from https://nodejs.org , then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting local model gateway...
echo   The real API key stays inside this process; the page only gets a short-lived token.
echo.

node gateway.js --open %*

echo.
echo   Gateway stopped. The page still works offline; only the AI is off.
pause
