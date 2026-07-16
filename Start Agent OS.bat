@echo off
setlocal enabledelayedexpansion
title MYTHOS — Personal AI OS
chcp 65001 >nul
cd /d "%~dp0mythos"

REM --- Free up MYTHOS ports from any previous run before starting -----------
REM 4478 = main server, 5050 = edge-tts sidecar, 9222 = browser CDP debug port.
echo Freeing previous MYTHOS ports (4478, 5050, 9222) if occupied...
for %%P in (4478 5050 9222) do (
    for /f "tokens=5" %%A in ('netstat -aon ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        echo   - port %%P held by PID %%A, killing...
        taskkill /F /PID %%A >nul 2>nul
    )
)

if not exist ".env" (
    if exist ".env.example" (
        echo Creating .env from .env.example ...
        copy /y ".env.example" ".env" >nul
    )
)

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

REM Launch split-view via Windows Terminal: left = MYTHOS server, right = live backend logs.
REM Falls back to single-pane mode if wt.exe is unavailable.
where wt.exe >nul 2>nul
if %errorlevel%==0 (
    start "" http://127.0.0.1:4478
    wt.exe -d "%~dp0mythos" --title "MYTHOS SERVER" cmd /k "node src/main.js" ^; split-pane -V -d "%~dp0mythos" --title "BACKEND LOGS" cmd /k "node scripts/live-logs.js"
) else (
    echo Windows Terminal not found — starting in single-pane mode.
    start "" http://127.0.0.1:4478
    node src/main.js
    pause
)
