@echo off
setlocal enabledelayedexpansion
title MYTHOS - Desktop (Electron)
chcp 65001 >nul
cd /d "%~dp0"

REM Start Electron App.bat — desktop launcher for the MYTHOS Electron shell
REM (electron/main.js, spine §13). Electron wraps the existing server: it
REM fork()s mythos/src/main.js on loopback and loads the HUD in a BrowserWindow.
REM
REM Conventions mirror "Start Agent OS.bat": %~dp0-relative (the repo path
REM contains a space, so quote everything), UTF-8 codepage, free MYTHOS-owned
REM ports before boot, sync deps on a fresh checkout, pause at the end so an
REM error stays visible rather than slamming the window shut.
REM
REM What this does NOT do (vs Start Agent OS.bat): no Windows Terminal
REM split-pane — Electron IS the window, and the server runs as the forked
REM child inside it. No browser-pane helper either — Electron opens its own.

REM --- Free up MYTHOS ports from any previous run before starting -----------
REM 4478 = the forked server child's HTTP port, 5050 = edge-tts sidecar the
REM child autostarts. Both are always MYTHOS-owned, safe to kill blindly.
REM If 4478 is held, the child can't bind -> the window loads a dead URL.
echo Freeing previous MYTHOS ports (4478, 5050) if occupied...
for %%P in (4478 5050) do (
    for /f "tokens=5" %%A in ('netstat -aon ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        echo   - port %%P held by PID %%A, killing...
        taskkill /F /PID %%A >nul 2>nul
    )
)

REM --- Dependency sync (Electron is a ~180MB devDep, not in a fresh clone) ---
REM The root package.json carries electron + electron-builder as devDeps; they
REM install to the repo-root node_modules/ (gitignored), separate from
REM mythos/node_modules/. On first run — or after a pull that touched the root
REM lockfile — install them. Same drift signal as Start Agent OS.bat: compare
REM the inner .package-lock.json marker's LastWriteTime against the root one.
set "NEEDS_INSTALL=0"
set "LOCK_DRIFT="
if not exist "node_modules" set "NEEDS_INSTALL=1"
if not exist "node_modules\.package-lock.json" set "NEEDS_INSTALL=1"
if exist "package-lock.json" if exist "node_modules\.package-lock.json" (
    for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "if((Get-Item 'package-lock.json').LastWriteTime -gt (Get-Item 'node_modules\.package-lock.json').LastWriteTime){'drift'}" 2^>nul`) do set "LOCK_DRIFT=%%D"
    if /i "!LOCK_DRIFT!"=="drift" set "NEEDS_INSTALL=1"
)
if "!NEEDS_INSTALL!"=="1" (
    echo Syncing Electron dependencies against package-lock.json...
    call npm install
    if errorlevel 1 (
        echo Dependency install failed. See messages above.
        echo If electron's postinstall was blocked, run: npm approve-scripts -a
        pause
        exit /b 1
    )
)

REM --- Launch Electron --------------------------------------------------------
REM npm start runs "electron electron/main.js" (root package.json). Electron
REM opens its own GUI window; the forked server boots inside it. The window
REM stays open until the operator closes it, at which point main.js kills the
REM child cleanly (see the app 'before-quit' handler).
echo.
echo Launching MYTHOS Desktop (Electron)...
echo Close the app window to exit. The server shuts down with it.
echo.
call npm start
set "ELCODE=!errorlevel!"

REM Final safety net: ALWAYS pause before this window closes. The difference
REM between "opens + closes silently" and "stays open so you can read any error".
echo.
echo ============================================================
if !ELCODE! neq 0 (
    echo MYTHOS Desktop exited with code !ELCODE!.
) else (
    echo MYTHOS Desktop exited.
)
echo Press any key to close this launcher window.
echo ============================================================
pause >nul
