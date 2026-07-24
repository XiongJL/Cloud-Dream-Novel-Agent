from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.main import build_app
from novel_agent_runtime.roles import list_agent_roles
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import AgentRun, AgentRunEvent, new_id
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.tool_adapter import FastMcpAgentToolAdapter
from novel_agent_runtime.tool_manifest import AVAILABLE_AGENT_TOOLS


class FakeAutomationClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], str]] = []
        self.request_ids: list[str] = []
        self.cancelled_request_ids: list[str] = []

    async def invoke(
        self,
        method: str,
        params: dict[str, Any],
        origin: str,
        request_id: str | None = None,
    ) -> Any:
        self.calls.append((method, params, origin))
        if request_id:
            self.request_ids.append(request_id)
        if method == "agent.generate_chat":
            return {"content": "我会分析这一章的冲突目标。", "shouldPlan": True, "needsClarification": False}
        if method == "agent.generate_plan":
            return {
                "title": "章节续写计划",
                "steps": [
                    {"agent": "supervisor", "title": "读取当前章节上下文", "tools": ["chapter.get"]},
                    {"agent": "writer", "title": "生成续写草稿", "tools": ["chapter.generate_draft"]},
                ],
            }
        if method == "agent.revise_plan":
            first_step = params["currentPlan"]["steps"][0]
            return {
                "title": "章节续写与读者检查计划",
                "steps": [
                    {
                        "stepId": first_step["stepId"],
                        "agent": first_step["agent"],
                        "title": first_step["title"],
                        "tools": first_step["tools"],
                    },
                    {"agent": "reader", "title": "检查追更欲望", "tools": ["rag.ask"]},
                ],
            }
        if method == "agent.generate_report":
            return {
                "content": "## 最终建议\n\n冲突出现偏晚，建议提前设置明确阻力，并在章末留下未解决的问题。",
                "conversationSummary": "审阅已完成。核心问题是冲突出现偏晚；建议前置明确阻力，并在章末保留悬念。完整分析已保存在产物中。",
            }
        if method == "agent.detect_creative_direction":
            return {"requiresDecision": False}
        if method == "chapter.get":
            return {"id": params["chapterId"], "title": "第三章"}
        if method == "chapter.generate_draft":
            return {"draftSessionId": "draft_1", "type": "chapter-draft"}
        if method == "draft.get":
            if str(params["draftSessionId"]).startswith("creative"):
                return {
                    "draftSessionId": params["draftSessionId"],
                    "type": "creative-assets",
                    "status": "draft",
                    "version": 2,
                }
            return {
                "draftSessionId": params["draftSessionId"],
                "type": "chapter-draft",
                "status": "draft",
                "version": 2,
            }
        if method == "chapter.revise_draft":
            return {
                "draftSessionId": "draft_revision_1",
                "type": "chapter-draft",
                "status": "draft",
                "previewSummary": "根据审批意见生成的新版本",
            }
        if method == "creative_assets.revise_draft":
            return {
                "draftSessionId": "creative_revision_1",
                "type": "creative-assets",
                "status": "draft",
                "previewSummary": "角色 1，情节线 1",
            }
        if method == "creative_assets.generate_draft":
            return {"draftSessionId": "creative_draft_1", "type": "creative-assets"}
        if method == "rag.ask":
            return {"answer": "analysis complete"}
        return {"ok": True}

    async def cancel(self, request_id: str) -> bool:
        self.cancelled_request_ids.append(request_id)
        return True


def create_runtime(state_dir: Path) -> tuple[NovelAgentRuntime, FakeAutomationClient]:
    store = AgentStateStore(state_dir)
    automation = FakeAutomationClient()
    runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
    return runtime, automation


