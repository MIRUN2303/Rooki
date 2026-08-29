@echo off
setlocal EnableExtensions

REM ============================================================
REM  ROOKI launcher - single entry point.
REM  Electron spawns STT / agent / vite as children and kills
REM  them all when you close the window.
REM ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "ELECTRON_RUN_AS_NODE="

if /i "%~1"=="--shortcut" goto shortcut
if not exist "%ROOT%\node_modules\electron" (
  echo [LAUNCHER] Installing dependencies, first run...
  pushd "%ROOT%"
  call npm install
  popd
)

set "ROOKI_DEV=1"
start "ROOKI" "%ROOT%\node_modules\electron\dist\electron.exe" "%ROOT%"
echo [LAUNCHER] ROOKI launched. Close the window to stop all services.
exit /b 0

:shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([IO.Path]::Combine($env:USERPROFILE,'Desktop','Rooki.lnk')); $s.TargetPath = 'cmd.exe'; $s.Arguments = '/c ""%~f0""'; $s.WorkingDirectory = '%ROOT%'; $s.IconLocation = 'shell32.dll,13'; $s.Save()"
echo [LAUNCHER] Desktop shortcut created.
echo [LAUNCHER] Shortcut location: %USERPROFILE%\Desktop\Rooki.lnk
pause
exit /b 0