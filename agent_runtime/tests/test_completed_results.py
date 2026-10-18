from __future__ import annotations

import asyncio
from collections import Counter
from types import SimpleNamespace

import pytest

from novel_agent_runtime.intent.schemas import FailedRunRef, IntentConversationState, IntentRequest, SemanticProposal
from novel_agent_runtime.intent.service import IntentService
from novel_agent_runtime.skill_analysis_graph import SkillAnalysisGraph, SkillWorkUnitStore
from novel_agent_runtime.skill_execution import STYLE_EXECUTION_HINTS
from novel_agent_runtime.toolchains.schemas import ToolchainError
from test_skill_analysis_graph import POLICY, analysis, chapters


@pytest.mark.parametrize("guard", ["chat_only", "pending_approval"])
def test_completed_results_respects_execution_guards(guard):
    request = IntentRequest(message="仅用已完成结果收尾", conversationId="same-thread",
        approvalMode="chat_only" if guard == "chat_only" else "standard",
        conversationState=IntentConversationState(hasPendingApproval=guard == "pending_approval",
            latestFailedRun=FailedRunRef(runId="original", failureRevision=1, canFinalizeCompleted=True)))
    service = IntentService()
    decision = service.finalize(request, service.preflight(request), SemanticProposal(responseContent="", shouldPlan=True))
    assert decision.route == "respond"
    assert decision.recovery is None
    assert "COMPLETED_RESULTS_BLOCKED" in decision.reasonCodes
    assert decision.operations == []


@pytest.mark.parametrize("message", ["就以当前结果提炼，后续章节可以不用管了", "仅用已完成结果收尾", "只用已有分析结果生成 Skill", "finalize using completed results"])
def test_completed_results_instruction_has_distinct_recovery_mode(message):
    request = IntentRequest(message=message, conversationId="same-thread", conversationState=IntentConversationState(
        latestFailedRun=FailedRunRef(runId="original", failureRevision=3, retryable=False, canFinalizeCompleted=True)))
    service = IntentService()
    decision = service.finalize(request, service.preflight(request), SemanticProposal(responseContent="new plan", shouldPlan=True, confidence=0.9))
    assert decision.route == "retry_failed_run"
    assert decision.recovery.mode == "use_completed_results"
    assert decision.recovery.failedRunId == "original"
    assert decision.operations == []


def test_completed_results_unavailable_never_creates_a_new_full_analysis_plan():
    request = IntentRequest(message="就以当前结果提炼，后续章节可以不用管了", conversationId="empty")
    service = IntentService()
    decision = service.finalize(request, service.preflight(request), SemanticProposal(
        responseContent="new plan", shouldPlan=True, requestedOperations=["agent_skill.style_extract"], confidence=0.9))
    assert decision.route == "respond"
    assert "COMPLETED_RESULTS_UNAVAILABLE" in decision.reasonCodes
    assert not IntentService.is_completed_results_request("不要只用当前结果，还需要读完后续章节")


