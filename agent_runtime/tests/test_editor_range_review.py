from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.toolchains.editor_range_review import normalize_editor_range_review
from novel_agent_runtime.toolchains.schemas import ChapterScopeBundle

from test_runtime import FakeAutomationClient


def _scope_bundle() -> dict[str, Any]:
    snapshots = [
        {
            "chapterId": f"chapter_{index}",
            "version": 1,
            "contentHash": f"hash_{index}",
            "updatedAt": f"2026-07-{index:02d}T00:00:00Z",
            "source": "database",
        }
        for index in range(1, 3)
    ]
    return {
        "scope": {
            "scopeId": "scope_editor_1",
            "novelId": "novel_1",
            "kind": "selected_chapters",
            "volumeId": "volume_1",
            "chapterIds": ["chapter_1", "chapter_2"],
            "anchorChapterId": "chapter_2",
            "processingMode": "detailed",
            "snapshot": snapshots,
        },
        "chapters": [
            {
                "chapterId": f"chapter_{index}",
                "volumeId": "volume_1",
                "title": f"第{index}章",
                "order": index,
                "volumeOrder": 1,
                "version": 1,
                "updatedAt": f"2026-07-{index:02d}T00:00:00Z",
                "contentHash": f"hash_{index}",
                "contentMode": "full",
                "content": f"第{index}章正文。",
                "summaryFresh": True,
                "target": True,
            }
            for index in range(1, 3)
        ],
        "narrativeSummaries": [],
        "entityContext": {
            "characters": [{"id": "character_1", "name": "顾野"}],
            "items": [],
            "worldSettings": [],
            "maps": [],
        },
        "plotContext": {"plotlines": [{"id": "plotline_1", "name": "主线"}]},
        "evidence": [{
            "sourceType": "character",
            "sourceId": "character_1",
            "title": "顾野",
            "excerpt": "顾野遇事会先观察。",
            "confidence": 0.9,
        }],
        "stateLedger": {},
        "coverage": {
            "totalChapterCount": 2,
            "contextChapterCount": 2,
            "readonlyChapterCount": 0,
            "detailedChapterCount": 2,
            "summarizedChapterCount": 0,
            "excerptChapterCount": 0,
            "omittedChapterCount": 0,
            "batchSize": 4,
            "batchCount": 1,
            "batches": [{"index": 0, "chapterIds": ["chapter_1", "chapter_2"]}],
        },
        "sourceSnapshot": snapshots,
        "warnings": [],
        "estimatedTokens": 2600,
    }


def _model_review() -> dict[str, Any]:
    return {
        "overallScore": 74,
        "summary": "主线衔接清楚，但第二章人物决策缺少触发铺垫。",
        "dimensions": [{
            "id": "motivation",
            "label": "人物动机",
            "score": 66,
            "reason": "行动变化快于情绪铺垫。",
            "checkable": True,
        }],
        "findings": [{
            "findingId": "finding_motivation_1",
            "title": "第二章决策缺少触发事件",
            "summary": "顾野从观察转向行动的变化过快。",
            "category": "motivation",
            "severity": "high",
            "chapterIds": ["chapter_2", "chapter_future"],
            "evidenceRefs": ["chapter_2", "fabricated_source"],
            "evidence": [
                {"sourceType": "chapter", "sourceId": "chapter_2", "title": "第二章", "excerpt": "顾野立刻行动。"},
                {"sourceType": "chapter", "sourceId": "chapter_future", "title": "伪造章节", "excerpt": "不存在。"},
            ],
            "recommendation": "在决定行动前补入外部刺激和一小段犹豫。",
            "recommendedRole": "writer",
            "uncertainty": "",
        }],
        "recommendations": ["优先修订第二章行动触发。"],
        "warnings": [],
    }


def test_editor_review_filters_out_of_scope_chapters_and_fabricated_evidence() -> None:
    review = normalize_editor_range_review(
        _model_review(),
        ChapterScopeBundle.model_validate(_scope_bundle()),
    )

    finding = review.findings[0]
    assert finding.chapterIds == ["chapter_2"]
    assert finding.evidenceRefs == ["chapter_2"]
    assert [item.sourceId for item in finding.evidence] == ["chapter_2"]
    assert any("不属于批准目标范围" in warning for warning in review.warnings)
    assert any("无法在范围上下文" in warning for warning in review.warnings)


async def _wait_terminal(runtime: NovelAgentRuntime, run_id: str) -> None:
    for _ in range(800):
        if runtime.state.runs[run_id].status in {"completed", "failed", "cancelled"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Editor range review did not reach a terminal state")


def test_editor_range_review_toolchain_publishes_approvable_expert_report(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "编辑多章节范围审核",
                    "deliverable": "expert_report",
                    "steps": [{
                        "agent": "editor",
                        "title": "审核第一至第二章",
                        "tools": [],
                        "toolchain": {
                            "id": "editor.range_review",
                            "version": "1.0.0",
                            "input": {
                                "kind": "selected_chapters",
                                "chapterIds": ["chapter_1", "chapter_2"],
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
                return {"evidence": [{
                    "sourceType": "chapter",
                    "sourceId": "chapter_1",
                    "title": "第一章",
                    "excerpt": "顾野习惯先观察。",
                }]}
            if method == "agent.generate_editor_range_review":
                assert params["scopeBundle"]["scope"]["chapterIds"] == ["chapter_1", "chapter_2"]
                return _model_review()
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({
            "goal": "对第一章和第二章做多章节编辑审核",
            "role": "editor",
        }, {"locale": "zh-CN"})
        assert plan.deliverable == "expert_report"
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "editor.range_review"

        run = await runtime.execute_plan({
            "planId": plan.planId,
            "novelId": "novel_1",
            "volumeId": "volume_1",
            "chapterId": "chapter_2",
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {})
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed", [(event.type, event.payload) for event in completed.events[-8:]]
        artifact = next(item for item in completed.artifacts if item.type == "chapter_range_review")
        report = artifact.metadata["expertReport"]
        assert report["artifactId"] == artifact.artifactId
        assert report["type"] == "chapter_range_review"
        assert report["sourceSnapshot"] == _scope_bundle()["sourceSnapshot"]
        assert report["findings"][0]["chapterIds"] == ["chapter_2"]
        assert report["findings"][0]["evidenceRefs"] == ["chapter_2"]
        assert artifact.reviewStatus == "unreviewed"
        assert len([event for event in completed.events if event.type == "tool_result"]) == 2
        assert not any(
            method.startswith("draft.") or method in {"chapter.save", "chapter.generate_draft"}
            for method, _, _ in automation.calls
        )

    asyncio.run(scenario())
