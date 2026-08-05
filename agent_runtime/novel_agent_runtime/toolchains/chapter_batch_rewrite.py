from __future__ import annotations

from typing import Any

from .schemas import (
    ChapterBatchRewriteInput,
    ChapterScopeBundle,
    DraftBatchRecord,
    ToolchainError,
)


def rewrite_scope_context_params(input_data: ChapterBatchRewriteInput) -> dict[str, Any]:
    params = {
        "scopeId": input_data.scopeId,
        "novelId": input_data.novelId,
        "kind": input_data.kind,
        "volumeId": input_data.volumeId,
        "chapterId": input_data.chapterId,
        "chapterIds": input_data.chapterIds,
        "anchorChapterId": input_data.chapterId,
        "processingMode": "detailed",
        "currentContent": input_data.currentContent,
        "goal": input_data.goal,
        "locale": input_data.locale,
        "batchSize": min(5, len(input_data.chapterIds)),
        "maxDetailedChapters": 5,
        "maxEstimatedTokens": 120000,
    }
    # FastMCP validates optional fields when they are present. Sending JSON null
    # for an optional string is therefore invalid; omit absent values entirely.
    return {key: value for key, value in params.items() if value is not None}


def normalize_rewrite_scope_bundle(value: Any, input_data: ChapterBatchRewriteInput) -> ChapterScopeBundle:
    try:
        bundle = ChapterScopeBundle.model_validate(value)
    except Exception as error:
        raise ToolchainError("NODE_FAILED", f"Rewrite scope context is invalid: {error}", node_id="context.build") from error
    targets = [chapter for chapter in bundle.chapters if chapter.target]
    target_by_id = {chapter.chapterId: chapter for chapter in targets}
    missing = [chapter_id for chapter_id in input_data.chapterIds if chapter_id not in target_by_id]
    if missing:
        raise ToolchainError(
            "NODE_FAILED",
            "Rewrite scope did not return every approved target chapter",
            node_id="context.build",
            details={"missingChapterIds": missing},
        )
    incomplete = [
        chapter_id for chapter_id in input_data.chapterIds
        if target_by_id[chapter_id].contentMode != "full" or not target_by_id[chapter_id].content.strip()
    ]
    if incomplete:
        raise ToolchainError(
            "BUDGET_EXCEEDED",
            "Batch rewrite requires the complete source text for every target chapter",
            node_id="context.build",
            details={"chapterIds": incomplete},
        )
    volume_ids = {target_by_id[chapter_id].volumeId for chapter_id in input_data.chapterIds}
    if volume_ids != {input_data.volumeId}:
        raise ToolchainError(
            "INPUT_INVALID",
            "Batch rewrite currently requires every target chapter to belong to the selected volume",
            node_id="context.build",
            details={"volumeIds": sorted(volume_ids)},
        )
    return bundle


def rewrite_batch_create_params(
    input_data: ChapterBatchRewriteInput,
    beats: list[Any],
    bundle: ChapterScopeBundle,
    run_id: str,
) -> dict[str, Any]:
    snapshot_by_id = {
        snapshot.chapterId: snapshot
        for snapshot in (bundle.sourceSnapshot or bundle.scope.snapshot)
    }
    missing = [chapter_id for chapter_id in input_data.chapterIds if chapter_id not in snapshot_by_id]
    if missing:
        raise ToolchainError(
            "NODE_FAILED",
            "Rewrite targets are missing versioned source snapshots",
            node_id="batch.create",
            details={"missingChapterIds": missing},
        )
    return {
        "novelId": input_data.novelId,
        "volumeId": input_data.volumeId,
        "anchorChapterId": input_data.chapterId,
        "mode": "batch_rewrite",
        "beats": [beat.model_dump() for beat in beats],
        "targetChapterIds": input_data.chapterIds,
        "sourceSnapshot": [
            {
                "chapterId": chapter_id,
                "version": snapshot_by_id[chapter_id].version,
                "contentHash": snapshot_by_id[chapter_id].contentHash,
            }
            for chapter_id in input_data.chapterIds
        ],
        "runId": run_id,
    }


