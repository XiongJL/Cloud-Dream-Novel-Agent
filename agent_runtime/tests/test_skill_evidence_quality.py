from __future__ import annotations

import asyncio
from collections import Counter
import sqlite3

import pytest

import novel_agent_runtime.skill_analysis_graph as analysis_module
from novel_agent_runtime.skill_analysis_graph import (
    SkillAnalysisGraph, SkillWorkUnitStore, analysis_projection, evidence_ref, validate_analysis,
)
from novel_agent_runtime.skill_execution import STYLE_EXECUTION_HINTS
from novel_agent_runtime.toolchains.schemas import ToolchainError
from test_skill_analysis_graph import POLICY, analysis, chapters


def sample(content="🙂他仔细思索了一下。\n原文中的有效证据。", source_id="chapter-0"):
    return {"sourceId": source_id, "content": content, "offset": 100, "version": 1, "contentHash": "locked"}


@pytest.mark.parametrize("bad_quote,content", [
    ("他微微思索了一下。", "他仔细思索了一下。原文。"),
    ('“为什么密封？为什么画线？”', '“为什么密封？为什么画线？为什么休息？”原文。'),
    ("前句。后句。", "前句。中间句。后句。原文。"),
    ("第一句。第二句。", "第一句。\n第二句。原文。"),
])
def test_invalid_quote_does_not_discard_other_exact_evidence(bad_quote, content):
    raw = analysis(quote=bad_quote)
    raw["findings"][0]["confidence"] = "high"
    raw["findings"][0]["evidence"].append({"sourceId": "chapter-0", "excerpt": "原文"})
    result = validate_analysis(raw, [sample(content)])
    finding = result["findings"][0]
    assert finding["confidence"] == "low"
    assert finding["evidenceIncomplete"] is True
    assert [item["excerpt"] for item in finding["evidence"]] == ["原文"]
    assert result["evidenceQuality"] == {"rejectedQuoteCount": 1, "omittedFindingCount": 0}
    assert result["rejectedEvidence"][0]["excerpt"] == bad_quote
    assert "剔除" in result["warnings"][-1]
    evidence = finding["evidence"][0]
    assert evidence["startOffset"] == 100 + content.index("原文")
    assert evidence["endOffset"] == evidence["startOffset"] + 2


def test_unsupported_finding_is_omitted_and_original_response_is_preserved():
    raw = analysis(quote="改写的句子")
    raw["findings"].append(analysis(quote="原文")["findings"][0])
    result = validate_analysis(raw, [sample("原文")])
    assert len(raw["findings"]) == 2
    assert len(result["findings"]) == 1
    assert result["evidenceQuality"]["omittedFindingCount"] == 1
    assert result["findings"][0]["evidence"][0]["excerpt"] == "原文"


def test_all_invalid_quotes_fail_with_actionable_error():
    with pytest.raises(ToolchainError, match="仅重试失败分片") as caught:
        validate_analysis(analysis(quote="改写的句子"), [sample("原文")])
    assert caught.value.code == "MODEL_OUTPUT_INVALID"
    assert caught.value.details["rejectedEvidence"][0]["reason"] == "not_verbatim"


def test_unknown_source_and_forged_merge_reference_remain_fatal():
    raw = analysis(quote="原文")
    raw["findings"][0]["evidence"].append({"sourceId": "outside", "excerpt": "原文"})
    with pytest.raises(ToolchainError, match="来源"):
        validate_analysis(raw, [sample("原文")])
    verified = validate_analysis(analysis(quote="原文"), [sample("原文")])
    merged = {"summary": "merge", "findings": [{"observation": "feature", "evidence": [
        {"evidenceRef": evidence_ref(verified["findings"][0]["evidence"][0])}, {"evidenceRef": "forged"}]}]}
    with pytest.raises(ToolchainError, match="未验证"):
        validate_analysis(merged, [verified], merged=True)