def test_review_comments_create_a_new_revision_run_and_artifact(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        comments = [{
            "commentId": "comment-1",
            "body": "加强人物在这一段的犹豫，并提前冲突。",
            "anchor": {"kind": "paragraph", "paragraphIndex": 1, "quote": "他停在门前。"},
        }]
        run = await runtime.revise_draft(
            {
                "sourceDraftSessionId": "draft_source_1",
                "sourceDraftVersion": 2,
                "sourceArtifactId": "artifact_source_1",
                "reviewRequestId": "review_request_1",
                "comments": comments,
                "threadId": "thread_review_1",
                "locale": "zh-CN",
            },
            {"origin": "desktop-ui"},
        )

        await runtime._run_tasks[run.runId]
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed"
        assert completed.draftSessionId == "draft_revision_1"
        assert [method for method, _, _ in automation.calls] == ["draft.get", "chapter.revise_draft"]
        revision_params = automation.calls[-1][1]
        assert revision_params["sourceDraftSessionId"] == "draft_source_1"
        assert revision_params["sourceDraftVersion"] == 2
        assert revision_params["reviewRequestId"] == "review_request_1"
        assert revision_params["comments"] == comments
        assert len(completed.artifacts) == 1
        artifact = completed.artifacts[0]
        assert artifact.type == "chapter_draft"
        assert artifact.reference["draftSessionId"] == "draft_revision_1"
        assert artifact.metadata["revisionOfDraftSessionId"] == "draft_source_1"
        assert artifact.metadata["reviewRequestId"] == "review_request_1"
        assert artifact.metadata["sourceArtifactId"] == "artifact_source_1"

        with pytest.raises(ValueError, match="version conflict"):
            await runtime.revise_draft(
                {
                    "sourceDraftSessionId": "draft_source_2",
                    "sourceDraftVersion": 1,
                    "comments": comments,
                },
                {"origin": "desktop-ui"},
            )

    asyncio.run(scenario())


def test_creative_asset_review_comments_create_a_new_package_version(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        comments = [{
            "commentId": "comment-creative-1",
            "reviewVersionId": "creative_source_1",
            "body": "角色动机过于直接，保留身份设定但增加内在矛盾。",
            "anchor": {
                "kind": "asset_item",
                "targetId": "creative_source_1:characters:0",
                "fieldPath": "characters.0",
                "quote": "林岚；定位：调查记者",
            },
        }]
        run = await runtime.revise_draft(
            {
                "sourceDraftSessionId": "creative_source_1",
                "sourceDraftVersion": 2,
                "sourceArtifactId": "artifact_creative_source_1",
                "reviewRequestId": "review_creative_1",
                "comments": comments,
                "threadId": "thread_creative_1",
            },
            {"origin": "desktop-ui"},
        )

        await runtime._run_tasks[run.runId]
        completed = runtime.state.runs[run.runId]
        plan = runtime.state.plans[run.planId]
        assert completed.status == "completed"
        assert completed.draftSessionId == "creative_revision_1"
        assert plan.deliverable == "creative_assets_draft"
        assert plan.steps[0].tools == ["creative_assets.revise_draft"]
        assert [method for method, _, _ in automation.calls] == ["draft.get", "creative_assets.revise_draft"]
        assert automation.calls[-1][1]["comments"] == comments
        assert len(completed.artifacts) == 1
        artifact = completed.artifacts[0]
        assert artifact.type == "creative_assets_draft"
        assert artifact.reference["draftSessionId"] == "creative_revision_1"
        assert artifact.metadata["revisionOfDraftSessionId"] == "creative_source_1"
        assert artifact.metadata["reviewRequestId"] == "review_creative_1"
        assert artifact.metadata["sourceArtifactId"] == "artifact_creative_source_1"

    asyncio.run(scenario())


def test_agent_role_registry_is_complete_localized_and_tool_safe(tmp_path: Path) -> None:
    roles = list_agent_roles("zh-CN")
    english_roles = list_agent_roles("en-US")

    assert [role.id for role in roles] == ["team", "writer", "editor", "reader", "worldbuilding", "research_rag"]
    assert [role.label for role in english_roles] == ["Team", "Writer", "Editor", "Reader", "Worldbuilding", "Research"]
    assert {role.agent for role in roles} == {"supervisor", "writer", "editor", "reader", "worldbuilding", "research_rag"}

    allowed_tools = set(AVAILABLE_AGENT_TOOLS)
    preset_ids: list[str] = []
    for role in roles:
        assert role.tools
        assert set(role.tools).issubset(allowed_tools)
        assert role.skills
        assert role.presets
        preset_ids.extend(preset.id for preset in role.presets)
        assert all(preset.goal.strip() for preset in role.presets)
    assert len(preset_ids) == len(set(preset_ids))

    runtime, _ = create_runtime(tmp_path)
    runtime_roles = runtime.roles({"locale": "en-US"}, {})
    assert runtime_roles[0]["label"] == "Team"

    with TestClient(build_app(runtime, None)) as client:
        response = client.post(
            "/invoke",
            json={"method": "agent.roles", "params": {"locale": "zh-CN"}, "context": {}},
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["data"][4]["id"] == "worldbuilding"
    assert payload["data"][4]["label"] == "世界观"


def test_health_reports_active_fastmcp_tool_transport(tmp_path: Path) -> None:
    store = AgentStateStore(tmp_path)
    automation = FakeAutomationClient()
    runtime = NovelAgentRuntime(
        store,
        automation,
        AgentEventBus(store),
        tool_adapter=FastMcpAgentToolAdapter(automation),
    )
    with TestClient(build_app(runtime, None)) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["data"]["toolTransport"] == "fastmcp"
    assert "agent.retry_run" in response.json()["data"]["capabilities"]


def test_execute_plan_requires_explicit_approval(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, _ = create_runtime(tmp_path)
        plan = await runtime.plan(
            {"goal": "续写下一段", "novelId": "novel_1", "chapterId": "chapter_3"},
            {},
        )

        with pytest.raises(ValueError, match="Explicit plan approval"):
            await runtime.execute_plan({"planId": plan.planId}, {})

    asyncio.run(scenario())


def test_execute_plan_requires_approved_steps_to_cover_declared_artifact(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, _ = create_runtime(tmp_path)
        plan = await runtime.plan(
            {"goal": "续写下一段", "novelId": "novel_1", "chapterId": "chapter_3"},
            {},
        )
        read_step = next(step for step in plan.steps if "chapter.get" in step.tools)

        with pytest.raises(ValueError, match="do not produce the declared deliverable"):
            await runtime.execute_plan(
                {
                    "planId": plan.planId,
                    "approval": {"approved": True, "approvedStepIds": [read_step.stepId]},
                },
                {},
            )

    asyncio.run(scenario())


def test_run_fails_when_declared_artifact_is_not_created(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        plan = await runtime.plan({"goal": "续写下一段", "novelId": "novel_1"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "approval": {"approved": True, "approvedStepIds": [step.stepId for step in plan.steps]},
            },
            {},
        )

        for _ in range(200):
            if runtime.state.runs[run.runId].status == "failed":
                break
            await asyncio.sleep(0.01)

        failed = runtime.state.runs[run.runId]
        assert failed.status == "failed"
        assert failed.artifacts == []
        assert any(
            event.type == "run_failed" and "chapter_draft" in str(event.payload.get("message"))
            for event in failed.events
        )
        assert not any(method == "agent.generate_report" for method, _, _ in automation.calls)

    asyncio.run(scenario())


def test_executor_graph_interrupt_persists_and_resumes_once(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def graph_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "LangGraph 审批恢复计划",
                    "deliverable": "report",
                    "steps": [{"agent": "editor", "title": "检索并报告", "tools": ["rag.ask"]}],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = graph_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "分析当前章节", "role": "editor"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {"novelId": "novel_1", "chapterId": "chapter_3", "locale": "zh-CN"},
        )

        for _ in range(100):
            task = runtime._run_tasks.get(run.runId)  # noqa: SLF001 - verifies interrupt releases the worker task.
            if runtime.state.runs[run.runId].status == "waiting_approval" and (task is None or task.done()):
                break
            await asyncio.sleep(0.01)

        waiting = runtime.state.runs[run.runId]
        assert waiting.status == "waiting_approval"
        assert waiting.pendingApproval is not None
        assert (runtime._run_tasks.get(run.runId) is None or runtime._run_tasks[run.runId].done())  # noqa: SLF001
        checkpoint_db = sqlite3.connect(tmp_path / "agent_graph.db")
        try:
            assert checkpoint_db.execute("SELECT COUNT(*) FROM checkpoints").fetchone()[0] > 0
        finally:
            checkpoint_db.close()

        await runtime.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": waiting.pendingApproval["checkpointId"],
                "selectedOptionIds": ["current_chapter"],
            }
        )
        for _ in range(200):
            if runtime.state.runs[run.runId].status in {"completed", "failed"}:
                break
            await asyncio.sleep(0.01)

        assert runtime.state.runs[run.runId].status == "completed"
        assert [method for method, _, _ in automation.calls].count("rag.ask") == 1
        approval_events = [event for event in runtime.state.runs[run.runId].events if event.type == "approval_required"]
        assert len(approval_events) == 1

    asyncio.run(scenario())


def test_executor_graph_can_cancel_while_interrupted(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def graph_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "等待取消计划",
                    "deliverable": "report",
                    "steps": [{"agent": "editor", "title": "等待范围确认", "tools": ["rag.ask"]}],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = graph_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "分析章节"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {"novelId": "novel_1", "chapterId": "chapter_3"},
        )
        for _ in range(100):
            task = runtime._run_tasks.get(run.runId)  # noqa: SLF001
            if runtime.state.runs[run.runId].status == "waiting_approval" and (task is None or task.done()):
                break
            await asyncio.sleep(0.01)

        cancelled = await runtime.cancel({"runId": run.runId})
        assert cancelled.status == "cancelled"
        assert cancelled.pendingApproval is None
        assert cancelled.events[-1].type == "run_cancelled"

    asyncio.run(scenario())


def test_executor_graph_resumes_waiting_approval_after_runtime_restart(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def graph_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "跨进程恢复计划",
                    "deliverable": "report",
                    "steps": [{"agent": "editor", "title": "恢复后检索", "tools": ["rag.ask"]}],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = graph_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "检查恢复"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {"novelId": "novel_1", "chapterId": "chapter_3"},
        )
        for _ in range(100):
            task = runtime._run_tasks.get(run.runId)  # noqa: SLF001
            if runtime.state.runs[run.runId].status == "waiting_approval" and (task is None or task.done()):
                break
            await asyncio.sleep(0.01)

        pending = runtime.state.runs[run.runId].pendingApproval
        assert pending is not None
        restarted = NovelAgentRuntime(runtime.store, automation, AgentEventBus(runtime.store))
        assert restarted.state.runs[run.runId].status == "waiting_approval"
        assert restarted.state.runs[run.runId].pendingApproval is not None

        await restarted.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": pending["checkpointId"],
                "selectedOptionIds": ["current_chapter"],
            }
        )
        for _ in range(200):
            if restarted.state.runs[run.runId].status in {"completed", "failed"}:
                break
            await asyncio.sleep(0.01)

        assert restarted.state.runs[run.runId].status == "completed"
        assert [method for method, _, _ in automation.calls].count("rag.ask") == 1

    asyncio.run(scenario())


def test_reader_plan_maps_current_volume_to_chapter_list(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def reader_plan_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                automation.calls.append((method, params, origin))
                return {
                    "title": "读者视角检查计划",
                    "steps": [
                        {"agent": "reader", "title": "对照当前卷章节节奏", "tools": ["chapter.list"]},
                    ],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = reader_plan_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "从读者视角检查追更欲望", "role": "reader"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_3",
                "locale": "zh-CN",
            },
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status in {"completed", "failed"}:
                break
            await asyncio.sleep(0.01)

        assert runtime.state.runs[run.runId].status == "completed"
        chapter_list_call = next(params for method, params, _ in automation.calls if method == "chapter.list")
        assert chapter_list_call == {"volumeId": "volume_1"}

    asyncio.run(scenario())


def test_chat_uses_model_interface_and_returns_plan_signal(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        response = await runtime.chat(
            {
                "message": "帮我分析第三章的冲突",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "conv_1",
            },
            {"locale": "zh-CN"},
        )

        assert response.assistantMessage.content == "我会分析这一章的冲突目标。"
        assert response.suggestedActions == [{"label": "生成计划草稿", "method": "agent.plan"}]
        assert response.awaitingUserInput is False
        method, params, _ = automation.calls[0]
        assert method == "agent.generate_chat"
        assert params["role"] == "editor"
        assert "currentContent" not in params

    asyncio.run(scenario())


def test_chat_intent_decision_flows_into_operation_routed_plan(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        response = await runtime.chat(
            {
                "message": "检查当前章节的一致性和设定冲突",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "conv_intent_plan",
                "chapterId": "chapter_3",
            },
            {"novelId": "novel_1", "chapterId": "chapter_3", "locale": "zh-CN"},
        )

        assert response.intentDecision is not None
        assert response.intentDecision.route == "plan"
        assert response.intentDecision.operations[0].type == "chapter.consistency_review"
        assert response.intentDecision.operations[0].suggestedToolchainId == "chapter.consistency_review"

        plan = await runtime.plan(
            {
                "goal": "检查当前章节的一致性和设定冲突",
                "role": "editor",
                "chapterId": "chapter_3",
                "intentDecision": response.intentDecision.model_dump(),
            },
            {"novelId": "novel_1", "chapterId": "chapter_3", "locale": "zh-CN"},
        )
        planner_call = next(params for method, params, _ in automation.calls if method == "agent.generate_plan")
        assert planner_call["intentDecision"]["operations"][0]["type"] == "chapter.consistency_review"
        assert plan.deliverable == "report"
        assert len(plan.steps) == 1
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "chapter.consistency_review"

    asyncio.run(scenario())


def test_chat_follow_up_inherits_previous_intent_without_model_reclassification(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, _ = create_runtime(tmp_path)
        first = await runtime.chat(
            {
                "message": "新增一段世界观设定",
                "role": "worldbuilding",
                "approvalMode": "review_required",
                "conversationId": "conv_reference",
            },
            {"novelId": "novel_1", "locale": "zh-CN"},
        )
        assert first.intentDecision is not None
        assert first.intentDecision.operations[0].type == "creative_asset.draft"

        second = await runtime.chat(
            {
                "message": "按刚才那个方案继续",
                "role": "worldbuilding",
                "approvalMode": "review_required",
                "conversationId": "conv_reference",
            },
            {"novelId": "novel_1", "locale": "zh-CN"},
        )
        assert second.intentDecision is not None
        assert [operation.type for operation in second.intentDecision.operations] == ["creative_asset.draft"]
        assert second.intentDecision.deliverable == "creative_assets_draft"
        assert "PREVIOUS_INTENT_INHERITED" in second.intentDecision.reasonCodes

    asyncio.run(scenario())


def test_chat_langgraph_reads_project_context_before_answering(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        model_calls = 0

        async def exploration_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            nonlocal model_calls
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                model_calls += 1
                if not params["toolObservations"]:
                    assert "plotline.list" in params["availableReadTools"]
                    return {
                        "content": "我先查看当前大纲。",
                        "shouldPlan": True,
                        "needsClarification": False,
                        "toolCalls": [{"name": "plotline.list", "args": {}}],
                    }
                assert params["toolObservations"][0]["toolName"] == "plotline.list"
                return {
                    "content": "当前主线在觉醒后缺少代价节点，我会据此形成补充计划。",
                    "shouldPlan": True,
                    "needsClarification": False,
                    "toolCalls": [],
                }
            if method == "plotline.list":
                assert params == {"novelId": "novel_1"}
                return {"plotLines": [{"title": "觉醒主线", "status": "active"}]}
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = exploration_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "根据当前大纲新增一段主线。",
                "role": "writer",
                "approvalMode": "review_required",
                "conversationId": "conv_exploration",
            },
            {"novelId": "novel_1", "locale": "zh-CN"},
        )

        assert model_calls == 2
        assert response.assistantMessage.content.startswith("当前主线")
        assert response.contextReads == [{"toolName": "plotline.list", "status": "completed"}]
        assert response.suggestedActions == [{"label": "生成计划草稿", "method": "agent.plan"}]

    asyncio.run(scenario())


def test_chat_langgraph_can_execute_project_reads_through_fastmcp(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        model_calls = 0

        async def exploration_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            nonlocal model_calls
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                model_calls += 1
                if not params["toolObservations"]:
                    return {
                        "content": "我先读取当前章节。",
                        "shouldPlan": False,
                        "needsClarification": False,
                        "toolCalls": [{"name": "chapter.get", "args": {}}],
                    }
                observation = params["toolObservations"][0]
                assert observation["result"]["title"] == "第三章"
                return {
                    "content": "当前章节已读取，可以继续审校。",
                    "shouldPlan": False,
                    "needsClarification": False,
                    "toolCalls": [],
                }
            if method == "chapter.get":
                assert request_id is None
                assert params == {"chapterId": "chapter_3"}
                return {"id": "chapter_3", "title": "第三章"}
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = exploration_invoke  # type: ignore[method-assign]
        adapter = FastMcpAgentToolAdapter(automation)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store), tool_adapter=adapter)

        response = await runtime.chat(
            {
                "message": "审校当前章节。",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "conv_fastmcp_exploration",
            },
            {"novelId": "novel_1", "chapterId": "chapter_3", "locale": "zh-CN"},
        )

        assert runtime.tool_transport == "fastmcp"
        assert model_calls == 2
        assert response.contextReads == [{"toolName": "chapter.get", "status": "completed"}]
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat", "chapter.get", "agent.generate_chat"]

    asyncio.run(scenario())


def test_chat_selected_chapter_context_redirects_redundant_discovery(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        model_calls = 0

        async def selected_chapter_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            nonlocal model_calls
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                model_calls += 1
                selection = params["selectionContext"]
                assert selection["novelTitle"] == "七夜"
                assert selection["chapterId"] == "chapter_3"
                assert selection["chapterTitle"] == "残响觉醒"
                assert selection["currentContent"] == "当前编辑器正文"
                if not params["toolObservations"]:
                    return {
                        "content": "我先确认你要校验哪一章。",
                        "shouldPlan": False,
                        "needsClarification": True,
                        "toolCalls": [{"name": "volume.list", "args": {}}],
                    }
                assert params["toolObservations"][0]["toolName"] == "chapter.get"
                return {
                    "content": "我会校验当前选中的章节。",
                    "shouldPlan": True,
                    "needsClarification": False,
                    "toolCalls": [],
                }
            if method == "chapter.get":
                assert params == {"chapterId": "chapter_3"}
                return {"id": "chapter_3", "title": "残响觉醒"}
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = selected_chapter_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "帮我校验这篇文章",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "conv_selected_chapter",
                "novelId": "novel_1",
                "novelTitle": "七夜",
                "volumeId": "volume_1",
                "chapterId": "chapter_3",
                "chapterTitle": "残响觉醒",
                "currentContentText": "当前编辑器正文",
            },
            {"locale": "zh-CN"},
        )

        assert model_calls == 2
        assert response.awaitingUserInput is False
        assert response.intentDecision is not None
        assert response.intentDecision.route == "plan"
        assert response.contextReads == [{"toolName": "chapter.get", "status": "completed"}]
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat", "chapter.get", "agent.generate_chat"]

    asyncio.run(scenario())


def test_chat_explicit_cross_chapter_scope_keeps_discovery_tool(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def cross_chapter_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                if not params["toolObservations"]:
                    return {
                        "content": "我先读取当前卷的章节结构。",
                        "shouldPlan": False,
                        "needsClarification": False,
                        "toolCalls": [{"name": "volume.list", "args": {}}],
                    }
                assert params["toolObservations"][0]["toolName"] == "volume.list"
                return {
                    "content": "我会校验当前章节和相邻章节。",
                    "shouldPlan": True,
                    "needsClarification": False,
                    "toolCalls": [],
                }
            if method == "volume.list":
                return [{"id": "volume_1", "title": "第一卷"}]
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = cross_chapter_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "帮我校验这篇文章和相邻章节",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "conv_cross_chapter",
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_3",
            },
            {"locale": "zh-CN"},
        )

        assert response.contextReads == [{"toolName": "volume.list", "status": "completed"}]
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat", "volume.list", "agent.generate_chat"]

    asyncio.run(scenario())


def test_chat_langgraph_rejects_non_read_only_tool_calls(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def unsafe_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            assert method == "agent.generate_chat"
            return {
                "content": "我会先形成计划，未经批准不写回。",
                "shouldPlan": True,
                "needsClarification": False,
                "toolCalls": [{"name": "outline.write", "args": {"title": "越权写入"}}],
            }

        automation.invoke = unsafe_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "修改大纲。",
                "approvalMode": "review_required",
                "conversationId": "conv_unsafe_tool",
            },
            {"novelId": "novel_1"},
        )

        assert response.contextReads == []
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat"]

    asyncio.run(scenario())


def test_chat_waits_for_clarification_before_suggesting_plan(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        call_count = 0

        async def clarification_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            nonlocal call_count
            automation.calls.append((method, params, origin))
            assert method == "agent.generate_chat"
            call_count += 1
            if call_count == 1:
                return {
                    "content": "你想新增世界观设定、剧情线，还是角色支线？",
                    "shouldPlan": True,
                    "needsClarification": True,
                }
            assert params["history"][-1]["content"] == "你想新增世界观设定、剧情线，还是角色支线？"
            return {
                "content": "明白了，我会为新增世界观设定形成计划。",
                "shouldPlan": True,
                "needsClarification": False,
            }

        automation.invoke = clarification_invoke  # type: ignore[method-assign]
        first = await runtime.chat(
            {
                "message": "大纲新增一部分。",
                "role": "worldbuilding",
                "approvalMode": "review_required",
                "conversationId": "conv_clarification",
            },
            {"locale": "zh-CN"},
        )
        assert first.awaitingUserInput is True
        assert first.suggestedActions == []

        second = await runtime.chat(
            {
                "message": "新增世界观设定。",
                "role": "worldbuilding",
                "approvalMode": "review_required",
                "conversationId": "conv_clarification",
            },
            {"locale": "zh-CN"},
        )
        assert second.awaitingUserInput is False
        assert second.suggestedActions == [{"label": "生成计划草稿", "method": "agent.plan"}]

    asyncio.run(scenario())


def test_chat_synchronizes_visible_conversation_history(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def history_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            assert method == "agent.generate_chat"
            assert len(params["history"]) == 28
            assert params["history"][0]["messageId"] == "history-0"
            assert params["history"][0]["content"] == "最早约束：必须保持第一人称。"
            assert params["history"][-1]["content"] == "最终总结：建议新增觉醒代价设定节点。"
            assert params["conversationContext"]["currentPlan"]["title"] == "新增觉醒代价"
            assert params["persistentSummary"]["revision"] == 1
            return {
                "content": "我会按上面的总结继续。",
                "shouldPlan": True,
                "needsClarification": False,
                "contextCompression": {
                    "applied": True,
                    "historyMessagesSummarized": 18,
                    "historyMessagesOmitted": 0,
                },
                "contextDiagnostics": {
                    "contextVersion": "agent-context-v1",
                    "model": "test-model",
                    "historyMessagesTotal": 28,
                    "historyMessagesKept": 10,
                    "historyMessagesSummarized": 18,
                },
                "conversationSummary": {
                    "version": "agent-conversation-summary-v1",
                    "revision": 2,
                    "coveredMessageIds": ["history-0"],
                    "coverage": {"messageCount": 1},
                    "facts": [],
                    "userDecisions": [],
                    "unresolvedQuestions": [],
                    "outcomes": [],
                    "artifactRefs": [],
                    "updatedAt": "2026-07-16T00:00:00Z",
                },
            }

        automation.invoke = history_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "按上面的总结生成草稿。",
                "role": "worldbuilding",
                "approvalMode": "review_required",
                "conversationId": "conv_history",
                "history": [
                    {"messageId": "history-0", "role": "user", "content": "最早约束：必须保持第一人称。"},
                    *[
                        {
                            "messageId": f"history-{index}",
                            "role": "assistant" if index % 2 else "user",
                            "content": f"中间消息 {index}",
                        }
                        for index in range(1, 27)
                    ],
                    {"messageId": "history-27", "role": "assistant", "content": "最终总结：建议新增觉醒代价设定节点。"},
                ],
                "persistentSummary": {
                    "version": "agent-conversation-summary-v1",
                    "revision": 1,
                    "coveredMessageIds": [],
                },
                "conversationContext": {
                    "currentPlan": {"title": "新增觉醒代价"},
                    "activeRun": {"status": "completed"},
                },
            },
            {"locale": "zh-CN"},
        )
        assert response.suggestedActions == [{"label": "生成计划草稿", "method": "agent.plan"}]
        assert response.contextCompression is not None
        assert response.contextCompression["historyMessagesSummarized"] == 18
        assert response.contextDiagnostics is not None
        assert response.contextDiagnostics["historyMessagesTotal"] == 28
        assert response.conversationSummary is not None
        assert response.conversationSummary["revision"] == 2
        assert response.assistantMessage.messageId

    asyncio.run(scenario())


def test_worldbuilding_creation_plan_guarantees_creative_draft(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def missing_draft_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "agent.generate_plan":
                automation.calls.append((method, params, origin))
                return {
                    "title": "新增世界观大纲节点",
                    "steps": [
                        {"agent": "worldbuilding", "title": "读取现有设定", "tools": ["worldsetting.list"]},
                        {"agent": "worldbuilding", "title": "形成新增设定方案", "tools": []},
                        {"agent": "editor", "title": "检查一致性", "tools": ["plotline.list"]},
                    ],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = missing_draft_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "大纲新增世界观设定部分", "role": "worldbuilding"}, {})
        assert plan.preferredRole == "worldbuilding"
        assert plan.deliverable == "creative_assets_draft"
        draft_steps = [step for step in plan.steps if "creative_assets.generate_draft" in step.tools]
        assert len(draft_steps) == 1
        assert draft_steps[0].agent == "worldbuilding"

        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "approval": {"approved": True, "approvedStepIds": [step.stepId for step in plan.steps]},
            },
            {},
        )
        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "completed":
                break
            await asyncio.sleep(0.01)
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed"
        assert completed.draftSessionId == "creative_draft_1"
        assert [artifact.type for artifact in completed.artifacts] == ["creative_assets_draft", "report"]
        assert completed.artifacts[0].reference == {"draftSessionId": "creative_draft_1"}
        report_params = next(params for method, params, _ in automation.calls if method == "agent.generate_report")
        assert report_params["role"] == "worldbuilding"
        assert report_params["deliverable"] == "creative_assets_draft"
        assert "reader" not in {step["agent"] for step in report_params["steps"]}

    asyncio.run(scenario())


