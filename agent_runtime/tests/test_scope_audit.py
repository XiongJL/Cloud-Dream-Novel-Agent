from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore

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
            "scopeId": "scope_audit_1",
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
                "content": "SECRET_1：顾野决定先观察车站。",
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
                "content": "FUTURE_SECRET_2：顾野突然冲进封锁区。",
                "summaryFresh": True,
                "target": True,
            },
        ],
        "narrativeSummaries": [],
        "entityContext": {
            "characters": [{"id": "character_1", "name": "顾野", "notes": "BACKSTAGE_RULE"}],
            "items": [],
            "worldSettings": [{"id": "setting_1", "name": "封锁规则", "description": "未经许可不得进入。"}],
            "maps": [],
        },
        "plotContext": {"plotlines": [{"id": "plotline_1", "name": "车站主线"}]},
        "evidence": [{
            "sourceType": "worldsetting",
            "sourceId": "setting_1",
            "title": "封锁规则",
            "excerpt": "未经许可不得进入。",
            "confidence": 0.9,
        }],
        "stateLedger": {"entities": {"character_1": {"secret": "BACKSTAGE_RULE"}}},
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
        "estimatedTokens": 3000,
    }


def _editor_review() -> dict[str, Any]:
    return {
        "overallScore": 70,
        "summary": "第二章的行动转折缺少动机铺垫。",
        "dimensions": [],
        "findings": [{
            "findingId": "editor_finding_1",
            "title": "行动转折过快",
            "summary": "顾野从观察直接转为闯入封锁区。",
            "category": "motivation",
            "severity": "high",
            "chapterIds": ["chapter_2"],
            "evidenceRefs": ["chapter_2"],
            "evidence": [{"sourceType": "chapter", "sourceId": "chapter_2", "title": "第二章", "excerpt": "突然冲进封锁区"}],
            "recommendation": "补充触发事件。",
            "recommendedRole": "writer",
            "uncertainty": "",
        }],
        "recommendations": ["先修订第二章动机。"],
        "warnings": [],
    }


def _worldbuilding_review() -> dict[str, Any]:
    return {
        "consistencyScore": 68,
        "summary": "人物行动与已登记的封锁规则存在张力。",
        "dimensions": [],
        "findings": [{
            "findingId": "world_finding_1",
            "title": "封锁规则缺少例外说明",
            "summary": "第二章没有解释顾野为何能够进入封锁区。",
            "category": "rule_conflict",
            "severity": "high",
            "chapterIds": ["chapter_2"],
            "subjectIds": ["setting_1"],
            "evidenceRefs": ["chapter_2", "setting_1"],
            "evidence": [{"sourceType": "worldsetting", "sourceId": "setting_1", "title": "封锁规则", "excerpt": "未经许可不得进入"}],
            "recommendation": "说明例外条件或进入代价。",
            "recommendedRole": "worldbuilding",
            "uncertainty": "",
        }],
        "entityAssessments": [],
        "recommendations": ["补齐规则例外。"],
        "warnings": [],
    }


def _reader_evaluation(chapter_id: str, index: int) -> dict[str, Any]:
    return {
        "chapterId": chapter_id,
        "chapterTitle": f"第{index}章",
        "clarityScore": 80,
        "emotionalIntensity": 65,
        "suspenseScore": 72,
        "retentionScore": 74,
        "dominantEmotion": "好奇",
        "confusionPoints": [],
        "immersionBreaks": [],
        "effectiveHooks": ["封锁区谜团"],
        "expectations": ["解释闯入原因"],
        "dropRisk": "low",
        "summary": f"第{index}章可继续阅读。",
        "readerStateSummary": f"读者读完第{index}章，只知道 READER_STATE_{index}。",
        "findings": [{
            "findingId": f"reader_finding_{index}",
            "title": "读者需要行动解释",
            "summary": "行动原因尚未充分呈现。",
            "category": "confusion",
            "severity": "medium",
            "chapterIds": [chapter_id],
            "evidenceRefs": [chapter_id],
            "evidence": [{"sourceType": "chapter", "sourceId": chapter_id, "title": f"第{index}章", "excerpt": "当前章文本"}],
            "recommendation": "在当前知识范围内补足因果。",
            "recommendedRole": "writer",
            "uncertainty": "",
        }],
        "warnings": [],
    }