def test_closure_freezes_verified_chapters_and_only_merges_without_reads(tmp_path):
    async def scenario():
        store = SkillWorkUnitStore(tmp_path / "units.db")
        graph = SkillAnalysisGraph(tmp_path / "graph.db", store)
        calls = Counter()
        fail = True

        async def read(chapter):
            # Stored-document catalog hashes and extracted-prose hashes differ.
            return {**chapter, "contentMode": "full", "content": "原文", "contentHash": "prose-" + chapter["chapterId"]}

        async def model(kind, payload, key):
            if kind == "merge":
                calls["merge"] += 1
                return payload["source"]["results"][0]
            cid = payload["source"]["samples"][0]["sourceId"]
            calls[cid] += 1
            if fail and cid == "chapter-1":
                raise ToolchainError("MODEL_OUTPUT_INVALID", "failed chapter")
            return analysis(cid)

        async def progress(_):
            pass

        args = dict(owner="original:step", chapters=chapters(6), goal="Analyze", skill_hash="locked",
            hints=STYLE_EXECUTION_HINTS, policy=POLICY, read=read, model=model, progress=progress, check_cancelled=lambda: None)
        with pytest.raises(ToolchainError):
            await graph.run(**args)
        frozen = graph.freeze_completed(store.path, graph.checkpoint_path, owner=args["owner"], chapters=args["chapters"])
        assert [item["chapterId"] for item in frozen["chapters"]] == ["chapter-0", "chapter-2"]
        assert [item["chapterId"] for item in frozen["omittedChapters"]] == ["chapter-1", "chapter-3", "chapter-4", "chapter-5"]
        baseline = calls.copy()

        async def forbidden_read(_):
            pytest.fail("a completed-results closure must not read raw chapters")

        closed_args = {**args, "chapters": frozen["chapters"], "completed_scope": frozen,
                       "read": forbidden_read, "policy": {**POLICY, "maxModelCalls": 4}}
        result = await graph.run(**closed_args)
        assert result["chapterCount"] == 2
        assert result["coverage"]["totalChapterCount"] == 6
        assert result["coverage"]["analyzedChapterCount"] == 2
        assert result["coverage"]["omittedChapterCount"] == 4
        assert result["coverage"]["mode"] == "user_completed_results"
        assert len(result["unitRefs"]) == 2
        assert calls == baseline + Counter({"merge": 1})
        await graph.run(**closed_args)
        assert calls == baseline + Counter({"merge": 1}), "checkpoint reuse must not repeat closure calls"

        # Late or separately recovered analyses do not expand the approved closure.
        fail = False
        await graph.run(**args)
        late = await graph.run(**{**closed_args, "policy": POLICY})
        assert late["chapterCount"] == 2
        assert late["unitRefs"] == result["unitRefs"]
        with pytest.raises(ToolchainError, match="冻结记录不一致"):
            await graph.run(**{**closed_args, "completed_scope": {**frozen, "manifestHash": "tampered"}})

    asyncio.run(scenario())


def test_incomplete_long_chapter_is_not_counted_as_completed(tmp_path):
    async def scenario():
        store = SkillWorkUnitStore(tmp_path / "units.db")
        graph = SkillAnalysisGraph(tmp_path / "graph.db", store)

        async def read(chapter):
            return {**chapter, "contentMode": "full", "content": "原文" * (10000 if chapter["chapterId"] == "chapter-0" else 1)}

        async def model(kind, payload, key):
            if kind == "merge":
                return payload["source"]["results"][0]
            sample = payload["source"]["samples"][0]
            if sample["sourceId"] == "chapter-0" and sample["offset"] > 0:
                raise ToolchainError("MODEL_OUTPUT_INVALID", "unfinished part")
            return analysis(sample["sourceId"])

        async def progress(_):
            pass

        catalog = chapters(6)
        with pytest.raises(ToolchainError):
            await graph.run(owner="long:step", chapters=catalog, goal="Analyze", skill_hash="same",
                hints=STYLE_EXECUTION_HINTS, policy=POLICY, read=read, model=model, progress=progress, check_cancelled=lambda: None)
        frozen = graph.freeze_completed(store.path, graph.checkpoint_path, owner="long:step", chapters=catalog)
        assert [item["chapterId"] for item in frozen["chapters"]] == ["chapter-1", "chapter-2"]
        assert all(item["snapshot"]["chapterId"] != "chapter-0" for item in
            store.completed_analysis("long:step", frozen["sourceGraphKey"]) if item["ref"] in {entry["ref"] for entry in frozen["units"]})

    asyncio.run(scenario())


