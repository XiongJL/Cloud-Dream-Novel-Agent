from __future__ import annotations

import os
from pathlib import Path
import sys

from novel_agent_runtime.automation import AutomationClient, AutomationInvokeError


def resolve_runtime_path(explicit: str | None = None) -> Path:
    """Explicit paths never fall through into another running application's data."""
    selected = explicit or os.environ.get("NOVEL_EDITOR_RUNTIME_FILE")
    if selected:
        return Path(selected)
    user_data = os.environ.get("NOVEL_EDITOR_USER_DATA")
    if user_data:
        return Path(user_data) / "automation" / "runtime.json"
    base = Path(os.environ["APPDATA"]) if os.environ.get("APPDATA") else (
        Path.home() / "Library" / "Application Support" if sys.platform == "darwin"
        else Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    )
    candidates = [base / name / "automation" / "runtime.json" for name in (
        "云梦小说智能体", "云梦小说编辑器", "@novel-editor/desktop-dev",
    )]
    existing = []
    for candidate in candidates:
        try:
            existing.append((candidate.stat().st_mtime_ns, candidate))
        except FileNotFoundError:
            pass
    if not existing:
        raise AutomationInvokeError("APP_NOT_RUNNING", "桌面应用未运行，或 automation runtime 文件不存在。")
    return max(existing, key=lambda item: item[0])[1]


class DesktopConnection(AutomationClient):
    """Pin one request (including cancellation) to one desktop instance."""

    invoke_path = "/mcp/invoke"

    def __init__(self, runtime_path: Path, timeout_seconds: float):
        super().__init__(runtime_path, timeout_seconds)
        self._runtime_snapshot = super()._read_runtime()

    def _read_runtime(self):
        return self._runtime_snapshot
