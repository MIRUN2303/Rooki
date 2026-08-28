@echo off
setlocal EnableExtensions

REM ============================================================
REM  ROOKI launcher - instant loading screen + background services
REM  All paths derive from this script's own location.
REM ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

REM optional: --shortcut installs a desktop .lnk pointing here
if /i "%~1"=="--shortcut" goto shortcut
if /i "%~1"=="--desktop" goto desktop

echo [LAUNCHER] Starting ROOKI...
echo [LAUNCHER] Launcher: %~f0
echo [LAUNCHER] Project root: %ROOT%

REM ---------- resolve Python (venv first, then system) ----------
set "PY=%ROOT%\tools\venv\Scripts\python.exe"
if not exist "%PY%" (
  where python >nul 2>&1 && (
    for /f "tokens=*" %%a in ('where python') do set "PY=%%a"
  ) || (
    echo [LAUNCHER][ERROR] Python not found. Please install Python.
    goto fail
  )
)
echo [LAUNCHER] Python: %PY%

REM ---------- resolve node ----------
set "NODE=node"
where node >nul 2>&1
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE=C:\Program Files\nodejs\node.exe"
  ) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
    set "NODE=C:\Program Files (x86)\nodejs\node.exe"
  ) else (
    echo [LAUNCHER][ERROR] Node.js not found in PATH or common locations.
    echo [LAUNCHER][ERROR] Please install Node.js from https://nodejs.org/
    goto fail
  )
)
for /f "tokens=*" %%a in ('"%NODE%" --version') do echo [LAUNCHER] Node: %%a

REM ---------- open loading screen IMMEDIATELY ----------
start "" "%ROOT%\loading.html"

REM ---------- HTTP readiness check ----------
REM Usage: call :wait_for <port> <path> <max_wait_sec>
REM Returns 0 if ready, 1 if timeout

REM ---------- STT server (:8765) ----------
echo [LAUNCHER] Checking STT :8765...
call :wait_for 8765 /health 5
if errorlevel 1 (
  echo [LAUNCHER] Starting STT server...
  start "ROOKI-STT" /min "%PY%" "%ROOT%\stt_server.py"
  echo [LAUNCHER] Waiting for STT to load Parakeet model ^(2-3 minutes^)...
  call :wait_for 8765 /health 180
  if errorlevel 1 (
    echo [LAUNCHER][ERROR] STT server did not become ready on :8765
    echo [LAUNCHER][ERROR] Check the ROOKI-STT window for model loading errors.
    goto fail
  )
  echo [LAUNCHER] STT ready on :8765
) else (
  echo [LAUNCHER] STT already ready on :8765 - reusing
)

REM ---------- Agent bridge (:8766) ----------
echo [LAUNCHER] Checking Agent :8766...
call :wait_for 8766 /ping 5
if errorlevel 1 (
  echo [LAUNCHER] Starting agent bridge...
  start "ROOKI-AGENT" /min "%NODE%" "%ROOT%\tools\agent\server.mjs"
  call :wait_for 8766 /ping 20
  if errorlevel 1 (
    echo [LAUNCHER][ERROR] Agent bridge did not become ready on :8766
    goto fail
  )
) else (
  echo [LAUNCHER] Agent already ready on :8766 - reusing
)

REM ---------- Kokoro TTS (:8767) ----------
echo [LAUNCHER] Checking Kokoro TTS :8767...
call :wait_for 8767 /health 5
if errorlevel 1 (
  echo [LAUNCHER] Starting Kokoro TTS server...
  start "ROOKI-TTS" /min "%PY%" "%ROOT%\tts_server.py"
  call :wait_for 8767 /health 60
  if errorlevel 1 (
    echo [LAUNCHER][WARN] Kokoro TTS did not become ready on :8767 - voice will be unavailable
  )
) else (
  echo [LAUNCHER] Kokoro TTS already ready on :8767 - reusing
)

REM ---------- Vite frontend (:5173) ----------
echo [LAUNCHER] Checking Frontend :5173...
call :wait_for 5173 / 5
if errorlevel 1 (
  if exist "%ROOT%\node_modules" (
    echo [LAUNCHER] Starting frontend...
    start "ROOKI-VITE" /min cmd /c "cd /d "%ROOT%" && npx vite --host 0.0.0.0 --port 5173"
  ) else (
    echo [LAUNCHER] Installing frontend dependencies...
    pushd "%ROOT%"
    call npm install
    popd
    echo [LAUNCHER] Starting frontend...
    start "ROOKI-VITE" /min cmd /c "cd /d "%ROOT%" && npx vite --host 0.0.0.0 --port 5173"
  )
  call :wait_for 5173 / 60
  if errorlevel 1 (
    echo [LAUNCHER][ERROR] Frontend did not become HTTP-ready on :5173
    goto fail
  )
) else (
  echo [LAUNCHER] Frontend already ready on :5173 - reusing
)

REM ---------- all green ----------
echo [LAUNCHER] All services ready.
echo [LAUNCHER] ROOKI is loading...
exit /b 0

REM ============================================================
REM  Desktop mode - launches Electron shell
REM ============================================================
:desktop
echo [LAUNCHER] Starting ROOKI Desktop...

REM Check if node_modules exists
if not exist "%ROOT%\node_modules\electron" (
  echo [LAUNCHER] Installing Electron dependencies...
  pushd "%ROOT%"
  call npm install
  popd
)

REM Launch Electron (it manages services internally)
start "ROOKI" "%NODE%" "%ROOT%\node_modules\electron\cli.js" "%ROOT%"
echo [LAUNCHER] ROOKI Desktop launched.
exit /b 0

REM ============================================================
REM  Subroutines
REM ============================================================

:wait_for
REM Usage: call :wait_for <port> <path> <max_wait_sec>
REM Returns 0 if ready, 1 if timeout
setlocal
set "WF_PORT=%~1"
set "WF_PATH=%~2"
set /a WF_MAX=%3
set /a WF_TRIES=0
set /a WF_DOT=0
:wait_for_loop
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\tools\check_port.ps1" -Port %WF_PORT% -Path "%WF_PATH%" -TimeoutSec 2 >nul 2>&1
if %errorlevel%==0 (
  echo.
  endlocal
  exit /b 0
)
set /a WF_TRIES+=1
set /a WF_DOT+=1
if %WF_DOT%==10 (
  set /a WF_DOT=0
  <nul set /p=.
)
if %WF_TRIES% geq %WF_MAX% (
  echo.
  endlocal
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait_for_loop

:shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([IO.Path]::Combine($env:USERPROFILE,'Desktop','Rooki.lnk')); $s.TargetPath = 'cmd.exe'; $s.Arguments = '/c ""%~f0""'; $s.WorkingDirectory = '%ROOT%'; $s.IconLocation = 'shell32.dll,13'; $s.Save()"
echo [LAUNCHER] Desktop shortcut created.
echo [LAUNCHER] Shortcut location: %USERPROFILE%\Desktop\Rooki.lnk
pause
exit /b 0

:fail
echo.
echo [LAUNCHER] Startup failed. Check the ROOKI-* windows above for the actual error.
echo [LAUNCHER] Common issues:
echo   - Node.js not in PATH (install from https://nodejs.org)
echo   - Python venv missing (run tools\setup.ps1)
echo   - Port already in use (close other ROOKI instances)
pause
exit /b 1
