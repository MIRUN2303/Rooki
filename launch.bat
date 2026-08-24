@echo off
setlocal EnableExtensions

REM ============================================================
REM  ROOKI launcher - safe from any working directory
REM  All paths derive from this script's own location.
REM ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

REM optional: --shortcut installs a desktop .lnk pointing here
if /i "%~1"=="--shortcut" (
  powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([IO.Path]::Combine($env:USERPROFILE,'Desktop','Rooki.lnk')); $s.TargetPath = '%~f0'; $s.WorkingDirectory = '%ROOT%'; $s.IconLocation = '%ROOT%\tools\agent\server.mjs'; $s.Save()"
  echo [LAUNCHER] Desktop shortcut created.
  exit /b 0
)

echo [LAUNCHER] Project root: %ROOT%

REM ---------- resolve Python (venv first, then system) ----------
set "PY=%ROOT%\tools\venv\Scripts\python.exe"
if not exist "%PY%" for %%P in ("python3.13.exe" "python.exe") do call :findpy %%P
if not defined PY set "PY=python"
echo [LAUNCHER] Python: %PY%

REM ---------- resolve node ----------
set "NODE=node"
where node >nul 2>&1 || (echo [LAUNCHER][ERROR] Node.js not found in PATH & goto :fail)

REM ---------- helpers: is a port listening? ----------
set "PS=powershell -NoProfile -Command"

REM ---------- STT server (:8765) ----------
call :port_up 8765
if errorlevel 1 (
  echo [LAUNCHER] Starting STT server...
  start "ROOKI-STT" /min "%PY%" "%ROOT%\stt_server.py"
  call :wait_port 8765 90 || (echo [LAUNCHER][ERROR] STT server did not become ready on :8765 & goto :fail)
) else (
  echo [LAUNCHER] STT already running on :8765 - skipping
)

REM ---------- Agent bridge (:8766) ----------
call :port_up 8766
if errorlevel 1 (
  echo [LAUNCHER] Starting agent bridge...
  start "ROOKI-AGENT" /min "%NODE%" "%ROOT%\tools\agent\server.mjs"
  call :wait_port 8766 20 || (echo [LAUNCHER][ERROR] agent bridge did not start on :8766 & goto :fail)
) else (
  echo [LAUNCHER] Agent already running on :8766 - skipping
)

REM ---------- Vite frontend (:5173) ----------
call :port_up 5173
if errorlevel 1 (
  if not exist "%ROOT%\node_modules" (
    echo [LAUNCHER] Installing frontend dependencies...
    pushd "%ROOT%" && call npm install && popd
  )
  echo [LAUNCHER] Starting frontend...
  start "ROOKI-VITE" /min cmd /c "cd /d ""%ROOT%"" && npx vite --host 0.0.0.0 --port 5173"
  call :wait_port 5173 40 || (echo [LAUNCHER][ERROR] frontend did not start on :5173 & goto :fail)
) else (
  echo [LAUNCHER] Frontend already running on :5173 - skipping
)

REM ---------- all green -> open UI ----------
echo [LAUNCHER] All services ready. Opening http://localhost:5173
start "" http://localhost:5173
echo [LAUNCHER] Rooki is running. Close the ROOKI-* windows to stop it.
timeout /t 4 /nobreak >nul
exit /b 0

:findpy
for /f "delims=" %%F in ('where %~1 2^>nul') do (set "PY=%%F" & goto :eof)
goto :eof

:port_up
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient;try{$c.Connect('127.0.0.1',%1);$r=$c.Connected}catch{$r=$false};$c.Close();exit ([int]$r)" >nul 2>&1
if %errorlevel%==0 (exit /b 0) else (exit /b 1)

:wait_port
setlocal
set /a tries=0
:wait_loop
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient;try{$c.Connect('127.0.0.1',%1);$r=$c.Connected}catch{$r=$false};$c.Close();exit ([int]$r)" >nul 2>&1
if %errorlevel%==0 (endlocal & exit /b 0)
set /a tries+=1
if %tries% geq %2 (endlocal & exit /b 1)
timeout /t 1 /nobreak >nul
goto wait_loop

:fail
echo.
echo [LAUNCHER] Startup failed. Check the ROOKI-* windows above for the actual error.
pause
exit /b 1
