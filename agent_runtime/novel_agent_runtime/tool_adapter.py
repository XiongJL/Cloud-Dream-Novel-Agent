from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Protocol

from fastmcp import Client, FastMCP
from fastmcp.tools import Tool, ToolResult
from mcp.types import ToolAnnotations
from pydantic import PrivateAttr

from .automation import AutomationInvokeError
from .tool_manifest import AGENT_TOOL_MANIFEST, AgentToolDefinition


class AutomationInvoker(Protocol):
    async def invoke(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        origin: str = "desktop-ui",
        request_id: str | None = None,
    ) -> Any: ...

    async def cancel(self, request_id: str) -> bool: ...


class AgentToolAdapter(Protocol):
    transport_name: str

    async def invoke(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        origin: str = "desktop-ui",
        request_id: str | None = None,
    ) -> Any: ...

    async def cancel(self, request_id: str) -> bool: ...

    async def list_tools(self) -> list[str]: ...


class HttpAgentToolAdapter:
    transport_name = "http"

    def __init__(self, upstream: AutomationInvoker) -> None:
        self.upstream = upstream
        self._allowed_tools = frozenset(definition.name for definition in AGENT_TOOL_MANIFEST)

    async def invoke(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        origin: str = "desktop-ui",
        request_id: str | None = None,
    ) -> Any:
        if method not in self._allowed_tools:
            raise AutomationInvokeError("TOOL_NOT_ALLOWED", f"Tool is not registered for Agent use: {method}")
        return await self.upstream.invoke(method, params, origin, request_id=request_id)

    async def cancel(self, request_id: str) -> bool:
        return await self.upstream.cancel(request_id)

    async def list_tools(self) -> list[str]:
        return [definition.name for definition in AGENT_TOOL_MANIFEST]


@dataclass(frozen=True)
class _InvocationContext:
    origin: str
    request_id: str | None


_INVOCATION_CONTEXT: ContextVar[_InvocationContext | None] = ContextVar(
    "novel_agent_fastmcp_invocation",
    default=None,
)


class _AutomationProxyTool(Tool):
    _upstream: AutomationInvoker = PrivateAttr()

    def __init__(self, definition: AgentToolDefinition, upstream: AutomationInvoker) -> None:
        super().__init__(
            name=definition.name,
            description=definition.description,
            parameters=definition.input_schema,
            annotations=ToolAnnotations(
                readOnlyHint=definition.read_only,
                destructiveHint=not definition.read_only,
                idempotentHint=definition.read_only,
                openWorldHint=False,
            ),
        )
        self._upstream = upstream

    async def run(self, arguments: dict[str, Any]) -> ToolResult:
        context = _INVOCATION_CONTEXT.get()
        if context is None:
            return self.convert_result({
                "ok": False,
                "code": "FASTMCP_CONTEXT_MISSING",
                "message": "FastMCP invocation context is missing",
            })
        try:
            data = await self._upstream.invoke(
                self.name,
                arguments,
                context.origin,
                request_id=context.request_id,
            )
            return self.convert_result({"ok": True, "data": data})
        except AutomationInvokeError as error:
            return self.convert_result({
                "ok": False,
                "code": error.code,
                "message": error.message,
                "details": error.details,
                "statusCode": error.status_code,
            })
        except Exception as error:
            return self.convert_result({
                "ok": False,
                "code": "FASTMCP_UPSTREAM_ERROR",
                "message": str(error),
            })


class FastMcpAgentToolAdapter:
    transport_name = "fastmcp"

    def __init__(self, upstream: AutomationInvoker, timeout_seconds: float = 90) -> None:
        self.upstream = upstream
        self.timeout_seconds = timeout_seconds
        self.server = FastMCP(
            "CloudDream Novel Agent Tools",
            instructions="Internal Agent tools. Side-effect tools require an approved plan before invocation.",
            strict_input_validation=True,
        )
        for definition in AGENT_TOOL_MANIFEST:
            self.server.add_tool(_AutomationProxyTool(definition, upstream))
        self._allowed_tools = frozenset(definition.name for definition in AGENT_TOOL_MANIFEST)
        self._tool_timeouts = {definition.name: definition.timeout_seconds for definition in AGENT_TOOL_MANIFEST}

    async def invoke(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        origin: str = "desktop-ui",
        request_id: str | None = None,
    ) -> Any:
        if method not in self._allowed_tools:
            raise AutomationInvokeError("TOOL_NOT_ALLOWED", f"Tool is not registered for Agent use: {method}")
        call_timeout = self._tool_timeouts.get(method, self.timeout_seconds)
        token = _INVOCATION_CONTEXT.set(_InvocationContext(origin=origin, request_id=request_id))
        try:
            try:
                async with Client(self.server, timeout=max(self.timeout_seconds, call_timeout)) as client:
                    result = await client.call_tool(
                        method,
                        params or {},
                        timeout=call_timeout,
                        raise_on_error=True,
                    )
            except AutomationInvokeError:
                raise
            except Exception as error:
                raise AutomationInvokeError("FASTMCP_PROTOCOL_ERROR", str(error)) from error
        finally:
            _INVOCATION_CONTEXT.reset(token)
        payload = result.data
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            payload = payload if isinstance(payload, dict) else {}
            raise AutomationInvokeError(
                str(payload.get("code") or "FASTMCP_TOOL_ERROR"),
                str(payload.get("message") or f"FastMCP tool failed: {method}"),
                payload.get("details"),
                payload.get("statusCode") if isinstance(payload.get("statusCode"), int) else None,
            )
        return payload.get("data")

    async def cancel(self, request_id: str) -> bool:
        return await self.upstream.cancel(request_id)

    async def list_tools(self) -> list[str]:
        async with Client(self.server, timeout=self.timeout_seconds) as client:
            return [tool.name for tool in await client.list_tools()]
