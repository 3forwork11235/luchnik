@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal
title Archer online (Tuna)
cls
echo ==========================================
echo    ARCHER ONLINE - Tuna
echo ==========================================
echo.

echo [+] Checking the running Tuna application...
set "TUNA_URL="
for /f "tokens=*" %%a in ('powershell -NoProfile -Command "try { $s = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/v1/status' -TimeoutSec 5; if ($s.connected -and $s.address) { $s.address -replace '^http://','https://' } else { 'ERROR' } } catch { 'ERROR' }"') do set "TUNA_URL=%%a"

if not defined TUNA_URL goto :TUNA_ERROR
if "%TUNA_URL%"=="ERROR" goto :TUNA_ERROR

set "PYTHON=python"
if exist "%~dp0.venv\Scripts\python.exe" set "PYTHON=%~dp0.venv\Scripts\python.exe"

echo [+] Checking game server on port 8765...
powershell -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
    echo [+] Starting game server...
    start "Archer server" /MIN "%PYTHON%" -X utf8 "%~dp0server.py"
) else (
    echo [+] Game server is already running.
)

powershell -NoProfile -Command "$deadline = (Get-Date).AddSeconds(15); do { if (Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); exit 1" >nul 2>&1
if errorlevel 1 goto :SERVER_ERROR

cls
echo ==========================================
echo    ARCHER ONLINE - Ready!
echo ==========================================
echo.
echo  Both players open this address in a browser (PC, Android, iPhone):
echo.
echo      %TUNA_URL%
echo.
echo  If Tuna shows a warning page, press "Visit" - the game opens after it.
echo  One player presses "Create game" and sends the invite link,
echo  the other one opens the link (or enters the game ID).
echo.
echo  Tuna must forward to http://127.0.0.1:8765  (command: tuna http 8765)
echo  Keep Tuna and the server windows open while playing.
echo.
pause >nul
exit /b 0

:TUNA_ERROR
echo [!] Could not read an active Tuna tunnel from http://127.0.0.1:4040/v1/status
echo [!] Start a tunnel to the game server with: tuna http 8765
echo [!] Leave Tuna running, then run this file again.
echo.
pause
exit /b 1

:SERVER_ERROR
echo [!] The game server did not start listening on port 8765.
echo [!] Run start_server.bat to see the error.
echo.
pause
exit /b 1