def _scope_audit_result() -> dict[str, Any]:
    return {
        "summary": "编辑与世界观专家共同定位到第二章转折问题，读者报告补充了阅读体验影响。",
        "experts": [],
        "findings": [
            {
                "findingId": "audit_consensus_1",
                "title": "第二章转折需要同时补足动机与规则解释",
                "summary": "人物动机和封锁规则在同一转折处同时缺环。",
                "category": "cross_expert",
                "severity": "high",
                "chapterIds": ["chapter_2"],
                "sourceFindingIds": ["editor_finding_1", "world_finding_1"],
                "sourceExperts": ["editor", "worldbuilding"],
                "relationship": "consensus",
                "evidenceRefs": ["chapter_2", "setting_1"],
                "evidence": [],
                "recommendation": "用一个触发事件同时解释行动与规则例外。",
                "recommendedRole": "writer",
                "uncertainty": "",
            },
            {
                "findingId": "fabricated_audit_finding",
                "title": "伪造的考据结论",
                "summary": "未执行的考据专家声称存在历史错误。",
                "category": "fabricated",
                "severity": "critical",
                "chapterIds": ["chapter_2"],
                "sourceFindingIds": ["fake_finding"],
                "sourceExperts": ["research_rag"],
                "relationship": "single",
                "evidenceRefs": ["fake_source"],
                "evidence": [],
                "recommendation": "不应保留。",
                "recommendedRole": "research_rag",
                "uncertainty": "",
            },
        ],
        "conflicts": [{
            "conflictId": "conflict_1",
            "topic": "修订优先级",
            "sourceFindingIds": ["editor_finding_1", "reader_finding_2"],
            "experts": ["editor", "reader"],
            "summary": "编辑强调动机，读者强调可理解性。",
            "resolution": "用同一场景补丁共同处理。",
        }],
        "recommendations": ["优先修订第二章。"],
        "warnings": [],
    }


