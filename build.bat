@echo off
chcp 65001 >nul
title TodoGraph - Build Portable EXE

cd /d "%~dp0"

rem Check Node.js
where node >nul 2>nul
if errorlevel 1 goto :no_node

rem Check pnpm; try corepack if missing
where pnpm >nul 2>nul
if errorlevel 1 call corepack enable >nul 2>nul
where pnpm >nul 2>nul
if errorlevel 1 goto :no_pnpm

echo ============================================
echo   TodoGraph - Build Portable EXE
echo ============================================
echo.
echo NOTE: if a `pnpm dev` / Electron is still running,
echo       close it first (Ctrl+C). Otherwise pnpm install
echo       can fail with EPERM on Windows.
echo.

rem --- Step 0: heal stale per-package node_modules if previous hoisted install was aborted ---
rem When node-linker=hoisted is in effect, the real packages live in the ROOT
rem node_modules (no .pnpm/ store). But an interrupted install may have left
rem packages\*\node_modules full of dangling symlinks pointing into the removed
rem .pnpm store. Detect that state and purge those per-package node_modules
rem so `pnpm install` can recreate them from scratch.
if exist "node_modules\" (
  if not exist "node_modules\.pnpm\" (
    echo [0/3] Healing per-package node_modules after previous aborted install...
    for /d %%i in ("packages\*") do (
      if exist "%%i\node_modules" (
        echo        removing %%i\node_modules
        rmdir /s /q "%%i\node_modules"
      )
    )
  )
)

rem --- Step 1: install dependencies ---
echo [1/3] Installing dependencies (pnpm install)...
call pnpm install
if errorlevel 1 goto :install_fail

rem --- Step 2: build all workspace packages ---
echo.
echo [2/3] Building core / shared / server / renderer...
call pnpm -r build
if errorlevel 1 goto :build_fail

rem --- Step 3: package portable exe ---
echo.
echo [3/3] Packaging Windows portable exe...
call pnpm --filter @todograph/app exec electron-builder --win portable
if errorlevel 1 goto :pkg_fail

echo.
echo ============================================
echo   Build succeeded
echo   Output: %~dp0Build\
echo ============================================
dir /b "Build\*.exe" 2>nul
echo.
echo Tip: double-click the portable .exe to run.
echo      User data is stored next to the exe, in a "data" folder.
echo.
pause
exit /b 0

:no_node
echo [ERROR] Node.js not found. Install Node 20+: https://nodejs.org/
pause
exit /b 1

:no_pnpm
echo [ERROR] pnpm not found. Run: npm install -g pnpm
pause
exit /b 1

:install_fail
echo.
echo [ERROR] pnpm install failed (usually EPERM on Windows).
echo   Most likely cause: a node.exe process still holds a file handle
echo   inside node_modules. Candidates:
echo     - A `pnpm dev` / Electron window still open
echo     - VS Code's TypeScript language server (open files via symlinks)
echo     - A zombie node.exe from a previous aborted install
echo.
echo   Fix:
echo     1) Close VS Code windows opened on this project
echo     2) Close any terminal running `pnpm dev` or `start.bat`
echo     3) Open Task Manager, end all node.exe that look like ours
echo     4) Re-run this bat. Step [0/3] will auto-purge stale links.
echo.
pause
exit /b 1

:build_fail
echo [ERROR] build failed (pnpm -r build)
pause
exit /b 1

:pkg_fail
echo [ERROR] electron-builder failed
pause
exit /b 1
