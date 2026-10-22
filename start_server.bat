@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Archer server

set "PYTHON=python"
if exist "%~dp0.venv\Scripts\python.exe" set "PYTHON=%~dp0.venv\Scripts\python.exe"

"%PYTHON%" -c "import websockets" >nul 2>&1
if errorlevel 1 (
    echo [+] Installing websockets...
    "%PYTHON%" -m pip install -r requirements.txt
)

echo.
echo  If phones cannot open the address below, run open_firewall.bat once.
echo.
"%PYTHON%" -X utf8 server.py
pause
