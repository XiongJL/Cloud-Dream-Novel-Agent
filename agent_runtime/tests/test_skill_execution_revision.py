from __future__ import annotations

import asyncio
import sqlite3
from collections import Counter

import pytest

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import AgentRun
from novel_agent_runtime.skill_analysis_context import attach_analysis, expert_pages, verify_expert_evidence, combine_expert_pages
from novel_agent_runtime.skill_analysis_graph import SkillAnalysisGraph, SkillWorkUnitStore, canonical, preflight_analysis, evidence_ref, validate_analysis
from novel_agent_runtime.skill_execution import STYLE_EXECUTION_HINTS
from novel_agent_runtime.skill_execution_engine import SkillExecutionEngine
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.toolchains.schemas import ChapterScopeBundle, ToolchainError
from test_chapter_scope_context import _scope_bundle
from test_runtime import FakeAutomationClient
from test_skill_analysis_graph import POLICY, analysis, chapters


def test_lazy_engine_isolates_corrupt_journal_and_initializes_once(tmp_path):
    async def scenario():
        store = AgentStateStore(tmp_path)
        damaged = tmp_path / "agent_skill_units.db"
        damaged.write_bytes(b"not a SQLite database")
        runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
        assert runtime.skill_execution_engine.status == "uninitialized"
        with pytest.raises(ToolchainError, match="其他功能") as failure:
            await runtime.skill_execution_engine.get_graph()
        assert failure.value.details["availability"] == "recovery_required"
        assert damaged.read_bytes() == b"not a SQLite database"
        healthy = SkillExecutionEngine(tmp_path / "healthy")
        results = await asyncio.gather(*(healthy.get_graph() for _ in range(8)))
        assert all(item is results[0] for item in results)
    asyncio.run(scenario())


def test_corrupt_graph_checkpoint_reuses_completed_units(tmp_path):
    async def scenario():
        engine = SkillExecutionEngine(tmp_path)
        graph = await engine.get_graph()
        calls = Counter()
        async def read(item):
            return {**item, "contentMode": "full", "content": "原文"}
        async def model(kind, payload, key):
            calls[kind] += 1
            return analysis(payload["source"]["samples"][0]["sourceId"]) if kind == "analyze" else payload["source"]["results"][0]
        async def progress(_):
            pass
        kwargs = dict(owner="run", chapters=chapters(2), goal="Analyze", skill_hash="locked", hints=STYLE_EXECUTION_HINTS,
            policy=POLICY, read=read, model=model, progress=progress, check_cancelled=lambda: None)
        result = await graph.run(**kwargs)
        graph.checkpoint_path.write_bytes(b"damaged graph checkpoint")
        restored = await SkillExecutionEngine(tmp_path).get_graph()
        assert await restored.run(**kwargs) == result
        assert calls == Counter(analyze=2, merge=1)
        copies = list(tmp_path.glob("skill-checkpoint-recovery-*/agent_skill_graph.db"))
        assert copies and copies[0].read_bytes() == b"damaged graph checkpoint"
    asyncio.run(scenario())


def test_six_kilobyte_merge_preserves_large_full_results_and_all_candidates(tmp_path):
    async def scenario():
        graph = SkillAnalysisGraph(tmp_path / "graph.db", SkillWorkUnitStore(tmp_path / "units.db"))
        sizes = []
        async def read(item):
            return {**item, "contentMode": "full", "content": "q" * 117, "contentHash": "a" * 64}
        async def model(kind, payload, key):
            sizes.append(len(canonical(payload["source"]).encode("utf-8")))
            if kind == "merge":
                return payload["source"]["results"][0]
            sample = payload["source"]["samples"][0]
            return {"summary": "s" * 300, "warnings": ["w" * 120] * 8,
                "findings": [{"dimension": str(i), "observation": "o" * 180, "confidence": "medium",
                    "evidence": [{"sourceId": sample["sourceId"], "excerpt": "q" * 117}] * 2} for i in range(8)]}
        async def progress(_):
            pass
        result = await graph.run(owner="run", chapters=chapters(2), goal="Analyze", skill_hash="locked", hints=STYLE_EXECUTION_HINTS,
            policy={**POLICY, "maxInputBytes": 6000}, read=read, model=model, progress=progress, check_cancelled=lambda: None)
        assert len(result["unitRefs"]) == 2
        units = [graph.store.result(ref) for ref in result["unitRefs"]]
        assert all(len(canonical(item).encode("utf-8")) > 8000 for item in units)
        assert all(len(item["findings"]) == 8 for item in units)
        assert max(sizes) <= 6000
    asyncio.run(scenario())


