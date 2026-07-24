from __future__ import annotations

import asyncio
from typing import Any

import pytest

from novel_agent_runtime.automation import AutomationInvokeError
from novel_agent_runtime.request_graph import RetryableRequestGraph
from novel_agent_runtime.retry import AgentRequestError, agent_retry_policy


def fast_graph(*, interval: float = 0.001) -> RetryableRequestGraph:
    return RetryableRequestGraph(agent_retry_policy(
        initial_interval=interval,
        backoff_factor=1,
        max_interval=interval,
        jitter=False,
    ))


def test_request_graph_emits_real_attempt_sequence_and_succeeds_once() -> None:
    async def scenario() -> None:
        calls = 0
        events: list[tuple[str, dict[str, Any]]] = []

        async def request() -> dict[str, str]:
            nonlocal calls
            calls += 1
            if calls < 4:
                raise AutomationInvokeError(
                    "PROVIDER_UNAVAILABLE",
                    "HTTP 504 <html>gateway</html>",
                    {"httpStatus": 504, "retryable": True},
                )
            return {"content": "完成"}

        async def on_event(event_type: str, payload: dict[str, Any]) -> None:
            events.append((event_type, payload))

        result = await fast_graph().run(
            request,
            operation_id="operation-1",
            request_id="request-1",
            node_id="report.synthesize",
            method="agent.generate_report",
            on_event=on_event,
        )

        assert result == {"content": "完成"}
        assert calls == 4
        assert [event_type for event_type, _ in events] == [
            "request_retry_scheduled",
            "request_retry_started",
            "request_retry_scheduled",
            "request_retry_started",
            "request_retry_scheduled",
            "request_retry_started",
            "request_retry_succeeded",
        ]
        assert [payload["retryAttempt"] for _, payload in events] == [1, 1, 2, 2, 3, 3, 3]
        assert all(payload["retryLimit"] == 3 for _, payload in events)
        assert all(payload["requestId"] == "request-1" for _, payload in events)
        assert "<html>" not in str(events)

    asyncio.run(scenario())


def test_request_graph_exhaustion_returns_one_sanitized_failure() -> None:
    async def scenario() -> None:
        calls = 0
        events: list[tuple[str, dict[str, Any]]] = []

        async def request() -> None:
            nonlocal calls
            calls += 1
            raise AutomationInvokeError("NETWORK_ERROR", "socket secret")

        async def on_event(event_type: str, payload: dict[str, Any]) -> None:
            events.append((event_type, payload))

        with pytest.raises(AgentRequestError) as raised:
            await fast_graph().run(
                request,
                operation_id="operation-2",
                request_id="request-2",
                node_id="model",
                method="agent.generate_plan",
                on_event=on_event,
            )

        assert calls == 4
        assert raised.value.failure.attempts == 4
        assert raised.value.failure.user_message == "模型服务暂时不可用，已重试 3 次。"
        exhausted = [payload for event_type, payload in events if event_type == "request_retry_exhausted"]
        assert len(exhausted) == 1
        assert exhausted[0]["attempt"] == 4

    asyncio.run(scenario())


def test_request_graph_does_not_retry_non_retryable_error() -> None:
    async def scenario() -> None:
        calls = 0
        events: list[str] = []

        async def request() -> None:
            nonlocal calls
            calls += 1
            raise AutomationInvokeError("INVALID_INPUT", "schema invalid", status_code=500)

        async def on_event(event_type: str, _payload: dict[str, Any]) -> None:
            events.append(event_type)

        with pytest.raises(AgentRequestError) as raised:
            await fast_graph().run(
                request,
                operation_id="operation-3",
                request_id="request-3",
                node_id="model",
                method="agent.generate_plan",
                on_event=on_event,
            )

        assert calls == 1
        assert events == []
        assert raised.value.failure.retryable is False

    asyncio.run(scenario())


def test_request_graph_cancellation_interrupts_backoff() -> None:
    async def scenario() -> None:
        failed = asyncio.Event()
        calls = 0

        async def request() -> None:
            nonlocal calls
            calls += 1
            failed.set()
            raise AutomationInvokeError("NETWORK_ERROR", "connection reset")

        task = asyncio.create_task(fast_graph(interval=30).run(
            request,
            operation_id="operation-4",
            request_id="request-4",
            node_id="model",
            method="agent.generate_plan",
        ))
        await failed.wait()
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert calls == 1

    asyncio.run(scenario())
