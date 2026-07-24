from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.toolchains.chapter_scope_context import (
    apply_scope_node_result,
    build_scope_bundle,
    initial_scope_context_state,
    project_scope_bundle,
)
from novel_agent_runtime.toolchains.schemas import ChapterScopeBundle, ChapterScopeContextInput

from test_runtime import FakeAutomationClient


def _scope_bundle() -> dict[str, Any]:
    chapters = [
        {
            "chapterId": f"chapter_{index}",
            "volumeId": "volume_1",
            "title": f"第{index}章",
            "order": index,
            "volumeOrder": 1,
            "version": 1,
            "updatedAt": f"2026-07-{index:02d}T00:00:00.000Z",
            "contentHash": f"hash_{index}",
            "contentMode": "full",
            "content": f"第{index}章正文，未来关键词_{index}。",
            "summaryFresh": True,
            "target": True,
        }
        for index in range(1, 4)
    ]
    snapshots = [
        {
            "chapterId": chapter["chapterId"],
            "version": 1,
            "contentHash": chapter["contentHash"],
            "updatedAt": chapter["updatedAt"],
            "source": "database",
        }
        for chapter in chapters
    ]
    return {
        "scope": {
            "scopeId": "scope_1",
            "novelId": "novel_1",
            "kind": "selected_chapters",
            "volumeId": "volume_1",
            "chapterIds": [chapter["chapterId"] for chapter in chapters],
            "anchorChapterId": "chapter_2",
            "processingMode": "detailed",
            "snapshot": snapshots,
        },
        "chapters": chapters,
        "narrativeSummaries": [{
            "id": "summary_novel",
            "level": "novel",
            "title": "全书摘要",
            "summaryText": "第三章会揭示未来关键词_3。",
            "keyFacts": ["后台事实"],
            "unresolvedThreads": [],
            "sourceFingerprint": "fingerprint",
        }],
        "entityContext": {
            "characters": [{"id": "character_1", "name": "顾野", "secret": "未来关键词_3"}],
            "items": [],
            "worldSettings": [{"id": "world_1", "name": "后台规则"}],
            "maps": [],
        },
        "plotContext": {"plotlines": [{"id": "plot_1", "name": "未来主线"}]},
        "evidence": [],
        "stateLedger": {
            "entities": {"顾野": {"secret": "未来关键词_3"}},
            "timelineHints": ["第三章真相"],
            "openQuestions": [],
            "unresolvedThreads": [],
        },
        "coverage": {
            "totalChapterCount": 3,
            "contextChapterCount": 3,
            "readonlyChapterCount": 0,
            "detailedChapterCount": 3,
            "summarizedChapterCount": 0,
            "excerptChapterCount": 0,
            "omittedChapterCount": 0,
            "batchSize": 4,
            "batchCount": 1,
            "batches": [{"index": 0, "chapterIds": ["chapter_1", "chapter_2", "chapter_3"]}],
        },
        "sourceSnapshot": snapshots,
        "warnings": [],
        "estimatedTokens": 2400,
    }


def test_scope_input_uses_current_selection_as_anchor() -> None:
    value = ChapterScopeContextInput(
        novelId="novel_1",
        chapterId="chapter_2",
        goal="审核当前章节",
    )

    assert value.anchorChapterId == "chapter_2"
    assert value.chapterIds == ["chapter_2"]
    assert value.kind == "current_chapter"


def test_selected_scope_does_not_promote_current_chapter_to_target() -> None:
    value = ChapterScopeContextInput(
        novelId="novel_1",
        kind="selected_chapters",
        chapterId="chapter_current",
        chapterIds=["chapter_3", "chapter_4"],
        goal="审核选择章节",
    )

    assert value.anchorChapterId == "chapter_4"
    assert value.chapterIds == ["chapter_3", "chapter_4"]