def assert_rewrite_batch_alignment(
    batch: DraftBatchRecord,
    input_data: ChapterBatchRewriteInput,
    bundle: ChapterScopeBundle,
) -> None:
    if batch.mode != "batch_rewrite":
        raise ToolchainError("NODE_FAILED", "Draft batch mode does not match batch rewrite", node_id="batch.read")
    child_targets = [child.targetChapterId for child in batch.children]
    if child_targets != input_data.chapterIds:
        raise ToolchainError(
            "NODE_FAILED",
            "Draft batch targets do not match the approved chapter scope",
            node_id="batch.read",
            details={"expected": input_data.chapterIds, "actual": child_targets},
        )
    current_snapshot = {
        snapshot.chapterId: snapshot
        for snapshot in (bundle.sourceSnapshot or bundle.scope.snapshot)
    }
    batch_snapshot = {snapshot.chapterId: snapshot for snapshot in batch.sourceSnapshot}
    committed_targets = {
        child.targetChapterId for child in batch.children
        if child.status == "committed" and child.targetChapterId
    }
    conflicts = [
        chapter_id for chapter_id in input_data.chapterIds
        if chapter_id not in committed_targets and (
            chapter_id not in current_snapshot
            or chapter_id not in batch_snapshot
            or current_snapshot[chapter_id].version != batch_snapshot[chapter_id].version
            or current_snapshot[chapter_id].contentHash != batch_snapshot[chapter_id].contentHash
        )
    ]
    if conflicts:
        raise ToolchainError(
            "VERSION_CONFLICT",
            "One or more rewrite targets changed after the draft batch snapshot was created",
            node_id="batch.read",
            details={"chapterIds": conflicts},
        )


def rewrite_child_params(
    input_data: ChapterBatchRewriteInput,
    batch: DraftBatchRecord,
    child_index: int,
    bundle: ChapterScopeBundle,
    generated_drafts: list[dict[str, Any]],
) -> dict[str, Any]:
    beat = batch.outline.beats[child_index]
    chapter_id = input_data.chapterIds[child_index]
    chapter = next((item for item in bundle.chapters if item.chapterId == chapter_id and item.target), None)
    if chapter is None:
        raise ToolchainError("NODE_FAILED", f"Rewrite target {chapter_id} is unavailable", node_id=f"draft.generate.{child_index}")
    previous_rewrites = generated_drafts[-2:]
    prepared_context = _prepared_rewrite_context(input_data, bundle, chapter_id, chapter.content)
    batch_context = {
        "draftBatchId": batch.draftBatchId,
        "batchMode": "batch_rewrite",
        "outlineRevision": batch.outline.revision,
        "childIndex": child_index,
        "targetChapterId": chapter_id,
        "targetChapterTitle": chapter.title,
        "allBeats": [item.model_dump() for item in batch.outline.beats],
        "currentBeat": beat.model_dump(),
        "previousRewriteSummaries": [
            {
                "childIndex": item.get("childIndex"),
                "title": item.get("title"),
                "summary": item.get("summary"),
            }
            for item in generated_drafts
        ],
        "recentFullRewrites": [
            {
                "childIndex": item.get("childIndex"),
                "title": item.get("title"),
                "content": str(item.get("generatedText") or "")[-12000:],
            }
            for item in previous_rewrites
        ],
        "stateLedger": batch.stateLedger.model_dump(),
    }
    intent = "\n".join([
        input_data.goal,
        f"完整改写目标章节：{chapter.title}（{chapter_id}）",
        f"修订目标：{beat.chapterGoal}",
        f"核心冲突：{beat.coreConflict}",
        f"关键事件：{'；'.join(beat.keyEvents)}",
        f"信息揭示：{'；'.join(beat.reveals)}",
        f"结尾钩子：{beat.endingHook}",
        "输出完整替换正文，不要续写在原文之后，不要解释修改过程。",
    ])
    return {
        "novelId": input_data.novelId,
        "chapterId": chapter_id,
        "targetChapterId": chapter_id,
        "currentContent": chapter.content,
        "mode": "rewrite_chapter",
        "batchMode": "batch_rewrite",
        "userIntent": intent,
        "locale": input_data.locale,
        "presentation": "silent",
        "contextChapterCount": input_data.contextChapterCount,
        "recentRawChapterCount": input_data.recentRawChapterCount,
        "targetLength": beat.targetWordCount,
        "style": input_data.style,
        "tone": input_data.tone,
        "pace": input_data.pace,
        "preparedContext": prepared_context,
        "draftBatchId": batch.draftBatchId,
        "childIndex": child_index,
        "generationRevision": batch.children[child_index].generationRevision,
        "batchTitle": beat.title,
        "batchContext": batch_context,
    }


