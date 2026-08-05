from __future__ import annotations

from typing import Any

from .schemas import ChapterContinuationInput, ContextBundle, DraftSessionRef, ToolchainError


def continuation_context_params(input_data: ChapterContinuationInput) -> dict[str, Any]:
    params: dict[str, Any] = {
        "novelId": input_data.novelId,
        "chapterId": input_data.chapterId,
        "contextChapterCount": input_data.contextChapterCount,
        "recentRawChapterCount": input_data.recentRawChapterCount,
        "locale": input_data.locale,
    }
    if input_data.currentContent:
        params["currentContent"] = input_data.currentContent
    for key in ("targetLength", "style", "tone", "pace"):
        value = getattr(input_data, key)
        if value not in (None, ""):
            params[key] = value
    return params


def build_continuation_context_bundle(
    value: Any,
    rag_result: Any | None = None,
) -> ContextBundle:
    if not isinstance(value, dict):
        raise ToolchainError(
            "NODE_FAILED",
            "chapter.continuation_context.build returned an invalid context object",
            node_id="context.build",
        )
    hard = value.get("hardContext") if isinstance(value.get("hardContext"), dict) else {}
    dynamic = value.get("dynamicContext") if isinstance(value.get("dynamicContext"), dict) else {}
    snapshot = value.get("snapshot") if isinstance(value.get("snapshot"), dict) else {}
    chapter_sources = snapshot.get("chapterSources") if isinstance(snapshot.get("chapterSources"), list) else []
    anchor_id = str(snapshot.get("anchorChapterId") or "")
    anchor = next(
        (item for item in chapter_sources if isinstance(item, dict) and str(item.get("chapterId") or "") == anchor_id),
        {},
    )
    recent_chapters = dynamic.get("recentChapters") if isinstance(dynamic.get("recentChapters"), list) else []
    evidence = []
    rag_warnings: list[str] = []
    if isinstance(rag_result, dict):
        evidence = rag_result.get("evidence") if isinstance(rag_result.get("evidence"), list) else []
        rag_warnings = [str(item) for item in rag_result.get("warnings", []) if str(item).strip()]
    try:
        return ContextBundle.model_validate({
            "chapter": {
                "id": anchor_id,
                "volumeId": anchor.get("volumeId"),
                "title": anchor.get("title") or "",
                "content": value.get("currentContentSource") or dynamic.get("currentChapterBeforeCursor") or "",
                "version": anchor.get("version"),
                "contentHash": anchor.get("contentHash"),
            },
            "adjacentChapters": recent_chapters,
            "plotlines": hard.get("plotLines") if isinstance(hard.get("plotLines"), list) else [],
            "characters": hard.get("characters") if isinstance(hard.get("characters"), list) else [],
            "worldSettings": hard.get("worldSettings") if isinstance(hard.get("worldSettings"), list) else [],
            "items": hard.get("items") if isinstance(hard.get("items"), list) else [],
            "evidence": evidence,
            "warnings": [
                *[str(item) for item in value.get("warnings", []) if str(item).strip()],
                *rag_warnings,
            ],
            "toolCallCount": 1 + (1 if rag_result is not None else 0),
            "estimatedTokens": int(snapshot.get("estimatedTokens") or 0),
            "sourceStatus": {
                "context.build": "completed",
                **({"rag.retrieve": "completed"} if rag_result is not None else {}),
            },
        })
    except Exception as error:
        raise ToolchainError(
            "NODE_FAILED",
            f"Continuation context failed validation: {error}",
            node_id="context.build",
        ) from error


def build_generation_brief(
    input_data: ChapterContinuationInput,
    context: ContextBundle,
    direction_summary: str = "",
) -> str:
    chapter = context.chapter
    parts = [input_data.goal.strip()]
    if direction_summary.strip():
        parts.append(f"用户确认的创作方向：{direction_summary.strip()}")
    title = str(chapter.get("title") or "").strip()
    if title:
        parts.append(f"当前章节：{title}")
    if context.plotlines:
        parts.append(f"活跃情节线：{_names(context.plotlines)}")
    if context.characters:
        parts.append(f"相关角色：{_names(context.characters)}")
    if context.worldSettings:
        parts.append(f"世界规则：{_names(context.worldSettings)}")
    if context.warnings:
        parts.append(f"资料提醒：{'；'.join(context.warnings[:3])}")
    return "\n".join(part for part in parts if part)


def chapter_draft_params(
    input_data: ChapterContinuationInput,
    context: ContextBundle,
    brief: str,
    prepared_context: dict[str, Any] | None = None,
    resolved_target: dict[str, Any] | None = None,
) -> dict[str, Any]:
    current_content = input_data.currentContent or str(context.chapter.get("content") or "")
    fills_existing_empty_chapter = (
        isinstance(resolved_target, dict)
        and resolved_target.get("hasContent") is False
        and _has_usable_prior_chapter_context(input_data.chapterId, context.adjacentChapters)
    )
    if not current_content.strip() and not fills_existing_empty_chapter:
        raise ToolchainError(
            "CONTEXT_INSUFFICIENT",
            "生成续写草稿前需要当前章节正文，或可用的前序章节上下文。",
            node_id="draft.generate",
        )
    params: dict[str, Any] = {
        "novelId": input_data.novelId,
        "chapterId": input_data.chapterId,
        "currentContent": current_content,
        "mode": "new_chapter" if fills_existing_empty_chapter else "continue_chapter",
        "userIntent": brief,
        "locale": input_data.locale,
        "presentation": "toast",
        "contextChapterCount": input_data.contextChapterCount,
        "recentRawChapterCount": input_data.recentRawChapterCount,
    }
    for key in ("targetLength", "style", "tone", "pace"):
        value = getattr(input_data, key)
        if value not in (None, ""):
            params[key] = value
    if prepared_context:
        params["preparedContext"] = prepared_context
    return params


def _has_usable_prior_chapter_context(
    target_chapter_id: str,
    adjacent_chapters: list[dict[str, Any]],
) -> bool:
    content_fields = ("content", "excerpt", "summary", "summaryText", "text")
    return any(
        str(chapter.get("chapterId") or chapter.get("id") or "") != target_chapter_id
        and any(str(chapter.get(field) or "").strip() for field in content_fields)
        for chapter in adjacent_chapters
        if isinstance(chapter, dict)
    )


def normalize_chapter_draft(value: Any) -> DraftSessionRef:
    try:
        session = DraftSessionRef.model_validate(value)
    except Exception as error:
        raise ToolchainError(
            "NODE_FAILED",
            f"chapter.generate_draft returned an invalid DraftSession: {error}",
            node_id="draft.generate",
        ) from error
    if session.type and session.type != "chapter-draft":
        raise ToolchainError(
            "NODE_FAILED",
            f"chapter.generate_draft returned unexpected draft type: {session.type}",
            node_id="draft.generate",
        )
    if session.status not in {"draft", "pending", "ready"}:
        raise ToolchainError(
            "NODE_FAILED",
            f"chapter.generate_draft returned non-reviewable status: {session.status}",
            node_id="draft.generate",
        )
    return session.model_copy(update={"type": session.type or "chapter-draft"})


def _names(items: list[dict[str, Any]]) -> str:
    values = [str(item.get("name") or item.get("title") or "").strip() for item in items[:8]]
    return "、".join(value for value in values if value) or "已读取相关资料"
