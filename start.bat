@echo off
chcp 65001 >nul
title Vibe-Trading Launcher

echo ==================================================
echo   Vibe-Trading 一键启动
echo ==================================================
echo.

:: 启动后端 API 服务 (端口 8000)
echo [1/3] 启动后端 API 服务...
start "Vibe-Trading Backend" cmd /k "cd /d %~dp0agent && python api_server.py"

:: Wait for the backend to actually answer before starting the frontend: Uvicorn
:: binds 8000 only after imports and the startup preflight (api_server.py lifespan)
:: finish, so the old fixed 3s sleep let the vite proxy hit a closed port and fill
:: the console with ECONNREFUSED - a startup race, not a failure.
:: Keep this block ASCII: cmd reads a UTF-8 .bat byte-by-byte and a long non-ASCII
:: comment line desynchronises the reader and gets the tail executed.
echo [2/3] waiting for backend, up to 90s...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 90;$i++){ try { Invoke-WebRequest -Uri 'http://127.0.0.1:8000/api/health' -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok=$true; break } catch { Start-Sleep -Seconds 1 } }; if(-not $ok){ exit 1 }"
if errorlevel 1 (
  echo       [WARN] backend did not answer within 90s, starting frontend anyway.
) else (
  echo       backend ready.
)

:: 启动前端开发服务 (端口 5899)
echo [3/3] 启动前端开发服务...
start "Vibe-Trading Frontend" cmd /k "cd /d %~dp0frontend && npm.cmd run dev"

echo.
echo ==================================================
echo   后端: http://127.0.0.1:8000
echo   前端: http://localhost:5899
echo ==================================================
echo.
echo 浏览器打开 http://localhost:5899 即可使用
echo 关闭对应的命令行窗口即可停止服务
pause
