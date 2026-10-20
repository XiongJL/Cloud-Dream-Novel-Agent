from __future__ import annotations

import re
import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from novel_agent_runtime.intent.operations import INTENT_OPERATION_REGISTRY
from novel_agent_runtime.agent_skills.authoring import style_skill_body, style_skill_member_document
from novel_agent_runtime.style_quality import evidence_pages, validate_quality, build_dossier, CRITERIA, review_evidence_page, quality_key
from novel_agent_runtime.skill_analysis_graph import SkillWorkUnitStore, fingerprint
from novel_agent_runtime.toolchains.schemas import ToolchainError, StyleSkillPackAuthoringPlan
from test_skill_analysis_graph import analysis


def quality_fixture(tmp_path, provider):
    store = SkillWorkUnitStore(tmp_path / "units.db")
    run = SimpleNamespace(runId="run", currentStepId="step", retryRootRunId=None, retryOfRunId=None,
        resumedFrom=None, cancelRequested=False, skillSnapshot=[])
    policy = {"maxInputBytes": 48000, "outputReserveTokens": 32768, "maxModelCalls": 200,
        "maxWorkUnits": 200, "maxTotalTokens": 20000000, "stages": {"expert": {
            "maxInputBytes": 48000, "inputReserveTokens": 10000, "outputReserveTokens": 32768, "maxProviderCalls": 2}}}
    calls = []
    async def graph():
        return SimpleNamespace(store=store)
    async def invoke(_, method, params, request, key):
        calls.append(tuple(c["findingRef"] for c in params["source"]["candidates"]))
        return await provider(params["source"])
    async def recover(*_):
        raise ToolchainError("SIDE_EFFECT_UNKNOWN", "请求尚未核对")
    runtime = SimpleNamespace(skill_execution_engine=SimpleNamespace(get_graph=graph),
        _invoke_skill_model=invoke, _recover_skill_model=recover)
    source = {"features": {}, "coverage": {}, "candidates": [
        {"findingRef": str(i), **analysis()["findings"][0]} for i in range(16)]}
    return runtime, run, policy, source, store, calls


def evidence_result(source):
    return {"phase": "evidence", "decisions": [{"findingRef": c["findingRef"], "feature": "short_actions",
        "disposition": "supported", "reason": "当前引文支持局部观察"} for c in source["candidates"]]}


def test_truncated_evidence_halves_without_losing_candidates_and_reuses_children(tmp_path):
    async def scenario():
        async def provider(source):
            if len(source["candidates"]) > 4:
                raise ToolchainError("MODEL_OUTPUT_TRUNCATED", "output full")
            return evidence_result(source)
        runtime, run, policy, source, store, calls = quality_fixture(tmp_path, provider)
        result = await review_evidence_page(runtime, run, source, policy)
        assert [c["findingRef"] for c in result["decisions"]] == [str(i) for i in range(16)]
        assert [len(c) for c in calls] == [8, 4, 4, 8, 4, 4]
        # Resume must not resend the failed 8-item requests, or any completed child.
        run.retryOfRunId = "run"
        run.retryRootRunId = "run"
        assert await review_evidence_page(runtime, run, source, policy) == result
        assert len(calls) == 6
        assert store.record(quality_key(run, "evidence", {**source, "candidates": source["candidates"][:8]}))["error"]["code"] == "MODEL_OUTPUT_TRUNCATED"
    asyncio.run(scenario())


def test_old_completed_16_candidate_page_requires_no_provider_call(tmp_path):
    async def scenario():
        async def provider(_):
            raise AssertionError("completed page must be reused")
        runtime, run, policy, source, store, calls = quality_fixture(tmp_path, provider)
        key = quality_key(run, "evidence", source)
        store.begin("run:step", key, fingerprint(source), 100, policy)
        store.finish(key, evidence_result(source))
        assert len((await review_evidence_page(runtime, run, source, policy))["decisions"]) == 16
        assert calls == []
    asyncio.run(scenario())


@pytest.mark.parametrize("code", ["NETWORK_ERROR", "PROVIDER_TIMEOUT", "STORAGE_BUSY", "MODEL_OUTPUT_INVALID"])
def test_other_failures_do_not_authorize_subdivision(tmp_path, code):
    async def scenario():
        async def provider(_):
            raise ToolchainError(code, "stop")
        runtime, run, policy, source, store, calls = quality_fixture(tmp_path, provider)
        with pytest.raises(ToolchainError) as caught:
            await review_evidence_page(runtime, run, source, policy)
        assert caught.value.code == code and len(calls) == 1
    asyncio.run(scenario())


