@echo off
set ELECTRON_RUN_AS_NODE=
set ROOKI_DEV=1
cd /d D:\web practice\rooki2
start /min python D:\web practice\rooki2\stt_server.py
start /min node D:\web practice\rooki2\tools/agent/server.mjs
start /min npx vite --host 0.0.0.0 --port 5173
timeout /t 10 >nul
start /min node_modules\electron\dist\electron.exe .

