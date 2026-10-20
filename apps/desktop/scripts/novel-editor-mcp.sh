#!/bin/sh
# Packaged gateway uses the bundled executable, never a system Python/Node.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/../agent-runtime/novel-agent-runtime" ]; then
  exec "$SCRIPT_DIR/../agent-runtime/novel-agent-runtime" --mode mcp-stdio "$@"
fi
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
PYTHON=${NOVEL_EDITOR_PYTHON_EXE:-"$REPO_ROOT/agent_runtime/.venv/bin/python"}
if [ ! -x "$PYTHON" ]; then
  echo '[novel-editor-mcp] Project Python missing; sync agent_runtime/.venv first.' >&2
  exit 1
fi
cd "$REPO_ROOT/agent_runtime" || exit 1
exec "$PYTHON" -m novel_mcp "$@"
