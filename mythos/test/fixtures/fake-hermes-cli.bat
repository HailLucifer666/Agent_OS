@echo off
rem Test fixture for hermes-adapter.test.js — stands in for the real `hermes`
rem binary. --version replies instantly (so probe() finds the CLI reachable);
rem -z hangs indefinitely (via `ping`, which sleeps without needing a console
rem input handle) so the runTask() timeout path is forced to actually fire
rem and tree-kill this process.
if "%~1"=="--version" (
  echo fake-hermes 0.0.0
  exit /b 0
)
if "%~1"=="-z" (
  ping -n 3600 127.0.0.1 >nul
  exit /b 0
)
exit /b 1