def test_planner_rejects_tools_outside_allowlist(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def invalid_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "危险计划",
                    "steps": [{"agent": "writer", "title": "直接写回", "tools": ["chapter.save"]}],
                }
            return await FakeAutomationClient().invoke(method, params, origin, request_id=request_id)

        automation.invoke = invalid_invoke  # type: ignore[method-assign]
        with pytest.raises(ValueError, match="unavailable tool"):
            await runtime.plan({"goal": "修改第三章"}, {})

    asyncio.run(scenario())


def test_register_plan_validates_and_persists_external_review_plan(tmp_path: Path) -> None:
    runtime, _ = create_runtime(tmp_path)
    payload = {
        "planId": "plan_revision_1",
        "threadId": "thread_revision_1",
        "title": "修订人物动机",
        "goal": "根据已接受的问题修订人物动机",
        "requiresApproval": True,
        "preferredRole": "editor",
        "deliverable": "report",
        "steps": [{
            "stepId": "step_revision_1",
            "agent": "editor",
            "title": "读取目标章节",
            "tools": ["chapter.get"],
            "status": "completed",
        }],
    }

    registered = runtime.register_plan({"plan": payload}, {})
    assert registered.planId == "plan_revision_1"
    assert registered.steps[0].status == "pending"
    assert runtime.state.plans[registered.planId].title == "修订人物动机"
    assert runtime.register_plan({"plan": registered.model_dump()}, {}).planId == registered.planId

    invalid = {
        **payload,
        "planId": "plan_revision_invalid",
        "steps": [{**payload["steps"][0], "stepId": "step_invalid", "tools": ["chapter.save"]}],
    }
    with pytest.raises(ValueError, match="unknown tools"):
        runtime.register_plan({"plan": invalid}, {})


