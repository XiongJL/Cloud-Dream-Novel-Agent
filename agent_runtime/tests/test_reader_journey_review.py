from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.toolchains.reader_journey_review import (
    build_reader_journey_artifact,
    normalize_reader_chapter_evaluation,
    reader_chapter_request,
)
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
        for index in range(1, 4)
    ]
    contents = [
        "SECRET_1：主角收到一封没有署名的信。",
        "SECRET_2：主角循着信上的地址来到旧车站。",
        "FUTURE_SECRET_3：寄信人其实是失踪多年的姐姐。",
    ]
    return {
        "scope": {
            "scopeId": "scope_reader_1",
            "novelId": "novel_1",
            "kind": "selected_chapters",
            "volumeId": "volume_1",
            "chapterIds": ["chapter_1", "chapter_2", "chapter_3"],
            "anchorChapterId": "chapter_3",
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
                "content": contents[index - 1],
                "summaryFresh": True,
                "target": True,
            }
            for index in range(1, 4)
        ],
        "narrativeSummaries": [{"chapterId": "chapter_3", "summary": "FUTURE_SECRET_3"}],
        "entityContext": {
            "characters": [{"id": "character_1", "name": "姐姐", "notes": "BACKSTAGE_RULE: 寄信人真相"}],
            "items": [],
            "worldSettings": [{"id": "setting_1", "name": "后台真相", "description": "BACKSTAGE_RULE"}],
            "maps": [],
        },
        "plotContext": {"plotlines": [{"id": "plotline_1", "name": "姐姐归来", "notes": "BACKSTAGE_RULE"}]},
        "evidence": [{
            "sourceType": "worldsetting",
            "sourceId": "setting_1",
            "title": "后台真相",
            "excerpt": "BACKSTAGE_RULE",
            "confidence": 1,
        }],
        "stateLedger": {"entities": {"character_1": {"secret": "BACKSTAGE_RULE"}}},
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
        "estimatedTokens": 3600,
    }


def _evaluation(chapter_id: str, index: int) -> dict[str, Any]:
    return {
        "chapterId": chapter_id,
        "chapterTitle": f"第{index}章",
        "scoreScale": 100,
        "clarityScore": 82 - index,
        "emotionalIntensity": 60 + index,
        "suspenseScore": 70 + index,
        "retentionScore": 75 + index,
        "dominantEmotion": "好奇",
        "confusionPoints": [],
        "immersionBreaks": [],
        "effectiveHooks": ["身份谜团"],
        "expectations": ["揭开寄信人身份"],
        "dropRisk": "low",
        "summary": f"第{index}章保持了阅读动力。",
        "readerStateSummary": f"读者读完第{index}章，只知道 STATE_{index}。",
        "findings": [{
            "findingId": f"reader_finding_{index}",
            "title": "悬念有效",
            "summary": "当前章留下明确问题。",
            "category": "retention",
            "severity": "info",
            "chapterIds": [chapter_id, "chapter_3"] if index == 1 else [chapter_id],
            "evidenceRefs": [chapter_id, "chapter_3"] if index == 1 else [chapter_id],
            "evidence": [
                {"sourceType": "chapter", "sourceId": chapter_id, "title": f"第{index}章", "excerpt": "当前章证据"},
                {"sourceType": "chapter", "sourceId": "chapter_3", "title": "未来章节", "excerpt": "FUTURE_SECRET_3"},
            ] if index == 1 else [],
            "recommendation": "保留章末问题。",
            "recommendedRole": "writer",
            "uncertainty": "",
        }],
        "warnings": [],
    }


def test_reader_request_contains_only_current_chapter_and_prior_reader_state() -> None:
    bundle = ChapterScopeBundle.model_validate(_scope_bundle())
    first = json.dumps(reader_chapter_request("zh-CN", bundle.chapters[0], "", 0, 3), ensure_ascii=False)
    second = json.dumps(reader_chapter_request("zh-CN", bundle.chapters[1], "STATE_1", 1, 3), ensure_ascii=False)

    assert "SECRET_1" in first
    assert "SECRET_2" not in first
    assert "FUTURE_SECRET_3" not in first
    assert "BACKSTAGE_RULE" not in first
    assert "STATE_1" in second
    assert "SECRET_2" in second
    assert "FUTURE_SECRET_3" not in second
    assert "BACKSTAGE_RULE" not in second


def test_reader_score_protocol_requires_explicit_percentage_scale() -> None:
    chapter = ChapterScopeBundle.model_validate(_scope_bundle()).chapters[0]
    valid = _evaluation(chapter.chapterId, 1)
    valid["retentionScore"] = 8

    evaluation = normalize_reader_chapter_evaluation(valid, chapter)
    assert evaluation.scoreScale == 100
    assert evaluation.retentionScore == 8

    missing_scale = dict(valid)
    missing_scale.pop("scoreScale")
    with pytest.raises(Exception):
        normalize_reader_chapter_evaluation(missing_scale, chapter)

    wrong_scale = {**valid, "scoreScale": 10}
    with pytest.raises(Exception):
        normalize_reader_chapter_evaluation(wrong_scale, chapter)