def test_unknown_old_page_blocks_new_subdivision_requests(tmp_path):
    async def scenario():
        async def provider(_):
            raise AssertionError("unknown request must be reconciled first")
        runtime, run, policy, source, store, calls = quality_fixture(tmp_path, provider)
        store.begin("run:step", quality_key(run, "evidence", source), fingerprint(source), 100, policy)
        with pytest.raises(ToolchainError) as caught:
            await review_evidence_page(runtime, run, source, policy)
        assert caught.value.code == "SIDE_EFFECT_UNKNOWN" and calls == []
    asyncio.run(scenario())


def test_single_candidate_truncation_stops_and_budget_cancellation_are_respected(tmp_path):
    async def scenario():
        async def provider(_):
            raise ToolchainError("MODEL_OUTPUT_TRUNCATED", "output full")
        runtime, run, policy, source, store, calls = quality_fixture(tmp_path, provider)
        with pytest.raises(ToolchainError, match="单个文风候选"):
            await review_evidence_page(runtime, run, source, policy)
        assert [len(c) for c in calls] == [8, 4, 2, 1]
        run.cancelRequested = True
        with pytest.raises(ToolchainError) as caught:
            await review_evidence_page(runtime, run, source, policy)
        assert caught.value.code == "CANCELLED" and len(calls) == 4
        run.cancelRequested = False
        policy["maxModelCalls"] = 0
        with pytest.raises(ToolchainError) as caught:
            await review_evidence_page(runtime, run, {**source, "candidates": source["candidates"][8:]}, policy)
        assert caught.value.code == "BUDGET_EXCEEDED" and len(calls) == 4
    asyncio.run(scenario())


def test_electron_operation_registry_matches_python():
    source = (Path(__file__).resolve().parents[2] / "apps/desktop/shared/agentOperationIds.ts").read_text(encoding="utf-8")
    assert re.findall(r"'([^']+)'", source) == [item["id"] for item in INTENT_OPERATION_REGISTRY.list_public()]


def test_every_leaf_is_reviewed_and_distinct_chapter_counts_survive_projection():
    units = [(str(i), {**analysis(f"chapter-{i % 5}"), "findings": analysis(f"chapter-{i % 5}")["findings"] * 3}) for i in range(33)]
    pages = evidence_pages(units, 16000)
    assert sum(len(page) for page in pages) == 99 and len(pages) >= 7
    reviews = []
    for page in pages:
        review = validate_quality({"phase": "evidence", "decisions": [{"findingRef": c["findingRef"], "feature": "short_actions",
            "disposition": "supported", "reason": "可定位的动作支持局部观察"} for c in page]}, "evidence", {"candidates": page})
        reviews.append(review)
    dossier = build_dossier(pages, reviews, {"analyzedChapterCount": 5})
    assert dossier["reviewedCandidateCount"] == 99
    assert dossier["features"][0]["supportedChapterCount"] == 5
    assert dossier["features"][0]["supportedFindingCount"] == 99
    assert len(dossier["features"][0]["supportedExamples"]) == 1
    # Repeated IDs or missing decisions cannot masquerade as a full review.
    with pytest.raises(ToolchainError, match="逐项"):
        validate_quality({"phase": "evidence", "decisions": reviews[0]["decisions"][:-1]}, "evidence", {"candidates": pages[0]})


def test_incomplete_or_absent_evidence_cannot_be_promoted():
    page = [{"findingRef": "partial", **analysis()["findings"][0], "evidenceIncomplete": True},
            {"findingRef": "none", "observation": "unknown", "evidence": []}]
    reviewed = validate_quality({"phase": "evidence", "decisions": [{"findingRef": c["findingRef"], "feature": "other",
        "disposition": "supported", "reason": "claim"} for c in page]}, "evidence", {"candidates": page})
    assert all(c["disposition"] == "unresolved" for c in reviewed["decisions"])


def test_unverified_checks_and_contradictions_block_document_acceptance():
    raw = {"phase": "document", "summary": "候选被写成硬性模板", "checks": {key: "pass" for key in CRITERIA}, "issues": []}
    raw["checks"]["rule_calibration"] = "unverified"
    assert validate_quality(raw, "document", {})["accepted"] is False
    raw["checks"]["rule_calibration"] = "pass"
    raw["issues"] = [{"message": "章末低置信却要求固定短句"}]
    assert validate_quality(raw, "document", {})["accepted"] is False
    del raw["checks"]["task_fit"]
    with pytest.raises(ToolchainError, match="完整质量"):
        validate_quality(raw, "document", {})


