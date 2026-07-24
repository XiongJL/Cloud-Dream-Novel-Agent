from pydantic import ValidationError
import pytest

from novel_agent_runtime.toolchains.schemas import DraftBatchRecord


def make_batch() -> dict:
    beat = {
        "beatId": "beat-1",
        "childIndex": 0,
        "title": "第三章",
        "chapterGoal": "发现异常来源",
        "coreConflict": "主角必须在暴露前完成调查",
        "keyEvents": ["进入旧站"],
        "reveals": ["信号来自地下"],
        "endingHook": "门后传来第二个人的声音",
        "targetWordCount": 2400,
    }
    return {
        "draftBatchId": "batch-1",
        "novelId": "novel-1",
        "volumeId": "volume-1",
        "anchorChapterId": "chapter-2",
        "mode": "sequence_continuation",
        "insertionMode": "after_anchor",
        "status": "outline_draft",
        "outline": {"revision": 1, "status": "draft", "beats": [beat]},
        "children": [
            {
                "childIndex": 0,
                "title": "第三章",
                "status": "pending",
                "generationRevision": 1,
            }
        ],
        "stateLedger": {},
        "sourceSnapshot": [
            {"chapterId": "chapter-2", "version": 4, "contentHash": "hash-4"}
        ],
        "linkedRunIds": [],
        "version": 1,
        "createdAt": "2026-07-17T00:00:00.000Z",
        "updatedAt": "2026-07-17T00:00:00.000Z",
    }


def test_draft_batch_schema_accepts_ordered_parent_child_contract() -> None:
    batch = DraftBatchRecord.model_validate(make_batch())

    assert batch.outline.beats[0].targetWordCount == 2400
    assert batch.children[0].generationRevision == 1


def test_draft_batch_schema_rejects_misaligned_child_indices() -> None:
    payload = make_batch()
    payload["children"][0]["childIndex"] = 1

    try:
        DraftBatchRecord.model_validate(payload)
    except ValidationError as error:
        assert "ordered zero-based indices" in str(error)
    else:
        raise AssertionError("Expected an invalid child index to be rejected")


def test_draft_batch_schema_validates_evidence_bound_state_delta() -> None:
    payload = make_batch()
    payload["stateLedger"] = {
        "characterLocations": {"顾野": "旧站"},
        "stateDeltas": [{
            "childIndex": 0,
            "generationRevision": 1,
            "draftSessionId": "draft-1",
            "characterLocations": [{
                "characterKey": "顾野",
                "location": "旧站",
                "evidenceExcerpt": "顾野抵达旧站",
            }],
            "relationshipChanges": [],
            "knowledgeChanges": [],
            "itemStates": [],
            "resolvedConflicts": [],
            "openedConflicts": [],
            "warnings": [],
        }],
    }

    batch = DraftBatchRecord.model_validate(payload)

    assert batch.stateLedger.stateDeltas[0].characterLocations[0].location == "旧站"


def test_draft_batch_schema_rejects_state_delta_without_evidence() -> None:
    payload = make_batch()
    payload["stateLedger"] = {
        "stateDeltas": [{
            "childIndex": 0,
            "generationRevision": 1,
            "draftSessionId": "draft-1",
            "characterLocations": [{
                "characterKey": "顾野",
                "location": "旧站",
                "evidenceExcerpt": "",
            }],
        }],
    }

    with pytest.raises(ValidationError):
        DraftBatchRecord.model_validate(payload)