def test_revise_plan_preserves_plan_identity_and_existing_step_ids(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        plan = await runtime.plan({"goal": "续写下一段", "role": "writer"}, {})
        original_plan_id = plan.planId
        original_thread_id = plan.threadId
        original_first_step_id = plan.steps[0].stepId

        revised = await runtime.revise_plan(
            {
                "planId": plan.planId,
                "revision": "增加读者视角的追更欲望检查",
                "role": "reader",
            },
            {"locale": "zh-CN"},
        )

        assert revised.planId == original_plan_id
        assert revised.threadId == original_thread_id
        assert revised.steps[0].stepId == original_first_step_id
        assert revised.steps[1].stepId != plan.steps[1].stepId
        assert revised.steps[1].agent == "reader"
        method, params, _ = automation.calls[-1]
        assert method == "agent.revise_plan"
        assert params["revision"] == "增加读者视角的追更欲望检查"

    asyncio.run(scenario())


def test_explicit_chapter_scope_overrides_model_and_survives_revision(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def scoped_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            automation.calls.append((method, params, origin))
            if method == "agent.generate_plan":
                return {
                    "title": "跨章编辑审核",
                    "deliverable": "expert_report",
                    "steps": [{
                        "agent": "editor",
                        "title": "审核模型猜测的范围",
                        "tools": [],
                        "toolchain": {
                            "id": "editor.range_review",
                            "version": "1.0.0",
                            "input": {"kind": "selected_chapters", "chapterIds": ["model_chapter"]},
                        },
                    }],
                }
            if method == "agent.revise_plan":
                first_step = params["currentPlan"]["steps"][0]
                return {
                    "title": "修订后的跨章编辑审核",
                    "deliverable": "expert_report",
                    "steps": [{
                        "stepId": first_step["stepId"],
                        "agent": "editor",
                        "title": "再次审核模型猜测的范围",
                        "tools": [],
                        "toolchain": {
                            "id": "editor.range_review",
                            "version": "1.0.0",
                            "input": {"kind": "novel", "chapterIds": []},
                        },
                    }],
                }
            return await FakeAutomationClient().invoke(method, params, origin, request_id=request_id)

        automation.invoke = scoped_invoke  # type: ignore[method-assign]
        explicit_scope = {
            "kind": "selected_chapters",
            "chapterIds": ["chapter_2", "chapter_4"],
            "anchorChapterId": "chapter_4",
            "processingMode": "detailed",
        }
        plan = await runtime.plan(
            {
                "goal": "审核选择的两章",
                "role": "editor",
                "novelId": "novel_1",
                "chapterId": "chapter_2",
                "chapterScope": explicit_scope,
            },
            {"locale": "zh-CN"},
        )
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.input["kind"] == "selected_chapters"
        assert plan.steps[0].toolchain.input["chapterIds"] == ["chapter_2", "chapter_4"]
        assert plan.steps[0].toolchain.input["anchorChapterId"] == "chapter_4"

        revised = await runtime.revise_plan(
            {
                "planId": plan.planId,
                "revision": "加强动机检查",
                "role": "editor",
                "novelId": "novel_1",
                "chapterId": "chapter_2",
                "chapterScope": explicit_scope,
            },
            {"locale": "zh-CN"},
        )
        assert revised.steps[0].toolchain is not None
        assert revised.steps[0].toolchain.input["kind"] == "selected_chapters"
        assert revised.steps[0].toolchain.input["chapterIds"] == ["chapter_2", "chapter_4"]

    asyncio.run(scenario())


def test_full_run_resumes_from_approval_and_creates_draft(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def quality_plan_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                automation.calls.append((method, params, origin))
                return {
                    "title": "章节打磨计划",
                    "steps": [
                        {"agent": "supervisor", "title": "读取章节", "tools": ["chapter.get"]},
                        {"agent": "editor", "title": "分析节奏", "tools": ["rag.ask"]},
                        {"agent": "writer", "title": "生成草稿", "tools": ["chapter.generate_draft"]},
                    ],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = quality_plan_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "打磨第三章", "role": "team"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "chapterId": "chapter_3",
                "currentContent": "第三章正文",
                "approval": {
                    "approved": True,
                    "approvedStepIds": [step.stepId for step in plan.steps],
                },
            },
            {"locale": "zh-CN"},
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "waiting_approval":
                break
            await asyncio.sleep(0.01)

        waiting_run = runtime.state.runs[run.runId]
        assert waiting_run.status == "waiting_approval"
        assert waiting_run.pendingApproval is not None
        checkpoint_id = str(waiting_run.pendingApproval["checkpointId"])
        await runtime.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": checkpoint_id,
                "selectedOptionIds": ["current_chapter"],
            }
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "completed":
                break
            await asyncio.sleep(0.01)

        completed_run = runtime.state.runs[run.runId]
        assert completed_run.status == "completed"
        assert completed_run.draftSessionId == "draft_1"
        assert [artifact.type for artifact in completed_run.artifacts] == ["chapter_draft", "report"]
        assert completed_run.artifacts[0].reference == {"draftSessionId": "draft_1"}
        assert "最终建议" in str(completed_run.artifacts[1].content)
        assert sum(event.type == "artifact_created" for event in completed_run.events) == 2
        milestones = [
            event.type for event in completed_run.events
            if event.type in {"approval_required", "draft_created", "run_completed"}
            or (event.type == "message" and event.payload.get("kind") == "final_report")
        ]
        assert milestones == ["approval_required", "draft_created", "message", "run_completed"]
        final_report_event = next(
            event for event in completed_run.events
            if event.type == "message" and event.payload.get("kind") == "final_report"
        )
        assert "审阅已完成" in str(final_report_event.payload.get("content"))
        assert "最终建议" not in str(final_report_event.payload.get("content"))
        assert final_report_event.payload.get("reportArtifactId") == completed_run.artifacts[1].artifactId
        rag_call = next(params for method, params, _ in automation.calls if method == "rag.ask")
        assert rag_call["analysisScope"] == "current_chapter"
        assert rag_call["maxEvidenceItems"] == 8
        report_call = next(params for method, params, _ in automation.calls if method == "agent.generate_report")
        assert any(finding["toolName"] == "rag.ask" for finding in report_call["findings"])

    asyncio.run(scenario())


def test_low_confidence_checkpoint_can_skip_draft_generation(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def low_confidence_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                automation.calls.append((method, params, origin))
                return {
                    "title": "低置信度章节检查",
                    "steps": [
                        {"agent": "editor", "title": "分析章节", "tools": ["rag.ask"]},
                        {"agent": "writer", "title": "生成草稿", "tools": ["chapter.generate_draft"]},
                    ],
                }
            if method == "rag.ask":
                automation.calls.append((method, params, origin))
                return {
                    "answer": "现有资料不足以形成稳定判断。",
                    "confidence": "low",
                    "warnings": ["向量索引没有匹配结果"],
                    "evidence": [],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = low_confidence_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "检查第三章"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "chapterId": "chapter_3",
                "currentContent": "第三章正文",
                "approval": {"approved": True, "approvedStepIds": [step.stepId for step in plan.steps]},
            },
            {},
        )

        for _ in range(2000):
            pending = runtime.state.runs[run.runId].pendingApproval
            if pending and pending.get("checkpointType") == "analysis_scope":
                break
            await asyncio.sleep(0.01)
        scope_checkpoint = runtime.state.runs[run.runId].pendingApproval
        assert scope_checkpoint is not None
        await runtime.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": scope_checkpoint["checkpointId"],
                "selectedOptionIds": ["current_chapter"],
            }
        )

        for _ in range(2000):
            pending = runtime.state.runs[run.runId].pendingApproval
            if pending and pending.get("checkpointType") == "evidence_quality":
                break
            await asyncio.sleep(0.01)
        evidence_checkpoint = runtime.state.runs[run.runId].pendingApproval
        assert evidence_checkpoint is not None
        assert evidence_checkpoint["allowFreeText"] is False
        with pytest.raises(ValueError, match="does not allow free-text"):
            await runtime.submit_approval(
                {
                    "runId": run.runId,
                    "checkpointId": evidence_checkpoint["checkpointId"],
                    "freeText": "直接继续",
                }
            )
        await runtime.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": evidence_checkpoint["checkpointId"],
                "selectedOptionIds": ["report_only"],
            }
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "completed":
                break
            await asyncio.sleep(0.01)

        completed_run = runtime.state.runs[run.runId]
        assert completed_run.status == "completed"
        assert completed_run.draftSessionId is None
        assert not any(method == "chapter.generate_draft" for method, _, _ in automation.calls)
        approval_types = [
            event.payload.get("checkpointType")
            for event in completed_run.events
            if event.type == "approval_required"
        ]
        assert approval_types == ["analysis_scope", "evidence_quality"]
        skipped = [
            event for event in completed_run.events
            if event.type == "tool_result" and event.status == "skipped"
        ]
        assert skipped and skipped[-1].payload["reason"] == "report_only"

    asyncio.run(scenario())


