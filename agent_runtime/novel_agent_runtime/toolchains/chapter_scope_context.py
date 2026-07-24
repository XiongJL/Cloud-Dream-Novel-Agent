from __future__ import annotations

from typing import Any

from .schemas import (
    ChapterScopeBundle,
    ChapterScopeContextInput,
    ContextEvidence,
    ToolchainError,
    estimate_tokens,
)


SCOPE_CONTEXT_NODES = ("scope.read", "rag.retrieve")


def initial_scope_context_state(input_data: ChapterScopeContextInput) -> dict[str, Any]:
    return {
        "input": input_data.model_dump(),
        "nodeIndex": 0,
        "bundle": None,
        "warnings": [],
        "sourceStatus": {},
        "toolCallCount": 0,
        "estimatedTokens": 0,
    }


def build_scope_tool_call(node_id: str, state: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    input_data = ChapterScopeContextInput.model_validate(state["input"])
    if node_id == "scope.read":
        return "chapter.scope_context.build", input_data.model_dump(exclude_none=True)
    if node_id == "rag.retrieve":
        return "rag.ask", {
            "novelId": input_data.novelId,
            **({"chapterId": input_data.anchorChapterId} if input_data.anchorChapterId else {}),
            "question": (
                f"{input_data.goal}\n"
                "请只返回与批准章节范围直接相关的事实、伏笔、人物状态和设定证据，并标注来源章节。"
            ),
            "locale": input_data.locale,
            "scope": "novel",
            "maxEvidenceItems": 20,
        }
    raise ToolchainError("NODE_FAILED", f"Unknown scope context node: {node_id}", node_id=node_id)


def apply_scope_node_result(state: dict[str, Any], node_id: str, result: Any) -> dict[str, Any]:
    updated = {**state}
    if node_id == "scope.read":
        try:
            bundle = ChapterScopeBundle.model_validate(result)
        except Exception as error:
            raise ToolchainError(
                "CONTEXT_INSUFFICIENT",
                f"Chapter scope context is invalid: {error}",
                node_id=node_id,
                retryable=True,
            ) from error
        updated["bundle"] = bundle.model_dump()
        token_count = bundle.estimatedTokens or estimate_tokens(bundle.model_dump())
    elif node_id == "rag.retrieve":
        evidence = _rag_evidence(result)
        bundle = ChapterScopeBundle.model_validate(state.get("bundle") or {})
        known = {
            (item.sourceType, item.sourceId, item.excerpt)
            for item in bundle.evidence
        }
        bundle.evidence.extend(
            item for item in evidence
            if (item.sourceType, item.sourceId, item.excerpt) not in known
        )
        updated["bundle"] = bundle.model_dump()
        token_count = estimate_tokens([item.model_dump() for item in evidence])
        if not evidence:
            updated["warnings"] = [
                *(state.get("warnings") or []),
                "RAG 未返回范围内的补充证据。",
            ]
    else:
        raise ToolchainError("NODE_FAILED", f"Unknown scope context node: {node_id}", node_id=node_id)
    updated.update({
        "nodeIndex": int(state.get("nodeIndex") or 0) + 1,
        "sourceStatus": {**(state.get("sourceStatus") or {}), node_id: "completed"},
        "toolCallCount": int(state.get("toolCallCount") or 0) + 1,
        "estimatedTokens": int(state.get("estimatedTokens") or 0) + token_count,
    })
    return updated


def apply_scope_node_failure(state: dict[str, Any], node_id: str, error: Exception) -> dict[str, Any]:
    if node_id == "scope.read":
        raise ToolchainError(
            "CONTEXT_INSUFFICIENT",
            f"Chapter scope could not be read: {error}",
            node_id=node_id,
            retryable=True,
        ) from error
    return {
        **state,
        "nodeIndex": int(state.get("nodeIndex") or 0) + 1,
        "warnings": [*(state.get("warnings") or []), f"RAG 补充检索失败：{error}"],
        "sourceStatus": {**(state.get("sourceStatus") or {}), node_id: "failed"},
        "toolCallCount": int(state.get("toolCallCount") or 0) + 1,
    }


def build_scope_bundle(state: dict[str, Any], role: str) -> ChapterScopeBundle:
    bundle = ChapterScopeBundle.model_validate(state.get("bundle") or {})
    bundle.warnings = list(dict.fromkeys([*bundle.warnings, *(state.get("warnings") or [])]))
    bundle.estimatedTokens = max(bundle.estimatedTokens, int(state.get("estimatedTokens") or 0))
    return project_scope_bundle(bundle, role)


def project_scope_bundle(
    bundle: ChapterScopeBundle,
    role: str,
    *,
    reader_through_chapter_id: str | None = None,
) -> ChapterScopeBundle:
    if role != "reader":
        return bundle.model_copy(deep=True)

    projected = bundle.model_copy(deep=True)
    through_id = reader_through_chapter_id or bundle.scope.anchorChapterId
    if not through_id and bundle.chapters:
        through_id = bundle.chapters[-1].chapterId
    through_index = next(
        (index for index, chapter in enumerate(bundle.chapters) if chapter.chapterId == through_id),
        -1,
    )
    projected.chapters = projected.chapters[: through_index + 1] if through_index >= 0 else []
    visible_ids = {chapter.chapterId for chapter in projected.chapters}
    projected.scope.chapterIds = [chapter_id for chapter_id in projected.scope.chapterIds if chapter_id in visible_ids]
    projected.scope.snapshot = [item for item in projected.scope.snapshot if item.chapterId in visible_ids]
    projected.sourceSnapshot = [item for item in projected.sourceSnapshot if item.chapterId in visible_ids]
    projected.narrativeSummaries = []
    projected.entityContext = {"characters": [], "items": [], "worldSettings": [], "maps": []}
    projected.plotContext = {"plotlines": []}
    normalized_evidence = [ContextEvidence.model_validate(item) for item in projected.evidence]
    projected.evidence = [
        item
        for item in normalized_evidence
        if item.sourceType == "chapter" and item.sourceId in visible_ids
    ]
    projected.stateLedger.entities = {}
    projected.stateLedger.timelineHints = []
    projected.stateLedger.openQuestions = []
    projected.stateLedger.unresolvedThreads = []
    projected.coverage.totalChapterCount = len(projected.scope.chapterIds)
    projected.coverage.contextChapterCount = len(projected.chapters)
    projected.coverage.readonlyChapterCount = sum(1 for item in projected.chapters if not item.target)
    projected.coverage.detailedChapterCount = sum(
        1 for item in projected.chapters if item.target and item.contentMode in {"full", "truncated"}
    )
    projected.coverage.summarizedChapterCount = sum(
        1 for item in projected.chapters if item.target and item.contentMode == "summary"
    )
    projected.coverage.excerptChapterCount = sum(
        1 for item in projected.chapters if item.target and item.contentMode == "excerpt"
    )
    projected.coverage.omittedChapterCount = 0
    projected.coverage.batches = [
        {"index": 0, "chapterIds": projected.scope.chapterIds}
    ] if projected.scope.chapterIds else []
    projected.coverage.batchCount = len(projected.coverage.batches)
    projected.warnings = list(dict.fromkeys([
        *projected.warnings,
        "读者投影已隐藏未来章节、后台设定、情节线与非章节证据。",
    ]))
    projected.estimatedTokens = estimate_tokens(projected.model_dump())
    return projected


def _rag_evidence(value: Any) -> list[ContextEvidence]:
    record = value if isinstance(value, dict) else {}
    raw = record.get("evidence") or record.get("sources") or record.get("citations") or []
    output: list[ContextEvidence] = []
    if isinstance(raw, list):
        for item in raw[:20]:
            if isinstance(item, str):
                output.append(ContextEvidence(sourceType="rag", excerpt=item[:2000]))
            elif isinstance(item, dict):
                confidence = item.get("confidence")
                try:
                    normalized_confidence = max(0.0, min(1.0, float(confidence))) if confidence is not None else None
                except (TypeError, ValueError):
                    normalized_confidence = None
                output.append(ContextEvidence(
                    sourceType=str(item.get("sourceType") or item.get("type") or "rag"),
                    sourceId=str(item.get("sourceId") or item.get("id") or "") or None,
                    title=str(item.get("title") or item.get("name") or "")[:300],
                    excerpt=str(item.get("excerpt") or item.get("snippet") or item.get("content") or "")[:2000],
                    confidence=normalized_confidence,
                    metadata={key: item[key] for key in ("chapterId", "volumeId", "score") if key in item},
                ))
    return output
