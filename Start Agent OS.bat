@echo off
setlocal
title MYTHOS — Personal AI OS
chcp 65001 >nul
cd /d "%~dp0mythos"

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

start "" http://127.0.0.1:4478
node src/main.js
pause