def test_reader_score_protocol_rejects_out_of_range_scores_and_too_many_findings() -> None:
    chapter = ChapterScopeBundle.model_validate(_scope_bundle()).chapters[0]
    invalid_score = {**_evaluation(chapter.chapterId, 1), "clarityScore": 101}
    with pytest.raises(Exception):
        normalize_reader_chapter_evaluation(invalid_score, chapter)

    too_many_findings = _evaluation(chapter.chapterId, 1)
    too_many_findings["findings"] = [
        {**too_many_findings["findings"][0], "findingId": f"finding_{index}"}
        for index in range(5)
    ]
    with pytest.raises(Exception):
        normalize_reader_chapter_evaluation(too_many_findings, chapter)


def test_reader_journey_builds_warning_for_summary_chapter() -> None:
    bundle_payload = _scope_bundle()
    bundle_payload["chapters"][0]["contentMode"] = "summary"
    bundle = ChapterScopeBundle.model_validate(bundle_payload)
    evaluation = normalize_reader_chapter_evaluation(
        _evaluation(bundle.chapters[0].chapterId, 1),
        bundle.chapters[0],
    )

    journey = build_reader_journey_artifact([evaluation], bundle)

    assert "1 章仅以摘要或摘录评估" in journey.warnings[-1]


async def _wait_terminal(runtime: NovelAgentRuntime, run_id: str) -> None:
    for _ in range(1000):
        if runtime.state.runs[run_id].status in {"completed", "failed", "cancelled"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Reader journey review did not reach a terminal state")


def test_reader_journey_is_sequential_and_never_leaks_future_or_backstage_context(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke
        reader_requests: list[dict[str, Any]] = []

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "读者多章节顺序盲测",
                    "deliverable": "expert_report",
                    "steps": [{
                        "agent": "reader",
                        "title": "顺序盲读三个章节",
                        "tools": [],
                        "toolchain": {
                            "id": "reader.journey_review",
                            "version": "1.0.0",
                            "input": {
                                "kind": "selected_chapters",
                                "chapterIds": ["chapter_1", "chapter_2", "chapter_3"],
                                "anchorChapterId": "chapter_3",
                            },
                        },
                    }],
                }
            if method == "chapter.scope_context.build":
                automation.calls.append((method, params, origin))
                return _scope_bundle()
            if method == "rag.ask":
                raise AssertionError("Reader journey must not call RAG")
            if method == "agent.generate_reader_chapter_evaluation":
                automation.calls.append((method, params, origin))
                reader_requests.append(params)
                index = len(reader_requests)
                return _evaluation(str(params["chapter"]["chapterId"]), index)
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({
            "goal": "对选中的三章做多章节读者盲测",
            "role": "reader",
        }, {"locale": "zh-CN"})
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "reader.journey_review"

        run = await runtime.execute_plan({
            "planId": plan.planId,
            "novelId": "novel_1",
            "volumeId": "volume_1",
            "chapterId": "chapter_3",
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {})
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed", [(event.type, event.payload) for event in completed.events[-12:]]
        assert [item["chapter"]["chapterId"] for item in reader_requests] == ["chapter_1", "chapter_2", "chapter_3"]
        serialized = [json.dumps(item, ensure_ascii=False) for item in reader_requests]
        assert "SECRET_2" not in serialized[0]
        assert "FUTURE_SECRET_3" not in serialized[0]
        assert "FUTURE_SECRET_3" not in serialized[1]
        assert "BACKSTAGE_RULE" not in "".join(serialized)
        assert reader_requests[0]["priorReaderState"] == ""
        assert "STATE_1" in reader_requests[1]["priorReaderState"]
        assert "STATE_2" in reader_requests[2]["priorReaderState"]

        artifact = next(item for item in completed.artifacts if item.type == "reader_journey")
        report = artifact.metadata["expertReport"]
        assert report["artifactId"] == artifact.artifactId
        assert report["type"] == "reader_journey"
        assert report["sourceSnapshot"] == _scope_bundle()["sourceSnapshot"]
        assert report["findings"][0]["chapterIds"] == ["chapter_1"]
        assert report["findings"][0]["evidenceRefs"] == ["chapter_1"]
        assert artifact.metadata["readerJourney"]["chapters"][0]["warnings"]
        assert artifact.reviewStatus == "unreviewed"
        assert len([event for event in completed.events if event.type == "tool_result"]) == 1
        assert not any(method == "rag.ask" for method, _, _ in automation.calls)
        assert not any(
            method.startswith("draft.") or method in {"chapter.save", "chapter.generate_draft"}
            for method, _, _ in automation.calls
        )

    asyncio.run(scenario())
