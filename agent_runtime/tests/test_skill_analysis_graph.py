from __future__ import annotations

import asyncio
import json
import sqlite3
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from novel_agent_runtime.skill_analysis_graph import SkillAnalysisGraph, SkillWorkUnitStore, split_verbatim, validate_analysis
from novel_agent_runtime.skill_execution import SkillExecutionHints, STYLE_EXECUTION_HINTS, builtin_executor_profile
from novel_agent_runtime.toolchains.schemas import ToolchainError


POLICY = {"maxInputBytes": 48000, "outputReserveTokens": 32768,
          "maxConcurrency": 3, "maxModelCalls": 2048, "maxTotalTokens": 64000000}


def chapters(count):
    return [{"chapterId": f"chapter-{i}", "volumeId": "volume", "title": str(i),
             "version": 1, "updatedAt": "2026-10-09T00:00:00.000Z", "contentHash": f"v-{i}"} for i in range(count)]


def analysis(source_id="chapter-0", quote="原文"):
    return {"summary": "Features with evidence", "findings": [{"dimension": "language_style",
            "observation": "Concrete short actions", "confidence": "medium",
            "evidence": [{"sourceId": source_id, "excerpt": quote}]}], "warnings": []}


def test_execution_hints_and_builtin_identity():
    assert STYLE_EXECUTION_HINTS.parallel
    assert not SkillExecutionHints().supports_chapter_analysis
    assert not STYLE_EXECUTION_HINTS.model_copy(update={"crossUnitDependency": "ordered_state"}).parallel
    for unsupported in ({"preferredUnit": "scene"}, {"preferredUnit": "entity"},
                        {"contextRequirement": "continuous_full_text"}, {"coverageRequirement": "representative_sample"}):
        assert not STYLE_EXECUTION_HINTS.model_copy(update=unsupported).supports_chapter_analysis
    with pytest.raises(ValidationError):
        SkillExecutionHints.model_validate({"executorProfileId": "builtin", "maxConcurrency": 200})
    builtin = SimpleNamespace(scope="builtin", skillId="builtin.style-skill-extractor", revisionId="builtin.style-skill-extractor@1.2.0", position="primary")
    assert builtin_executor_profile("agent_skill.style_extract", [builtin]) == "style_extraction_v1"
    copy = SimpleNamespace(scope="user", skillId=builtin.skillId, revisionId=builtin.revisionId, position="primary")
    assert builtin_executor_profile("agent_skill.style_extract", [copy]) is None
    assert builtin_executor_profile("agent_skill.style_extract", [SimpleNamespace(**{**vars(builtin), "position": "auxiliary"})]) is None


def test_split_covers_verbatim_unicode_without_truncation():
    text = ("一段原文🙂\n" * 4000) + "最后一字。"
    parts = split_verbatim(text, 8000)
    assert "".join(part for _, part in parts) == text
    assert all(len(part.encode("utf-8")) <= 8000 for _, part in parts)
    assert [offset for offset, _ in parts] == [sum(len(value) for _, value in parts[:i]) for i in range(len(parts))]


def test_evidence_cannot_escape_source_or_merge():
    source = {"sourceId": "c", "content": "🙂原文测试", "offset": 100, "contentHash": "hash", "version": 7, "updatedAt": "2026-10-09"}
    checked = validate_analysis(analysis("c"), [source])
    evidence = checked["findings"][0]["evidence"][0]
    assert evidence["startOffset"] == 101
    assert evidence["endOffset"] == 103
    assert evidence["offsetUnit"] == "unicode_codepoints"
    assert evidence["chapterVersion"] == 7
    assert evidence["sourceUpdatedAt"] == "2026-10-09"
    with pytest.raises(ToolchainError, match="原文"):
        validate_analysis(analysis("c", "不存在"), [source])
    with pytest.raises(ToolchainError, match="来源"):
        validate_analysis(analysis("forged"), [checked], merged=True)


