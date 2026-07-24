from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from novel_agent_runtime.automation import AutomationInvokeError
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.invocations import SideEffectResultUnknown
from novel_agent_runtime.request_graph import RetryableRequestGraph
from novel_agent_runtime.retry import agent_retry_policy
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import AgentRun
from novel_agent_runtime.store import AgentStateStore


class FlakyInvoker:
    transport_name = "test"

    def __init__(self) -> None:
        self.calls: dict[str, int] = {}

    async def invoke(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        origin: str = "desktop-ui",
        request_id: str | None = None,
    ) -> Any:
        del origin, request_id
        count = self.calls.get(method, 0) + 1
        self.calls[method] = count
        if method == "agent.generate_plan":
            if count < 4:
                raise AutomationInvokeError("PROVIDER_UNAVAILABLE", "gateway")
            return {"title": "检查计划", "steps": [{"agent": "editor", "title": "检查", "tools": ["chapter.get"]}]}
        if method == "agent.generate_chat":
            return {"content": "继续处理。", "shouldPlan": True, "needsClarification": False}
        if method in {"agent.generate_report", "chapter.get"} and count < 4:
            raise AutomationInvokeError("NETWORK_ERROR", "connection reset")
        if method == "agent.generate_report":
            return {"content": "报告完成", "conversationSummary": "报告完成"}
        if method == "chapter.get":
            return {"id": (params or {}).get("chapterId"), "title": "第一章"}
        if method == "chapter.generate_draft":
            raise AutomationInvokeError("NETWORK_ERROR", "write response lost")
        return {"ok": True}

    async def cancel(self, _request_id: str) -> bool:
        return True

    async def list_tools(self) -> list[str]:
        return ["chapter.get", "chapter.generate_draft"]


def create_runtime(tmp_path: Path) -> tuple[NovelAgentRuntime, FlakyInvoker]:
    store = AgentStateStore(tmp_path)
    invoker = FlakyInvoker()
    runtime = NovelAgentRuntime(store, invoker, AgentEventBus(store), tool_adapter=invoker)
    runtime.request_graph = RetryableRequestGraph(agent_retry_policy(
        initial_interval=0.001,
        backoff_factor=1,
        max_interval=0.001,
        jitter=False,
    ))
    return runtime, invoker


def test_plan_generation_uses_request_graph_without_creating_duplicate_plan(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)
        plan = await runtime.plan({"goal": "检查第一章", "novelId": "novel-1", "chapterId": "chapter-1"}, {})

        assert invoker.calls["agent.generate_plan"] == 4
        assert len(runtime.state.plans) == 1
        assert runtime.state.plans[plan.planId].title == "检查计划"

    asyncio.run(scenario())


def test_run_model_and_read_only_tool_emit_retry_events(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)
        run = AgentRun(runId="run-1", threadId="thread-1", planId="plan-1", status="running", currentStepId="step-1")
        runtime.state.runs[run.runId] = run

        report = await runtime._automation_invoke(run, "agent.generate_report", {"goal": "检查"})
        chapter = await runtime._tool_invoke(run, "chapter.get", {"chapterId": "chapter-1"})

        assert report["content"] == "报告完成"
        assert chapter["id"] == "chapter-1"
        assert invoker.calls["agent.generate_report"] == 4
        assert invoker.calls["chapter.get"] == 4
        event_types = [event.type for event in run.events]
        assert event_types.count("request_retry_scheduled") == 6
        assert event_types.count("request_retry_started") == 6
        assert event_types.count("request_retry_succeeded") == 2
        assert all(event.payload.get("retryLimit") == 3 for event in run.events)

    asyncio.run(scenario())


def test_side_effect_tool_never_enters_request_retry_graph(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)
        run = AgentRun(runId="run-write", threadId="thread-1", planId="plan-1", status="running", currentStepId="step-write")
        runtime.state.runs[run.runId] = run

        with pytest.raises(SideEffectResultUnknown):
            await runtime._tool_invoke(run, "chapter.generate_draft", {"chapterId": "chapter-1"})

        assert invoker.calls["chapter.generate_draft"] == 1
        assert not any(event.type.startswith("request_retry") for event in run.events)

    asyncio.run(scenario())