def test_creative_direction_choice_is_injected_into_draft_intent(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def direction_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.detect_creative_direction":
                automation.calls.append((method, params, origin))
                return {
                    "requiresDecision": True,
                    "title": "章末方向确认",
                    "question": "章末更偏向胜利还是危机？",
                    "reason": "两个方向会改变下一章的起点。",
                    "options": [
                        {"id": "model_victory", "label": "阶段性胜利", "description": "先兑现本章目标。"},
                        {"id": "model_crisis", "label": "危机升级", "description": "用更强阻力制造追更钩子。"},
                    ],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = direction_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "续写下一段"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "chapterId": "chapter_3",
                "currentContent": "第三章正文",
                "approval": {"approved": True, "approvedStepIds": [step.stepId for step in plan.steps]},
            },
            {},
        )

        for _ in range(2000):
            pending = runtime.state.runs[run.runId].pendingApproval
            if pending and pending.get("checkpointType") == "creative_direction":
                break
            await asyncio.sleep(0.01)
        checkpoint = runtime.state.runs[run.runId].pendingApproval
        assert checkpoint is not None
        assert [option["id"] for option in checkpoint["options"]] == ["direction_1", "direction_2"]
        await runtime.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": checkpoint["checkpointId"],
                "selectedOptionIds": ["direction_2"],
            }
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "completed":
                break
            await asyncio.sleep(0.01)

        assert runtime.state.runs[run.runId].status == "completed"
        draft_params = next(params for method, params, _ in automation.calls if method == "chapter.generate_draft")
        assert "用户确认的创作方向" in draft_params["userIntent"]
        assert "危机升级" in draft_params["userIntent"]
        assert "model_crisis" not in draft_params["userIntent"]

    asyncio.run(scenario())


