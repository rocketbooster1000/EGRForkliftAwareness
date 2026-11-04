@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  set "AWARELY_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
) else (
  set "AWARELY_NODE=node.exe"
)
if not "%AWARELY_NODE%"=="node.exe" if not exist "%AWARELY_NODE%" (
  echo Install Node.js 20 or newer, then run this file again.
  pause
  exit /b 1
)
pushd "%~dp0"
"%AWARELY_NODE%" server.cjs
popd
endlocal
