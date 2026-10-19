from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import anyio
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_context
from fastmcp.tools import Tool, ToolResult
from mcp.types import TextContent, ToolAnnotations
from pydantic import PrivateAttr

from novel_agent_runtime.automation import AutomationInvokeError
from .connection import DesktopConnection, resolve_runtime_path
from .contracts import load_tool_contracts


def create_registered_server(profile: str, tool_factory: Callable, **settings) -> FastMCP:
    server = FastMCP(strict_input_validation=True, **settings)
    for definition in load_tool_contracts(profile):
        server.add_tool(tool_factory(definition))
    return server


def _result(data: Any, *, is_error: bool = False) -> ToolResult:
    structured = data if isinstance(data, dict) else {"items": data} if isinstance(data, list) else {"value": data}
    return ToolResult(
        content=[TextContent(type="text", text=json.dumps(structured, ensure_ascii=False))],
        structured_content=structured,
        is_error=is_error,
    )


class DesktopProxyTool(Tool):
    _definition: dict = PrivateAttr()
    _runtime_path: str | None = PrivateAttr()

    def __init__(self, definition: dict, runtime_path: str | None = None):
        super().__init__(
            name=definition["name"], description=definition["description"],
            parameters=definition["inputSchema"],
            output_schema=definition["outputSchema"],
            annotations=ToolAnnotations(
                readOnlyHint=definition["readOnly"], destructiveHint=definition["destructive"],
                idempotentHint=definition["readOnly"] or definition["idempotent"], openWorldHint=False,
            ),
        )
        self._definition = definition
        self._runtime_path = runtime_path

    async def run(self, arguments: dict[str, Any]) -> ToolResult:
        request_id = uuid4().hex
        connection = None
        try:
            seconds = self._definition["timeoutSeconds"]
            connection = DesktopConnection(resolve_runtime_path(self._runtime_path), seconds)
            # MCP request IDs are connection-local; never use them as business IDs.
            parent = f"mcp:{get_context().request_id}"
            deadline = (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()
            with anyio.fail_after(seconds):
                data = await connection.invoke(
                    self.name, arguments, "mcp-bridge", request_id=request_id,
                    parent_request_id=parent, deadline_at=deadline,
                )
            return _result(data)
        except anyio.get_cancelled_exc_class():
            if connection:
                await _cancel(connection, request_id)
            raise
        except TimeoutError:
            if connection:
                await _cancel(connection, request_id)
            return _result({"code": "UPSTREAM_TIMEOUT", "message": "应用执行超时，原请求结果尚未确认。", "requestId": request_id}, is_error=True)
        except AutomationInvokeError as error:
            if connection and error.code == "UPSTREAM_TIMEOUT":
                await _cancel(connection, request_id)
            return _result({"code": error.code, "message": error.message, "details": error.details, "requestId": request_id}, is_error=True)


async def _cancel(connection, request_id):
    # A cancelled request's AnyIO scope would immediately cancel cleanup too.
    with anyio.CancelScope(shield=True):
        with anyio.move_on_after(3):
            try:
                await connection.cancel(request_id)
            except Exception:
                pass  # Cancelling cannot establish whether a side effect completed.


def build_mcp_server(runtime_path: str | None = None) -> FastMCP:
    return create_registered_server(
        "external_mcp", lambda definition: DesktopProxyTool(definition, runtime_path),
        name="novel-editor-mcp",
        instructions="调用桌面写作工具；长章节任务使用 chapter.draft.start 并查询状态。断开连接不撤销已受理任务。",
    )