def test_closure_requires_current_graph_proof_when_multiple_methods_exist(tmp_path):
    async def scenario():
        store = SkillWorkUnitStore(tmp_path / "units.db")
        graph = SkillAnalysisGraph(tmp_path / "graph.db", store)
        progress_ids = []

        async def read(chapter):
            return {**chapter, "contentMode": "full", "content": "原文"}

        async def model(kind, payload, key):
            return payload["source"]["results"][0] if kind == "merge" else analysis(payload["source"]["samples"][0]["sourceId"])

        async def progress(payload):
            progress_ids.append(payload["unitId"])

        args = dict(owner="same:step", chapters=chapters(2), goal="Analyze", hints=STYLE_EXECUTION_HINTS,
            policy=POLICY, read=read, model=model, progress=progress, check_cancelled=lambda: None)
        await graph.run(**args, skill_hash="first-method")
        await graph.run(**args, skill_hash="second-method")
        with pytest.raises(ToolchainError, match="多个来源或方法版本"):
            graph.freeze_completed(store.path, graph.checkpoint_path, owner=args["owner"], chapters=args["chapters"])
        frozen = graph.freeze_completed(store.path, graph.checkpoint_path, owner=args["owner"],
            chapters=args["chapters"], active_unit_id=progress_ids[-1])
        assert len(frozen["chapters"]) == 2
        assert all(unit["graphKey"] == frozen["sourceGraphKey"] for unit in store.completed_analysis(args["owner"], frozen["sourceGraphKey"]))
        with pytest.raises(ToolchainError, match="没有已完成"):
            graph.freeze_completed(store.path, graph.checkpoint_path, owner="different:step", chapters=args["chapters"])
        with pytest.raises(ToolchainError, match="没有已完成"):
            graph.freeze_completed(store.path, graph.checkpoint_path, owner=args["owner"],
                chapters=[{**chapter, "version": 2} for chapter in args["chapters"]])

    asyncio.run(scenario())


def test_closure_rejects_changed_chapter_before_any_model_request():
    from novel_agent_runtime.runtime import NovelAgentRuntime
    from test_scope_audit import _scope_bundle

    async def scenario():
        runtime = NovelAgentRuntime.__new__(NovelAgentRuntime)
        calls = []
        fresh = _scope_bundle()
        frozen_chapters = [{key: chapter[key] for key in ("chapterId", "version", "updatedAt")}
                           for chapter in fresh["chapters"]]
        fresh["chapters"][0]["version"] += 1

        async def invoke(run, method, params):
            calls.append((method, params))
            return fresh

        runtime._tool_invoke = invoke
        run = SimpleNamespace(runId="original", retryRootRunId=None, retryOfRunId=None)
        plan = SimpleNamespace(goal="Analyze")
        step = SimpleNamespace(stepId="step")
        with pytest.raises(ToolchainError, match="来源章节已改变"):
            await runtime._finalize_completed_analysis(run, plan, step,
                {"novel_id": "novel_1", "locale": "zh-CN"}, STYLE_EXECUTION_HINTS,
                {"owner": "original:step", "chapters": frozen_chapters})
        assert len(calls) == 1
        assert calls[0][0] == "chapter.scope_context.build"
        assert calls[0][1]["representation"] == "catalog"

    asyncio.run(scenario())


def test_original_expert_receives_only_closed_scope_and_all_verified_candidates():
    from novel_agent_runtime.skill_analysis_context import attach_analysis, expert_pages
    from novel_agent_runtime.toolchains.schemas import ChapterScopeBundle
    from test_scope_audit import _scope_bundle

    original = _scope_bundle()
    original["narrativeSummaries"] = [{"chapterId": "chapter_2", "summary": "excluded chapter"},
                                      {"level": "novel", "summaryText": "full book overview"}]
    original["evidence"].append({"sourceType": "chapter", "sourceId": "chapter_2", "excerpt": "excluded"})
    bundle = ChapterScopeBundle.model_validate(original)
    units = [(str(i), {**analysis("chapter_1", "顾野决定"), "chapterIds": ["chapter_1"]}) for i in range(33)]
    analyzed = {"analysisRef": "root", "analysis": analysis(), "unitRefs": [ref for ref, _ in units],
        "sourceSnapshot": [bundle.sourceSnapshot[0].model_dump()], "executionPolicy": POLICY,
        "coverage": {"mode": "user_completed_results", "analyzedChapterCount": 1, "omittedChapterCount": 1}, "warnings": []}
    closed = attach_analysis(bundle, analyzed)
    assert closed.scope.chapterIds == ["chapter_1"]
    assert closed.narrativeSummaries == []
    assert closed.coverage.omittedChapterCount == 1
    assert closed.coverage.batches == []
    pages = expert_pages(closed, units, 16000)
    assert sum(len(page.skillAnalysis["candidates"]) for page in pages) == 33
    for page in pages:
        assert page.scope.chapterIds == ["chapter_1"]
        assert all(item.sourceId != "chapter_2" for item in page.evidence)
        assert all(chapter.content == "" for chapter in page.chapters)
    assert bundle.scope.chapterIds == ["chapter_1", "chapter_2"], "original approved context remains intact"
