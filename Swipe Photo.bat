@echo off
setlocal
title Swipe Photo
cd /d "%~dp0"
chcp 65001 >nul

rem Swipe Photo untuk Windows: klik dua kali file ini.
rem Butuh Node.js 18+ (https://nodejs.org). Tanpa instalasi lain.

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(+process.versions.node.split('.')[0] < 18 ? 1 : 0)"
if errorlevel 1 goto oldnode

echo.
echo   Swipe Photo sedang berjalan.
echo   Browser akan terbuka otomatis di http://localhost:4321
echo.
echo   JANGAN tutup jendela ini selama memakai Swipe Photo.
echo   Kalau sudah selesai, tutup saja jendela ini.
echo.
set HOST=127.0.0.1
node server.js
if errorlevel 1 pause
exit /b

:oldnode
echo.
echo   Versi Node.js di komputer ini terlalu lama.
echo   Swipe Photo butuh Node.js versi 18 atau lebih baru.
goto download

:nonode
echo.
echo   Node.js belum terpasang di komputer ini.
echo   Swipe Photo butuh Node.js versi 18 atau lebih baru.

:download
echo.
echo   Halaman download Node.js akan dibuka. Pasang versi LTS,
echo   lalu klik dua kali file "Swipe Photo.bat" ini lagi.
echo.
start "" "https://nodejs.org/id/download"
pause
exit /b 1
