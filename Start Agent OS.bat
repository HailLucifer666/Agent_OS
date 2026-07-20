@echo off
setlocal enabledelayedexpansion
title MYTHOS - Personal AI OS
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
REM The browser-agent writes its launched Chrome/Edge PID to .browser-agent.pid.
REM If MYTHOS died without a clean shutdown, that browser survives invisibly
REM and keeps playing audio - kill it before booting.
REM
REM PHASE 3 HARDENING: before tree-killing, verify the PID's command line
REM actually looks like a MYTHOS-launched browser - it must contain "MYTHOS"
REM or "chrome-debug-profile". This protects the operator's own browser if the
REM pidfile ever holds a wrong PID.
REM
REM NOTE: parens inside REM lines confuse cmd's multi-line if-block parser
REM because REM does not escape parens. Keep all explanatory text ABOVE the
REM if-block, never inside it. Also NOTE: wmic was deprecated and removed by
REM Microsoft from Windows 11; use PowerShell Get-CimInstance instead.
if exist ".browser-agent.pid" (
    set /p ORPHAN_PID=<".browser-agent.pid"
    if defined ORPHAN_PID (
        set "ORPHAN_CMD="
        for /f "usebackq tokens=*" %%C in (`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=!ORPHAN_PID!' | Select-Object -First 1).CommandLine" 2^>nul`) do set "ORPHAN_CMD=%%C"
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
            echo     MYTHOS-launched browser. Skipping kill to protect the operator.
            echo     Delete .browser-agent.pid manually if it is stale.
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

REM Launch split-view via Windows Terminal: left = MYTHOS server, right = live
REM backend logs. Falls back to single-pane mode if wt.exe is unavailable.
REM
REM Why it is shaped this way (2026-07-21, reconciling a half-applied prior edit
REM whose comments described a `start /wait` + arg-form approach the code never
REM actually used):
REM   - `start "" wt.exe ...` launches Windows Terminal in its OWN window and
REM     returns immediately (wt.exe is a GUI app; /wait would not help and is
REM     NOT used). The two panes live in that WT window; this launcher window is
REM     separate and just reports status, then pauses at end-of-file so nothing
REM     ever slams shut silently.
REM   - The ;-delimited split-pane subcommand form IS used (escaped as ^; so cmd
REM     passes a literal ; through to wt.exe). Each pane's -d takes !MYTHOS_DIR!
REM     via delayed expansion so the spaced repo path ("D:\Agen OS\...") survives
REM     wt.exe's reparse. Each pane ends with `& pause` so a crash stays visible.
where wt.exe >nul 2>nul
if %errorlevel%==0 (
    echo Launching Windows Terminal split-view...
    start "" http://127.0.0.1:4478
    start "" wt.exe -d "!MYTHOS_DIR!" --title "MYTHOS SERVER" cmd /k "node src/main.js & echo. & echo [MYTHOS SERVER exited] & pause" ^; split-pane -V -d "!MYTHOS_DIR!" --title "BACKEND LOGS" cmd /k "node scripts/live-logs.js & echo. & echo [BACKEND LOGS exited] & pause"
    REM Give wt.exe a moment to open its window before this launcher pauses.
    timeout /t 2 /nobreak >nul
    echo Windows Terminal launched in a separate window - MYTHOS is running there.
) else (
    echo Windows Terminal not found - starting in single-pane mode.
    start "" http://127.0.0.1:4478
    node src/main.js
    echo.
    echo [MYTHOS exited with code %errorlevel%]
)

REM Final safety net: ALWAYS pause before this launcher window closes, no matter
REM which branch above ran. The difference between "opens + closes silently" and
REM "stays open so you can read any error".
echo.
echo ============================================================
echo Launcher finished. Press any key to close this window.
echo ============================================================
pause >nul