def test_cancel_aborts_active_automation_request_without_creating_draft(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke
        draft_started = asyncio.Event()

        async def slow_draft_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "chapter.generate_draft":
                automation.calls.append((method, params, origin))
                if request_id:
                    automation.request_ids.append(request_id)
                draft_started.set()
                await asyncio.Event().wait()
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = slow_draft_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "续写下一段"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "chapterId": "chapter_3",
                "currentContent": "第三章正文",
                "approval": {"approved": True, "approvedStepIds": [step.stepId for step in plan.steps]},
            },
            {},
        )

        await asyncio.wait_for(draft_started.wait(), timeout=1)
        active_request_ids = set(runtime._active_request_ids[run.runId])
        cancelled = await runtime.cancel({"runId": run.runId})
        assert cancelled.status in {"cancelling", "cancelled"}

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "cancelled":
                break
            await asyncio.sleep(0.01)

        final_run = runtime.state.runs[run.runId]
        assert final_run.status == "cancelled"
        assert final_run.draftSessionId is None
        assert set(automation.cancelled_request_ids) == active_request_ids
        assert any(event.type == "run_cancelled" for event in final_run.events)
        assert not any(event.type == "run_failed" for event in final_run.events)
        invocation = runtime.store.list_invocations(run.runId)[0]
        assert invocation.status == "unknown"
        assert invocation.error and invocation.error["code"] == "CANCELLED_WHILE_IN_FLIGHT"

    asyncio.run(scenario())