def test_preflight_rejects_infeasible_minimum_before_model_calls():
    with pytest.raises(ToolchainError, match="最小"):
        preflight_analysis({**POLICY, "maxInputBytes": 700}, 2)
    with pytest.raises(ToolchainError, match="尚未开始"):
        preflight_analysis({**POLICY, "maxModelCalls": 2}, 3)
    with pytest.raises(ToolchainError, match="尚未开始"):
        preflight_analysis({**POLICY, "maxModelCalls": 5}, 3, include_expert=True, include_route=True)


def test_expert_pages_cover_more_than_eight_candidates_and_reject_forged_quotes():
    bundle = ChapterScopeBundle.model_validate(_scope_bundle())
    units = [(str(i), {**analysis("chapter_1", "正文"), "chapterIds": ["chapter_1"]}) for i in range(33)]
    analyzed = {"analysisRef": "root", "analysis": analysis(), "unitRefs": [ref for ref, _ in units],
        "sourceSnapshot": [item.model_dump() for item in bundle.sourceSnapshot], "executionPolicy": POLICY,
        "coverage": {"analyzedChapterCount": 3}, "warnings": []}
    bundle = attach_analysis(bundle, analyzed)
    pages = expert_pages(bundle, units, 16000)
    refs = [item["findingRef"] for page in pages for item in page.skillAnalysis["candidates"]]
    assert len(refs) == len(set(refs)) == 33
    assert len(pages) >= 3
    page = pages[0]
    raw = {"summary": "Reviewed", "findings": [{"chapterIds": ["chapter_1"],
        "evidenceRefs": ["chapter_1"], "evidence": [{"sourceId": "chapter_1", "excerpt": "伪造引文"}]}]}
    with pytest.raises(ToolchainError, match="逐项"):
        verify_expert_evidence(raw, page)
    raw["candidateDecisions"] = [{"findingRef": item["findingRef"], "status": "confirmed", "reason": "Checked"}
        for item in page.skillAnalysis["candidates"]]
    checked = verify_expert_evidence(raw, page)
    assert not checked["findings"][0]["evidence"]
    assert checked["findings"][0]["uncertainty"]
    assert checked["warnings"]
    combined = combine_expert_pages([{**checked, "overallScore": 90}, {**checked, "overallScore": 40}])
    assert combined["overallScore"] is None
    assert len(combined["candidateDecisions"]) == len(raw["candidateDecisions"])


def test_unknown_response_reconciles_without_another_paid_call(tmp_path):
    async def scenario():
        graph = SkillAnalysisGraph(tmp_path / "graph.db", SkillWorkUnitStore(tmp_path / "units.db"))
        calls = Counter()
        async def read(item):
            return {**item, "contentMode": "full", "content": "原文"}
        async def model(kind, payload, key):
            calls[kind] += 1
            if kind == "analyze":
                raise ToolchainError("SIDE_EFFECT_UNKNOWN", "provider result unknown")
            assert kind == "recover" and payload["requestId"].startswith("skill_")
            return analysis()
        async def progress(_):
            pass
        kwargs = dict(owner="run", chapters=chapters(1), goal="Analyze", skill_hash="locked", hints=STYLE_EXECUTION_HINTS,
            policy=POLICY, read=read, model=model, progress=progress, check_cancelled=lambda: None)
        with pytest.raises(ToolchainError, match="unknown"):
            await graph.run(**kwargs)
        await graph.run(**kwargs)
        assert calls == Counter(analyze=1, recover=1)
    asyncio.run(scenario())


