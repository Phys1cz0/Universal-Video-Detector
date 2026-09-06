@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "LOG=%TEMP%\uvd_setup_coapp_%RANDOM%_%RANDOM%.log"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-coapp.ps1" > "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo setup-coapp.ps1 failed. The PowerShell script displayed and copied the full error when possible.
    echo.
    type "%LOG%"
    echo.
    echo Press any key to close this window.
    pause >nul
    del "%LOG%" >nul 2>&1
    exit /b %RC%
)

del "%LOG%" >nul 2>&1
exit /b 0