def test_execute_plan_only_runs_approved_steps(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        plan = await runtime.plan(
            {"goal": "续写下一段", "novelId": "novel_1", "chapterId": "chapter_3"},
            {},
        )
        plan.deliverable = "report"
        approved_step = plan.steps[0]
        skipped_step = plan.steps[1]

        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "chapterId": "chapter_3",
                "currentContent": "正文",
                "approval": {"approved": True, "approvedStepIds": [approved_step.stepId]},
            },
            {},
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "completed":
                break
            await asyncio.sleep(0.01)

        assert runtime.state.runs[run.runId].status == "completed"
        assert approved_step.status == "completed"
        assert skipped_step.status == "skipped"
        execution_methods = [method for method, _, _ in automation.calls if not method.startswith("agent.generate_")]
        assert execution_methods == ["chapter.get"]

    asyncio.run(scenario())


def test_analysis_scope_changes_rag_request(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        run = AgentRun(
            runId=new_id("run"),
            threadId=new_id("thread"),
            planId=new_id("plan"),
            status="running",
            approvalResponses=[
                {
                    "checkpointType": "analysis_scope",
                    "selectedOptionIds": ["volume_structure"],
                    "freeText": "重点检查伏笔回收",
                }
            ],
        )

        await runtime._invoke_tool(
            run,
            "rag.ask",
            "提高追更欲望",
            "novel_1",
            None,
            "chapter_3",
            "正文",
            "zh-CN",
        )

        method, params, _ = automation.calls[-1]
        assert method == "rag.ask"
        assert params["analysisScope"] == "volume_structure"
        assert params["maxEvidenceItems"] == 24
        assert "当前卷的整体结构" in params["question"]
        assert "重点检查伏笔回收" in params["question"]

    asyncio.run(scenario())


def test_event_stream_replays_terminal_event(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        event_bus = AgentEventBus(store)
        run_id = new_id("run")
        await event_bus.append(
            AgentRunEvent(eventId=new_id("evt"), runId=run_id, type="run_started")
        )
        terminal = await event_bus.append(
            AgentRunEvent(eventId=new_id("evt"), runId=run_id, type="run_completed")
        )

        replayed = []
        async for event in event_bus.subscribe(run_id, after_sequence=0):
            replayed.append(event)

        assert [event.type for event in replayed] == ["run_started", "run_completed"]
        assert replayed[-1].sequence == terminal.sequence

    asyncio.run(scenario())


def test_sse_endpoint_authenticates_and_replays_after_sequence(tmp_path: Path) -> None:
    store = AgentStateStore(tmp_path)
    event_bus = AgentEventBus(store)
    automation = FakeAutomationClient()
    runtime = NovelAgentRuntime(store, automation, event_bus)
    run_id = new_id("run")

    async def seed_events() -> tuple[AgentRunEvent, AgentRunEvent]:
        first = await event_bus.append(
            AgentRunEvent(eventId=new_id("evt"), runId=run_id, type="run_started")
        )
        terminal = await event_bus.append(
            AgentRunEvent(eventId=new_id("evt"), runId=run_id, type="run_completed")
        )
        return first, terminal

    first, terminal = asyncio.run(seed_events())
    app = build_app(runtime, "test-token")
    with TestClient(app) as client:
        unauthorized = client.get(f"/events/{run_id}")
        assert unauthorized.status_code == 401

        response = client.get(
            f"/events/{run_id}?afterSequence={first.sequence}",
            headers={"Authorization": "Bearer test-token"},
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    data_lines = [line.removeprefix("data: ") for line in response.text.splitlines() if line.startswith("data: ")]
    assert len(data_lines) == 1
    payload = json.loads(data_lines[0])
    assert payload["eventId"] == terminal.eventId
    assert payload["sequence"] == terminal.sequence
    assert payload["type"] == "run_completed"
