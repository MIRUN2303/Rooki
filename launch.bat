@echo off
setlocal

cd /d "%~dp0"

echo [LAUNCHER] Starting ROOKI2...
echo [LAUNCHER] Project: %cd%

REM --- Use Python 3.13 (has numpy) ---
set PYTHON=C:\Users\mirun\AppData\Local\Programs\Python\Python313\python.exe
if not exist "%PYTHON%" (
    echo [LAUNCHER] Python 3.13 not found at %PYTHON%
    echo [LAUNCHER] Falling back to system python...
    set PYTHON=python
)

echo [LAUNCHER] Using Python: %PYTHON%
%PYTHON% --version

REM --- Check node_modules ---
if not exist "node_modules" (
    echo [LAUNCHER] node_modules not found, running npm install...
    call npm install
)

REM --- Start servers in a new window ---
echo [LAUNCHER] Starting servers...
start "ROOKI2 - Servers" cmd /c "concurrently -k -n VITE,STT,AGENT -c green,cyan,yellow \"vite\" \"C:\\Users\\mirun\\AppData\\Local\\Programs\\Python\\Python313\\python.exe stt_server.py\" \"node tools/agent/server.mjs\""

REM --- Wait for servers to be ready ---
echo [LAUNCHER] Waiting for servers to start...
timeout /t 4 /nobreak >nul

REM --- Open browser ---
echo [LAUNCHER] Opening browser...
start http://localhost:5173

echo [LAUNCHER] Launched! Close the server window to stop.
pause
