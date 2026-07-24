from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.toolchains.research_range_fact_check import (
    normalize_research_claims,
    normalize_research_fact_check,
    research_search_evidence,
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
        for index in range(1, 3)
    ]
    return {
        "scope": {
            "scopeId": "scope_research_1",
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
                "chapterId": "chapter_1",
                "volumeId": "volume_1",
                "title": "第一章",
                "order": 1,
                "volumeOrder": 1,
                "version": 1,
                "updatedAt": "2026-07-01T00:00:00Z",
                "contentHash": "hash_1",
                "contentMode": "full",
                "content": "医生说，成年人的骨骼数量通常为206块。",
                "summaryFresh": True,
                "target": True,
            },
            {
                "chapterId": "chapter_2",
                "volumeId": "volume_1",
                "title": "第二章",
                "order": 2,
                "volumeOrder": 1,
                "version": 1,
                "updatedAt": "2026-07-02T00:00:00Z",
                "contentHash": "hash_2",
                "contentMode": "full",
                "content": "叙述称某项未提供来源的法律在所有地区都完全相同。",
                "summaryFresh": True,
                "target": True,
            },
        ],
        "narrativeSummaries": [],
        "entityContext": {"characters": [], "items": [], "worldSettings": [], "maps": []},
        "plotContext": {"plotlines": []},
        "evidence": [{
            "sourceType": "rag",
            "sourceId": "rag_doc_1",
            "title": "已导入医学资料",
            "excerpt": "成年人通常有206块骨骼。",
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
        "estimatedTokens": 2400,
    }


def _claim_extraction() -> dict[str, Any]:
    return {
        "claims": [
            {
                "claimId": "claim_bones",
                "statement": "成年人通常有206块骨骼。",
                "chapterId": "chapter_1",
                "excerpt": "成年人的骨骼数量通常为206块",
                "category": "medical",
                "importance": "medium",
                "searchKeyword": "206块骨骼",
                "needsProjectSearch": True,
                "requiresExternalEvidence": False,
            },
            {
                "claimId": "claim_law",
                "statement": "该法律在所有地区完全相同。",
                "chapterId": "chapter_2",
                "excerpt": "在所有地区都完全相同",
                "category": "legal",
                "importance": "high",
                "searchKeyword": "法律 所有地区",
                "needsProjectSearch": False,
                "requiresExternalEvidence": True,
            },
            {
                "claimId": "claim_future",
                "statement": "未来章节的声明。",
                "chapterId": "chapter_future",
                "excerpt": "不存在",
                "category": "other",
                "importance": "low",
                "searchKeyword": "未来",
                "needsProjectSearch": True,
                "requiresExternalEvidence": False,
            },
        ],
        "warnings": [],
    }


def _project_search_results() -> list[dict[str, Any]]:
    return [{
        "entityType": "chapter",
        "entityId": "chapter_reference",
        "chapterId": "chapter_reference",
        "novelId": "novel_1",
        "title": "资料附录",
        "snippet": "附录记录：成年人通常有206块骨骼。",
        "keyword": "206块骨骼",
        "matchType": "content",
    }]


def _model_report() -> dict[str, Any]:
    return {
        "overallReliabilityScore": 55,
        "summary": "一条声明有项目证据，一条仍需外部法律来源。",
        "claims": [],
        "findings": [
            {
                "findingId": "research_finding_1",
                "claimId": "claim_bones",
                "statement": "被模型改写的声明",
                "summary": "项目附录与已导入资料均支持该常见表述。",
                "verdict": "supported",
                "confidence": 0.88,
                "category": "other",
                "severity": "info",
                "chapterIds": ["chapter_future"],
                "evidenceRefs": ["chapter_reference", "fabricated_source"],
                "evidence": [
                    {"sourceType": "project_search", "sourceId": "chapter_reference", "title": "资料附录", "excerpt": "206块骨骼"},
                    {"sourceType": "web", "sourceId": "fabricated_source", "title": "虚构网站", "excerpt": "不存在"},
                ],
                "recommendation": "可保留表述。",
                "recommendedRole": "research_rag",
                "uncertainty": "",
            },
            {
                "findingId": "research_finding_2",
                "claimId": "claim_law",
                "statement": "法律声明",
                "summary": "模型声称已经证实，但未给出来源。",
                "verdict": "supported",
                "confidence": 0.9,
                "category": "legal",
                "severity": "high",
                "chapterIds": ["chapter_2"],
                "evidenceRefs": [],
                "evidence": [],
                "recommendation": "补充具体法域和来源。",
                "recommendedRole": "research_rag",
                "uncertainty": "",
            },
            {
                "findingId": "research_finding_fake",
                "claimId": "claim_unknown",
                "statement": "未知声明",
                "summary": "不存在。",
                "verdict": "supported",
                "confidence": 1,
                "category": "other",
                "severity": "info",
                "chapterIds": [],
                "evidenceRefs": [],
                "evidence": [],
                "recommendation": "",
                "recommendedRole": "research_rag",
                "uncertainty": "",
            },
        ],
        "recommendations": ["为法律陈述补充适用地区和来源。"],
        "warnings": [],
        "searchStats": {},
    }


def test_research_normalization_filters_sources_and_downgrades_unsupported_verdicts() -> None:
    bundle = ChapterScopeBundle.model_validate(_scope_bundle())
    extraction = normalize_research_claims(_claim_extraction(), bundle, 8)
    search_evidence = {
        "claim_bones": research_search_evidence(extraction.claims[0], _project_search_results()),
    }
    report = normalize_research_fact_check(
        _model_report(),
        bundle,
        extraction.claims,
        search_evidence,
        extraction.warnings,
    )

    assert [item.claimId for item in extraction.claims] == ["claim_bones", "claim_law"]
    assert len(report.findings) == 2
    assert report.findings[0].statement == extraction.claims[0].statement
    assert report.findings[0].chapterIds == ["chapter_1"]
    assert report.findings[0].evidenceRefs == ["chapter_reference"]
    assert report.findings[1].verdict == "unverified"
    assert report.findings[1].confidence == 0.3
    assert any("未配置外部网络搜索" in warning for warning in report.warnings)
    assert any("无法关联" in warning for warning in report.warnings)
    assert any("无法在范围" in warning for warning in report.warnings)


async def _wait_terminal(runtime: NovelAgentRuntime, run_id: str) -> None:
    for _ in range(1000):
        if runtime.state.runs[run_id].status in {"completed", "failed", "cancelled"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Research range fact check did not reach a terminal state")


def test_research_range_toolchain_searches_project_and_publishes_read_only_report(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "多章节考据与事实核查",
                    "deliverable": "expert_report",
                    "steps": [{
                        "agent": "research_rag",
                        "title": "核查第一至第二章事实",
                        "tools": [],
                        "toolchain": {
                            "id": "research.range_fact_check",
                            "version": "1.0.0",
                            "input": {
                                "kind": "selected_chapters",
                                "chapterIds": ["chapter_1", "chapter_2"],
                                "anchorChapterId": "chapter_2",
                                "maxClaims": 8,
                                "maxProjectSearches": 1,
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
                    "sourceType": "rag",
                    "sourceId": "rag_doc_1",
                    "title": "已导入医学资料",
                    "excerpt": "成年人通常有206块骨骼。",
                }]}
            if method == "agent.extract_research_claims":
                automation.calls.append((method, params, origin))
                assert params["maxClaims"] == 8
                return _claim_extraction()
            if method == "search.query":
                automation.calls.append((method, params, origin))
                assert params["keyword"] == "206块骨骼"
                return _project_search_results()
            if method == "agent.generate_research_fact_check":
                automation.calls.append((method, params, origin))
                assert params["externalSearchAvailable"] is False
                assert set(params["projectSearchEvidence"]) == {"claim_bones"}
                return _model_report()
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({
            "goal": "对当前卷考据并核查第一章和第二章中的事实",
            "role": "research_rag",
        }, {"locale": "zh-CN"})
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "research.range_fact_check"

        run = await runtime.execute_plan({
            "planId": plan.planId,
            "novelId": "novel_1",
            "volumeId": "volume_1",
            "chapterId": "chapter_2",
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {})
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed", [(event.type, event.payload) for event in completed.events[-14:]]
        artifact = next(item for item in completed.artifacts if item.type == "research_fact_check")
        report = artifact.metadata["expertReport"]
        fact_check = artifact.metadata["researchFactCheck"]
        assert report["type"] == "research_fact_check"
        assert report["expert"] == "research_rag"
        assert report["sourceSnapshot"] == _scope_bundle()["sourceSnapshot"]
        assert report["findings"][0]["evidenceRefs"] == ["chapter_reference"]
        assert fact_check["findings"][1]["verdict"] == "unverified"
        assert fact_check["searchStats"]["searchedClaimCount"] == 1
        assert any("未配置外部网络搜索" in warning for warning in fact_check["warnings"])
        assert artifact.reviewStatus == "unreviewed"
        assert len([event for event in completed.events if event.type == "tool_result"]) == 3
        assert len([call for call in automation.calls if call[0] == "search.query"]) == 1
        assert not any("external" in method or "web" in method for method, _, _ in automation.calls)
        assert not any(
            method.startswith("draft.") or method in {"chapter.save", "chapter.generate_draft"}
            for method, _, _ in automation.calls
        )

    asyncio.run(scenario())
