from __future__ import annotations

from typing import Any

from .schemas import (
    ChapterBeatInput,
    ChapterSequenceContinuationInput,
    DraftBatchRecord,
    DraftSessionRef,
    NarrativeStateDelta,
    NarrativeStateDeltaRecord,
    ToolchainError,
)


MAX_CHAPTER_BEAT_REVISIONS = 10


def sequence_context_params(input_data: ChapterSequenceContinuationInput) -> dict[str, Any]:
    params: dict[str, Any] = {
        "novelId": input_data.novelId,
        "chapterId": input_data.chapterId,
        "currentContent": input_data.currentContent,
        "contextChapterCount": input_data.contextChapterCount,
        "recentRawChapterCount": input_data.recentRawChapterCount,
        "locale": input_data.locale,
    }
    for key in ("style", "tone", "pace"):
        value = getattr(input_data, key)
        if value:
            params[key] = value
    return params


def beat_generation_params(
    input_data: ChapterSequenceContinuationInput,
    continuation_context: dict[str, Any],
) -> dict[str, Any]:
    return {
        "novelId": input_data.novelId,
        "chapterId": input_data.chapterId,
        "goal": input_data.goal,
        "chapterCount": input_data.chapterCount,
        "locale": input_data.locale,
        "context": continuation_context,
    }


def beat_revision_params(
    input_data: ChapterSequenceContinuationInput,
    continuation_context: dict[str, Any],
    previous_beats: list[ChapterBeatInput],
    revision_instruction: str,
) -> dict[str, Any]:
    return {
        **beat_generation_params(input_data, continuation_context),
        "previousBeats": [beat.model_dump() for beat in previous_beats],
        "revisionInstruction": revision_instruction,
    }


def normalize_beat_inputs(value: Any, expected_count: int) -> list[ChapterBeatInput]:
    raw_beats = value.get("beats") if isinstance(value, dict) else value
    if not isinstance(raw_beats, list):
        raise ToolchainError("NODE_FAILED", "Chapter beat generation returned no beats", node_id="beats.generate")
    try:
        beats = [ChapterBeatInput.model_validate(item) for item in raw_beats]
    except Exception as error:
        raise ToolchainError(
            "NODE_FAILED",
            f"Chapter beat generation returned invalid data: {error}",
            node_id="beats.generate",
        ) from error
    if len(beats) != expected_count:
        raise ToolchainError(
            "NODE_FAILED",
            f"Expected {expected_count} chapter beats, received {len(beats)}",
            node_id="beats.generate",
        )
    return beats


def batch_create_params(
    input_data: ChapterSequenceContinuationInput,
    beats: list[ChapterBeatInput],
    continuation_context: dict[str, Any],
    run_id: str,
) -> dict[str, Any]:
    snapshot = continuation_context.get("snapshot") if isinstance(continuation_context, dict) else {}
    chapter_sources = snapshot.get("chapterSources") if isinstance(snapshot, dict) else []
    source_snapshot = []
    for item in chapter_sources if isinstance(chapter_sources, list) else []:
        if not isinstance(item, dict):
            continue
        chapter_id = str(item.get("chapterId") or "").strip()
        content_hash = str(item.get("contentHash") or "").strip()
        version = item.get("version")
        if chapter_id and content_hash and isinstance(version, int) and version >= 1:
            source_snapshot.append({
                "chapterId": chapter_id,
                "version": version,
                "contentHash": content_hash,
            })
    return {
        "novelId": input_data.novelId,
        "volumeId": input_data.volumeId,
        "anchorChapterId": input_data.chapterId,
        "mode": "sequence_continuation",
        "insertionMode": input_data.insertionMode,
        "beats": [beat.model_dump() for beat in beats],
        "sourceSnapshot": source_snapshot,
        "runId": run_id,
    }


def batch_regeneration_params(
    input_data: ChapterSequenceContinuationInput,
    run_id: str,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "draftBatchId": input_data.resumeBatchId,
        "version": input_data.resumeBatchVersion,
        "runId": run_id,
    }
    if input_data.startChildIndex is not None:
        params["fromChildIndex"] = input_data.startChildIndex
    return params


