from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.tool_adapter import FastMcpAgentToolAdapter

from test_runtime import FakeAutomationClient


def _tool_result(method: str, params: dict[str, Any]) -> Any:
    if method == "chapter.get":
        return {"id": params["chapterId"], "volumeId": "volume_1", "title": "第二章", "content": "顾野隐瞒了伤势。"}
    if method == "volume.list":
        return [{"id": "volume_1", "title": "第一卷"}]
    if method == "chapter.list":
        return [
            {"id": "chapter_1", "order": 1, "title": "第一章", "summary": "顾野受伤。"},
            {"id": "chapter_2", "order": 2, "title": "第二章", "summary": "顾野隐瞒伤势。"},
            {"id": "chapter_3", "order": 3, "title": "第三章", "summary": "顾野参加追逐。"},
        ]
    if method == "plotline.list":
        return [{"id": "plot_1", "name": "伤势伏笔", "status": "active"}]
    if method == "character.list":
        return [{"id": "character_1", "name": "顾野", "description": "左腿受伤"}]
    if method == "worldsetting.list":
        return [{"id": "world_1", "name": "恢复规则", "rules": "重伤无法在一天内恢复"}]
    if method == "item.list":
        return [{"id": "item_1", "name": "止痛针", "description": "只能止痛，不能治愈"}]
    if method == "rag.ask":
        return {
            "answer": "第一章确认顾野左腿受伤。",
            "evidence": [{"sourceType": "chapter", "sourceId": "chapter_1", "title": "第一章", "excerpt": "左腿无法着力", "confidence": 0.96}],
        }
    return {"ok": True}


def _review() -> dict[str, Any]:
    return {
        "overallScore": 72,
        "summary": "伤势延续存在一处需要校准的问题。",
        "dimensions": [
            {"id": "character", "label": "人物状态", "score": 65, "reason": "行动与伤势存在张力", "checkable": True},
            {"id": "world", "label": "世界规则", "score": 80, "reason": "规则资料完整", "checkable": True},
        ],
        "issues": [
            {
                "issueId": "issue-1",
                "type": "character_state",
                "severity": "high",
                "title": "伤势对追逐行动的限制不足",
                "location": "第二章后半段",
                "excerpt": "顾野全速追了出去",
                "evidence": [{"sourceType": "chapter", "sourceId": "chapter_1", "title": "第一章", "excerpt": "左腿无法着力", "confidence": 0.96}],
                "recommendation": "补充止痛而非治愈的代价，并限制移动速度。",
                "uncertainty": "",
            },
            {
                "issueId": "issue-duplicate",
                "type": "character_state",
                "severity": "medium",
                "title": "伤势对追逐行动的限制不足",
                "location": "第二章后半段",
                "excerpt": "",
                "evidence": [],
                "recommendation": "重复项",
                "uncertainty": "需人工确认",
            },
        ],
        "uncheckableDimensions": [{"dimension": "技能", "reason": "当前项目没有技能资料"}],
        "warnings": [],
    }


async def _wait_terminal(runtime: NovelAgentRuntime, run_id: str) -> None:
    for _ in range(3000):
        if runtime.state.runs[run_id].status in {"completed", "failed", "cancelled"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Toolchain run did not reach a terminal state")


@pytest.mark.parametrize("transport", ["http", "fastmcp"])
def test_consistency_toolchain_runs_on_both_transports_and_publishes_structured_artifact(
    tmp_path: Path,
    transport: str,
) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path / transport)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "章节一致性审核",
                    "deliverable": "report",
                    "steps": [{
                        "agent": "editor",
                        "title": "执行稳定的一致性审核链",
                        "tools": [],
                        "toolchain": {"id": "chapter.consistency_review", "version": "1.0.0", "input": {}},
                    }],
                }
            if method == "agent.generate_consistency_review":
                return _review()
            if method in {"agent.generate_report", "agent.detect_creative_direction", "agent.generate_chat", "agent.revise_plan"}:
                return await original_invoke(method, params, origin, request_id=request_id)
            automation.calls.append((method, params, origin))
            if request_id:
                automation.request_ids.append(request_id)
            return _tool_result(method, params)

        automation.invoke = invoke  # type: ignore[method-assign]
        adapter = FastMcpAgentToolAdapter(automation) if transport == "fastmcp" else None
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store), tool_adapter=adapter)
        plan = await runtime.plan({"goal": "审核当前章节的一致性", "role": "editor"}, {"locale": "zh-CN"})
        assert plan.steps[0].toolchain is not None

        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_2",
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {},
        )
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed"
        review_artifact = next(item for item in completed.artifacts if item.type == "consistency_review")
        structured = review_artifact.metadata["review"]
        assert structured["overallScore"] == 72
        assert len(structured["issues"]) == 1
        assert structured["contextStats"]["toolCallCount"] == 8
        assert not any(item.type in {"chapter_draft", "creative_assets_draft"} for item in completed.artifacts)
        assert any(event.type == "toolchain_started" for event in completed.events)
        assert any(event.type == "toolchain_completed" for event in completed.events)
        assert len([event for event in completed.events if event.type == "tool_result"]) == 8

    asyncio.run(scenario())


def test_context_toolchain_degrades_when_optional_source_fails(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "章节上下文",
                    "deliverable": "report",
                    "steps": [{
                        "agent": "editor",
                        "title": "装配上下文",
                        "tools": [],
                        "toolchain": {"id": "chapter.context", "version": "1.0.0", "input": {}},
                    }],
                }
            if method == "character.list":
                raise RuntimeError("character service unavailable")
            if method == "agent.generate_report":
                return await original_invoke(method, params, origin, request_id=request_id)
            automation.calls.append((method, params, origin))
            return _tool_result(method, params)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({"goal": "读取章节上下文", "role": "editor"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_2",
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {},
        )
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]
        bundle = next(item for item in completed.artifacts if item.type == "context_bundle").metadata["contextBundle"]

        assert completed.status == "completed"
        assert bundle["characters"] == []
        assert bundle["sourceStatus"]["character.read"] == "failed"
        assert any("character.list" in warning for warning in bundle["warnings"])
        assert any(event.type == "toolchain_node_completed" and event.status == "partial" for event in completed.events)

    asyncio.run(scenario())


def test_read_only_toolchain_cancellation_stops_active_node(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        started = asyncio.Event()

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            automation.calls.append((method, params, origin))
            if request_id:
                automation.request_ids.append(request_id)
            if method == "agent.generate_plan":
                return {
                    "title": "可取消上下文链",
                    "deliverable": "report",
                    "steps": [{
                        "agent": "editor",
                        "title": "装配上下文",
                        "tools": [],
                        "toolchain": {"id": "chapter.context", "version": "1.0.0", "input": {}},
                    }],
                }
            if method == "chapter.get":
                started.set()
                await asyncio.sleep(60)
            return _tool_result(method, params)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({"goal": "读取章节上下文", "role": "editor"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_2",
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {},
        )
        await asyncio.wait_for(started.wait(), timeout=2)
        await runtime.cancel({"runId": run.runId})
        await _wait_terminal(runtime, run.runId)
        cancelled = runtime.state.runs[run.runId]

        assert cancelled.status == "cancelled"
        assert automation.cancelled_request_ids
        assert not any(event.type == "toolchain_completed" for event in cancelled.events)

    asyncio.run(scenario())
