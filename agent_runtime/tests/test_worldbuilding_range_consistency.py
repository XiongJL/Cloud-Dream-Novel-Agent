from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.toolchains.schemas import ChapterScopeBundle
from novel_agent_runtime.toolchains.worldbuilding_range_consistency import normalize_worldbuilding_consistency

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
            "scopeId": "scope_world_1",
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
                "content": "第一章中灵灯只能燃烧一刻钟。" if index == 1 else "第二章中灵灯连续照亮了一整夜。",
                "summaryFresh": True,
                "target": True,
            }
            for index in range(1, 3)
        ],
        "narrativeSummaries": [],
        "entityContext": {
            "characters": [{"id": "character_1", "name": "顾野", "ability": "无夜视能力"}],
            "items": [{"id": "item_1", "name": "灵灯", "duration": "一刻钟"}],
            "worldSettings": [{"id": "setting_1", "name": "灵灯规则", "description": "每次只能燃烧一刻钟"}],
            "maps": [{"id": "map_1", "name": "旧城地道"}],
        },
        "plotContext": {"plotlines": [{"id": "plotline_1", "name": "地道探索"}]},
        "evidence": [{
            "sourceType": "worldsetting",
            "sourceId": "setting_1",
            "title": "灵灯规则",
            "excerpt": "每次只能燃烧一刻钟。",
            "confidence": 1,
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
        "estimatedTokens": 2800,
    }


def _model_review() -> dict[str, Any]:
    return {
        "consistencyScore": 62,
        "summary": "第二章的灵灯持续时间与已登记规则冲突。",
        "dimensions": [{
            "id": "items",
            "label": "物品属性",
            "score": 45,
            "reason": "持续时间前后不一致。",
            "checkable": True,
        }],
        "findings": [{
            "findingId": "world_finding_1",
            "title": "灵灯持续时间冲突",
            "summary": "正文将一刻钟延长为整夜，没有解释规则变化。",
            "category": "item",
            "severity": "high",
            "chapterIds": ["chapter_2", "chapter_future"],
            "subjectIds": ["item_1", "fabricated_item"],
            "evidenceRefs": ["chapter_2", "setting_1", "fabricated_source"],
            "evidence": [
                {"sourceType": "chapter", "sourceId": "chapter_2", "title": "第二章", "excerpt": "照亮一整夜"},
                {"sourceType": "worldsetting", "sourceId": "setting_1", "title": "灵灯规则", "excerpt": "只能燃烧一刻钟"},
                {"sourceType": "item", "sourceId": "fabricated_item", "title": "伪造物品", "excerpt": "不存在"},
            ],
            "recommendation": "补充充能机制或恢复一刻钟限制。",
            "recommendedRole": "worldbuilding",
            "uncertainty": "",
        }],
        "entityAssessments": [
            {
                "entityType": "item",
                "entityId": "item_1",
                "name": "灵灯",
                "status": "conflict",
                "chapterIds": ["chapter_1", "chapter_2"],
                "summary": "燃烧时长发生漂移。",
                "evidence": [{"sourceType": "worldsetting", "sourceId": "setting_1", "title": "规则", "excerpt": "一刻钟"}],
                "uncertainty": "",
            },
            {
                "entityType": "item",
                "entityId": "fabricated_item",
                "name": "不存在的物品",
                "status": "insufficient",
                "chapterIds": ["chapter_future"],
                "summary": "无法核验。",
                "evidence": [],
                "uncertainty": "",
            },
        ],
        "recommendations": ["统一灵灯能量规则。"],
        "warnings": [],
    }


def test_worldbuilding_review_filters_out_of_scope_entities_and_fabricated_evidence() -> None:
    review = normalize_worldbuilding_consistency(
        _model_review(),
        ChapterScopeBundle.model_validate(_scope_bundle()),
    )

    finding = review.findings[0]
    assert finding.chapterIds == ["chapter_2"]
    assert finding.subjectIds == ["item_1"]
    assert finding.evidenceRefs == ["chapter_2", "setting_1"]
    assert [item.sourceId for item in finding.evidence] == ["chapter_2", "setting_1"]
    assert review.entityAssessments[1].entityId is None
    assert review.entityAssessments[1].chapterIds == []
    assert any("批准目标范围" in warning for warning in review.warnings)
    assert any("未登记" in warning for warning in review.warnings)
    assert any("无法在范围上下文" in warning for warning in review.warnings)


async def _wait_terminal(runtime: NovelAgentRuntime, run_id: str) -> None:
    for _ in range(800):
        if runtime.state.runs[run_id].status in {"completed", "failed", "cancelled"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Worldbuilding range review did not reach a terminal state")


def test_worldbuilding_range_toolchain_publishes_read_only_expert_report(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "世界观多章节一致性审核",
                    "deliverable": "expert_report",
                    "steps": [{
                        "agent": "worldbuilding",
                        "title": "核对第一至第二章设定",
                        "tools": [],
                        "toolchain": {
                            "id": "worldbuilding.range_consistency",
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
                    "sourceType": "worldsetting",
                    "sourceId": "setting_1",
                    "title": "灵灯规则",
                    "excerpt": "每次只能燃烧一刻钟。",
                }]}
            if method == "agent.generate_worldbuilding_range_consistency":
                automation.calls.append((method, params, origin))
                assert params["scopeBundle"]["scope"]["chapterIds"] == ["chapter_1", "chapter_2"]
                assert params["scopeBundle"]["entityContext"]["worldSettings"][0]["id"] == "setting_1"
                return _model_review()
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({
            "goal": "对第一章和第二章做世界观一致性检查",
            "role": "worldbuilding",
        }, {"locale": "zh-CN"})
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "worldbuilding.range_consistency"

        run = await runtime.execute_plan({
            "planId": plan.planId,
            "novelId": "novel_1",
            "volumeId": "volume_1",
            "chapterId": "chapter_2",
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {})
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed", [(event.type, event.payload) for event in completed.events[-10:]]
        artifact = next(item for item in completed.artifacts if item.type == "worldbuilding_consistency")
        report = artifact.metadata["expertReport"]
        assert report["artifactId"] == artifact.artifactId
        assert report["type"] == "worldbuilding_consistency"
        assert report["expert"] == "worldbuilding"
        assert report["sourceSnapshot"] == _scope_bundle()["sourceSnapshot"]
        assert report["findings"][0]["chapterIds"] == ["chapter_2"]
        assert report["findings"][0]["evidenceRefs"] == ["chapter_2", "setting_1"]
        assert artifact.metadata["worldbuildingConsistency"]["entityAssessments"]
        assert artifact.reviewStatus == "unreviewed"
        assert len([event for event in completed.events if event.type == "tool_result"]) == 2
        assert not any(
            method.startswith("draft.") or method in {"chapter.save", "chapter.generate_draft"}
            for method, _, _ in automation.calls
        )

    asyncio.run(scenario())