def test_budget_reserves_internal_attempts_and_settles_only_known_usage(tmp_path):
    units = SkillWorkUnitStore(tmp_path / "units.db")
    policy = {**POLICY, "maxModelCalls": 3, "maxTotalTokens": 10000}
    units.begin("run", "one", "input", 9000, policy, 3)
    with pytest.raises(ToolchainError, match="预算"):
        units.begin("run", "two", "input", 100, policy)
    units.finish("one", analysis(), {"executionUsage": {"calls": 1, "attempts": [
        {"usage": {"input_tokens": 400, "output_tokens": 100}}]}})
    units.begin("run", "two", "input", 9000, policy, 2)
    units.finish("two", analysis(), {"executionUsage": {"calls": 1, "attempts": [{}]}})
    with sqlite3.connect(units.path) as db:
        assert db.execute("SELECT SUM(reserved_calls),SUM(reserved_tokens) FROM skill_work_units").fetchone() == (2, 9500)
    with pytest.raises(ToolchainError, match="预算"):
        units.begin("run", "three", "input", 1000, policy)


def test_repeated_quotes_at_distinct_offsets_survive_merge_by_reference():
    first = validate_analysis(analysis(quote="原文"), [{"sourceId": "chapter-0", "content": "原文", "offset": 0}])
    later = validate_analysis(analysis(quote="原文"), [{"sourceId": "chapter-0", "content": "原文", "offset": 100}])
    refs = [evidence_ref(item["findings"][0]["evidence"][0]) for item in (first, later)]
    assert refs[0] != refs[1]
    merged = validate_analysis({"summary": "Repeat", "findings": [{"observation": "Repeated phrase", "evidence":
        [{"evidenceRef": ref} for ref in refs]}]}, [first, later], merged=True)
    assert [item["startOffset"] for item in merged["findings"][0]["evidence"]] == [0, 100]


def test_expert_deduplication_preserves_critical_severity_and_all_sources():
    common = {"category": "logic", "title": "Same conflict", "chapterIds": ["chapter-0"]}
    result = combine_expert_pages([
        {"summary": "Page one", "findings": [{**common, "severity": "low", "evidenceRefs": ["a"], "evidence": [{"sourceId": "a"}]}]},
        {"summary": "Page two", "findings": [{**common, "severity": "critical", "evidenceRefs": ["b"], "evidence": [{"sourceId": "b"}]}]},
    ])
    assert len(result["findings"]) == 1
    finding = result["findings"][0]
    assert finding["severity"] == "critical" and finding["findingId"].startswith("finding_")
    assert finding["evidenceRefs"] == ["a", "b"]
    assert len(finding["evidence"]) == 2


def test_abandoned_prepared_request_blocks_changed_policy_without_provider_call(tmp_path):
    async def scenario():
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        run = AgentRun(runId="run", threadId="thread", planId="plan", status="running", currentStepId="review")
        runtime.state.skillRequestRefs["old-request"] = {"owner": "run:review", "status": "prepared"}
        calls = []
        async def invoke(*args, **kwargs):
            calls.append(args)
        runtime._invoke_automation_request = invoke
        with pytest.raises(ToolchainError, match="未核对"):
            await runtime._invoke_skill_model(run, "agent.analyze_skill_work_unit", {"executionBudget": {"version": 3}}, "new-request", "new-unit")
        assert not calls
        assert "new-request" not in runtime.state.skillRequestRefs
    asyncio.run(scenario())


def test_source_edit_is_rejected_before_expert_or_publication(tmp_path):
    async def scenario():
        store = AgentStateStore(tmp_path)
        runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
        run = AgentRun(runId="run", threadId="thread", planId="plan", status="running", currentStepId="review")
        original = ChapterScopeBundle.model_validate(_scope_bundle())
        fresh = _scope_bundle()
        fresh["chapters"][0]["version"] += 1
        async def read(*args):
            return fresh
        runtime._tool_invoke = read
        with pytest.raises(ToolchainError, match="来源已改变"):
            await runtime._validate_skill_sources(run, original.scope.model_dump(), original.sourceSnapshot)
        assert not run.artifacts
    asyncio.run(scenario())
