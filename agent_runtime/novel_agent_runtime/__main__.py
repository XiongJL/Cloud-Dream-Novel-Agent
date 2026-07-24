from __future__ import annotations

import json


def _report_progress(phase: str) -> None:
    print(
        "@@NOVEL_AGENT_PROGRESS@@" + json.dumps({"phase": phase}, ensure_ascii=False),
        flush=True,
    )


_report_progress("loading_web_server")
import uvicorn  # noqa: E402,F401
import fastapi  # noqa: E402,F401

_report_progress("loading_graph_engine")
import langgraph.graph  # noqa: E402,F401
import langgraph.checkpoint.sqlite  # noqa: E402,F401

_report_progress("loading_tool_protocol")
import fastmcp  # noqa: E402,F401

_report_progress("loading_runtime")

from .main import main  # noqa: E402


if __name__ == "__main__":
    main()