@pytest.mark.parametrize("count", [1, 7, 500])
def test_graph_bounded_parallel_analysis_and_resume(tmp_path, count):
    async def scenario():
        units = SkillWorkUnitStore(tmp_path / "state.db")
        graph = SkillAnalysisGraph(tmp_path / "graph.db", units)
        catalog = chapters(count)
        active = maximum = model_calls = reads = 0
        payload_sizes = []

        async def read(chapter):
            nonlocal reads
            reads += 1
            return {**chapter, "contentMode": "full", "content": "原文。独立章节动作。"}

        async def model(kind, payload, key):
            nonlocal active, maximum, model_calls
            model_calls += 1
            active += 1
            maximum = max(maximum, active)
            payload_sizes.append(len(json.dumps(payload, ensure_ascii=False).encode()))
            await asyncio.sleep(0.02)
            active -= 1
            if kind == "analyze":
                sample = payload["source"]["samples"][0]
                assert "chapters" not in payload["source"]
                return analysis(sample["sourceId"])
            return payload["source"]["results"][0]

        async def progress(_):
            pass

        kwargs = dict(owner="run", chapters=catalog, goal="Analyze style", skill_hash="locked",
                      hints=STYLE_EXECUTION_HINTS, policy=POLICY, read=read, model=model,
                      progress=progress, check_cancelled=lambda: None)
        result = await graph.run(**kwargs)
        assert result["coverage"]["analyzedChapterCount"] == count
        assert reads == count
        assert model_calls == 2 * count - 1
        assert maximum <= 3
        assert maximum > 1 if count > 1 else maximum == 1
        assert max(payload_sizes) < POLICY["maxInputBytes"]
        assert "chapters" not in result
        before = (reads, model_calls)
        assert await graph.run(**kwargs) == result
        assert (reads, model_calls) == before
        # Checkpoints keep references; source prose lives only in bounded calls.
        async with __import__('langgraph.checkpoint.sqlite.aio', fromlist=['AsyncSqliteSaver']).AsyncSqliteSaver.from_conn_string(str(tmp_path / "graph.db")) as saver:
            async for checkpoint in saver.alist(None, limit=1):
                assert "原文。独立章节动作。" not in str(checkpoint.checkpoint)

    asyncio.run(scenario())


def test_ordered_dependency_and_failed_unit_recovery(tmp_path):
    async def scenario():
        graph = SkillAnalysisGraph(tmp_path / "graph.db", SkillWorkUnitStore(tmp_path / "state.db"))
        hints = STYLE_EXECUTION_HINTS.model_copy(update={"decomposition": "ordered_units", "crossUnitDependency": "ordered_state"})
        attempts = []
        fail = True

        async def read(chapter):
            return {**chapter, "contentMode": "full", "content": "原文"}

        async def model(kind, payload, key):
            nonlocal fail
            if kind == "merge":
                return payload["source"]["results"][0]
            source = payload["source"]
            source_id = source["samples"][0]["sourceId"]
            attempts.append(source_id)
            if source_id == "chapter-1" and fail:
                fail = False
                raise ToolchainError("MODEL_OUTPUT_INVALID", "failed unit")
            if source_id != "chapter-0":
                assert source["previous"]["summary"]
            return analysis(source_id)

        async def progress(_):
            pass

        kwargs = dict(owner="run", chapters=chapters(3), goal="Ordered analysis", skill_hash="locked",
                      hints=hints, policy=POLICY, read=read, model=model, progress=progress, check_cancelled=lambda: None)
        with pytest.raises(ToolchainError, match="failed unit"):
            await graph.run(**kwargs)
        result = await graph.run(**kwargs)
        assert result["coverage"]["maxConcurrency"] == 1
        assert attempts == ["chapter-0", "chapter-1", "chapter-1", "chapter-2"]
    asyncio.run(scenario())


def test_cancel_stale_source_and_budget(tmp_path):
    async def scenario():
        graph = SkillAnalysisGraph(tmp_path / "graph.db", SkillWorkUnitStore(tmp_path / "state.db"))
        cancelled = False
        calls = 0

        def check():
            if cancelled:
                raise ToolchainError("CANCELLED", "cancelled")

        async def read(chapter):
            return {**chapter, "contentMode": "full", "content": "原文"}

        async def model(kind, payload, key):
            nonlocal cancelled, calls
            calls += 1
            cancelled = True
            return analysis(payload["source"]["samples"][0]["sourceId"])

        async def progress(_):
            pass

        kwargs = dict(owner="run", chapters=chapters(10), goal="Analyze", skill_hash="locked",
                      hints=STYLE_EXECUTION_HINTS, policy=POLICY, read=read, model=model, progress=progress, check_cancelled=check)
        with pytest.raises(ToolchainError, match="cancelled"):
            await graph.run(**kwargs)
        assert calls <= 3
        cancelled = False
        async def changed(chapter):
            return {**await read(chapter), "version": 2}
        with pytest.raises(ToolchainError, match="章节已改变"):
            await graph.run(**{**kwargs, "owner": "changed", "read": changed})
        with pytest.raises(ToolchainError, match="预算"):
            await graph.run(**{**kwargs, "owner": "budget", "policy": {**POLICY, "maxModelCalls": 0}})
    asyncio.run(scenario())


def test_unknown_request_not_automatically_repeated(tmp_path):
    units = SkillWorkUnitStore(tmp_path / "state.db")
    units.begin("run", "unit", "input", 1000, POLICY)
    with pytest.raises(ToolchainError, match="不能自动重复"):
        units.begin("run", "unit", "input", 1000, POLICY)
    with sqlite3.connect(units.path) as db:
        assert db.execute("SELECT attempts FROM skill_work_units").fetchone()[0] == 1
