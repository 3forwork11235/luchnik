@echo off
rem Собирает APK «Лучника» из index.html и room.js этой папки
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
pause