def normalize_regeneration_preparation(
    value: Any,
    node_id: str,
) -> tuple[DraftBatchRecord, int, list[dict[str, Any]]]:
    if not isinstance(value, dict):
        raise ToolchainError("NODE_FAILED", "Regeneration preparation is not an object", node_id=node_id)
    batch = normalize_draft_batch(value.get("batch"), node_id)
    from_child_index = value.get("fromChildIndex")
    preserved = value.get("preservedDrafts")
    if not isinstance(from_child_index, int) or from_child_index < 0 or from_child_index >= len(batch.children):
        raise ToolchainError("NODE_FAILED", "Regeneration preparation returned an invalid start index", node_id=node_id)
    if not isinstance(preserved, list) or len(preserved) != from_child_index:
        raise ToolchainError("NODE_FAILED", "Regeneration preparation returned an incomplete prefix", node_id=node_id)

    generated_drafts: list[dict[str, Any]] = []
    for child_index, raw_session in enumerate(preserved):
        try:
            session = DraftSessionRef.model_validate(raw_session)
        except Exception as error:
            raise ToolchainError(
                "NODE_FAILED",
                f"Preserved DraftSession is invalid: {error}",
                node_id=node_id,
            ) from error
        if session.childIndex != child_index or session.status not in {"draft", "committed"}:
            raise ToolchainError(
                "NODE_FAILED",
                "Preserved DraftSession does not match the contiguous prefix",
                node_id=node_id,
            )
        payload = raw_session.get("payload") if isinstance(raw_session, dict) else {}
        payload = payload if isinstance(payload, dict) else {}
        generated_text = str(payload.get("generatedText") or payload.get("content") or "")
        compact = generated_text.strip()
        summary = compact[:500]
        if len(compact) > 700:
            summary = f"{compact[:350]} … {compact[-250:]}"
        generated_drafts.append({
            "childIndex": child_index,
            "title": batch.outline.beats[child_index].title,
            "draftSessionId": session.draftSessionId,
            "generatedText": generated_text,
            "summary": summary or session.previewSummary,
        })
    if len(generated_drafts) > 2:
        for earlier in generated_drafts[:-2]:
            earlier["generatedText"] = ""
    return batch, from_child_index, generated_drafts


def normalize_draft_batch(value: Any, node_id: str) -> DraftBatchRecord:
    try:
        return DraftBatchRecord.model_validate(value)
    except Exception as error:
        raise ToolchainError(
            "NODE_FAILED",
            f"Draft batch returned invalid data: {error}",
            node_id=node_id,
        ) from error


def chapter_beats_checkpoint(
    step_id: str,
    batch: DraftBatchRecord,
    *,
    revision_error: str | None = None,
) -> dict[str, Any]:
    beat_lines = [
        f"{index + 1}. {beat.title}：{beat.chapterGoal}；冲突：{beat.coreConflict}；钩子：{beat.endingHook}"
        for index, beat in enumerate(batch.outline.beats)
    ]
    revision_count = max(0, batch.outline.revision - 1)
    checkpoint = {
        "checkpointId": f"batch-beats:{batch.draftBatchId}:{batch.outline.revision}",
        "checkpointType": "chapter_beats",
        "title": f"确认 {len(batch.outline.beats)} 章节拍",
        "question": "确认以下整批章节节拍后，将按顺序生成正文：\n" + "\n".join(beat_lines),
        "reason": "后续章节依赖前序草稿；节拍确认后才允许开始正文生成。",
        "options": [{"id": "approve_beats", "label": "确认并生成"}],
        "allowFreeText": revision_count < MAX_CHAPTER_BEAT_REVISIONS,
        "freeTextPlaceholder": "告诉我如何调整这些章节节拍……",
        "stepId": step_id,
        "draftBatchId": batch.draftBatchId,
        "outlineRevision": batch.outline.revision,
        "revisionCount": revision_count,
        "maxRevisionCount": MAX_CHAPTER_BEAT_REVISIONS,
        "beats": [beat.model_dump() for beat in batch.outline.beats],
    }
    if revision_error:
        checkpoint["revisionError"] = revision_error[:1000]
    return checkpoint