def test_trial_needs_prose_and_must_not_copy_source():
    with pytest.raises(ToolchainError):
        validate_quality({"phase": "generate_trial", "text": "只提供检查清单"}, "generate_trial", {})
    text = "值班员逐项核对登记时间。" * 25
    with pytest.raises(ToolchainError, match="来源长句"):
        validate_quality({"phase": "generate_trial", "text": text}, "generate_trial", {"sourceQuotes": [text[:24]]})
    assert validate_quality({"phase": "generate_trial", "text": text}, "generate_trial", {})["text"] == text


def test_optional_review_advice_does_not_block_but_missing_severity_remains_blocking():
    raw = {"phase": "document", "summary": "核心检查通过，可润色", "checks": {key: "pass" for key in CRITERIA},
        "issues": [{"severity": "advisory", "message": "可增加一个可选例子"}]}
    assert validate_quality(raw, "document", {})["accepted"]
    raw["checks"]["rule_calibration"] = "fail"
    assert not validate_quality(raw, "document", {})["accepted"]
    raw["checks"]["rule_calibration"] = "pass"
    del raw["issues"][0]["severity"]
    assert not validate_quality(raw, "document", {})["accepted"], "Legacy issues retain their blocking meaning"
    raw["issues"][0]["severity"] = "unknown"
    with pytest.raises(ToolchainError):
        validate_quality(raw, "document", {})


def plan_binding(operation="chapter.continuation", role="writer"):
    members = [{"draftKey": key, "stableIdCandidate": key.replace('_', '-'), "title": key, "description": key,
        "confidence": "medium", "triggerHints": ["写作"], "antiTriggerHints": ["检索"], "supportedOperations": ["chapter.continuation"],
        "constraints": ["不复制原文"], "methodDimensions": ["节奏", "视角", "对白"], "evaluationPrompt": "原创试写"}
        for key in ("language_style", "suspense_release")]
    return {"summary": "plan", "skills": members, "pack": {"stableIdCandidate": "test-pack", "title": "Pack", "description": "Pack",
        "bindings": [{"operationId": operation, "roleId": role, "primaryDraftKey": "language_style", "auxiliaryDraftKey": "suspense_release"}]}}


@pytest.mark.parametrize("operation,role", [("draft.chapter", "writer"), ("chapter.rewrite", "writer"), ("chapter.continuation", "reader")])
def test_invalid_binding_is_rejected_before_authoring(operation, role):
    with pytest.raises(ValueError):
        StyleSkillPackAuthoringPlan.model_validate(plan_binding(operation, role))
    assert StyleSkillPackAuthoringPlan.model_validate(plan_binding()).pack.bindings[0].operationId == "chapter.continuation"


@pytest.mark.parametrize("prefix", ["", "---\nschemaVersion: novel-editor.agent-skill.v1\nstableId: malicious.other\nsemanticSelection: true\n",
    "---\nschemaVersion: novel-editor.agent-skill.v1\nstableId: malicious.other\n---\n"])
def test_style_header_is_owned_by_program_even_when_model_breaks_file(prefix):
    member = StyleSkillPackAuthoringPlan.model_validate(plan_binding()).skills[0]
    body = "## 应用方法\n依据新场景与证据边界生成原创正文。\n## 降级\n未核验的方法仅作为可调建议。"
    document = style_skill_member_document(member, prefix + body, "novel", "novel-1")
    assert style_skill_body(document) == body
    assert 'stableId: "language-style"' in document and "malicious.other" not in document
    assert "semanticSelection: suggest" in document
    assert document.count("\n---\n") == 1
    assert 'ownerNovelId: "novel-1"' in document
    assert style_skill_member_document(member, document, "novel", "novel-1") == document


def test_unrecoverable_body_cannot_be_overwritten_with_metadata_or_empty_text():
    for text in ("", "---\nschemaVersion: novel-editor.agent-skill.v1\nstableId: x", "x" * 32001):
        with pytest.raises(ValueError):
            style_skill_body(text)
    member = StyleSkillPackAuthoringPlan.model_validate(plan_binding()).skills[0]
    with pytest.raises(ValueError, match="32 KiB"):
        style_skill_member_document(member, "叙述" * 9000, "user")
