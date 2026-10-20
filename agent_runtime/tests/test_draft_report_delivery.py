from types import SimpleNamespace
from unittest.mock import AsyncMock
import asyncio

from novel_agent_runtime.runtime import NovelAgentRuntime


def test_completed_draft_report_retains_delivery_and_warning_scope():
    runtime = object.__new__(NovelAgentRuntime)
    runtime._emit = AsyncMock()
    step = SimpleNamespace(stepId="step", agent="writer", title="Write and review",
                           toolchain=SimpleNamespace(id="chapter.continuation", version="1.0.0"))
    output = {"draftSessionId": "revised", "draftType": "chapter-draft", "status": "draft",
              "version": 1, "previewSummary": "Revised chapter 2300 words", "artifactId": "artifact",
              "warnings": ["RAG evidence unavailable: output limit"]}
    result = asyncio.run(runtime._complete_toolchain(
        SimpleNamespace(), SimpleNamespace(), step, {"report_findings": []},
        {"draftReviewArtifactId": "review", "draftRevisionArtifactId": "revision",
         "draftReview": {"summary": "Reviewed actual prose"}},
        SimpleNamespace(title="Continuation"), output, artifact_id="artifact", tool_call_count=5,
    ))
    delivery = result["report_findings"][0]["data"]
    assert delivery["draftSessionId"] == "revised"
    assert delivery["previewSummary"] == "Revised chapter 2300 words"
    assert delivery["generationCompleted"] is True
    assert delivery["editorialReviewCompleted"] is True
    assert delivery["editorialRevisionCompleted"] is True
    assert "do not mean draft generation failed" in delivery["warningScope"]


def test_batch_delivery_retains_real_context_and_failed_checks_for_summary():
    artifact = SimpleNamespace(artifactId='batch', type='chapter_draft_batch', title='新章', status='ready',
        reference={'draftBatchId': 'b'}, metadata={'generatedDrafts': [
            {'contextSources': [{'chapterId': 'c1', 'title': '前章', 'contentMode': 'full'}],
             'warnings': ['状态抽取失败'], 'consistency': {'status': 'not_reviewed'}},
            {'contextSources': [{'chapterId': 'c1', 'title': '前章', 'contentMode': 'full'}],
             'warnings': ['状态抽取失败'], 'narrativeStateDelta': {'itemStates': []}},
        ]})
    manifest = NovelAgentRuntime._report_artifact_manifest(artifact)
    delivery = manifest['writingDelivery']
    assert delivery['contextChapterCount'] == 1
    assert delivery['warnings'] == ['状态抽取失败']
    assert delivery['stateVerifiedCount'] == 1
    assert not delivery['semanticReviewCompleted'] and not delivery['styleReviewCompleted']
