from __future__ import annotations

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
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
        parent_request_id: str | None = None,
        deadline_at: str | None = None,
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
        parent_request_id: str | None = None,
        deadline_at: str | None = None,
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
        parent_request_id: str | None = None,
        deadline_at: str | None = None,
    ) -> Any:
        if method not in self._allowed_tools:
            raise AutomationInvokeError("TOOL_NOT_ALLOWED", f"Tool is not registered for Agent use: {method}")
        normalized_params = normalize_tool_arguments(params or {})
        try:
            return await self.upstream.invoke(
                method, normalized_params, origin,
                request_id=request_id,
                parent_request_id=parent_request_id,
                deadline_at=deadline_at,
            )
        except TypeError as error:
            if "unexpected keyword argument" not in str(error):
                raise
            return await self.upstream.invoke(method, normalized_params, origin, request_id=request_id)

    async def cancel(self, request_id: str) -> bool:
        return await self.upstream.cancel(request_id)

    async def list_tools(self) -> list[str]:
        return [definition.name for definition in AGENT_TOOL_MANIFEST]


@dataclass(frozen=True)
class _InvocationContext:
    origin: str
    request_id: str | None
    parent_request_id: str | None
    deadline_at: str | None


_INVOCATION_CONTEXT: ContextVar[_InvocationContext | None] = ContextVar(
    "novel_agent_fastmcp_invocation",
    default=None,
)


def normalize_tool_arguments(value: Any) -> Any:
    """Normalize JSON tool arguments consistently for every transport."""
    if isinstance(value, dict):
        return {
            key: normalize_tool_arguments(item)
            for key, item in value.items()
            if item is not None
        }
    if isinstance(value, list):
        return [normalize_tool_arguments(item) for item in value]
    return value


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
                idempotentHint=definition.read_only or definition.idempotent,
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
            try:
                data = await self._upstream.invoke(
                    self.name,
                    arguments,
                    context.origin,
                    request_id=context.request_id,
                    parent_request_id=context.parent_request_id,
                    deadline_at=context.deadline_at,
                )
            except TypeError as error:
                if "unexpected keyword argument" not in str(error):
                    raise
                data = await self._upstream.invoke(
                    self.name, arguments, context.origin, request_id=context.request_id,
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
        parent_request_id: str | None = None,
        deadline_at: str | None = None,
    ) -> Any:
        if method not in self._allowed_tools:
            raise AutomationInvokeError("TOOL_NOT_ALLOWED", f"Tool is not registered for Agent use: {method}")
        call_timeout = self._tool_timeouts.get(method, self.timeout_seconds)
        if deadline_at:
            try:
                parsed_deadline = datetime.fromisoformat(deadline_at.replace("Z", "+00:00"))
                call_timeout = max(0.1, min(call_timeout, (parsed_deadline - datetime.now(timezone.utc)).total_seconds() - 1.0))
            except ValueError:
                pass
        token = _INVOCATION_CONTEXT.set(_InvocationContext(
            origin=origin,
            request_id=request_id,
            parent_request_id=parent_request_id,
            deadline_at=deadline_at,
        ))
        normalized_params = normalize_tool_arguments(params or {})
        try:
            try:
                # FastMCP's call timeout does not cover every part of the client
                # lifecycle (notably connection setup/teardown). Keep a hard
                # deadline around the complete in-process invocation so a run
                # cannot remain indefinitely on a tool_call event.
                async with asyncio.timeout(call_timeout):
                    async with Client(self.server, timeout=call_timeout) as client:
                        result = await client.call_tool(
                            method,
                            normalized_params,
                            timeout=call_timeout,
                            raise_on_error=True,
                        )
            except AutomationInvokeError:
                raise
            except TimeoutError as error:
                raise AutomationInvokeError(
                    "UPSTREAM_TIMEOUT",
                    f"FastMCP tool timed out after {call_timeout:g}s: {method}",
                    {"method": method, "timeoutSeconds": call_timeout},
                    504,
                ) from error
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