def sequence_child_params(
    input_data: ChapterSequenceContinuationInput,
    batch: DraftBatchRecord,
    child_index: int,
    continuation_context: dict[str, Any],
    generated_drafts: list[dict[str, Any]],
) -> dict[str, Any]:
    beat = batch.outline.beats[child_index]
    recent_full = generated_drafts[-2:]
    earlier = generated_drafts[:-2]
    dynamic_context = continuation_context.get("dynamicContext") if isinstance(continuation_context, dict) else {}
    current_content = input_data.currentContent or str(
        continuation_context.get("currentContentSource")
        or (dynamic_context.get("currentChapterBeforeCursor") if isinstance(dynamic_context, dict) else "")
        or ""
    )
    if recent_full:
        current_content = "\n\n".join(str(item.get("generatedText") or "") for item in recent_full).strip()
    batch_context = {
        "draftBatchId": batch.draftBatchId,
        "outlineRevision": batch.outline.revision,
        "childIndex": child_index,
        "allBeats": [item.model_dump() for item in batch.outline.beats],
        "currentBeat": beat.model_dump(),
        "recentFullDrafts": [
            {
                "childIndex": item.get("childIndex"),
                "title": item.get("title"),
                "content": str(item.get("generatedText") or "")[-12000:],
            }
            for item in recent_full
        ],
        "earlierDraftSummaries": [
            {
                "childIndex": item.get("childIndex"),
                "title": item.get("title"),
                "summary": item.get("summary"),
            }
            for item in earlier
        ],
        "stateLedger": batch.stateLedger.model_dump(),
    }
    intent = "\n".join([
        input_data.goal,
        f"本章节拍：{beat.title}",
        f"章节目标：{beat.chapterGoal}",
        f"核心冲突：{beat.coreConflict}",
        f"关键事件：{'；'.join(beat.keyEvents)}",
        f"信息揭示：{'；'.join(beat.reveals)}",
        f"结尾钩子：{beat.endingHook}",
    ])
    return {
        "novelId": input_data.novelId,
        "chapterId": input_data.chapterId,
        "currentContent": current_content,
        "mode": "new_chapter",
        "userIntent": intent,
        "locale": input_data.locale,
        "presentation": "silent",
        "contextChapterCount": input_data.contextChapterCount,
        "recentRawChapterCount": input_data.recentRawChapterCount,
        "targetLength": beat.targetWordCount,
        "style": input_data.style,
        "tone": input_data.tone,
        "pace": input_data.pace,
        "preparedContext": continuation_context,
        "draftBatchId": batch.draftBatchId,
        "childIndex": child_index,
        "generationRevision": batch.children[child_index].generationRevision,
        "batchTitle": beat.title,
        "batchContext": batch_context,
    }


def normalize_generated_child(
    value: Any,
    child_index: int,
    title: str,
    expected_generation_revision: int | None = None,
) -> tuple[DraftSessionRef, dict[str, Any]]:
    try:
        session = DraftSessionRef.model_validate(value)
    except Exception as error:
        raise ToolchainError(
            "NODE_FAILED",
            f"chapter.generate_draft returned an invalid batch child: {error}",
            node_id=f"draft.generate.{child_index}",
        ) from error
    if session.status != "draft" or session.draftBatchId is None or session.childIndex != child_index:
        raise ToolchainError(
            "NODE_FAILED",
            "chapter.generate_draft did not attach the expected batch child",
            node_id=f"draft.generate.{child_index}",
        )
    if expected_generation_revision is not None and session.generationRevision != expected_generation_revision:
        raise ToolchainError(
            "NODE_FAILED",
            "chapter.generate_draft attached an outdated generation revision",
            node_id=f"draft.generate.{child_index}",
        )
    payload = value.get("payload") if isinstance(value, dict) and isinstance(value.get("payload"), dict) else {}
    generated_text = str(payload.get("generatedText") or "")
    compact = generated_text.strip()
    summary = compact[:500]
    if len(compact) > 700:
        summary = f"{compact[:350]} … {compact[-250:]}"
    raw_delta = payload.get("narrativeStateDelta")
    state_delta = None
    if isinstance(raw_delta, dict):
        try:
            state_delta = NarrativeStateDelta.model_validate(raw_delta).model_dump()
        except Exception:
            state_delta = None
    return session, {
        "childIndex": child_index,
        "title": title,
        "draftSessionId": session.draftSessionId,
        "generatedText": generated_text,
        "summary": summary or session.previewSummary,
        "generationRevision": session.generationRevision or 1,
        **({"narrativeStateDelta": state_delta} if state_delta else {}),
    }


