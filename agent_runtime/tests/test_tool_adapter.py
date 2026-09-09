from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
from fastmcp import Client

from novel_agent_runtime.automation import AutomationClient, AutomationInvokeError, resolve_automation_timeout
import novel_agent_runtime.tool_adapter as tool_adapter_module
from novel_agent_runtime.tool_adapter import FastMcpAgentToolAdapter, HttpAgentToolAdapter
from novel_agent_runtime.tool_manifest import AGENT_TOOL_BY_NAME, AVAILABLE_AGENT_TOOLS


class FailingTransport(httpx.AsyncBaseTransport):
    def __init__(self, error: httpx.TransportError) -> None:
        self.error = error

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        del request
        raise self.error


class FakeAutomationInvoker:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], str, str | None]] = []
        self.cancelled: list[str] = []
        self.deadlines: list[str | None] = []

    async def invoke(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        origin: str = "desktop-ui",
        request_id: str | None = None,
        parent_request_id: str | None = None,
        deadline_at: str | None = None,
    ) -> Any:
        del parent_request_id
        payload = params or {}
        self.calls.append((method, payload, origin, request_id))
        self.deadlines.append(deadline_at)
        if payload.get("forceError"):
            raise AutomationInvokeError("UPSTREAM_TEST_ERROR", "upstream failed", {"method": method}, 409)
        return {"method": method, "params": payload}

    async def cancel(self, request_id: str) -> bool:
        self.cancelled.append(request_id)
        return True


def test_http_tool_adapter_enforces_manifest_and_delegates() -> None:
    assert AGENT_TOOL_BY_NAME["chapter.generate_draft"].timeout_seconds == 390
    assert AGENT_TOOL_BY_NAME["creative_assets.generate_draft"].timeout_seconds == 240
    assert AGENT_TOOL_BY_NAME["chapter.get"].timeout_seconds == 90
    assert resolve_automation_timeout("agent.generate_plotline_analysis", 90) == 270
    assert resolve_automation_timeout("agent.generate_consistency_review", 90) == 360
    assert resolve_automation_timeout("agent.generate_report", 90) == 240
    assert resolve_automation_timeout("chapter.get", 30) == 90
    assert resolve_automation_timeout("unknown.method", 45) == 45
    async def scenario() -> None:
        upstream = FakeAutomationInvoker()
        adapter = HttpAgentToolAdapter(upstream)

        result = await adapter.invoke(
            "chapter.get",
            {"chapterId": "chapter_1", "optionalField": None},
            "desktop-ui",
            request_id="request_1",
            deadline_at="2030-01-01T00:00:00+00:00",
        )
        assert result["params"]["chapterId"] == "chapter_1"
        assert upstream.calls == [("chapter.get", {"chapterId": "chapter_1"}, "desktop-ui", "request_1")]
        assert upstream.deadlines == ["2030-01-01T00:00:00+00:00"]
        assert await adapter.list_tools() == AVAILABLE_AGENT_TOOLS

        try:
            await adapter.invoke("chapter.save", {"chapterId": "chapter_1"})
        except AutomationInvokeError as error:
            assert error.code == "TOOL_NOT_ALLOWED"
        else:
            raise AssertionError("unregistered tool was accepted")

    asyncio.run(scenario())


def test_fastmcp_tool_adapter_exposes_annotations_validates_and_preserves_errors() -> None:
    async def scenario() -> None:
        upstream = FakeAutomationInvoker()
        adapter = FastMcpAgentToolAdapter(upstream)

        assert await adapter.list_tools() == AVAILABLE_AGENT_TOOLS
        async with Client(adapter.server) as client:
            tools = {tool.name: tool for tool in await client.list_tools()}
        assert tools["chapter.get"].annotations.readOnlyHint is True
        assert tools["chapter.get"].annotations.destructiveHint is False
        assert tools["chapter.generate_draft"].annotations.readOnlyHint is False
        assert tools["chapter.generate_draft"].annotations.destructiveHint is True
        assert tools["chapter.draft.start"].annotations.idempotentHint is True
        assert tools["chapter.draft.get_status"].annotations.readOnlyHint is True
        assert tools["chapter.draft.cancel"].annotations.idempotentHint is True
        assert tools["creative_assets.validate_draft"].annotations.readOnlyHint is False
        assert tools["creative_assets.validate_draft"].annotations.destructiveHint is True

        result = await adapter.invoke(
            "chapter.get",
            {"chapterId": "chapter_2", "optionalField": None},
            "desktop-ui",
            request_id="request_2",
            deadline_at="2030-01-01T00:00:00+00:00",
        )
        assert result == {"method": "chapter.get", "params": {"chapterId": "chapter_2"}}
        assert upstream.calls[-1] == ("chapter.get", {"chapterId": "chapter_2"}, "desktop-ui", "request_2")
        assert upstream.deadlines[-1] == "2030-01-01T00:00:00+00:00"

        try:
            await adapter.invoke("chapter.get", {})
        except AutomationInvokeError as error:
            assert error.code == "FASTMCP_PROTOCOL_ERROR"
        else:
            raise AssertionError("invalid FastMCP arguments were accepted")
        assert len(upstream.calls) == 1

        try:
            await adapter.invoke("chapter.get", {"chapterId": "chapter_3", "forceError": True})
        except AutomationInvokeError as error:
            assert error.code == "UPSTREAM_TEST_ERROR"
            assert error.status_code == 409
            assert error.details == {"method": "chapter.get"}
        else:
            raise AssertionError("upstream error was not propagated")

        assert await adapter.cancel("request_2") is True
        assert upstream.cancelled == ["request_2"]

    asyncio.run(scenario())


def test_fastmcp_tool_adapter_hard_times_out_client_lifecycle(monkeypatch) -> None:
    class HangingClient:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "HangingClient":
            await asyncio.Event().wait()
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

    async def scenario() -> None:
        upstream = FakeAutomationInvoker()
        adapter = FastMcpAgentToolAdapter(upstream, timeout_seconds=0.01)
        adapter._tool_timeouts["chapter.get"] = 0.01
        monkeypatch.setattr(tool_adapter_module, "Client", HangingClient)

        try:
            await asyncio.wait_for(
                adapter.invoke("chapter.get", {"chapterId": "chapter_2"}),
                timeout=1,
            )
        except AutomationInvokeError as error:
            assert error.code == "UPSTREAM_TIMEOUT"
            assert error.status_code == 504
        else:
            raise AssertionError("hung FastMCP lifecycle was not timed out")

    asyncio.run(scenario())


def test_automation_client_preserves_retryable_transport_failures(tmp_path, monkeypatch) -> None:
    runtime_path = tmp_path / "runtime.json"
    runtime_path.write_text(json.dumps({"port": 12345, "token": "test-token"}), encoding="utf-8")
    async_client = httpx.AsyncClient

    async def scenario() -> None:
        for transport_error, expected_code in (
            (httpx.RemoteProtocolError("Server disconnected without sending a response."), "NETWORK_ERROR"),
            (httpx.ReadTimeout("timed out"), "UPSTREAM_TIMEOUT"),
        ):
            monkeypatch.setattr(
                httpx,
                "AsyncClient",
                lambda **kwargs: async_client(
                    **kwargs,
                    transport=FailingTransport(transport_error),
                ),
            )
            client = AutomationClient(runtime_path)
            try:
                await client.invoke("chapter.get", {"chapterId": "chapter_1"})
            except AutomationInvokeError as error:
                assert error.code == expected_code
                assert error.details == {"method": "chapter.get"}
            else:
                raise AssertionError("transport failure was not preserved")

    asyncio.run(scenario())
