@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if exist "%SCRIPT_DIR%..\agent-runtime\novel-agent-runtime.exe" (
  "%SCRIPT_DIR%..\agent-runtime\novel-agent-runtime.exe" --mode mcp-stdio %*
  exit /b
)
set "RUNTIME_ROOT=%SCRIPT_DIR%..\..\..\agent_runtime"
set "PYTHON_EXE=%RUNTIME_ROOT%\.venv\Scripts\python.exe"
if defined NOVEL_EDITOR_PYTHON_EXE set "PYTHON_EXE=%NOVEL_EDITOR_PYTHON_EXE%"
if not exist "%PYTHON_EXE%" (
  echo [novel-editor-mcp] Project Python missing. Sync agent_runtime/.venv or set NOVEL_EDITOR_PYTHON_EXE. 1>&2
  exit /b 1
)
pushd "%RUNTIME_ROOT%"
"%PYTHON_EXE%" -m novel_mcp %*
set "MCP_EXIT=%ERRORLEVEL%"
popd
exit /b %MCP_EXIT%
