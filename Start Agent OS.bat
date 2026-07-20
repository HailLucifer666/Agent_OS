@echo off
setlocal enabledelayedexpansion
title MYTHOS — Personal AI OS
chcp 65001 >nul
cd /d "%~dp0mythos"

REM Capture the mythos dir ONCE as an env var. delayed-expansion !MYTHOS_DIR!
REM survives wt.exe's ;-delimited reparse (the bare "%~dp0mythos" form gets
REM unquoted by wt.exe when the path contains a space, e.g. "D:\Agen OS\..."
REM which is exactly why the window was opening + closing silently).
set "MYTHOS_DIR=%~dp0mythos"

REM --- Free up MYTHOS ports from any previous run before starting -----------
REM 4478 = main server, 5050 = edge-tts sidecar, 9222 = browser CDP debug port.
echo Freeing previous MYTHOS ports (4478, 5050, 9222) if occupied...
for %%P in (4478 5050 9222) do (
    for /f "tokens=5" %%A in ('netstat -aon ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        echo   - port %%P held by PID %%A, killing...
        taskkill /F /PID %%A >nul 2>nul
    )
)

REM --- BUG-029: kill any orphaned automation browser from a previous run ----
REM The browser-agent writes its launched Chrome/Edge PID to .browser-agent.pid
REM (both launchLocal in the adapter AND browser_launch_debug in from-browser.js
REM as of Phase 3 hardening). If MYTHOS died without a clean shutdown (terminal
REM closed), that browser survives invisibly and keeps playing audio — kill it
REM before booting.
REM
REM PHASE 3 HARDENING: before tree-killing, verify the PID's command line
REM actually looks like a MYTHOS-launched browser (contains "MYTHOS" or
REM "chrome-debug-profile"). This is a belt-and-suspenders check so that even
REM if something ever writes a wrong PID into the file (a bug, a stale file
REM from a different machine, an operator's own Chrome PID), this script will
REM NOT kill the operator's browser — it logs + skips instead.
if exist ".browser-agent.pid" (
    set /p ORPHAN_PID=<".browser-agent.pid"
    if defined ORPHAN_PID (
        REM Verify the PID's command line via wmic. delayed-expansion !ORPHAN_PID!
        REM is needed because we're inside an if-block.
        set "ORPHAN_CMD="
        for /f "tokens=2 delims==" %%C in ('wmic process where "ProcessId=!ORPHAN_PID!" get CommandLine /value 2^>nul ^| findstr "CommandLine"') do (
            set "ORPHAN_CMD=%%C"
        )
        set "PROVENANCE_OK=0"
        if defined ORPHAN_CMD (
            echo !ORPHAN_CMD! | findstr /i /c:"MYTHOS" >nul && set "PROVENANCE_OK=1"
            echo !ORPHAN_CMD! | findstr /i /c:"chrome-debug-profile" >nul && set "PROVENANCE_OK=1"
        )
        if "!PROVENANCE_OK!"=="1" (
            echo   - orphaned automation browser PID !ORPHAN_PID!, killing...
            taskkill /F /T /PID !ORPHAN_PID! >nul 2>nul
        ) else (
            echo   - NOTE: PID !ORPHAN_PID! in .browser-agent.pid does not look like a
            echo     MYTHOS-launched browser (command line did not contain "MYTHOS" or
            echo     "chrome-debug-profile"). Skipping kill to protect the operator's
            echo     own browser. Delete .browser-agent.pid manually if it is stale.
        )
    )
    del /f /q ".browser-agent.pid" >nul 2>nul
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
REM
REM FIX (2026-07-20): the wt.exe command previously used bare "%~dp0mythos"
REM which wt.exe's parser would unquote after the ; separator when the path
REM contained a space (e.g. "D:\Agen OS\..."). That made the window open and
REM close silently. Using !MYTHOS_DIR! (delayed expansion) keeps the quotes
REM intact across the reparse. Each pane also ends with `& pause` so any
REM boot/exit error stays visible instead of slamming the window shut.
where wt.exe >nul 2>nul
if %errorlevel%==0 (
    start "" http://127.0.0.1:4478
    wt.exe -d "!MYTHOS_DIR!" --title "MYTHOS SERVER" cmd /k "node src/main.js & echo. & echo [MYTHOS SERVER exited] & pause" ^; split-pane -V -d "!MYTHOS_DIR!" --title "BACKEND LOGS" cmd /k "node scripts/live-logs.js & echo. & echo [BACKEND LOGS exited] & pause"
) else (
    echo Windows Terminal not found — starting in single-pane mode.
    start "" http://127.0.0.1:4478
    node src/main.js
    echo.
    echo [MYTHOS exited with code %errorlevel%]
    pause
)