def test_exhausted_final_report_fails_once_without_artifact_or_raw_error(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)
        original_invoke = invoker.invoke

        async def always_fail_report(
            method: str,
            params: dict[str, Any] | None = None,
            origin: str = "desktop-ui",
            request_id: str | None = None,
        ) -> Any:
            if method == "agent.generate_report":
                invoker.calls[method] = invoker.calls.get(method, 0) + 1
                raise AutomationInvokeError(
                    "PROVIDER_UNAVAILABLE",
                    "HTTP 504 <html>private gateway page</html>",
                    {"httpStatus": 504, "retryable": True},
                )
            return await original_invoke(method, params, origin, request_id)

        invoker.invoke = always_fail_report  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "检查第一章", "novelId": "novel-1", "chapterId": "chapter-1"}, {})
        plan.deliverable = "report"
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {},
        )
        for _ in range(2000):
            if runtime.state.runs[run.runId].status in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.01)

        failed = runtime.state.runs[run.runId]
        assert failed.status == "failed"
        assert invoker.calls["agent.generate_report"] == 4
        assert failed.artifacts == []
        assert sum(event.type == "request_retry_exhausted" for event in failed.events) == 1
        assert sum(event.type == "run_failed" for event in failed.events) == 1
        terminal = next(event for event in failed.events if event.type == "run_failed")
        assert terminal.payload["attempts"] == 4
        assert terminal.payload["httpStatus"] == 504
        assert terminal.payload["failureRevision"] == 1
        assert "<html>" not in str(failed.events)

        original_event_count = len(failed.events)
        recovery_intent = await runtime.chat(
            {
                "message": "继续",
                "conversationId": "conversation-retry",
                "conversationContext": {"activeRun": {"runId": failed.runId, "status": "failed"}},
            },
            {},
        )
        assert recovery_intent.intentDecision is not None
        assert recovery_intent.intentDecision.route == "retry_failed_run"
        assert recovery_intent.intentDecision.recovery is not None
        assert recovery_intent.intentDecision.recovery.failedRunId == failed.runId
        assert recovery_intent.suggestedActions == [{"label": "重试失败步骤", "method": "agent.retry_run"}]
        assert invoker.calls.get("agent.generate_chat", 0) == 0

        with pytest.raises(ValueError, match="revision conflict"):
            await runtime.retry_run(
                {"failedRunId": failed.runId, "expectedFailureRevision": 2, "mode": "failed_node"},
                {},
            )

        invoker.invoke = original_invoke  # type: ignore[method-assign]
        resumed = await runtime.retry_run(
            {"failedRunId": failed.runId, "expectedFailureRevision": 1, "mode": "failed_node"},
            {},
        )
        for _ in range(2000):
            if runtime.state.runs[resumed.runId].status in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.01)

        completed = runtime.state.runs[resumed.runId]
        assert completed.status == "completed"
        assert completed.retryOfRunId == failed.runId
        assert completed.retryRootRunId == failed.runId
        assert completed.retryAttempt == 1
        assert completed.approvalResponses == failed.approvalResponses
        assert completed.resumedFrom and completed.resumedFrom["phase"] == "final_report"
        assert invoker.calls["agent.generate_report"] == 5
        assert invoker.calls["chapter.get"] == 4
        assert len(completed.artifacts) == 1
        assert completed.artifacts[0].type == "report"
        assert sum(event.type == "run_retry_started" for event in completed.events) == 1
        assert failed.status == "failed"
        assert failed.failureRevision == 1
        assert len(failed.events) == original_event_count

        with pytest.raises(ValueError, match="already has a linked retry"):
            await runtime.retry_run(
                {"failedRunId": failed.runId, "expectedFailureRevision": 1, "mode": "failed_node"},
                {},
            )

    asyncio.run(scenario())


def test_retry_run_rejects_side_effect_unknown_before_loading_checkpoint(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, _ = create_runtime(tmp_path)
        failed = AgentRun(
            runId="run-side-effect",
            threadId="thread-1",
            planId="plan-1",
            status="failed",
            failureRevision=1,
        )
        runtime.state.runs[failed.runId] = failed
        await runtime._emit(
            failed,
            "run_failed",
            status="failed",
            payload={"code": "SIDE_EFFECT_UNKNOWN", "failureRevision": 1},
        )

        with pytest.raises(ValueError, match="reconciled"):
            await runtime.retry_run(
                {"failedRunId": failed.runId, "expectedFailureRevision": 1, "mode": "failed_node"},
                {},
            )

    asyncio.run(scenario())
