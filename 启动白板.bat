@echo off
chcp 65001 >nul
title InkWell 白板

rem 清除会破坏 Electron 启动的环境变量
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
set ELECTRON_ENABLE_LOGGING=

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [提示] 首次运行，正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
  )
)

if not exist "src\renderer\bundle.js" call npm run build:renderer

echo 正在启动 InkWell 白板...
start "" "node_modules\electron\dist\electron.exe" "%~dp0"
exit /b 0
