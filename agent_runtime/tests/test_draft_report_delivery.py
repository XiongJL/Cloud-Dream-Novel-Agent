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