def _prepared_rewrite_context(
    input_data: ChapterBatchRewriteInput,
    bundle: ChapterScopeBundle,
    chapter_id: str,
    current_content: str,
) -> dict[str, Any]:
    chapter_sources = [
        {
            "chapterId": chapter.chapterId,
            "volumeId": chapter.volumeId,
            "title": chapter.title,
            "order": chapter.order,
            "volumeOrder": chapter.volumeOrder,
            "version": chapter.version,
            "contentHash": chapter.contentHash,
            "updatedAt": chapter.updatedAt,
            "source": "database",
            "contentMode": chapter.contentMode,
            "summaryFresh": chapter.summaryFresh,
        }
        for chapter in bundle.chapters
    ]
    entity_context = bundle.entityContext
    recent_chapters = [
        {
            "chapterId": chapter.chapterId,
            "title": chapter.title,
            "excerpt": chapter.content[-12000:],
            "contentMode": chapter.contentMode,
        }
        for chapter in bundle.chapters
        if chapter.chapterId != chapter_id
    ][-input_data.contextChapterCount:]
    return {
        "currentContentSource": current_content,
        "hardContext": {
            "worldSettings": entity_context.get("worldSettings", []),
            "plotLines": bundle.plotContext.get("plotlines", bundle.plotContext.get("plotLines", [])),
            "characters": entity_context.get("characters", []),
            "items": entity_context.get("items", []),
            "maps": entity_context.get("maps", []),
        },
        "dynamicContext": {
            "recentChapters": recent_chapters,
            "selectedIdeas": [],
            "selectedIdeaEntities": [],
            "currentChapterBeforeCursor": current_content,
            "narrativeSummaries": bundle.narrativeSummaries,
        },
        "params": {
            "mode": "rewrite_chapter",
            "contextChapterCount": input_data.contextChapterCount,
            "targetLength": 2000,
            "style": input_data.style,
            "tone": input_data.tone,
            "pace": input_data.pace,
        },
        "policy": {
            "version": "continuation-context-v1",
            "summaryChapterCount": input_data.contextChapterCount,
            "fullTextChapterCount": input_data.recentRawChapterCount,
            "maxFullTextChars": 12000,
            "maxSummaryChars": 2400,
            "maxCurrentContentChars": 12000,
        },
        "snapshot": {
            "scopeId": bundle.scope.scopeId,
            "novelId": input_data.novelId,
            "anchorChapterId": chapter_id,
            "chapterSources": chapter_sources,
            "narrativeSummaryIds": [
                str(item.get("id")) for item in bundle.narrativeSummaries if item.get("id")
            ],
            "estimatedTokens": bundle.estimatedTokens,
            "createdAt": chapter_sources[0]["updatedAt"] if chapter_sources else "",
        },
        "usedContext": ["chapter-scope-context-v1", "batch-rewrite"],
        "warnings": bundle.warnings,
    }