def test_reader_projection_removes_future_and_backend_context() -> None:
    bundle = ChapterScopeBundle.model_validate(_scope_bundle())
    bundle.evidence = [
        {"sourceType": "chapter", "sourceId": "chapter_1", "excerpt": "已知事实"},
        {"sourceType": "chapter", "sourceId": "chapter_3", "excerpt": "未来关键词_3"},
        {"sourceType": "worldsetting", "sourceId": "world_1", "excerpt": "后台规则"},
    ]

    projected = project_scope_bundle(bundle, "reader")
    serialized = projected.model_dump_json()

    assert [item.chapterId for item in projected.chapters] == ["chapter_1", "chapter_2"]
    assert [item.sourceId for item in projected.evidence] == ["chapter_1"]
    assert projected.narrativeSummaries == []
    assert projected.entityContext["worldSettings"] == []
    assert projected.plotContext["plotlines"] == []
    assert "未来关键词_3" not in serialized
    assert projected.scope.chapterIds == ["chapter_1", "chapter_2"]


def test_scope_node_merges_rag_and_preserves_source_snapshot() -> None:
    input_data = ChapterScopeContextInput(
        novelId="novel_1",
        kind="selected_chapters",
        chapterIds=["chapter_1", "chapter_2", "chapter_3"],
        anchorChapterId="chapter_2",
        goal="跨章检查",
    )
    state = initial_scope_context_state(input_data)
    state = apply_scope_node_result(state, "scope.read", _scope_bundle())
    state = apply_scope_node_result(state, "rag.retrieve", {
        "evidence": [{
            "sourceType": "chapter",
            "sourceId": "chapter_1",
            "title": "第一章",
            "excerpt": "顾野已经受伤。",
            "confidence": 0.95,
        }],
    })

    bundle = build_scope_bundle(state, "editor")

    assert bundle.scope.snapshot[1].contentHash == "hash_2"
    assert bundle.evidence[0].sourceId == "chapter_1"
    assert state["toolCallCount"] == 2
    assert state["sourceStatus"] == {"scope.read": "completed", "rag.retrieve": "completed"}


async def _wait_terminal(runtime: NovelAgentRuntime, run_id: str) -> None:
    for _ in range(600):
        if runtime.state.runs[run_id].status in {"completed", "failed", "cancelled"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Chapter scope context did not reach a terminal state")


def test_scope_toolchain_publishes_reader_safe_artifact(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "多章节读者上下文",
                    "deliverable": "report",
                    "steps": [{
                        "agent": "reader",
                        "title": "装配严格顺序阅读上下文",
                        "tools": [],
                        "toolchain": {
                            "id": "chapter.scope_context",
                            "version": "1.0.0",
                            "input": {
                                "kind": "selected_chapters",
                                "chapterIds": ["chapter_1", "chapter_2", "chapter_3"],
                                "anchorChapterId": "chapter_2",
                            },
                        },
                    }],
                }
            if method == "chapter.scope_context.build":
                automation.calls.append((method, params, origin))
                return _scope_bundle()
            if method == "rag.ask":
                automation.calls.append((method, params, origin))
                return {
                    "evidence": [
                        {"sourceType": "chapter", "sourceId": "chapter_1", "excerpt": "已知事实"},
                        {"sourceType": "chapter", "sourceId": "chapter_3", "excerpt": "未来关键词_3"},
                    ]
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({"goal": "按读者视角审核前三章", "role": "reader"}, {"locale": "zh-CN"})
        run = await runtime.execute_plan({
            "planId": plan.planId,
            "novelId": "novel_1",
            "volumeId": "volume_1",
            "chapterId": "chapter_2",
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {})
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed", [
            (event.type, event.payload) for event in completed.events[-8:]
        ]
        artifact = next(item for item in completed.artifacts if item.type == "chapter_scope_context")
        context = artifact.metadata["contextBundle"]
        assert [item["chapterId"] for item in context["chapters"]] == ["chapter_1", "chapter_2"]
        assert context["narrativeSummaries"] == []
        assert context["entityContext"]["characters"] == []
        assert "未来关键词_3" not in artifact.content
        assert len([event for event in completed.events if event.type == "tool_result"]) == 2
        assert any(event.type == "toolchain_completed" for event in completed.events)

    asyncio.run(scenario())
