from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from langgraph.types import RetryPolicy

from novel_agent_runtime.automation import AutomationInvokeError
from novel_agent_runtime.exploration_graph import AgentExplorationGraph, ExplorationState
from novel_agent_runtime.retry import AgentRequestError, is_retryable_agent_error
from novel_agent_runtime.toolchains.schemas import ToolchainError


def fast_retry_policy(*, interval: float = 0.001) -> RetryPolicy:
    return RetryPolicy(
        max_attempts=4,
        initial_interval=interval,
        backoff_factor=1,
        max_interval=interval,
        jitter=False,
        retry_on=is_retryable_agent_error,
    )


def initial_state() -> ExplorationState:
    return ExplorationState(
        message="检查章节",
        role="team",
        approval_mode="review_required",
        locale="zh-CN",
        history=[],
        context={},
        observations=[],
        tool_trace=[],
        pending_tool_calls=[],
        decision={},
        iterations=0,
    )


def test_model_node_succeeds_on_fourth_attempt_without_duplicate_output(tmp_path: Path) -> None:
    async def scenario() -> None:
        calls = 0
        retries: list[tuple[str, int, int]] = []

        async def model_call(_state: ExplorationState) -> dict[str, Any]:
            nonlocal calls
            calls += 1
            if calls < 4:
                raise AutomationInvokeError("PROVIDER_UNAVAILABLE", "HTTP 504 <html>gateway</html>")
            return {"content": "完成", "toolCalls": []}

        async def tool_call(_name: str, _args: dict[str, Any]) -> Any:
            raise AssertionError("tool should not run")

        graph = AgentExplorationGraph(
            tmp_path / "graph.db",
            ["chapter.get"],
            retry_policy=fast_retry_policy(),
        )
        result = await graph.run(
            "thread-model-retry",
            initial_state(),
            model_call,
            tool_call,
            lambda node, attempt, limit: _record_retry(retries, node, attempt, limit),
        )

        assert calls == 4
        assert result["decision"]["content"] == "完成"
        assert result["iterations"] == 1
        assert retries == [("model", 1, 3), ("model", 2, 3), ("model", 3, 3)]

    asyncio.run(scenario())


async def _record_retry(
    retries: list[tuple[str, int, int]],
    node: str,
    attempt: int,
    limit: int,
) -> None:
    retries.append((node, attempt, limit))


def test_read_tools_checkpoint_individually_and_only_failed_tool_retries(tmp_path: Path) -> None:
    async def scenario() -> None:
        model_calls = 0
        tool_calls = {"chapter.get": 0, "rag.ask": 0}

        async def model_call(state: ExplorationState) -> dict[str, Any]:
            nonlocal model_calls
            model_calls += 1
            if not state["observations"]:
                return {
                    "content": "读取中",
                    "toolCalls": [
                        {"name": "chapter.get", "args": {"chapterId": "chapter_1"}},
                        {"name": "rag.ask", "args": {"question": "冲突"}},
                    ],
                }
            return {"content": "完成", "toolCalls": []}

        async def tool_call(name: str, _args: dict[str, Any]) -> Any:
            tool_calls[name] += 1
            if name == "rag.ask" and tool_calls[name] < 4:
                raise AutomationInvokeError("NETWORK_ERROR", "connection reset")
            return {"name": name}

        graph = AgentExplorationGraph(
            tmp_path / "graph.db",
            ["chapter.get", "rag.ask"],
            retry_policy=fast_retry_policy(),
        )
        result = await graph.run("thread-tool-retry", initial_state(), model_call, tool_call)

        assert model_calls == 2
        assert tool_calls == {"chapter.get": 1, "rag.ask": 4}
        assert len(result["observations"]) == 2
        assert len(result["tool_trace"]) == 2
        assert all(item["status"] == "completed" for item in result["tool_trace"])

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "error",
    [
        AutomationInvokeError("INVALID_INPUT", "schema invalid", status_code=500),
        ToolchainError("SIDE_EFFECT_UNKNOWN", "write result unknown", retryable=True),
    ],
)
def test_non_retryable_error_attempts_once(tmp_path: Path, error: Exception) -> None:
    async def scenario() -> None:
        calls = 0

        async def model_call(_state: ExplorationState) -> dict[str, Any]:
            nonlocal calls
            calls += 1
            raise error

        async def tool_call(_name: str, _args: dict[str, Any]) -> Any:
            raise AssertionError("tool should not run")

        graph = AgentExplorationGraph(
            tmp_path / f"{type(error).__name__}.db",
            ["chapter.get"],
            retry_policy=fast_retry_policy(),
        )
        with pytest.raises(AgentRequestError) as raised:
            await graph.run(f"thread-{type(error).__name__}", initial_state(), model_call, tool_call)

        assert calls == 1
        assert raised.value.failure.attempts == 1
        assert raised.value.failure.retryable is False

    asyncio.run(scenario())


def test_cancellation_interrupts_retry_backoff(tmp_path: Path) -> None:
    async def scenario() -> None:
        first_failure = asyncio.Event()
        calls = 0

        async def model_call(_state: ExplorationState) -> dict[str, Any]:
            nonlocal calls
            calls += 1
            first_failure.set()
            raise AutomationInvokeError("NETWORK_ERROR", "connection reset")

        async def tool_call(_name: str, _args: dict[str, Any]) -> Any:
            raise AssertionError("tool should not run")

        graph = AgentExplorationGraph(
            tmp_path / "graph.db",
            ["chapter.get"],
            retry_policy=fast_retry_policy(interval=30),
        )
        task = asyncio.create_task(graph.run("thread-cancel", initial_state(), model_call, tool_call))
        await first_failure.wait()
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert calls == 1

    asyncio.run(scenario())
