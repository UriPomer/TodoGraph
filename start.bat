@echo off
chcp 65001 >nul
title TodoGraph

cd /d "%~dp0"

rem Check Node.js
where node >nul 2>nul
if errorlevel 1 goto :no_node

rem Check pnpm; try corepack if missing
where pnpm >nul 2>nul
if errorlevel 1 call corepack enable >nul 2>nul
where pnpm >nul 2>nul
if errorlevel 1 goto :no_pnpm

rem Install deps if node_modules is missing
if not exist "node_modules\" goto :install
goto :check_build

:install
echo [Setup] First run, installing dependencies (this may take a few minutes)...
call pnpm install
if errorlevel 1 goto :install_fail

:check_build
if not exist "packages\server\dist\" goto :build
goto :run

:build
echo [Setup] Building core packages...
call pnpm --filter @todograph/core --filter @todograph/shared --filter @todograph/server build
if errorlevel 1 goto :build_fail

:run
if "%PORT%"=="" set PORT=5173
echo ============================================
echo   TodoGraph Web Mode
echo   Open http://127.0.0.1:5174/
echo   Close this window to stop the server
echo ============================================
echo.

start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:5174/"

call pnpm dev
goto :end

:no_node
echo [ERROR] Node.js not found. Install Node 20+: https://nodejs.org/
pause
exit /b 1

:no_pnpm
echo [ERROR] pnpm not found. Run: npm install -g pnpm
pause
exit /b 1

:install_fail
echo [ERROR] pnpm install failed
pause
exit /b 1

:build_fail
echo [ERROR] build failed
pause
exit /b 1

:end
echo.
echo Server stopped.
pause
