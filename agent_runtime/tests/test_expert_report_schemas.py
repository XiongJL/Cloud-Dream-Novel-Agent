from novel_agent_runtime.schemas import (
    AgentArtifact,
    AgentRevisionTask,
    ExpertReportPayload,
    FindingDecision,
)
from novel_agent_runtime.planner import _resolve_deliverable


def _snapshot() -> dict:
    return {
        "chapterId": "chapter-1",
        "version": 2,
        "contentHash": "hash-2",
        "updatedAt": "2026-07-18T00:00:00Z",
        "source": "database",
    }


def test_expert_report_and_revision_task_contracts() -> None:
    report = ExpertReportPayload.model_validate({
        "artifactId": "artifact-1",
        "novelId": "novel-1",
        "runId": "run-1",
        "planId": "plan-1",
        "type": "chapter_range_review",
        "title": "章节范围审核",
        "expert": "editor",
        "scope": {
            "scopeId": "scope-1",
            "novelId": "novel-1",
            "kind": "current_chapter",
            "chapterIds": ["chapter-1"],
            "anchorChapterId": "chapter-1",
            "processingMode": "detailed",
            "snapshot": [_snapshot()],
        },
        "findings": [{
            "findingId": "finding-1",
            "title": "动机断层",
            "summary": "行动缺少铺垫",
            "category": "motivation",
            "severity": "high",
            "chapterIds": ["chapter-1"],
            "expert": "editor",
            "evidenceRefs": ["chapter-1"],
            "recommendedRole": "writer",
        }],
        "sourceSnapshot": [_snapshot()],
    })
    assert report.type == "chapter_range_review"
    assert report.findings[0].severity == "high"

    artifact = AgentArtifact(
        artifactId="artifact-1",
        runId="run-1",
        planId="plan-1",
        type="chapter_range_review",
        title="章节范围审核",
        metadata={"expertReport": report.model_dump()},
    )
    assert artifact.reviewStatus == "unreviewed"
    assert artifact.reviewRevision == 0

    decision = FindingDecision(findingId="finding-1", status="accepted")
    assert decision.status == "accepted"
    task = AgentRevisionTask(
        revisionTaskId="revision-1",
        novelId="novel-1",
        sourceArtifactId="artifact-1",
        sourceFindingId="finding-1",
        title="修订动机",
        description="补足行动动机",
        targetChapterIds=["chapter-1"],
        sourceExpert="editor",
        severity="high",
        recommendedRole="writer",
        sourceSnapshot=[_snapshot()],
    )
    assert task.status == "open"


def test_planner_preserves_expert_report_deliverable() -> None:
    assert _resolve_deliverable(
        "审核多个章节",
        {"deliverable": "expert_report", "steps": []},
    ) == "expert_report"
