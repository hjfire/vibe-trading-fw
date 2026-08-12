@echo off
chcp 65001 >nul
title 同步官方最新代码

echo ==================================================
echo   从 GitHub 拉取最新代码（含官方自动同步的更新）
echo ==================================================
echo.

cd /d %~dp0

git checkout main
if errorlevel 1 (
    echo.
    echo [提示] 切换 main 分支失败，可能有未保存的改动，请先处理。
    pause
    exit /b 1
)

git pull
if errorlevel 1 (
    echo.
    echo [提示] 拉取失败，请检查网络或联系助手排查。
    pause
    exit /b 1
)

echo.
echo ==================================================
echo   同步完成！你的本地代码已是最新。
echo ==================================================
pause
