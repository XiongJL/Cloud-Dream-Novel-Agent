from __future__ import annotations

from typing import Any

from .schemas import (
    ChapterContextInput,
    ContextBundle,
    ContextEvidence,
    ContextOmission,
    ToolchainError,
    estimate_tokens,
)


CONTEXT_NODES = (
    "chapter.read",
    "volume.locate",
    "chapter.adjacent",
    "plotline.read",
    "character.read",
    "world.read",
    "item.read",
    "rag.retrieve",
)

NODE_TOOL = {
    "chapter.read": "chapter.get",
    "volume.locate": "volume.list",
    "chapter.adjacent": "chapter.list",
    "plotline.read": "plotline.list",
    "character.read": "character.list",
    "world.read": "worldsetting.list",
    "item.read": "item.list",
    "rag.retrieve": "rag.ask",
}


def initial_context_state(input_data: ChapterContextInput) -> dict[str, Any]:
    return {
        "input": input_data.model_dump(),
        "nodeIndex": 0,
        "results": {},
        "warnings": [],
        "omitted": [],
        "sourceStatus": {},
        "toolCallCount": 0,
        "estimatedTokens": 0,
    }


def build_tool_call(node_id: str, state: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    input_data = ChapterContextInput.model_validate(state["input"])
    results = state.get("results") or {}
    if node_id == "chapter.read":
        return "chapter.get", {"chapterId": input_data.chapterId}
    if node_id == "volume.locate":
        return "volume.list", {"novelId": input_data.novelId}
    if node_id == "chapter.adjacent":
        volume_id = input_data.volumeId or _find_volume_id(results.get("chapter.read"), results.get("volume.locate"))
        if not volume_id:
            return None
        return "chapter.list", {"volumeId": volume_id}
    if node_id in {"plotline.read", "character.read", "world.read", "item.read"}:
        return NODE_TOOL[node_id], {"novelId": input_data.novelId}
    if node_id == "rag.retrieve":
        return "rag.ask", {
            "novelId": input_data.novelId,
            "chapterId": input_data.chapterId,
            "question": f"{input_data.goal}\n请只返回与当前章节一致性或续写直接相关的证据，并标注来源。",
            "locale": input_data.locale,
            "scope": "novel",
            "maxEvidenceItems": 10,
        }
    raise ToolchainError("NODE_FAILED", f"Unknown chapter context node: {node_id}", node_id=node_id)


def apply_node_result(state: dict[str, Any], node_id: str, result: Any) -> dict[str, Any]:
    updated = {**state}
    bounded_result = _bounded_value(result, string_limit=12000 if node_id == "chapter.read" else 3000)
    results = {**(state.get("results") or {}), node_id: bounded_result}
    source_status = {**(state.get("sourceStatus") or {}), node_id: "completed"}
    updated.update(
        {
            "results": results,
            "sourceStatus": source_status,
            "nodeIndex": int(state.get("nodeIndex") or 0) + 1,
            "toolCallCount": int(state.get("toolCallCount") or 0) + 1,
            "estimatedTokens": int(state.get("estimatedTokens") or 0) + estimate_tokens(bounded_result),
        }
    )
    return updated


def apply_node_skip(state: dict[str, Any], node_id: str, reason: str) -> dict[str, Any]:
    updated = {**state}
    updated["nodeIndex"] = int(state.get("nodeIndex") or 0) + 1
    updated["warnings"] = [*(state.get("warnings") or []), reason]
    updated["omitted"] = [*(state.get("omitted") or []), {"sourceType": node_id, "reason": reason}]
    updated["sourceStatus"] = {**(state.get("sourceStatus") or {}), node_id: "skipped"}
    return updated


def apply_node_failure(state: dict[str, Any], node_id: str, error: Exception) -> dict[str, Any]:
    if node_id == "chapter.read":
        raise ToolchainError(
            "CONTEXT_INSUFFICIENT",
            f"Target chapter could not be read: {error}",
            node_id=node_id,
            retryable=True,
        ) from error
    updated = apply_node_skip(state, node_id, f"{NODE_TOOL[node_id]} 读取失败：{error}")
    updated["toolCallCount"] = int(state.get("toolCallCount") or 0) + 1
    updated["sourceStatus"] = {**(updated.get("sourceStatus") or {}), node_id: "failed"}
    return updated


def exhaust_context_budget(state: dict[str, Any], reason: str) -> dict[str, Any]:
    updated = {**state}
    start = int(state.get("nodeIndex") or 0)
    for node_id in CONTEXT_NODES[start:]:
        updated = apply_node_skip(updated, node_id, reason)
    return updated


def build_context_bundle(state: dict[str, Any]) -> ContextBundle:
    input_data = ChapterContextInput.model_validate(state["input"])
    results = state.get("results") or {}
    chapter = _as_record(results.get("chapter.read"))
    if not chapter:
        raise ToolchainError("CONTEXT_INSUFFICIENT", "Target chapter is missing", node_id="chapter.read")
    adjacent = _adjacent_chapters(_as_items(results.get("chapter.adjacent")), input_data.chapterId, input_data.includeAdjacent)
    evidence = _rag_evidence(results.get("rag.retrieve"))
    warnings = list(state.get("warnings") or [])
    if not evidence:
        warnings.append("RAG 未返回可引用证据；审核中的推测必须标注不确定性。")
    bundle = ContextBundle(
        chapter=_compact_record(chapter),
        adjacentChapters=[_compact_record(item) for item in adjacent],
        plotlines=[_compact_record(item) for item in _as_items(results.get("plotline.read"))],
        characters=[_compact_record(item) for item in _as_items(results.get("character.read"))],
        worldSettings=[_compact_record(item) for item in _as_items(results.get("world.read"))],
        items=[_compact_record(item) for item in _as_items(results.get("item.read"))],
        evidence=evidence,
        warnings=_dedupe_strings(warnings),
        omitted=[ContextOmission.model_validate(item) for item in state.get("omitted") or []],
        toolCallCount=int(state.get("toolCallCount") or 0),
        estimatedTokens=int(state.get("estimatedTokens") or 0),
        sourceStatus=dict(state.get("sourceStatus") or {}),
    )
    budget = input_data.maxEstimatedTokens
    if budget and bundle.estimatedTokens > budget:
        bundle.warnings.append(f"上下文估算 {bundle.estimatedTokens} tokens，超过目标预算 {budget}；已保留结构化摘要供后续裁剪。")
    return bundle


def _find_volume_id(chapter_result: Any, volume_result: Any) -> str | None:
    chapter = _as_record(chapter_result)
    direct = chapter.get("volumeId") or chapter.get("volume_id")
    if direct:
        return str(direct)
    chapter_id = str(chapter.get("id") or chapter.get("chapterId") or "")
    for volume in _as_items(volume_result):
        chapter_ids = volume.get("chapterIds") or volume.get("chapters") or []
        if chapter_id and chapter_id in {str(item.get("id") if isinstance(item, dict) else item) for item in chapter_ids}:
            return str(volume.get("id") or volume.get("volumeId") or "") or None
    return None


def _as_record(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        for key in ("data", "chapter", "result"):
            nested = value.get(key)
            if isinstance(nested, dict):
                return nested
        return value
    return {}


def _as_items(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        for key in ("items", "data", "results", "chapters", "volumes"):
            nested = value.get(key)
            if isinstance(nested, list):
                return [item for item in nested if isinstance(item, dict)]
    return []


def _adjacent_chapters(items: list[dict[str, Any]], chapter_id: str, distance: int) -> list[dict[str, Any]]:
    if not items or distance <= 0:
        return []
    ordered = sorted(items, key=lambda item: (item.get("order") is None, item.get("order", 0)))
    index = next(
        (position for position, item in enumerate(ordered) if str(item.get("id") or item.get("chapterId")) == chapter_id),
        None,
    )
    if index is None:
        return []
    start = max(0, index - distance)
    end = min(len(ordered), index + distance + 1)
    return [item for position, item in enumerate(ordered[start:end], start=start) if position != index]


def _rag_evidence(value: Any) -> list[ContextEvidence]:
    record = _as_record(value)
    raw = record.get("evidence") or record.get("sources") or record.get("citations") or []
    evidence: list[ContextEvidence] = []
    if isinstance(raw, list):
        for item in raw[:20]:
            if isinstance(item, str):
                evidence.append(ContextEvidence(sourceType="rag", excerpt=item[:2000]))
            elif isinstance(item, dict):
                evidence.append(
                    ContextEvidence(
                        sourceType=str(item.get("sourceType") or item.get("type") or "rag"),
                        sourceId=str(item.get("sourceId") or item.get("id") or "") or None,
                        title=str(item.get("title") or item.get("name") or "")[:300],
                        excerpt=str(item.get("excerpt") or item.get("snippet") or item.get("content") or "")[:2000],
                        confidence=_confidence(item.get("confidence")),
                        metadata={key: item[key] for key in ("chapterId", "volumeId", "score") if key in item},
                    )
                )
    answer = str(record.get("answer") or "").strip()
    if answer and not evidence:
        evidence.append(ContextEvidence(sourceType="rag", excerpt=answer[:2000], confidence=_confidence(record.get("confidence"))))
    return evidence


def _confidence(value: Any) -> float | None:
    try:
        return max(0.0, min(1.0, float(value))) if value is not None else None
    except (TypeError, ValueError):
        return None


def _compact_record(record: dict[str, Any]) -> dict[str, Any]:
    preferred = (
        "id", "chapterId", "volumeId", "title", "name", "order", "summary", "description", "content",
        "status", "type", "role", "motivation", "rules", "location", "excerpt", "metadata",
    )
    compact = {key: record[key] for key in preferred if key in record and record[key] is not None}
    if "content" in compact and isinstance(compact["content"], str):
        compact["content"] = compact["content"][:12000]
    return compact or {key: value for key, value in list(record.items())[:12]}


def _dedupe_strings(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in values if value.strip()))


def _bounded_value(value: Any, *, string_limit: int, depth: int = 0) -> Any:
    if depth >= 5:
        return str(value)[:string_limit]
    if isinstance(value, str):
        return value[:string_limit]
    if isinstance(value, list):
        return [_bounded_value(item, string_limit=string_limit, depth=depth + 1) for item in value[:80]]
    if isinstance(value, dict):
        return {
            str(key): _bounded_value(item, string_limit=string_limit, depth=depth + 1)
            for key, item in list(value.items())[:60]
        }
    return value