def advance_batch_state_ledger(
    batch: DraftBatchRecord,
    child_index: int,
    draft_state: dict[str, Any],
) -> Any:
    beat = batch.outline.beats[child_index]
    ledger = batch.stateLedger
    timeline = [
        *ledger.timeline,
        {
            "childIndex": child_index,
            "draftSessionId": draft_state.get("draftSessionId"),
            "title": beat.title,
            "keyEvents": beat.keyEvents,
            "reveals": beat.reveals,
            "summary": draft_state.get("summary"),
        },
    ]
    foreshadowing = [
        *ledger.foreshadowing,
        {"childIndex": child_index, "hook": beat.endingHook, "status": "open"},
    ]
    conflicts = list(ledger.unresolvedConflicts)
    if beat.coreConflict not in conflicts:
        conflicts.append(beat.coreConflict)
    updated = ledger.model_copy(update={
        "timeline": timeline,
        "foreshadowing": foreshadowing,
        "unresolvedConflicts": conflicts,
    })
    raw_delta = draft_state.get("narrativeStateDelta")
    if not isinstance(raw_delta, dict):
        return updated
    try:
        delta = NarrativeStateDelta.model_validate(raw_delta)
    except Exception:
        return updated
    character_locations = dict(updated.characterLocations)
    for item in delta.characterLocations:
        character_locations[item.characterKey] = item.location
    knowledge_state = {key: list(values) for key, values in updated.knowledgeState.items()}
    for item in delta.knowledgeChanges:
        known = set(knowledge_state.get(item.characterKey, []))
        known.difference_update(item.forgotten)
        known.update(item.learned)
        knowledge_state[item.characterKey] = sorted(known)
    item_states = dict(updated.itemStates)
    for item in delta.itemStates:
        item_states[item.itemKey] = item.state
    resolved = {item.conflict for item in delta.resolvedConflicts}
    unresolved = [item for item in updated.unresolvedConflicts if item not in resolved]
    for item in delta.openedConflicts:
        if item.conflict not in unresolved:
            unresolved.append(item.conflict)
    draft_session_id = str(draft_state.get("draftSessionId") or "")
    generation_revision = int(draft_state.get("generationRevision") or 1)
    relationship_changes = [
        item for item in updated.relationshipChanges
        if not (
            item.get("source") == "state_extraction"
            and item.get("childIndex") == child_index
            and item.get("draftSessionId") == draft_session_id
        )
    ]
    relationship_changes.extend([
        {
            **item.model_dump(),
            "source": "state_extraction",
            "childIndex": child_index,
            "draftSessionId": draft_session_id,
            "generationRevision": generation_revision,
        }
        for item in delta.relationshipChanges
    ])
    state_deltas = [
        item for item in updated.stateDeltas
        if not (item.childIndex == child_index and item.draftSessionId == draft_session_id)
    ]
    state_deltas.append(NarrativeStateDeltaRecord.model_validate({
        **delta.model_dump(),
        "childIndex": child_index,
        "generationRevision": generation_revision,
        "draftSessionId": draft_session_id,
    }))
    return updated.model_copy(update={
        "characterLocations": character_locations,
        "relationshipChanges": relationship_changes,
        "knowledgeState": knowledge_state,
        "itemStates": item_states,
        "unresolvedConflicts": unresolved,
        "stateDeltas": state_deltas,
    })