def test_merge_cannot_upgrade_partial_evidence_confidence():
    raw = analysis(quote="微微思索")
    raw["findings"][0]["evidence"].append({"sourceId": "chapter-0", "excerpt": "原文"})
    verified = validate_analysis(raw, [sample("仔细思索。原文")])
    projected = analysis_projection(verified, 14000)
    assert projected["evidenceQuality"]["rejectedQuoteCount"] == 1
    for _ in range(3):
        merged = {"summary": "merge", "findings": [{"observation": "feature", "confidence": "high", "evidence": [
            {"evidenceRef": evidence_ref(verified["findings"][0]["evidence"][0])}]}]}
        verified = validate_analysis(merged, [verified], merged=True)
        assert verified["findings"][0]["confidence"] == "low"
        assert verified["findings"][0]["evidenceIncomplete"] is True
        assert len(analysis_projection(verified, 14000)["warnings"]) == 2


def test_retry_revalidates_saved_raw_result_without_repeating_model_call(tmp_path, monkeypatch):
    async def scenario():
        store = SkillWorkUnitStore(tmp_path / "units.db")
        graph = SkillAnalysisGraph(tmp_path / "graph.db", store)
        calls = Counter()
        strict = True
        original_validate = validate_analysis

        def old_validator(raw, sources, *, merged=False):
            if strict and not merged and any(item["excerpt"] not in sources[0]["content"]
                for finding in raw["findings"] for item in finding.get("evidence", [])):
                raise ToolchainError("MODEL_OUTPUT_INVALID", "old strict rejection")
            return original_validate(raw, sources, merged=merged)

        monkeypatch.setattr(analysis_module, "validate_analysis", old_validator)

        async def read(chapter):
            return {**chapter, "contentMode": "full", "content": "仔细思索。原文"}

        async def model(kind, payload, _key):
            if kind == "merge":
                return payload["source"]["results"][0]
            source_id = payload["source"]["samples"][0]["sourceId"]
            calls[source_id] += 1
            result = analysis(source_id)
            if source_id == "chapter-1":
                result["findings"][0]["evidence"].append({"sourceId": source_id, "excerpt": "微微思索"})
            result["_executionUsage"] = {"calls": 1, "attempts": [{"usage": {"total_tokens": 200}}]}
            return result

        async def progress(_):
            pass

        kwargs = dict(owner="original-run", chapters=chapters(6), goal="Analyze", skill_hash="locked",
            hints=STYLE_EXECUTION_HINTS, policy=POLICY, read=read, model=model,
            progress=progress, check_cancelled=lambda: None)
        with pytest.raises(ToolchainError, match="old strict rejection"):
            await graph.run(**kwargs)
        strict = False
        result = await graph.run(**kwargs)
        assert calls == Counter({f"chapter-{i}": 1 for i in range(6)})
        assert result["coverage"]["analyzedChapterCount"] == 6
        assert result["coverage"]["evidenceGapChapterCount"] == 1
        assert any("剔除 1 条" in item for item in result["warnings"])
        with sqlite3.connect(store.path) as db:
            saved = db.execute("SELECT status,attempts,reserved_calls,reserved_tokens,metadata_json FROM skill_work_units WHERE metadata_json LIKE '%revalidatedSavedResult%'").fetchone()
        assert saved[:4] == ("completed", 1, 1, 200)

    asyncio.run(scenario())


def test_saved_result_commit_requires_matching_input_hash(tmp_path):
    store = SkillWorkUnitStore(tmp_path / "units.db")
    store.begin("run", "key", "original-input", 200, POLICY)
    store.save_raw("key", analysis())
    store.fail("key", ToolchainError("MODEL_OUTPUT_INVALID", "quote rejected"))
    store.finish("key", analysis(), expected_input_hash="different-input")
    assert store.result("key") is None
    store.finish("key", analysis(), expected_input_hash="original-input")
    assert store.result("key") == analysis()
