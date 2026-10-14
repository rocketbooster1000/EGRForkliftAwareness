@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  set "SURROUND_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
) else (
  set "SURROUND_NODE=node.exe"
)
if not "%SURROUND_NODE%"=="node.exe" if not exist "%SURROUND_NODE%" (
  echo Install Node.js 20 or newer, then run this file again.
  pause
  exit /b 1
)
pushd "%~dp0"
"%SURROUND_NODE%" server.cjs
popd
endlocal
