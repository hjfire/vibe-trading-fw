@echo off
chcp 65001 >nul
title Vibe-Trading Launcher

echo ==================================================
echo   Vibe-Trading 一键启动
echo ==================================================
echo.

:: 启动后端 API 服务 (端口 8000)
echo [1/2] 启动后端 API 服务...
start "Vibe-Trading Backend" cmd /k "cd /d %~dp0agent && python api_server.py"

:: 等待后端启动
timeout /t 3 /nobreak >nul

:: 启动前端开发服务 (端口 5899)
echo [2/2] 启动前端开发服务...
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