async def _wait_terminal(runtime: NovelAgentRuntime, run_id: str) -> None:
    for _ in range(1200):
        if runtime.state.runs[run_id].status in {"completed", "failed", "cancelled"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Scope audit did not reach a terminal state")


def test_scope_audit_shares_context_runs_experts_and_filters_fabricated_sources(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke
        scope_reads = 0
        rag_reads = 0
        active_simple_experts = 0
        peak_simple_experts = 0
        reader_requests: list[dict[str, Any]] = []
        supervisor_payloads: list[dict[str, Any]] = []

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            nonlocal scope_reads, rag_reads, active_simple_experts, peak_simple_experts
            if method == "agent.generate_plan":
                return {
                    "title": "团队多章节综合审计",
                    "deliverable": "expert_report",
                    "steps": [{
                        "agent": "supervisor",
                        "title": "共享上下文并汇总专家结论",
                        "tools": [],
                        "toolchain": {
                            "id": "novel.scope_audit",
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
                scope_reads += 1
                automation.calls.append((method, params, origin))
                return _scope_bundle()
            if method == "rag.ask":
                rag_reads += 1
                automation.calls.append((method, params, origin))
                return {"evidence": []}
            if method in {"agent.generate_editor_range_review", "agent.generate_worldbuilding_range_consistency"}:
                active_simple_experts += 1
                peak_simple_experts = max(peak_simple_experts, active_simple_experts)
                try:
                    await asyncio.sleep(0.03)
                    return _editor_review() if method.endswith("editor_range_review") else _worldbuilding_review()
                finally:
                    active_simple_experts -= 1
            if method == "agent.generate_reader_chapter_evaluation":
                reader_requests.append(params)
                return _reader_evaluation(str(params["chapter"]["chapterId"]), len(reader_requests))
            if method == "agent.generate_scope_audit":
                supervisor_payloads.append(params)
                return _scope_audit_result()
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({
            "goal": "让编辑、读者和世界观专家综合审计第一章与第二章",
            "role": "team",
        }, {"locale": "zh-CN"})
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "novel.scope_audit"

        run = await runtime.execute_plan({
            "planId": plan.planId,
            "novelId": "novel_1",
            "volumeId": "volume_1",
            "chapterId": "chapter_2",
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {})
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed", [(event.type, event.payload) for event in completed.events[-16:]]
        assert scope_reads == 1
        assert rag_reads == 1
        assert peak_simple_experts == 2
        assert [item["chapter"]["chapterId"] for item in reader_requests] == ["chapter_1", "chapter_2"], [
            (event.type, event.status, event.payload) for event in completed.events
            if event.agent == "reader" or event.type == "run_failed"
        ]
        serialized_reader_requests = [json.dumps(item, ensure_ascii=False) for item in reader_requests]
        assert "FUTURE_SECRET_2" not in serialized_reader_requests[0]
        assert "BACKSTAGE_RULE" not in "".join(serialized_reader_requests)
        assert reader_requests[0]["priorReaderState"] == ""
        assert "READER_STATE_1" in reader_requests[1]["priorReaderState"]

        child_artifacts = [item for item in completed.artifacts if item.metadata.get("scopeAuditChild")]
        assert {item.type for item in child_artifacts} == {
            "chapter_range_review",
            "reader_journey",
            "worldbuilding_consistency",
        }
        assert all(item.reviewStatus == "unreviewed" for item in child_artifacts)
        audit_artifact = next(item for item in completed.artifacts if item.type == "scope_audit")
        audit = audit_artifact.metadata["scopeAudit"]
        assert audit_artifact.reviewStatus == "unreviewed"
        assert audit_artifact.metadata["executedExperts"] == ["editor", "reader", "worldbuilding"]
        assert audit_artifact.metadata["failedExperts"] == {}
        assert audit_artifact.metadata["maxConcurrency"] == 2
        assert set(audit_artifact.metadata["childArtifactIds"]) == {item.artifactId for item in child_artifacts}
        assert [item["findingId"] for item in audit["findings"]] == ["audit_consensus_1"]
        assert audit["findings"][0]["sourceExperts"] == ["editor", "worldbuilding"]
        assert audit["conflicts"][0]["experts"] == ["editor", "reader"]
        assert any("真实子报告来源" in warning for warning in audit["warnings"])
        assert len(supervisor_payloads) == 1
        assert {item["expert"] for item in supervisor_payloads[0]["childReports"]} == {
            "editor",
            "reader",
            "worldbuilding",
        }
        assert len([event for event in completed.events if event.type == "tool_result"]) == 2
        assert not any(
            method.startswith("draft.") or method in {"chapter.save", "chapter.generate_draft"}
            for method, _, _ in automation.calls
        )

    asyncio.run(scenario())


def test_scope_audit_runs_explicit_research_expert_with_project_search(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke
        method_counts: dict[str, int] = {}

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            method_counts[method] = method_counts.get(method, 0) + 1
            if method == "agent.generate_plan":
                return {
                    "title": "团队考据审计",
                    "deliverable": "expert_report",
                    "steps": [{
                        "agent": "supervisor",
                        "title": "执行考据并汇总",
                        "tools": [],
                        "toolchain": {
                            "id": "novel.scope_audit",
                            "version": "1.0.0",
                            "input": {
                                "kind": "selected_chapters",
                                "chapterIds": ["chapter_1", "chapter_2"],
                                "anchorChapterId": "chapter_2",
                                "experts": ["research_rag"],
                            },
                        },
                    }],
                }
            if method == "chapter.scope_context.build":
                return _scope_bundle()
            if method == "rag.ask":
                return {"evidence": []}
            if method == "agent.extract_research_claims":
                return {
                    "claims": [{
                        "claimId": "claim_1",
                        "statement": "封锁区规则在所有车站完全相同。",
                        "chapterId": "chapter_2",
                        "excerpt": "封锁区",
                        "category": "legal",
                        "importance": "high",
                        "searchKeyword": "封锁区 规则",
                        "needsProjectSearch": True,
                        "requiresExternalEvidence": False,
                    }],
                    "warnings": [],
                }
            if method == "search.query":
                assert params["novelId"] == "novel_1"
                return [{
                    "entityType": "chapter",
                    "entityId": "chapter_reference",
                    "chapterId": "chapter_reference",
                    "novelId": "novel_1",
                    "title": "资料附录",
                    "snippet": "不同车站采用不同封锁规则。",
                    "keyword": "封锁区 规则",
                    "matchType": "content",
                }]
            if method == "agent.generate_research_fact_check":
                return {
                    "overallReliabilityScore": 45,
                    "summary": "项目资料与章节中的绝对化陈述冲突。",
                    "claims": [],
                    "findings": [{
                        "findingId": "research_finding_1",
                        "claimId": "claim_1",
                        "statement": "封锁区规则在所有车站完全相同。",
                        "summary": "项目附录表明不同车站规则不同。",
                        "verdict": "contradicted",
                        "confidence": 0.85,
                        "category": "legal",
                        "severity": "high",
                        "chapterIds": ["chapter_2"],
                        "evidenceRefs": ["chapter_reference"],
                        "evidence": [{
                            "sourceType": "project_search",
                            "sourceId": "chapter_reference",
                            "title": "资料附录",
                            "excerpt": "不同车站采用不同封锁规则。",
                        }],
                        "recommendation": "删除绝对化表述。",
                        "recommendedRole": "research_rag",
                        "uncertainty": "",
                    }],
                    "recommendations": ["核对具体车站规则。"],
                    "warnings": [],
                    "searchStats": {},
                }
            if method == "agent.generate_scope_audit":
                assert [item["expert"] for item in params["childReports"]] == ["research_rag"]
                return {
                    "summary": "考据报告发现一处项目内资料冲突。",
                    "experts": [],
                    "findings": [{
                        "findingId": "audit_research_1",
                        "title": "封锁规则表述过度绝对",
                        "summary": "现有资料不支持所有车站规则相同。",
                        "category": "fact_check",
                        "severity": "high",
                        "chapterIds": ["chapter_2"],
                        "sourceFindingIds": ["research_finding_1"],
                        "sourceExperts": ["research_rag"],
                        "relationship": "single",
                        "evidenceRefs": ["chapter_reference"],
                        "evidence": [],
                        "recommendation": "按具体地点限定规则。",
                        "recommendedRole": "research_rag",
                        "uncertainty": "",
                    }],
                    "conflicts": [],
                    "recommendations": ["修订第二章。"],
                    "warnings": [],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({"goal": "由考据专家审计选中章节", "role": "team"}, {"locale": "zh-CN"})
        run = await runtime.execute_plan({
            "planId": plan.planId,
            "novelId": "novel_1",
            "volumeId": "volume_1",
            "chapterId": "chapter_2",
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {})
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed", [(event.type, event.payload) for event in completed.events[-12:]]
        assert method_counts["chapter.scope_context.build"] == 1
        assert method_counts["rag.ask"] == 1
        assert method_counts["search.query"] == 1
        assert method_counts["agent.extract_research_claims"] == 1
        assert method_counts["agent.generate_research_fact_check"] == 1
        child = next(item for item in completed.artifacts if item.metadata.get("scopeAuditChild"))
        assert child.type == "research_fact_check"
        audit = next(item for item in completed.artifacts if item.type == "scope_audit")
        assert audit.metadata["executedExperts"] == ["research_rag"]
        assert audit.metadata["scopeAudit"]["findings"][0]["sourceExperts"] == ["research_rag"]

    asyncio.run(scenario())
